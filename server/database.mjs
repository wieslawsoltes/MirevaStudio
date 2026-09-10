import {DatabaseSync, backup as sqliteBackup} from 'node:sqlite';
import {gzipSync, gunzipSync} from 'node:zlib';
import {chmodSync, existsSync} from 'node:fs';
import path from 'node:path';
import {digest,fail} from './security.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT, verified INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login INTEGER, mfa_secret BLOB, mfa_pending BLOB, mfa_last_step INTEGER NOT NULL DEFAULT -1, mfa_recovery TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, email TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(provider,subject));
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, method TEXT NOT NULL, mfa INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, authenticated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, agent TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT, data BLOB, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tokens_expiry ON tokens(expires_at);
CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, settings TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS members (org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')), joined_at INTEGER NOT NULL, PRIMARY KEY(org_id,user_id));
CREATE INDEX IF NOT EXISTS memberships_user ON members(user_id);
CREATE TABLE IF NOT EXISTS org_invites (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, org_id TEXT REFERENCES orgs(id), owner_id TEXT REFERENCES users(id), name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER, revision INTEGER NOT NULL DEFAULT 0, base_revision INTEGER NOT NULL DEFAULT 0, snapshot BLOB NOT NULL, storage_bytes INTEGER NOT NULL, record_count INTEGER NOT NULL, epoch INTEGER NOT NULL DEFAULT 1, settings TEXT NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS rooms_org ON rooms(org_id,archived_at,updated_at);
CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, hash TEXT UNIQUE NOT NULL, role TEXT NOT NULL, label TEXT NOT NULL, email TEXT, expires_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS grants_room ON grants(room_id);
CREATE TABLE IF NOT EXISTS room_members (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, PRIMARY KEY(room_id,user_id));
CREATE TABLE IF NOT EXISTS room_ops (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, revision INTEGER NOT NULL, batch_id TEXT NOT NULL, actor TEXT NOT NULL, ops BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(room_id,revision), UNIQUE(room_id,batch_id));
CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, revision INTEGER NOT NULL, name TEXT NOT NULL, snapshot BLOB NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checkpoints_room ON checkpoints(room_id,created_at);
CREATE TABLE IF NOT EXISTS presence (room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, client TEXT NOT NULL, grant_id TEXT NOT NULL, session_id TEXT, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(room_id,client));
CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_org ON audit(org_id,seq);
CREATE TABLE IF NOT EXISTS audit_anchors (org_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, hash TEXT NOT NULL, retained_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS libraries (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL, payload BLOB NOT NULL, revision INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, snapshot BLOB NOT NULL, title TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, expires_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mail_jobs (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, payload BLOB NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, leased_until INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS integrations (org_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, config BLOB NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(org_id,kind,id));
CREATE TABLE IF NOT EXISTS ai_jobs (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE, user_id TEXT NOT NULL, status TEXT NOT NULL, provider TEXT NOT NULL, prompt_hash TEXT NOT NULL, response BLOB, error TEXT, usage TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ai_jobs_room ON ai_jobs(room_id,created_at);
CREATE TABLE IF NOT EXISTS usage (org_id TEXT NOT NULL, period TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(org_id,period));
CREATE TABLE IF NOT EXISTS rates (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
INSERT OR IGNORE INTO meta(key,value) VALUES ('schema_version','2');
`;
export class Database {
  constructor(filename, vault) {
    this.filename = filename; this.vault = vault; this.statements = new Map(); this.depth = 0;
    this.sql = new DatabaseSync(filename, {enableForeignKeyConstraints: true});
    this.sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
    this.sql.exec(SCHEMA);
    for (const name of [filename, filename + '-wal', filename + '-shm']) if (existsSync(name)) chmodSync(name, 0o600);
  }
  statement(sql) { if (!this.statements.has(sql)) { if (this.statements.size > 256) this.statements.clear(); this.statements.set(sql, this.sql.prepare(sql)); } return this.statements.get(sql); }
  get(sql, ...params) { return this.statement(sql).get(...params); }
  all(sql, ...params) { return this.statement(sql).all(...params); }
  run(sql, ...params) { return this.statement(sql).run(...params); }
  transaction(fn) {
    if (this.depth) return fn();
    this.sql.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); if (result && typeof result.then === 'function') throw Error('Database transactions must not await network or filesystem work'); this.sql.exec('COMMIT'); return result; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  pack(value) { const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>100000000)throw fail(413,'Expanded document exceeds 100 MB');return this.vault.seal(gzipSync(bytes), 'document'); }
  unpack(value) { return JSON.parse(gunzipSync(this.vault.open(value, 'document'), {maxOutputLength: 100_000_000}).toString()); }
  organizationBytes(id){
    return this.get(`SELECT
    (SELECT coalesce(sum(length(snapshot)),0) FROM rooms WHERE org_id=?)+
    (SELECT coalesce(sum(length(ops)),0) FROM room_ops WHERE room_id IN (SELECT id FROM rooms WHERE org_id=?))+
    (SELECT coalesce(sum(length(snapshot)),0) FROM checkpoints WHERE room_id IN (SELECT id FROM rooms WHERE org_id=?))+
    (SELECT coalesce(sum(length(snapshot)),0) FROM publications WHERE room_id IN (SELECT id FROM rooms WHERE org_id=?))+
    (SELECT coalesce(sum(length(payload)),0) FROM libraries WHERE org_id=?)+
    (SELECT coalesce(sum(length(response)),0) FROM ai_jobs WHERE room_id IN (SELECT id FROM rooms WHERE org_id=?)) AS n`,id,id,id,id,id,id).n;
  }
  checkOrganizationQuota(id,extra=0){if(!id)return;const org=this.get('SELECT settings FROM orgs WHERE id=?',id);if(!org)throw fail(404,'Organization not found');if(this.organizationBytes(id)+extra>JSON.parse(org.settings).storageMB*1000000)throw fail(413,'Organization storage quota reached');}
  audit(orgId, actor, action, target = '', payload = {}) {
    const org = orgId || 'system', at = Date.now(), body = JSON.stringify(payload);
    return this.transaction(() => {
      const previous = this.get('SELECT hash FROM audit WHERE org_id=? ORDER BY seq DESC LIMIT 1', org)?.hash || this.get('SELECT hash FROM audit_anchors WHERE org_id=?', org)?.hash || '';
      const hash = digest(JSON.stringify([org, actor || '', action, target, body, at, previous]));
      this.run('INSERT INTO audit(org_id,actor,action,target,payload,at,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?)', org, actor || '', action, target, body, at, previous, hash);
      return hash;
    });
  }
  verifyAudit(orgId) {
    const org = orgId || 'system'; let previous = this.get('SELECT hash FROM audit_anchors WHERE org_id=?', org)?.hash || '', count = 0;
    for (const row of this.all('SELECT * FROM audit WHERE org_id=? ORDER BY seq', org)) {
      const expected = digest(JSON.stringify([row.org_id, row.actor, row.action, row.target, row.payload, row.at, previous]));
      if (row.prev_hash !== previous || row.hash !== expected) return {valid: false, brokenAt: row.seq, count};
      previous = row.hash; count++;
    }
    return {valid: true, count, head: previous};
  }
  retainAudit(orgId, before) {
    return this.transaction(() => {
      const last = this.get('SELECT seq,hash FROM audit WHERE org_id=? AND at<? ORDER BY seq DESC LIMIT 1', orgId, before);
      if (!last) return 0;
      this.run('INSERT INTO audit_anchors(org_id,seq,hash,retained_at) VALUES(?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET seq=excluded.seq,hash=excluded.hash,retained_at=excluded.retained_at', orgId, last.seq, last.hash, Date.now());
      return this.run('DELETE FROM audit WHERE org_id=? AND seq<=?', orgId, last.seq).changes;
    });
  }
  rate(key, cap, windowMs = 60000) {
    const now = Date.now();
    return this.transaction(() => {
      const row = this.get('SELECT start,count FROM rates WHERE key=?', key);
      if (!row || now - row.start >= windowMs) { this.run('INSERT INTO rates(key,start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET start=excluded.start,count=1', key, now); return true; }
      if (row.count >= cap) return false;
      this.run('UPDATE rates SET count=count+1 WHERE key=?', key); return true;
    });
  }
  async backup(filename) { if(existsSync(filename))throw Error('Backup destination already exists');await sqliteBackup(this.sql, filename);chmodSync(filename,0o600);const copy=new DatabaseSync(filename,{readOnly:true});try{const integrity=copy.prepare('PRAGMA integrity_check').get().integrity_check;if(integrity!=='ok')throw Error('Backup integrity check failed');return{file:path.basename(filename),integrity};}finally{copy.close();} }
  prune() { const now = Date.now(); this.transaction(() => { this.run('DELETE FROM sessions WHERE expires_at<?', now); this.run('DELETE FROM tokens WHERE expires_at<?', now); this.run('DELETE FROM rates WHERE start<?', now - 86400000); this.run('DELETE FROM presence WHERE updated_at<?', now - 30000); }); }
  close() { this.sql.close(); }
}
