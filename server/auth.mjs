import {randomBytes} from 'node:crypto';
import {secret, makeId, digest, fail, safeString, emailAddress, hashPassword, verifyPassword, parseCookies, setCookie, equalSecret, jsonBody, sendJSON, base32, verifyTotp} from './security.mjs';
const DAY = 86400000;
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export class AuthService {
  constructor(db, mail, {origin, production = false, allowRegistration = true, passwordN = 131072, sessionHours = 24} = {}) {
    this.db = db; this.mail = mail; this.origin = origin; this.production = production; this.allowRegistration = allowRegistration; this.passwordN = passwordN;
    this.sessionMs = Math.min(168, Math.max(1, sessionHours)) * 3600000;
    this.cookie = production ? '__Host-mireva_session' : 'mireva_session';
  }
  publicUser(user) { return {id: user.id, email: user.email, name: user.name, verified: !!user.verified, mfaEnabled: !!user.mfa_secret, createdAt: user.created_at}; }
  context(req) {
    if (req.authContext !== undefined) return req.authContext;
    const token = parseCookies(req)[this.cookie]; if (!token) return req.authContext = null;
    const session = this.db.get('SELECT * FROM sessions WHERE hash=?', digest(token));
    if (!session || session.expires_at <= Date.now() || Date.now() - session.last_seen > 12 * 3600000) return req.authContext = null;
    const user = this.db.get('SELECT * FROM users WHERE id=?', session.user_id);
    if (!user || user.disabled || !user.verified) return req.authContext = null;
    if (Date.now() - session.last_seen > 60000) this.db.run('UPDATE sessions SET last_seen=? WHERE hash=?', Date.now(), session.hash);
    return req.authContext = {token, session, user, csrf: this.db.vault.csrf(token)};
  }
  require(req, {pending = false} = {}) { const context = this.context(req); if (!context || !pending && !context.session.mfa) throw fail(401, 'Sign in with a verified account', 'sign_in_required'); return context; }
  csrf(req, context = this.require(req)) { if (!equalSecret(req.headers['x-csrf-token'], context.csrf)) throw fail(403, 'Session verification failed. Refresh the page and try again.', 'csrf'); }
  rate(req, key, cap = 10, interval = 60000) {
    const address = req.socket.remoteAddress || '';
    if (!this.db.rate('auth:' + key + ':' + digest(address).slice(0, 24), cap, interval)) throw fail(429, 'Too many attempts; try again later');
  }
  issueSession(req, res, user, method = 'password', mfa = !user.mfa_secret) {
    const token = secret(), now = Date.now(), id = makeId();
    this.db.run('INSERT INTO sessions(hash,id,user_id,method,mfa,created_at,authenticated_at,expires_at,last_seen,agent) VALUES(?,?,?,?,?,?,?,?,?,?)', digest(token), id, user.id, method, mfa ? 1 : 0, now, now, now + (mfa ? this.sessionMs : 300000), now, safeString(req.headers['user-agent'], 200));
    this.db.run('UPDATE users SET last_login=? WHERE id=?', now, user.id);
    setCookie(res, this.cookie, token, {secure: this.production, maxAge: Math.floor((mfa ? this.sessionMs : 300000) / 1000)});
    req.authContext = undefined;
    return {user: mfa ? this.publicUser(user) : null, needsMfa: !mfa, csrf: this.db.vault.csrf(token), sessionId: id};
  }
  token(kind, userId, data = {}, ttl = 3600000) {
    const token = secret(); this.db.run('INSERT INTO tokens(hash,kind,user_id,data,created_at,expires_at) VALUES(?,?,?,?,?,?)', digest(token), kind, userId, this.db.vault.seal(data, 'token'), Date.now(), Date.now() + ttl); return token;
  }
  findToken(token, kind) { if (typeof token !== 'string' || token.length > 100) throw fail(400, 'This link is invalid or expired'); const row = this.db.get('SELECT * FROM tokens WHERE hash=? AND kind=?', digest(token), kind); if (!row || row.expires_at < Date.now()) throw fail(400, 'This link is invalid or expired'); return {...row, data: row.data ? JSON.parse(this.db.vault.open(row.data, 'token').toString()) : {}}; }
  emailLink(user, kind) {
    this.db.run('DELETE FROM tokens WHERE kind=? AND user_id=?', kind, user.id);
    const token = this.token(kind, user.id, {}, kind === 'verify' ? DAY : 3600000);
    const link = kind === 'verify' ? `${this.origin}/api/auth/verify?token=${token}` : `${this.origin}/#reset=${token}`;
    const title = kind === 'verify' ? 'Verify your Mireva Studio account' : 'Reset your Mireva Studio password';
    this.mail.enqueue(user.email, title, `${title}\n\n${link}\n\nThis single-use link expires ${kind === 'verify' ? 'in 24 hours' : 'in one hour'}. Ignore it unless you requested it.`, `<h2>${escape(title)}</h2><p><a href="${escape(link)}">${kind === 'verify' ? 'Verify email address' : 'Reset password'}</a></p><p>Ignore this email unless you requested it.</p>`);
  }
  async reauthenticate(context, password) {
    if (context.user.password) { if (!await verifyPassword(password, context.user.password)) throw fail(403, 'Confirm your current password'); }
    else if (!context.session.method.startsWith('oidc:') || Date.now() - context.session.authenticated_at > 600000) throw fail(403, 'Sign in again with your identity provider before changing security settings');
  }
  secondFactor(userId, code) {
    return this.db.transaction(() => {
      const user = this.db.get('SELECT * FROM users WHERE id=?', userId); if (!user?.mfa_secret) return false;
      const value = safeString(code, 100).trim().toUpperCase(), recovery = JSON.parse(user.mfa_recovery || '[]'), hash = digest(value);
      if (recovery.includes(hash)) { this.db.run('UPDATE users SET mfa_recovery=? WHERE id=?', JSON.stringify(recovery.filter(item => item !== hash)), userId); return true; }
      const key = this.db.vault.open(user.mfa_secret, 'mfa').toString(), step = verifyTotp(key, value, user.mfa_last_step);
      if (step === null) return false;
      this.db.run('UPDATE users SET mfa_last_step=? WHERE id=?', step, userId); return true;
    });
  }
  async route(req, res, url) {
    const route = url.pathname.replace(/^\/api\/auth\/?/, ''), method = req.method;
    if (route.startsWith('oidc/')) return this.oidc.route(req, res, url);
    if (route === 'me' && method === 'GET') {
      const context = this.context(req), complete = context?.session.mfa;
      sendJSON(res, {user: complete ? this.publicUser(context.user) : null, needsMfa: !!context && !complete, csrf: context?.csrf || '', session: complete ? {id: context.session.id, method: context.session.method, authenticatedAt: context.session.authenticated_at} : null, providers: this.oidc?.publicProviders() || [], registration: this.allowRegistration, developmentMail: this.mail.mode === 'development-file'}); return;
    }
    if (route === 'register' && method === 'POST') {
      if (!this.allowRegistration) throw fail(403, 'Registration is disabled on this server'); this.rate(req, 'register', 8, 3600000);
      const b = await jsonBody(req, 10000), email = emailAddress(b.email), name = safeString(b.name, 80).trim(); if (!name) throw fail(400, 'Enter your display name');
      const password = await hashPassword(b.password, {N: this.passwordN, r: 8, p: 1});
      this.db.transaction(() => {
        if (this.db.get('SELECT id FROM users WHERE email=?', email)) return;
        const user = {id: makeId(), email, name, password, created_at: Date.now()};
        this.db.run('INSERT INTO users(id,email,name,password,created_at) VALUES(?,?,?,?,?)', user.id, email, name, password, user.created_at); this.emailLink(user, 'verify'); this.db.audit(null, user.id, 'account.register', user.id);
      });
      sendJSON(res, {message: 'Check your email for a verification link. Existing accounts can sign in or request a password reset.'}, 202); return;
    }
    if (route === 'verify' && ['POST', 'GET'].includes(method)) {
      const token = method === 'POST' ? (await jsonBody(req, 10000)).token : url.searchParams.get('token');
      this.db.transaction(() => { const record = this.findToken(token, 'verify'); this.db.run('UPDATE users SET verified=1 WHERE id=?', record.user_id); this.db.run('DELETE FROM tokens WHERE hash=?', record.hash); this.db.audit(null, record.user_id, 'account.email_verified', record.user_id); });
      if (method === 'GET') { res.writeHead(303, {Location: this.origin + '/#account=verified'}); res.end(); } else sendJSON(res, {ok: true}); return;
    }
    if (route === 'verification/resend' && method === 'POST') {
      this.rate(req, 'resend', 5, 3600000); const b = await jsonBody(req, 10000), email = emailAddress(b.email), user = this.db.get('SELECT * FROM users WHERE email=?', email);
      if (user && !user.verified) this.db.transaction(() => this.emailLink(user, 'verify')); sendJSON(res, {message: 'A verification email will be sent when applicable.'}, 202); return;
    }
    if (route === 'login' && method === 'POST') {
      this.rate(req, 'login', 20); const b = await jsonBody(req, 10000), email = emailAddress(b.email);
      if (!this.db.rate('login:' + digest(email), 10, 60000)) throw fail(429, 'Too many sign-in attempts; try again later');
      const user = this.db.get('SELECT * FROM users WHERE email=?', email), valid = await verifyPassword(b.password, user?.password);
      if (!valid || !user || user.disabled) throw fail(401, 'Email or password is incorrect');
      if (!user.verified) throw fail(403, 'Verify your email address before signing in', 'email_unverified');
      const result = this.db.transaction(() => { this.db.audit(null, user.id, 'account.sign_in', user.id); return this.issueSession(req, res, user); }); sendJSON(res, result); return;
    }
    if (route === 'password/reset/request' && method === 'POST') {
      this.rate(req, 'reset', 5, 3600000); const b = await jsonBody(req, 10000), user = this.db.get('SELECT * FROM users WHERE email=?', emailAddress(b.email));
      if (user?.verified && !user.disabled) this.db.transaction(() => this.emailLink(user, 'reset'));
      sendJSON(res, {message: 'Check your email for password-reset instructions.'}, 202); return;
    }
    if (route === 'password/reset' && method === 'POST') {
      this.rate(req, 'reset-consume', 12); const b = await jsonBody(req, 10000); this.findToken(b.token, 'reset');
      const password = await hashPassword(b.password, {N: this.passwordN, r: 8, p: 1});
      this.db.transaction(() => { const row = this.findToken(b.token, 'reset'); this.db.run('UPDATE users SET password=? WHERE id=?', password, row.user_id); this.db.run("DELETE FROM tokens WHERE user_id=? AND kind='reset'", row.user_id); this.db.run('DELETE FROM sessions WHERE user_id=?', row.user_id); this.db.audit(null, row.user_id, 'account.password_reset', row.user_id); });
      sendJSON(res, {ok: true, message: 'Password changed. Sign in again; authenticator protection remains enabled.'}); return;
    }
    if (route === 'mfa/verify' && method === 'POST') {
      const context = this.require(req, {pending: true}); this.csrf(req, context); this.rate(req, 'mfa', 8);
      if (context.session.mfa) throw fail(409, 'This session is already verified'); const b = await jsonBody(req, 5000);
      if (!this.secondFactor(context.user.id, b.code)) throw fail(401, 'Authenticator or recovery code is invalid or already used');
      const result = this.db.transaction(() => { this.db.run('DELETE FROM sessions WHERE hash=?', context.session.hash); return this.issueSession(req, res, context.user, context.session.method, true); }); sendJSON(res, result); return;
    }
    const context = this.require(req), {user, session} = context;
    if (!['GET', 'HEAD'].includes(method)) this.csrf(req, context);
    if (route === 'logout' && method === 'POST') { this.db.run('DELETE FROM sessions WHERE hash=?', session.hash); setCookie(res, this.cookie, '', {secure: this.production, maxAge: 0}); sendJSON(res, {ok: true}); return; }
    if (route === 'logout-all' && method === 'POST') { this.db.run('DELETE FROM sessions WHERE user_id=?', user.id); setCookie(res, this.cookie, '', {secure: this.production, maxAge: 0}); this.db.audit(null, user.id, 'account.sessions_revoked', user.id); sendJSON(res, {ok: true}); return; }
    if (route === 'profile' && method === 'PATCH') { const b = await jsonBody(req, 10000), name = safeString(b.name, 80).trim(); if (!name) throw fail(400, 'Enter a display name'); this.db.run('UPDATE users SET name=? WHERE id=?', name, user.id); sendJSON(res, {user: this.publicUser({...user, name})}); return; }
    if (route === 'sessions' && method === 'GET') { sendJSON(res, {sessions: this.db.all('SELECT id,method,mfa,created_at,authenticated_at,expires_at,last_seen,agent FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC', user.id, Date.now()).map(row => ({...row, current: row.id === session.id}))}); return; }
    if (route.startsWith('sessions/') && method === 'DELETE') { this.db.run('DELETE FROM sessions WHERE id=? AND user_id=?', route.split('/')[1], user.id); sendJSON(res, {ok: true}); return; }
    if (route === 'password/change' && method === 'POST') {
      this.rate(req, 'password-change', 8); const b = await jsonBody(req, 10000); await this.reauthenticate(context, b.currentPassword);
      const password = await hashPassword(b.password, {N: this.passwordN, r: 8, p: 1});
      const result = this.db.transaction(() => { this.db.run('UPDATE users SET password=? WHERE id=?', password, user.id); this.db.run('DELETE FROM sessions WHERE user_id=?', user.id); this.db.audit(null, user.id, 'account.password_changed', user.id); return this.issueSession(req, res, user, session.method, true); }); sendJSON(res, result); return;
    }
    if (route === 'mfa/enroll' && method === 'POST') {
      const b = await jsonBody(req, 10000); await this.reauthenticate(context, b.password); if (user.mfa_secret) throw fail(409, 'An authenticator is already enabled');
      const key = base32(randomBytes(20)); this.db.run('UPDATE users SET mfa_pending=? WHERE id=?', this.db.vault.seal({key, expires: Date.now() + 600000}, 'mfa-pending'), user.id);
      sendJSON(res, {secret: key, uri: `otpauth://totp/Mireva%20Studio:${encodeURIComponent(user.email)}?secret=${key}&issuer=Mireva%20Studio&algorithm=SHA1&digits=6&period=30`}); return;
    }
    if (route === 'mfa/confirm' && method === 'POST') {
      this.rate(req, 'mfa-confirm', 8); const b = await jsonBody(req, 5000), pending = user.mfa_pending && JSON.parse(this.db.vault.open(user.mfa_pending, 'mfa-pending').toString());
      if (!pending || pending.expires < Date.now()) throw fail(400, 'Start authenticator setup again');
      const step = verifyTotp(pending.key, b.code); if (step === null) throw fail(400, 'Authenticator code is invalid');
      const recoveryCodes = Array.from({length: 8}, () => randomBytes(10).toString('hex').toUpperCase().match(/.{1,5}/g).join('-'));
      this.db.transaction(() => { this.db.run('UPDATE users SET mfa_secret=?,mfa_pending=NULL,mfa_last_step=?,mfa_recovery=? WHERE id=?', this.db.vault.seal(pending.key, 'mfa'), step, JSON.stringify(recoveryCodes.map(digest)), user.id); this.db.run('DELETE FROM sessions WHERE user_id=? AND id<>?', user.id, session.id); this.db.audit(null, user.id, 'account.mfa_enabled', user.id); });
      sendJSON(res, {ok: true, recoveryCodes}); return;
    }
    if (route === 'mfa/disable' && method === 'POST') {
      this.rate(req, 'mfa-disable', 8); const b = await jsonBody(req, 10000); await this.reauthenticate(context, b.password); if (!this.secondFactor(user.id, b.code)) throw fail(401, 'Enter an unused authenticator or recovery code');
      this.db.transaction(() => { this.db.run("UPDATE users SET mfa_secret=NULL,mfa_pending=NULL,mfa_recovery='[]',mfa_last_step=-1 WHERE id=?", user.id); this.db.audit(null, user.id, 'account.mfa_disabled', user.id); }); sendJSON(res, {ok: true}); return;
    }
    if (route === 'identities' && method === 'GET') { sendJSON(res, {identities: this.db.all('SELECT provider,email,created_at FROM identities WHERE user_id=?', user.id)}); return; }
    throw fail(404, 'Account endpoint not found');
  }
}
