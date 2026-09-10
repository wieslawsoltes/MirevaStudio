import {randomBytes, createHash, createHmac, timingSafeEqual, scrypt as scryptCallback, createCipheriv, createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
import {readFile, writeFile, mkdir, open, link, unlink} from 'node:fs/promises';
import path from 'node:path';
const scrypt = promisify(scryptCallback);
export const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const makeId = () => randomBytes(12).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const fail = (status, message, code) => Object.assign(Error(message), {status, code});
export const safeString = (value, max = 100) => typeof value === 'string' ? value.slice(0, max) : '';
export function equalSecret(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export function emailAddress(value) {
  if(typeof value!=='string'||value.length>320)throw fail(400,'Enter a valid email address');const email = value.trim().toLowerCase();
  if (!/^[^\s<>@\u0000-\u001f]+@[^\s<>@\u0000-\u001f]+\.[^\s<>@\u0000-\u001f]+$/.test(email) || email.length > 254) throw fail(400, 'Enter a valid email address');
  return email;
}
export function requirePassword(value) {
  if (typeof value !== 'string' || [...value].length < 12 || value.length > 1024) throw fail(400, 'Use a password with 12–1,024 characters');
  if (['passwordpassword', '123456789012', 'qwertyuiop123', 'letmeinletmein'].includes(value.toLowerCase())) throw fail(400, 'Choose a less common password');
  return value;
}
let activeHashes = 0;
export async function hashPassword(password, {N = 131072, r = 8, p = 1} = {}) {
  requirePassword(password);
  if (activeHashes >= 3) throw fail(429, 'Authentication capacity is busy; retry shortly');
  activeHashes++;
  try {
    const salt = randomBytes(16), derived = await scrypt(password, salt, 32, {N, r, p, maxmem: 256 * 1024 * 1024});
    return ['scrypt', N, r, p, salt.toString('base64url'), derived.toString('base64url')].join('$');
  } finally { activeHashes--; }
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 1024) return false;
  if (activeHashes >= 3) throw fail(429, 'Authentication capacity is busy; retry shortly');
  activeHashes++;
  try {
    const [algorithm, n, r, p, salt, expected] = (encoded || '').split('$');
    const valid = algorithm === 'scrypt' && ['16384', '32768', '65536', '131072'].includes(n) && r === '8' && p === '1' && salt && expected;
    const derived = await scrypt(password, valid ? Buffer.from(salt, 'base64url') : Buffer.alloc(16), 32, {N: valid ? +n : 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024});
    return valid && equalSecret(derived.toString('base64url'), expected);
  } finally { activeHashes--; }
}
export class SecretVault {
  constructor(key) { if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('DATA_KEY must contain 32 bytes'); this.key = key; }
  static async open(dataDir, configured = process.env.DATA_KEY || '') {
    await mkdir(dataDir, {recursive: true, mode: 0o700});
    let key;
    if (configured) key = Buffer.from(configured, /^[\da-f]{64}$/i.test(configured) ? 'hex' : 'base64');
    else {
      const filename = path.join(dataDir, 'data.key');
      try { key = await readFile(filename); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        key = randomBytes(32);
        const temporary=filename+'.'+makeId()+'.tmp',handle=await open(temporary,'wx',0o600);try{await handle.writeFile(key);await handle.sync();}finally{await handle.close();}try{await link(temporary,filename);}catch(e){if(e.code!=='EEXIST')throw e;key=await readFile(filename);}finally{await unlink(temporary);}try{const directory=await open(dataDir,'r');try{await directory.sync();}finally{await directory.close();}}catch(e){if(!['EINVAL','ENOTSUP','EISDIR','EPERM'].includes(e.code))throw e;}
      }
    }
    return new SecretVault(key);
  }
  seal(value, context = 'mireva') {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([Buffer.from('MVS1'), iv, cipher.getAuthTag(), encrypted]);
  }
  open(value, context = 'mireva') {
    const data = Buffer.from(value);
    if (data.length < 32 || data.subarray(0, 4).toString() !== 'MVS1') throw Error('Invalid encrypted data');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(4, 16)); decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(data.subarray(16, 32));
    return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
  }
  csrf(token) { return createHmac('sha256', this.key).update('csrf:' + token).digest('base64url'); }
}
export function parseCookies(req) {
  const result = Object.create(null);
  for (const part of (req.headers.cookie || '').split(';')) { const split = part.indexOf('='); if (split > 0) { try { result[part.slice(0, split).trim()] = decodeURIComponent(part.slice(split + 1)); } catch {} } }
  return result;
}
export function setCookie(res, name, value, {secure = false, maxAge = 86400, path = '/', sameSite = 'Lax'} = {}) {
  const cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const old = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [...(Array.isArray(old) ? old : old ? [old] : []), cookie]);
}
export async function jsonBody(req, maxBytes = 12_000_000) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'Send application/json');
  if (Number(req.headers['content-length']) > maxBytes) throw fail(413, 'Request body is too large');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw fail(413, 'Request body is too large'); chunks.push(chunk); }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw fail(400, 'Invalid JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw fail(400, 'Send a JSON object');
  return result;
}
export function sendJSON(res, data, status = 200) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(data)); }
export function base32(bytes) {
  let value = 0, bits = 0, result = ''; const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31]; } }
  if (bits) result += alphabet[(value << (5 - bits)) & 31]; return result;
}
export function unbase32(value) { let buffer = 0, bits = 0; const bytes = []; for (const char of value.replace(/=+$/, '').toUpperCase()) { const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); if (n < 0) throw Error('Invalid authenticator secret'); buffer = (buffer << 5) | n; bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); } } return Buffer.from(bytes); }
export function totp(secret, time = Date.now()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
  const hash = createHmac('sha1', unbase32(secret)).update(counter).digest(), offset = hash.at(-1) & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
export function verifyTotp(secret, code, lastStep = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(code || '')) return null;
  for (const delta of [0, -1, 1]) { const step = Math.floor(now / 30000) + delta; if (step > lastStep && equalSecret(totp(secret, step * 30000), code)) return step; }
  return null;
}
