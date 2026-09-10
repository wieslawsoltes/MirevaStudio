import {secret, makeId, digest, fail, safeString, emailAddress, jsonBody, sendJSON} from './security.mjs';
import {validateSnapshot} from '../src/core/schema.js';
const ROLES = ['owner', 'admin', 'member', 'viewer'];
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export class OrganizationService {
  constructor(db, auth, mail) { this.db = db; this.auth = auth; this.mail = mail; }
  access(req, id, roles = ROLES, {allowWrongSSO = false} = {}) {
    const context = this.auth.require(req), org = this.db.get('SELECT o.*,m.role FROM orgs o JOIN members m ON m.org_id=o.id WHERE o.id=? AND m.user_id=? AND o.deleted=0', id, context.user.id);
    if (!org) throw fail(404, 'Organization not found');
    if (!roles.includes(org.role)) throw fail(403, 'Your organization role does not allow this action');
    org.settings = JSON.parse(org.settings || '{}');
    if (!allowWrongSSO && org.settings.ssoProvider && context.session.method !== 'oidc:' + org.settings.ssoProvider) throw fail(403, 'This organization requires sign-in using ' + org.settings.ssoProvider, 'sso_required');
    return {context, org};
  }
  settings(input, previous = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Organization settings must be an object');
    const next = {...previous};
    for (const [key, value] of Object.entries(input)) {
      if (key === 'ssoProvider') { if (value && !this.auth.oidc.publicProviders().some(p => p.id === value)) throw fail(400, 'Configure this SSO provider on the server first'); next[key] = value || ''; }
      else if (['allowGuestInvites', 'allowPublicPrototypes', 'membersCanCreate'].includes(key)) next[key] = value === true;
      else if (key === 'defaultProjectRole') { if (!['editor', 'commenter', 'viewer'].includes(value)) throw fail(400, 'Invalid default project role'); next[key] = value; }
      else if (['memberLimit', 'projectLimit', 'storageMB', 'aiDailyRequests', 'auditRetentionDays'].includes(key)) {
        const limits = {memberLimit: [1, 10000], projectLimit: [1, 10000], storageMB: [10, 100000], aiDailyRequests: [0, 10000], auditRetentionDays: [30, 3650]}, [min, max] = limits[key];
        if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `Invalid ${key}`); next[key] = value;
      } else throw fail(400, 'Unknown organization setting: ' + key);
    }
    return next;
  }
  async route(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean), id = parts[2], action = parts[3], sub = parts[4], method = req.method;
    const context = this.auth.require(req); if (!['GET', 'HEAD'].includes(method)) this.auth.csrf(req, context);
    if (!id && method === 'GET') {
      const rows = this.db.all('SELECT o.id,o.name,o.slug,o.settings,o.created_at AS createdAt,m.role FROM orgs o JOIN members m ON m.org_id=o.id WHERE m.user_id=? AND o.deleted=0 ORDER BY o.name', context.user.id);
      sendJSON(res, {organizations: rows.map(o => ({...o, settings: JSON.parse(o.settings), requiresSSO: !!JSON.parse(o.settings).ssoProvider && context.session.method !== 'oidc:' + JSON.parse(o.settings).ssoProvider}))}); return;
    }
    if (!id && method === 'POST') {
      this.auth.rate(req, 'org-create', 10, 3600000); const b = await jsonBody(req, 16000), name = safeString(b.name, 100).trim(); if (!name) throw fail(400, 'Enter an organization name');
      const id = makeId(), slug = (safeString(b.slug, 60) || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '') + '-' + id.slice(0, 6);
      const settings = this.settings(b.settings || {}, {allowGuestInvites: true, allowPublicPrototypes: true, membersCanCreate: true, defaultProjectRole: 'editor', memberLimit: 200, projectLimit: 200, storageMB: 2000, aiDailyRequests: 100, auditRetentionDays: 365});
      if (settings.ssoProvider && context.session.method !== 'oidc:' + settings.ssoProvider) throw fail(403, 'Sign in using the required provider before enforcing SSO');
      this.db.transaction(() => { this.db.run('INSERT INTO orgs(id,name,slug,settings,created_at) VALUES(?,?,?,?,?)', id, name, slug, JSON.stringify(settings), Date.now()); this.db.run("INSERT INTO members(org_id,user_id,role,joined_at) VALUES(?,?,'owner',?)", id, context.user.id, Date.now()); this.db.audit(id, context.user.id, 'organization.created', id, {name}); });
      sendJSON(res, {id, name, slug, settings, role: 'owner'}, 201); return;
    }
    if (id === 'accept' && method === 'POST') {
      const b = await jsonBody(req, 16000); if (typeof b.token !== 'string' || b.token.length > 100) throw fail(400, 'Invalid invitation');
      const result = this.db.transaction(() => {
        const invite = this.db.get('SELECT * FROM org_invites WHERE hash=?', digest(b.token));
        if (!invite || invite.accepted_at || invite.expires_at < Date.now()) throw fail(400, 'Invitation is invalid, expired, or already used');
        if (invite.email !== context.user.email) throw fail(403, 'Sign in using the email address that received this invitation');
        const org = this.db.get('SELECT * FROM orgs WHERE id=? AND deleted=0', invite.org_id); if (!org) throw fail(404, 'Organization not found'); const settings = JSON.parse(org.settings);
        if (settings.ssoProvider && context.session.method !== 'oidc:' + settings.ssoProvider) throw fail(403, 'Sign in using the organization’s required SSO provider', 'sso_required');
        if (!this.db.get('SELECT 1 FROM members WHERE org_id=? AND user_id=?', org.id, context.user.id)) {
          if (this.db.get('SELECT count(*) AS n FROM members WHERE org_id=?', org.id).n >= (settings.memberLimit || 200)) throw fail(409, 'Organization member limit reached');
          this.db.run('INSERT INTO members(org_id,user_id,role,joined_at) VALUES(?,?,?,?)', org.id, context.user.id, invite.role, Date.now());
        }
        this.db.run('UPDATE org_invites SET accepted_at=? WHERE id=?', Date.now(), invite.id); this.db.audit(org.id, context.user.id, 'member.invitation_accepted', context.user.id, {role: invite.role}); return {id: org.id, name: org.name};
      }); sendJSON(res, result); return;
    }
    const {org} = this.access(req, id);
    const admin = () => { if (!['owner', 'admin'].includes(org.role)) throw fail(403, 'Organization administrator permission is required'); };
    const owner = () => { if (org.role !== 'owner') throw fail(403, 'Organization owner permission is required'); };
    if (!action && method === 'GET') {
      const storage = this.db.get('SELECT count(*) AS projects,coalesce(sum(storage_bytes),0) AS bytes FROM rooms WHERE org_id=?', id);
      sendJSON(res, {organization: org, usage: {...storage,bytes:this.db.organizationBytes(id), members: this.db.get('SELECT count(*) AS n FROM members WHERE org_id=?', id).n}, providers: this.auth.oidc.publicProviders()}); return;
    }
    if (!action && method === 'PATCH') {
      admin(); const b = await jsonBody(req, 16000), name = b.name === undefined ? org.name : safeString(b.name, 100).trim(); if (!name) throw fail(400, 'Enter an organization name');
      if (b.settings?.ssoProvider !== undefined) owner(); const settings = b.settings ? this.settings(b.settings, org.settings) : org.settings;
      if (settings.ssoProvider && context.session.method !== 'oidc:' + settings.ssoProvider) throw fail(403, 'Sign in using the required provider before enforcing SSO');
      this.db.transaction(() => { this.db.run('UPDATE orgs SET name=?,settings=? WHERE id=?', name, JSON.stringify(settings), id); this.db.audit(id, context.user.id, 'organization.updated', id, {name, settings}); }); sendJSON(res, {ok: true}); return;
    }
    if (!action && method === 'DELETE') {
      owner(); const b = await jsonBody(req, 16000); if (b.confirm !== org.name) throw fail(400, 'Enter the organization name to confirm deletion'); await this.auth.reauthenticate(context, b.password);
      this.db.transaction(() => { this.db.run('UPDATE orgs SET deleted=1 WHERE id=?', id); this.db.run('UPDATE rooms SET archived_at=? WHERE org_id=?', Date.now(), id); this.db.audit(id, context.user.id, 'organization.deleted', id); }); sendJSON(res, {ok: true}); return;
    }
    if (action === 'members') {
      if (method === 'GET') { sendJSON(res, {members: this.db.all('SELECT u.id,u.name,u.email,m.role,m.joined_at AS joinedAt FROM members m JOIN users u ON u.id=m.user_id WHERE m.org_id=? ORDER BY m.role,u.name', id)}); return; }
      admin(); const target = this.db.get('SELECT * FROM members WHERE org_id=? AND user_id=?', id, sub); if (!target) throw fail(404, 'Member not found');
      if (target.role === 'owner') owner();
      if (method === 'PATCH' || method === 'DELETE') {
        const b = method === 'PATCH' ? await jsonBody(req, 16000) : {}, role = method === 'DELETE' ? null : b.role;
        if (role && !ROLES.includes(role)) throw fail(400, 'Invalid member role'); if (role === 'owner') owner();
        this.db.transaction(() => {
          if (target.role === 'owner' && role !== 'owner' && this.db.get("SELECT count(*) AS n FROM members WHERE org_id=? AND role='owner'", id).n <= 1) throw fail(409, 'Keep at least one organization owner');
          if (method === 'DELETE') this.db.run('DELETE FROM members WHERE org_id=? AND user_id=?', id, sub); else this.db.run('UPDATE members SET role=? WHERE org_id=? AND user_id=?', role, id, sub);
          this.db.audit(id, context.user.id, method === 'DELETE' ? 'member.removed' : 'member.role_changed', sub, {role});
        }); sendJSON(res, {ok: true}); return;
      }
    }
    if (action === 'invites') {
      admin();
      if (method === 'GET') { sendJSON(res, {invites: this.db.all('SELECT id,email,role,expires_at AS expires,accepted_at AS accepted,created_at AS createdAt FROM org_invites WHERE org_id=? ORDER BY created_at DESC LIMIT 500', id)}); return; }
      if (method === 'DELETE') { this.db.transaction(() => { this.db.run('DELETE FROM org_invites WHERE id=? AND org_id=?', sub, id); this.db.audit(id, context.user.id, 'member.invitation_revoked', sub); }); sendJSON(res, {ok: true}); return; }
      if (method === 'POST') {
        const b = await jsonBody(req, 16000), email = emailAddress(b.email), role = b.role || 'member'; if (!ROLES.includes(role)) throw fail(400, 'Invalid invitation role'); if (role === 'owner') owner();
        const token = secret(), invite = makeId(), expires = Date.now() + Math.min(30, Math.max(1, Number(b.days) || 7)) * 86400000;
        this.db.transaction(() => {
          if (this.db.get('SELECT count(*) AS n FROM org_invites WHERE org_id=? AND accepted_at IS NULL AND expires_at>?', id, Date.now()).n >= 1000) throw fail(429, 'Invitation limit reached');
          this.db.run('DELETE FROM org_invites WHERE org_id=? AND email=? AND accepted_at IS NULL', id, email);
          this.db.run('INSERT INTO org_invites(id,hash,org_id,email,role,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', invite, digest(token), id, email, role, expires, context.user.id, Date.now());
          const link = this.auth.origin + '/#org-invite=' + token;
          this.mail.enqueue(email, 'Invitation to ' + org.name + ' on Mireva Studio', `You have been invited to ${org.name} as ${role}. Sign in with ${email} and open ${link}`, `<p>You have been invited to <strong>${escape(org.name)}</strong> as ${escape(role)}.</p><p><a href="${escape(link)}">Accept invitation</a></p>`);
          this.db.audit(id, context.user.id, 'member.invited', invite, {email, role});
        }); sendJSON(res, {id: invite, email, role, expires, token}, 201); return;
      }
    }
    if (action === 'projects' && method === 'GET') {
      const archived = url.searchParams.get('archived') === 'true';
      sendJSON(res, {projects: this.db.all(`SELECT r.id,r.name,r.revision,r.created_at AS createdAt,r.updated_at AS updatedAt,r.archived_at AS archivedAt,r.storage_bytes AS storageBytes,r.record_count AS records,r.owner_id AS ownerId FROM rooms r WHERE r.org_id=? AND r.archived_at IS ${archived ? 'NOT ' : ''}NULL ORDER BY r.updated_at DESC LIMIT 1000`, id)}); return;
    }
    if (action === 'library') {
      if (method === 'GET') {
        if (sub) { const item = this.db.get('SELECT * FROM libraries WHERE id=? AND org_id=?', sub, id); if (!item) throw fail(404, 'Library item not found'); sendJSON(res, {...item, payload: this.db.unpack(item.payload)}); }
        else sendJSON(res, {items: this.db.all('SELECT id,name,kind,revision,created_by AS createdBy,updated_at AS updatedAt FROM libraries WHERE org_id=? ORDER BY name LIMIT 1000', id)}); return;
      }
      if (org.role === 'viewer') throw fail(403, 'Editing permission required');
      if (method === 'DELETE') { admin(); this.db.transaction(() => { this.db.run('DELETE FROM libraries WHERE id=? AND org_id=?', sub, id); this.db.audit(id, context.user.id, 'library.deleted', sub); }); sendJSON(res, {ok: true}); return; }
      if (['POST', 'PUT'].includes(method)) {
        const b = await jsonBody(req, 12000000), name = safeString(b.name, 100).trim(), kind = b.kind || 'components'; if (!name || !['components', 'template', 'palette'].includes(kind)) throw fail(400, 'Enter a name and a supported library kind');
        if (kind === 'palette') { if (!Array.isArray(b.payload) || b.payload.length > 100 || b.payload.some(c => !/^#[a-f0-9]{6}$/i.test(c))) throw fail(400, 'Palette must contain up to 100 hex colors'); } else validateSnapshot(b.payload);
        const itemId = sub || makeId(), payload = this.db.pack(b.payload);
        const revision = this.db.transaction(() => {
          const existing = this.db.get('SELECT * FROM libraries WHERE id=? AND org_id=?', itemId, id);
          if (sub && !existing) throw fail(404, 'Library item not found'); if (existing && b.revision !== existing.revision) throw fail(409, 'Library changed; reload before publishing');
          const revision = (existing?.revision || 0) + 1;
          this.db.run('INSERT INTO libraries(id,org_id,name,kind,payload,revision,created_by,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,payload=excluded.payload,revision=excluded.revision,updated_at=excluded.updated_at', itemId, id, name, kind, payload, revision, context.user.id, Date.now()); this.db.checkOrganizationQuota(id);this.db.audit(id, context.user.id, 'library.published', itemId, {revision, name, kind}); return revision;
        }); sendJSON(res, {id: itemId, revision}, sub ? 200 : 201); return;
      }
    }
    if (action === 'audit' && method === 'GET') {
      admin(); const after = Math.max(0, Number(url.searchParams.get('after')) || 0), limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const entries = this.db.all('SELECT * FROM audit WHERE org_id=? AND seq>? ORDER BY seq LIMIT ?', id, after, limit).map(row => ({...row, payload: JSON.parse(row.payload)}));
      sendJSON(res, {entries, integrity: this.db.verifyAudit(id), next: entries.at(-1)?.seq || after}); return;
    }
    if (action === 'audit' && method === 'DELETE') {
      owner(); const days = org.settings.auditRetentionDays || 365, removed = this.db.retainAudit(id, Date.now() - days * 86400000); this.db.audit(id, context.user.id, 'audit.retention_applied', id, {days, removed}); sendJSON(res, {removed}); return;
    }
    throw fail(404, 'Organization endpoint not found');
  }
}
