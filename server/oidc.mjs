import {createPublicKey, verify, createHash} from 'node:crypto';
import {secret, makeId, digest, fail, safeString, emailAddress, parseCookies, setCookie, equalSecret, jsonBody, sendJSON} from './security.mjs';

function endpoint(value, allowInsecure) {
  let url; try { url = new URL(value); } catch { throw fail(503, 'Identity provider returned an invalid endpoint'); }
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || allowInsecure && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw fail(503, 'Identity provider endpoints must use HTTPS');
  return url.href;
}
async function boundedJSON(response, limit = 1000000) {
  if (!response.ok) throw fail(502, 'Identity provider request failed');
  let size = 0; const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw fail(502, 'Identity provider response is too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(502, 'Identity provider returned invalid JSON'); }
}
export class OIDCService {
  constructor(auth, providers = [], {allowInsecureTest = false} = {}) {
    this.auth = auth; this.db = auth.db; this.allowInsecure = allowInsecureTest && !auth.production; this.cache = new Map(); this.keys = new Map();
    if (!Array.isArray(providers) || providers.length > 20) throw Error('OIDC_PROVIDERS must be an array with at most 20 entries');
    this.providers = providers.map(p => {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(p.id) || !p.clientId || typeof p.clientId !== 'string') throw Error('Each OIDC provider needs a unique id and clientId');
      const issuer = endpoint(p.issuer, this.allowInsecure).replace(/\/$/, '');
      return {...p, issuer, name: safeString(p.name, 60) || p.id, clientSecret: p.clientSecret || '', tokenAuth: p.tokenAuth || 'client_secret_basic'};
    });
    if (new Set(this.providers.map(p => p.id)).size !== this.providers.length) throw Error('OIDC provider ids must be unique');
    auth.oidc = this;
  }
  publicProviders() { return this.providers.map(({id, name}) => ({id, name})); }
  provider(id) { const p = this.providers.find(p => p.id === id); if (!p) throw fail(404, 'Unknown identity provider'); return p; }
  async discovery(p) {
    const cached = this.cache.get(p.id); if (cached && cached.until > Date.now()) return cached.value;
    const value = await boundedJSON(await fetch(p.issuer + '/.well-known/openid-configuration', {redirect: 'error', signal: AbortSignal.timeout(10000)}));
    if (value.issuer !== p.issuer) throw fail(502, 'Identity provider issuer does not match configuration');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) value[key] = endpoint(value[key], this.allowInsecure);
    if (value.response_types_supported && !value.response_types_supported.includes('code')) throw fail(503, 'Identity provider must support authorization code flow');
    if (value.code_challenge_methods_supported && !value.code_challenge_methods_supported.includes('S256')) throw fail(503, 'Identity provider must support S256 PKCE');
    this.cache.set(p.id, {value, until: Date.now() + 3600000}); return value;
  }
  async jwks(p, force = false) {
    const cached = this.keys.get(p.id); if (!force && cached && cached.until > Date.now()) return cached.value;
    const discovery = await this.discovery(p), value = await boundedJSON(await fetch(discovery.jwks_uri, {redirect: 'error', signal: AbortSignal.timeout(10000)}));
    if (!Array.isArray(value.keys) || value.keys.length > 100) throw fail(502, 'Identity provider signing keys are invalid');
    this.keys.set(p.id, {value: value.keys, until: Date.now() + 300000}); return value.keys;
  }
  async verifyToken(p, token, nonce, accessToken) {
    if (typeof token !== 'string' || token.length > 100000) throw fail(401, 'Invalid identity token');
    let header, claims; const parts = token.split('.');
    try { if (parts.length !== 3) throw Error(); header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw fail(401, 'Invalid identity token'); }
    if (!['RS256', 'ES256'].includes(header.alg) || header.crit || header.jku || header.jwk || header.x5u) throw fail(401, 'Unsupported identity token signing algorithm');
    let keys = await this.jwks(p), candidates = keys.filter(k => (!header.kid || k.kid === header.kid) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg) && (!k.key_ops || k.key_ops.includes('verify')) && (header.alg === 'RS256' ? k.kty === 'RSA' : k.kty === 'EC' && k.crv === 'P-256'));
    if (!candidates.length && header.kid) { keys = await this.jwks(p, true); candidates = keys.filter(k => k.kid === header.kid && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg) && (!k.key_ops || k.key_ops.includes('verify')) && (header.alg === 'RS256' ? k.kty === 'RSA' : k.kty === 'EC' && k.crv === 'P-256')); }
    if (candidates.length !== 1) throw fail(401, 'Identity token signing key is missing or ambiguous');
    const key = createPublicKey({key: candidates[0], format: 'jwk'});
    if (header.alg === 'RS256' && key.asymmetricKeyDetails?.modulusLength < 2048) throw fail(401, 'Identity provider uses an insecure signing key');
    if (!verify('sha256', Buffer.from(parts[0] + '.' + parts[1]), {key, ...(header.alg === 'ES256' ? {dsaEncoding: 'ieee-p1363'} : {})}, Buffer.from(parts[2], 'base64url'))) throw fail(401, 'Identity token signature is invalid');
    const now = Date.now() / 1000, audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== p.issuer || !audience.includes(p.clientId) || (audience.length > 1 || claims.azp !== undefined) && claims.azp !== p.clientId) throw fail(401, 'Identity token issuer or audience is invalid');
    if (!Number.isFinite(claims.exp) || claims.exp < now - 30 || !Number.isFinite(claims.iat) || claims.iat > now + 30 || now - claims.iat > 600 || claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 30)) throw fail(401, 'Identity token is expired or not yet valid');
    if (!equalSecret(claims.nonce, nonce) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.email_verified !== true) throw fail(401, 'Identity token must include a verified email and the correct nonce');
    if (claims.at_hash !== undefined && (!accessToken || !equalSecret(claims.at_hash, createHash('sha256').update(accessToken).digest().subarray(0, 16).toString('base64url')))) throw fail(401, 'Identity token access-token binding is invalid');
    claims.email = emailAddress(claims.email); return claims;
  }
  async route(req, res, url) {
    const [, , , , id, action] = url.pathname.split('/');
    const provider = this.provider(id), callback = `${this.auth.origin}/api/auth/oidc/${provider.id}/callback`, cookie = (this.auth.production ? '__Host-' : '') + 'mireva_oidc_' + provider.id;
    if (action === 'start' && ['GET', 'POST'].includes(req.method)) {
      let linkUser = null;
      if (req.method === 'POST') { const c = this.auth.require(req); this.auth.csrf(req, c); const b = await jsonBody(req, 10000); await this.auth.reauthenticate(c, b.password); linkUser = c.user.id; }
      this.auth.rate(req, 'oidc-start', 20); const discovery = await this.discovery(provider), verifier = secret(48), nonce = secret(), binding = secret();
      const state = this.auth.token('oidc', linkUser, {provider: provider.id, verifier, nonce, binding: digest(binding), linkUser}, 300000);
      setCookie(res, cookie, binding, {secure: this.auth.production, maxAge: 300});
      const target = new URL(discovery.authorization_endpoint);
      for (const [key, value] of Object.entries({client_id: provider.clientId, response_type: 'code', scope: 'openid email profile', redirect_uri: callback, state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(linkUser ? {prompt: 'login', max_age: '0'} : {})})) target.searchParams.set(key, value);
      if (req.method === 'POST') sendJSON(res, {url: target.href}); else { res.writeHead(303, {Location: target.href}); res.end(); } return;
    }
    if (action === 'callback' && req.method === 'GET') {
      const state = this.auth.findToken(url.searchParams.get('state'), 'oidc'), data = state.data;
      if (data.provider !== provider.id || !equalSecret(data.binding, digest(parseCookies(req)[cookie] || ''))) throw fail(401, 'Identity-provider browser session does not match');
      if (data.linkUser && this.auth.require(req).user.id !== data.linkUser) throw fail(403, 'Sign in to the account being linked');
      this.db.transaction(() => { if (!this.db.run('DELETE FROM tokens WHERE hash=?', state.hash).changes) throw fail(401, 'Sign-in request was already used'); });
      setCookie(res, cookie, '', {secure: this.auth.production, maxAge: 0});
      if (url.searchParams.has('error') || !url.searchParams.get('code')) throw fail(401, 'Identity-provider sign-in was declined');
      const discovery = await this.discovery(provider), params = new URLSearchParams({grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: callback, code_verifier: data.verifier, client_id: provider.clientId});
      const headers = {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'};
      if (provider.clientSecret) {
        if (provider.tokenAuth === 'client_secret_post') params.set('client_secret', provider.clientSecret);
        else headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(provider.clientId) + ':' + encodeURIComponent(provider.clientSecret)).toString('base64');
      }
      const tokens = await boundedJSON(await fetch(discovery.token_endpoint, {method: 'POST', headers, body: params, redirect: 'error', signal: AbortSignal.timeout(15000)}));
      const claims = await this.verifyToken(provider, tokens.id_token, data.nonce, tokens.access_token);
      this.db.transaction(() => {
        let identity = this.db.get('SELECT * FROM identities WHERE provider=? AND subject=?', provider.id, claims.sub), user;
        if (data.linkUser) {
          if (identity && identity.user_id !== data.linkUser) throw fail(409, 'This identity is already linked to another account');
          user = this.db.get('SELECT * FROM users WHERE id=?', data.linkUser);
        } else if (identity) user = this.db.get('SELECT * FROM users WHERE id=?', identity.user_id);
        else {
          if (this.db.get('SELECT id FROM users WHERE email=?', claims.email)) throw fail(409, 'An account with this email already exists. Sign in there, then link this provider from Account security.');
          if (!this.auth.allowRegistration) throw fail(403, 'Registration is disabled');
          const id = makeId(); this.db.run('INSERT INTO users(id,email,name,password,verified,created_at) VALUES(?,?,?,NULL,1,?)', id, claims.email, safeString(claims.name, 80) || claims.email.split('@')[0], Date.now()); user = this.db.get('SELECT * FROM users WHERE id=?', id);
        }
        if (!user || user.disabled) throw fail(403, 'Account is unavailable');
        if (!identity) this.db.run('INSERT INTO identities(provider,subject,user_id,email,created_at) VALUES(?,?,?,?,?)', provider.id, claims.sub, user.id, claims.email, Date.now());
        this.db.audit(null, user.id, data.linkUser ? 'account.identity_linked' : 'account.sso_sign_in', provider.id);
        if (!data.linkUser) this.auth.issueSession(req, res, user, 'oidc:' + provider.id);
      });
      res.writeHead(303, {Location: this.auth.origin + '/#account=' + (data.linkUser ? 'linked' : 'signed-in')}); res.end(); return;
    }
    if (action === 'unlink' && req.method === 'POST') {
      const context = this.auth.require(req); this.auth.csrf(req, context); const b = await jsonBody(req, 10000); await this.auth.reauthenticate(context, b.password);
      this.db.transaction(() => {
        const count = this.db.get('SELECT count(*) AS n FROM identities WHERE user_id=?', context.user.id).n;
        if (!context.user.password && count <= 1) throw fail(409, 'Keep at least one sign-in method');
        if (this.db.get("SELECT 1 FROM members m JOIN orgs o ON o.id=m.org_id WHERE m.user_id=? AND json_extract(o.settings,'$.ssoProvider')=? AND o.deleted=0", context.user.id, provider.id)) throw fail(409, 'An organization requires this identity provider');
        this.db.run('DELETE FROM identities WHERE user_id=? AND provider=?', context.user.id, provider.id); this.db.audit(null, context.user.id, 'account.identity_unlinked', provider.id);
      }); sendJSON(res, {ok: true}); return;
    }
    throw fail(404, 'Identity-provider endpoint not found');
  }
}
