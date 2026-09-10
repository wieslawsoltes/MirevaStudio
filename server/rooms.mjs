import {DocumentStore} from '../src/core/store.js';
import {validateSnapshot, validateOp, validId, clone, validateHierarchy} from '../src/core/schema.js';
import {secret, makeId, digest, fail, safeString, jsonBody, sendJSON} from './security.mjs';
export class RoomService {
  constructor(db, auth, organizations, ai, {createKey = '', allowAnonymous = true, compactEvery = 100, maxBytes = 100000000, maxRooms = 10000} = {}) {
    this.db = db; this.auth = auth; this.orgs = organizations; this.ai = ai; this.createKey = createKey; this.allowAnonymous = allowAnonymous;
    this.compactEvery = Math.max(2, compactEvery); this.maxBytes = maxBytes; this.maxRooms = maxRooms; this.cache = new Map(); this.clients = new Set();
    this.db.sql.exec('CREATE TABLE IF NOT EXISTS room_receipts(room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,batch_id TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(room_id,batch_id)); CREATE INDEX IF NOT EXISTS receipts_expiry ON room_receipts(created_at);');
    this.poller = setInterval(() => this.poll(), 250); this.poller.unref();
  }
  row(id) { if (!/^[a-f0-9]{24}$/.test(id)) throw fail(404, 'Project not found'); const row = this.db.get('SELECT * FROM rooms WHERE id=?', id); if (!row) throw fail(404, 'Project not found'); return row; }
  access(req, row, {write = false, archived = false} = {}) {
    const bearer = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
    let principal;
    if (bearer) {
      const grant = this.db.get('SELECT * FROM grants WHERE room_id=? AND hash=? AND revoked=0 AND (expires_at IS NULL OR expires_at>?)', row.id, digest(bearer[1]), Date.now());
      if (!grant) throw fail(401, 'Invitation is invalid, expired, or revoked');
      if (row.org_id) { const org = this.db.get('SELECT * FROM orgs WHERE id=? AND deleted=0', row.org_id); if (!org) throw fail(404, 'Organization not found'); const settings = JSON.parse(org.settings); if (!settings.allowGuestInvites || settings.ssoProvider) throw fail(403, 'This organization requires account-based access'); }
      principal = {id:grant.id, role:grant.role, grant, name:grant.label, context:null};
    } else {
      const context = this.auth.require(req);
      if (row.org_id) {
        const {org} = this.orgs.access(req, row.org_id), assigned = this.db.get('SELECT role FROM room_members WHERE room_id=? AND user_id=?', row.id, context.user.id);
        const role = ['owner','admin'].includes(org.role) || row.owner_id === context.user.id ? 'owner' : org.role === 'viewer' ? 'viewer' : assigned?.role || org.settings.defaultProjectRole || 'editor';
        principal = {id:context.user.id, role, orgRole:org.role, context, name:context.user.name};
      } else {
        const role = row.owner_id === context.user.id ? 'owner' : this.db.get('SELECT role FROM room_members WHERE room_id=? AND user_id=?', row.id, context.user.id)?.role;
        if (!role) throw fail(404, 'Project not found'); principal = {id:context.user.id, role, context, name:context.user.name};
      }
      if (write) this.auth.csrf(req, context);
    }
    if (row.archived_at && !archived) throw fail(409, 'Project is archived; an owner must restore it'); return principal;
  }
  load(row) {
    let cached = this.cache.get(row.id);
    if (!cached || cached.revision < row.base_revision || cached.revision > row.revision) {
      const store = new DocumentStore('server'); store.load(this.db.unpack(row.snapshot)); cached = {store, revision:row.base_revision, used:Date.now()};
    }
    if (cached.revision < row.revision) {
      for (const event of this.db.all('SELECT revision,ops FROM room_ops WHERE room_id=? AND revision>? ORDER BY revision', row.id, cached.revision)) { const value = this.db.unpack(event.ops); cached.store.receive(value.ops || value); cached.revision = event.revision; }
    }
    if (cached.revision !== row.revision) throw fail(503, 'Project journal is incomplete; restore a verified backup');
    cached.used = Date.now(); this.cache.set(row.id, cached);
    if (this.cache.size > 64) for (const [id, entry] of [...this.cache].sort((a,b) => a[1].used-b[1].used)) { if (id !== row.id && ![...this.clients].some(c => c.room === id)) this.cache.delete(id); if (this.cache.size <= 64) break; }
    return cached;
  }
  quota(row, bytes) {
    if (bytes > this.maxBytes) throw fail(413, 'Project storage limit reached');
    this.db.checkOrganizationQuota(row.org_id,Math.max(0,bytes-(row.storage_bytes||0)));
  }
  async create(req, res) {
    const context = this.auth.context(req);
    if (this.createKey && req.headers['x-create-key'] !== this.createKey && !context?.session.mfa) throw fail(401, 'A server creation key or verified account is required');
    if (!context?.session.mfa && !this.allowAnonymous) throw fail(401, 'A verified account is required to create projects');
    if (context?.session.mfa) this.auth.csrf(req, context);
    if (!this.db.rate('room-create:' + digest(req.socket.remoteAddress || ''), 20, 3600000)) throw fail(429, 'Project creation rate limit reached');
    const b = await jsonBody(req), snapshot = validateSnapshot(b.snapshot), id = makeId(), token = context?.session.mfa ? null : secret(), orgId = b.orgId || null;
    if (orgId) { const {org} = this.orgs.access(req, orgId, ['owner','admin','member']); if (org.role === 'member' && !org.settings.membersCanCreate) throw fail(403, 'Only administrators may create projects'); }
    const packed = this.db.pack(snapshot), now = Date.now(), name = safeString(snapshot.records.project?.name, 100) || 'Untitled project';
    this.db.transaction(() => {
      if (this.db.get('SELECT count(*) AS n FROM rooms').n >= this.maxRooms) throw fail(503, 'Server project limit reached');
      if (orgId) { const settings = JSON.parse(this.db.get('SELECT settings FROM orgs WHERE id=?', orgId).settings); if (this.db.get('SELECT count(*) AS n FROM rooms WHERE org_id=? AND archived_at IS NULL', orgId).n >= (settings.projectLimit || 200)) throw fail(409, 'Organization project limit reached'); }
      this.quota({id, org_id:orgId}, packed.length);
      this.db.run('INSERT INTO rooms(id,org_id,owner_id,name,created_at,updated_at,snapshot,storage_bytes,record_count) VALUES(?,?,?,?,?,?,?,?,?)', id, orgId, context?.session.mfa ? context.user.id : null, name, now, now, packed, packed.length, Object.keys(snapshot.records).length);
      if (token) this.db.run("INSERT INTO grants(id,room_id,hash,role,label,created_at) VALUES(?,?,?,'owner','Workspace owner',?)", makeId(), id, digest(token), now);
      this.db.audit(orgId, context?.user.id || 'anonymous', 'project.created', id, {name});
    }); sendJSON(res, {id, ...(token ? {token} : {account:true, orgId}), role:'owner'}, 201);
  }
  commit(req, row, b) {
    if (!Array.isArray(b.ops) || !b.ops.length || b.ops.length > 512) throw fail(400, 'Send 1–512 operations'); for (const op of b.ops) validateOp(op);
    const contentHash = digest(JSON.stringify(b.ops)), batchId = b.batchId ? safeString(b.batchId, 100) + ':' + contentHash : contentHash;
    return this.db.transaction(() => {
      row = this.row(row.id); const principal = this.access(req, row, {write:true}); if (!['owner','editor','commenter'].includes(principal.role)) throw fail(403, 'View-only invitation');
      const receipt = this.db.get('SELECT revision FROM room_receipts WHERE room_id=? AND batch_id=?', row.id, batchId); if (receipt) return {ok:true, revision:receipt.revision, duplicate:true};
      const current = this.load(row).store, next = new DocumentStore('server'); next.records = new Map(current.records); next.clock = current.clock; next.structureVersion = current.structureVersion + 1;
      for (const id of new Set(b.ops.map(op => op.id))) if (next.records.has(id)) next.records.set(id, clone(next.records.get(id)));
      for (const op of b.ops) {
        if (op.stamp[0] > current.clock + 1000000) throw fail(400, 'Operation clock is too far ahead');
        const before = next.records.get(op.id), values = op.values || {}, entity = before?.entity || values.entity;
        if (before?.entity && values.entity && before.entity !== values.entity) throw fail(400, 'Cannot change record entity');
        if (principal.role === 'commenter') {
          if (entity !== 'comment' || op.kind === 'text') throw fail(403, 'This invitation can only comment');
          if (before?.authorId && before.authorId !== principal.id) throw fail(403, 'Cannot edit another member’s comment');
          const allowed = new Set(['entity','text','author','authorId','thread','frame','x','y','resolved','deleted','createdAt']); if (Object.keys(values).some(k => !allowed.has(k))) throw fail(403, 'Invalid comment operation');
        }
        if (entity === 'comment' && principal.role !== 'owner') {
          if (values.authorId && values.authorId !== principal.id) throw fail(403, 'Comment author does not match this identity');
          if (!before?.authorId && values.authorId !== principal.id) throw fail(403, 'New comments require the author’s identity');
          if (before?.authorId && values.authorId && values.authorId !== before.authorId) throw fail(403, 'Comment authors cannot be changed');
        }
        if (!entity) throw fail(400, 'New records need an entity');if(op.kind==='text'&&(before?.entity!=='node'||!['text','button','input'].includes(before.type)))throw fail(400,'Character operations require a text element'); next.apply(op);
      }
      if(b.ops.some(o=>o.values&&('parent' in o.values||!current.records.has(o.id))))validateHierarchy(Object.fromEntries(next.records));
      if (next.records.size > 30000) throw fail(413, 'Project exceeds 30,000 records');
      const revision = row.revision + 1, event = {ops:b.ops, client:safeString(b.client), revision}, packed = this.db.pack(event), now = Date.now();
      let bytes = row.storage_bytes + packed.length;
      const compact = revision - row.base_revision >= this.compactEvery;
      const snapshot = compact ? this.db.pack(next.snapshot()) : null;
      if (compact) bytes = snapshot.length;
      this.quota(row, bytes);
      this.db.run('INSERT INTO room_ops(room_id,revision,batch_id,actor,ops,created_at) VALUES(?,?,?,?,?,?)', row.id, revision, batchId, principal.id, packed, now);
      this.db.run('INSERT INTO room_receipts(room_id,batch_id,revision,created_at) VALUES(?,?,?,?)', row.id, batchId, revision, now);
      if (compact) { this.db.run('UPDATE rooms SET snapshot=?,base_revision=? WHERE id=?', snapshot, revision, row.id); this.db.run('DELETE FROM room_ops WHERE room_id=? AND revision<=?', row.id, revision - this.compactEvery); }
      this.db.run('UPDATE rooms SET revision=?,updated_at=?,storage_bytes=?,record_count=?,name=? WHERE id=?', revision, now, bytes, next.records.size, safeString(next.get('project')?.name,100)||row.name, row.id);
      this.db.checkOrganizationQuota(row.org_id);
      this.cache.set(row.id, {store:next, revision, used:now});
      return {ok:true, revision};
    });
  }
  packet(client, event, value) {
    if (client.res.destroyed || client.res.writableEnded || client.res.writableLength > 2000000) { client.res.destroy(); return; }
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  }
  poll() {
    for (const client of this.clients) {
      try {
        client.req.authContext = undefined; const row = this.row(client.room), principal = this.access(client.req, row);
        if (principal.role !== client.role) { client.res.end(); continue; }
        if (row.revision > client.revision) {
          const entries = this.db.all('SELECT revision,ops FROM room_ops WHERE room_id=? AND revision>? ORDER BY revision', row.id, client.revision);
          if (!entries.length || entries[0].revision !== client.revision + 1) this.packet(client, 'hello', {snapshot:this.load(row).store.snapshot(), revision:row.revision, role:principal.role, grantId:principal.id});
          else for (const entry of entries) this.packet(client, 'ops', this.db.unpack(entry.ops));
          client.revision = row.revision;
        }
        const live = this.db.all('SELECT client,payload,updated_at FROM presence WHERE room_id=? AND updated_at>?', row.id, Date.now() - 25000), ids = new Set();
        for (const p of live) { ids.add(p.client); if (client.presence.get(p.client) !== p.updated_at) { this.packet(client, 'presence', JSON.parse(p.payload)); client.presence.set(p.client, p.updated_at); } }
        for (const id of client.presence.keys()) if (!ids.has(id)) { client.presence.delete(id); this.packet(client, 'leave', {client:id}); }
        if (Date.now() - client.heartbeat > 10000) { client.res.write(': heartbeat\n\n'); client.heartbeat = Date.now(); }
      } catch { client.res.end(); }
    }
  }
  async route(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean), id = parts[2], action = parts[3], target = parts[4], method = req.method;
    if (!id && method === 'POST') return this.create(req, res);
    if (!id && method === 'GET') { const c = this.auth.require(req); sendJSON(res, {projects:this.db.all('SELECT id,name,revision,updated_at AS updatedAt,archived_at AS archivedAt FROM rooms WHERE owner_id=? AND org_id IS NULL ORDER BY updated_at DESC LIMIT 1000', c.user.id)}); return; }
    const row = this.row(id), principal = this.access(req, row, {write:!['GET','HEAD'].includes(method), archived:action === 'archive'});
    const owner = () => { if (principal.role !== 'owner') throw fail(403, 'Only an owner can manage this project'); };
    const editor = () => { if (!['owner','editor'].includes(principal.role)) throw fail(403, 'Editing permission required'); };
    if (!action && method === 'GET') { sendJSON(res, {snapshot:this.load(row).store.snapshot(), revision:row.revision, role:principal.role, grantId:principal.id, orgId:row.org_id, account:!!principal.context}); return; }
    if (action === 'events' && method === 'GET') {
      if(this.clients.size>=1024||[...this.clients].filter(c=>c.principal===principal.id).length>=16)throw fail(429,'Live-session connection limit reached');
      const clientId = safeString(url.searchParams.get('client')); if (!validId(clientId)) throw fail(400, 'Invalid client ID'); if ([...this.clients].filter(c => c.room === id).length >= 128) throw fail(429, 'Project live-session limit reached');
      for (const c of this.clients) if (c.room === id && c.client === clientId && c.principal === principal.id) c.res.end();
      res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'}); res.flushHeaders();
      const c = {res, req, room:id, client:clientId, principal:principal.id, role:principal.role, revision:row.revision, heartbeat:Date.now(), presence:new Map()}; this.clients.add(c);
      this.packet(c, 'hello', {snapshot:this.load(row).store.snapshot(), revision:row.revision, role:principal.role, grantId:principal.id, presence:this.db.all('SELECT payload FROM presence WHERE room_id=? AND updated_at>?', id, Date.now()-25000).map(p=>JSON.parse(p.payload))});
      res.on('close', () => { this.clients.delete(c); if (![...this.clients].some(other => other.room===id && other.client===clientId)) this.db.run('DELETE FROM presence WHERE room_id=? AND client=? AND grant_id=?', id, clientId, principal.id); }); return;
    }
    if (action === 'ops' && method === 'POST') { const b = await jsonBody(req); const result = this.commit(req, row, b); sendJSON(res, result); this.poll(); return; }
    if (action === 'presence' && method === 'POST') {
      const b = await jsonBody(req, 24000); if (!validId(b.client)) throw fail(400, 'Invalid client');
      const existing = this.db.get('SELECT grant_id FROM presence WHERE room_id=? AND client=?', id, b.client); if (existing && existing.grant_id !== principal.id) throw fail(409, 'Client identity collision');
      const cursor = b.cursor && Number.isFinite(b.cursor.x) && Number.isFinite(b.cursor.y) && Math.abs(b.cursor.x)<1e9 && Math.abs(b.cursor.y)<1e9 ? {x:b.cursor.x,y:b.cursor.y} : null;
      const payload = {client:b.client, grantId:principal.id, role:principal.role, name:principal.context ? principal.name : safeString(b.name,40)||'Guest', color:/^#[0-9a-f]{6}$/i.test(b.color)?b.color:'#7560d5', cursor, selection:Array.isArray(b.selection)?b.selection.filter(validId).slice(0,100):[], time:Date.now()};
      if (b.text && validId(b.text.node) && JSON.stringify(b.text).length < 2000) payload.text = b.text;
      this.db.run('INSERT INTO presence(room_id,client,grant_id,session_id,payload,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(room_id,client) DO UPDATE SET grant_id=excluded.grant_id,session_id=excluded.session_id,payload=excluded.payload,updated_at=excluded.updated_at', id, b.client, principal.id, principal.context?.session.id || null, JSON.stringify(payload), payload.time); sendJSON(res, {ok:true}); return;
    }
    if (action === 'invites') {
      owner();
      if (method === 'GET') { sendJSON(res, {invites:this.db.all('SELECT id,role,label,created_at AS createdAt,expires_at AS expires,revoked FROM grants WHERE room_id=?', id)}); return; }
      if (method === 'POST') {
        if (row.org_id) { const settings = JSON.parse(this.db.get('SELECT settings FROM orgs WHERE id=?',row.org_id).settings); if (!settings.allowGuestInvites || settings.ssoProvider) throw fail(403, 'Guest invitations are disabled by organization policy'); }
        const b = await jsonBody(req,16000); if (!['editor','commenter','viewer'].includes(b.role)) throw fail(400, 'Choose editor, commenter, or viewer'); if (this.db.get('SELECT count(*) AS n FROM grants WHERE room_id=? AND revoked=0',id).n >=256) throw fail(409,'Invitation limit reached');
        const token = secret(), grantId = makeId(); this.db.transaction(() => { this.db.run('INSERT INTO grants(id,room_id,hash,role,label,expires_at,created_at) VALUES(?,?,?,?,?,?,?)', grantId,id,digest(token),b.role,safeString(b.label,80)||b.role,Date.now()+Math.min(365,Math.max(1,Number(b.days)||30))*86400000,Date.now()); this.db.audit(row.org_id,principal.id,'project.invited',id,{role:b.role,grantId}); }); sendJSON(res,{id:grantId,token,role:b.role},201); return;
      }
      if (method === 'DELETE') { const grant=this.db.get('SELECT role FROM grants WHERE id=? AND room_id=?',target,id); if (!grant||grant.role==='owner') throw fail(400,'Cannot revoke this invitation'); this.db.transaction(()=>{this.db.run('UPDATE grants SET revoked=1 WHERE id=? AND room_id=?',target,id);this.db.audit(row.org_id,principal.id,'project.invitation_revoked',id,{grantId:target});}); this.poll();sendJSON(res,{ok:true});return; }
    }
    if (action === 'members') {
      owner(); if (!principal.context) throw fail(403,'An account-owned project is required');
      if (method === 'GET') { sendJSON(res,{members:this.db.all('SELECT u.id,u.name,u.email,m.role FROM room_members m JOIN users u ON u.id=m.user_id WHERE m.room_id=?',id)});return; }
      if (method === 'PUT') { const b=await jsonBody(req,16000);if(!['editor','commenter','viewer'].includes(b.role))throw fail(400,'Invalid role');const user=this.db.get('SELECT id FROM users WHERE email=? AND verified=1',safeString(b.email,254).toLowerCase());if(!user)throw fail(404,'Verified account not found');if(row.org_id&&!this.db.get('SELECT 1 FROM members WHERE org_id=? AND user_id=?',row.org_id,user.id))throw fail(403,'Invite this person to the organization first');this.db.run('INSERT INTO room_members(room_id,user_id,role) VALUES(?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET role=excluded.role',id,user.id,b.role);this.db.audit(row.org_id,principal.id,'project.member_role',id,{user:user.id,role:b.role});sendJSON(res,{ok:true});return; }
      if (method === 'DELETE') {this.db.run('DELETE FROM room_members WHERE room_id=? AND user_id=?',id,target);this.db.audit(row.org_id,principal.id,'project.member_removed',id,{user:target});sendJSON(res,{ok:true});return;}
    }
    if (action === 'versions') {
      if (method==='GET') {if(target){const v=this.db.get('SELECT * FROM checkpoints WHERE room_id=? AND id=?',id,target);if(!v)throw fail(404,'Version not found');sendJSON(res,{id:v.id,name:v.name,createdAt:v.created_at,revision:v.revision,snapshot:this.db.unpack(v.snapshot)});}else sendJSON(res,{versions:this.db.all('SELECT id,name,created_at AS createdAt,revision,author FROM checkpoints WHERE room_id=? ORDER BY created_at DESC',id)});return;}
      if(method==='POST'){editor();const b=await jsonBody(req,16000),v=makeId(),name=safeString(b.name,100)||'Checkpoint',now=Date.now();this.db.transaction(()=>{const fresh=this.row(id),packed=this.db.pack(this.load(fresh).store.snapshot());this.db.run('INSERT INTO checkpoints(id,room_id,revision,name,snapshot,author,created_at) VALUES(?,?,?,?,?,?,?)',v,id,fresh.revision,name,packed,principal.id,now);this.db.run('DELETE FROM checkpoints WHERE room_id=? AND id NOT IN (SELECT id FROM checkpoints WHERE room_id=? ORDER BY created_at DESC LIMIT 20)',id,id);this.db.checkOrganizationQuota(row.org_id);this.db.audit(row.org_id,principal.id,'project.checkpoint',id,{checkpoint:v,name});});sendJSON(res,{id:v,name,createdAt:now},201);return;}
      if(method==='DELETE'){owner();this.db.run('DELETE FROM checkpoints WHERE id=? AND room_id=?',target,id);sendJSON(res,{ok:true});return;}
    }
    if(action==='archive'&&method==='POST'){owner();const b=await jsonBody(req,16000);this.db.transaction(()=>{this.db.run('UPDATE rooms SET archived_at=?,updated_at=? WHERE id=?',b.archived===false?null:Date.now(),Date.now(),id);this.db.audit(row.org_id,principal.id,b.archived===false?'project.restored':'project.archived',id);});this.poll();sendJSON(res,{ok:true});return;}
    if(action==='publish'){
      if(method==='GET'){sendJSON(res,{publications:this.db.all('SELECT id,title,enabled,expires_at AS expires,created_at AS createdAt FROM publications WHERE room_id=?',id)});return;}
      owner();if(row.org_id&&!JSON.parse(this.db.get('SELECT settings FROM orgs WHERE id=?',row.org_id).settings).allowPublicPrototypes)throw fail(403,'Public prototypes are disabled');
      if(method==='POST'){const b=await jsonBody(req,16000),publication=makeId();this.db.transaction(()=>{if(this.db.get('SELECT count(*) AS n FROM publications WHERE room_id=?',id).n>=100)throw fail(409,'Revoke an older publication before adding another');this.db.run('INSERT INTO publications(id,room_id,snapshot,title,expires_at,created_at) VALUES(?,?,?,?,?,?)',publication,id,this.db.pack(this.load(row).store.snapshot()),safeString(b.title,100)||row.name,Date.now()+Math.min(365,Math.max(1,Number(b.days)||30))*86400000,Date.now());this.db.checkOrganizationQuota(row.org_id);this.db.audit(row.org_id,principal.id,'prototype.published',id,{publication});});sendJSON(res,{id:publication,url:this.auth.origin+'/p/'+publication},201);return;}
      if(method==='DELETE'){this.db.run('UPDATE publications SET enabled=0 WHERE room_id=? AND id=?',id,target);this.db.audit(row.org_id,principal.id,'prototype.unpublished',id,{publication:target});sendJSON(res,{ok:true});return;}
    }
    if(action==='ai')return this.ai.route(req,res,row,principal,parts);
    throw fail(404,'Project endpoint not found');
  }
  close(){clearInterval(this.poller);for(const c of this.clients)c.res.end();}
}
