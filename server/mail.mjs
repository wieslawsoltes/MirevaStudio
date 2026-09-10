import net from 'node:net';
import tls from 'node:tls';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {makeId, secret, safeString, emailAddress} from './security.mjs';
const header = value => String(value).replace(/[\r\n\u0000]/g, '');
const encoded = value => Buffer.from(String(value)).toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
const senderAddress = value => emailAddress((String(value).match(/<([^>]+)>/) || [null, value])[1]);
class SMTPReader {
  constructor(socket) {
    this.socket = socket; this.buffer = ''; this.lines = []; this.responses = []; this.waiters = [];
    this.data = chunk => { this.buffer += chunk.toString();if(this.buffer.length>65536||this.lines.length>500||this.responses.length>100)return socket.destroy(Error('SMTP response too large'));let end; while ((end = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1); if (this.buffer.length > 65536) return socket.destroy(Error('SMTP response too large')); this.lines.push(line); if (/^\d{3} /.test(line)) { const response = {code: +line.slice(0, 3), lines: this.lines}; this.lines = []; const waiter = this.waiters.shift(); waiter ? waiter.resolve(response) : this.responses.push(response); } } };
    this.error = error => { this.failure = error; for (const waiter of this.waiters.splice(0)) waiter.reject(error); };
    socket.on('data', this.data); socket.on('error', this.error); socket.on('close', () => this.error(Error('SMTP connection closed')));
  }
  async reply(codes) { if (this.failure) throw this.failure; const result = this.responses.length ? this.responses.shift() : await new Promise((resolve, reject) => this.waiters.push({resolve, reject})); if (!codes.includes(result.code)) throw Error('SMTP delivery rejected: ' + result.code); return result; }
  command(text, codes) { this.socket.write(text + '\r\n'); return this.reply(codes); }
  detach() { this.socket.removeListener('data', this.data); this.socket.removeListener('error', this.error); }
}
export async function sendSMTP(config, message) {
  let socket = config.secure ? tls.connect({host: config.host, port: config.port || 465, servername: config.host, rejectUnauthorized: config.rejectUnauthorized !== false}) : net.connect({host: config.host, port: config.port || 587});
  const timer = setTimeout(() => socket.destroy(Error('SMTP delivery timed out')), 25000); timer.unref();
  try {
    socket.on('error', () => {});
    await once(socket, config.secure ? 'secureConnect' : 'connect');
    let reader = new SMTPReader(socket); await reader.reply([220]);
    let greeting = await reader.command('EHLO mireva.local', [250]);
    if (!config.secure) {
      if (greeting.lines.some(line => /STARTTLS/i.test(line))) {
        await reader.command('STARTTLS', [220]); reader.detach();
        socket = tls.connect({socket, servername: config.host, rejectUnauthorized: config.rejectUnauthorized !== false}); socket.on('error', () => {});
        await once(socket, 'secureConnect'); reader = new SMTPReader(socket); greeting = await reader.command('EHLO mireva.local', [250]);
      } else if (!config.allowInsecureTest) throw Error('SMTP requires STARTTLS or implicit TLS');
    }
    if (config.user) {
      if (!socket.encrypted && !config.allowInsecureTest) throw Error('Refusing to send SMTP credentials without TLS');
      await reader.command('AUTH PLAIN ' + Buffer.from('\0' + config.user + '\0' + config.password).toString('base64'), [235]);
    }
    await reader.command('MAIL FROM:<' + senderAddress(message.from) + '>', [250]);
    await reader.command('RCPT TO:<' + emailAddress(message.to) + '>', [250, 251]);
    await reader.command('DATA', [354]);
    const boundary = 'mireva_' + secret(16);
    const data = [`From: ${header(message.from)}`, `To: ${header(message.to)}`, `Subject: =?UTF-8?B?${Buffer.from(message.subject).toString('base64')}?=`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${message.id}@mireva.local>`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '', `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', encoded(message.text), `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', encoded(message.html || message.text), `--${boundary}--`, ''].join('\r\n');
    await reader.command(data.replace(/^\./gm, '..') + '\r\n.', [250]);
    await reader.command('QUIT', [221]);
  } finally { clearTimeout(timer); socket.destroy(); }
}
export class MailQueue {
  constructor(db, {dataDir, from = process.env.MAIL_FROM || 'Mireva Studio <noreply@localhost.test>', transport, webhook = process.env.MAIL_WEBHOOK_URL || '', webhookKey = process.env.MAIL_WEBHOOK_KEY || '', smtp, production = false} = {}) {
    this.db = db; this.dataDir = dataDir; this.from = from; this.transport = transport; this.webhook = webhook; this.webhookKey = webhookKey;
    this.smtp = smtp || (process.env.SMTP_HOST ? {host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === '1', user: process.env.SMTP_USER || '', password: process.env.SMTP_PASSWORD || ''} : null);
    this.mode = transport ? 'injected' : this.smtp ? 'smtp' : webhook ? 'webhook' : 'development-file';
    this.production = production; this.working = null;
    if (production && this.smtp && (this.smtp.allowInsecureTest || this.smtp.rejectUnauthorized === false)) throw Error('Production SMTP cannot disable transport security');
    if (production && webhook && !webhook.startsWith('https://')) throw Error('Production mail webhook must use HTTPS');
  }
  enqueue(to, subject, text, html = '') {
    if (this.production && this.mode === 'development-file') throw Error('Configure SMTP or a transactional mail webhook before enabling registration');
    const id = makeId(), message = {id, from: this.from, to: emailAddress(to), subject, text, html};
    this.db.run('INSERT INTO mail_jobs(id,recipient,payload,next_attempt,created_at) VALUES(?,?,?,?,?)', id, message.to, this.db.vault.seal(message, 'mail'), Date.now(), Date.now());
    queueMicrotask(() => this.drain().catch(() => {})); return id;
  }
  async deliver(message) {
    if (this.transport) return this.transport(message);
    if (this.smtp) return sendSMTP(this.smtp, message);
    if (this.webhook) {
      const response = await fetch(this.webhook, {method: 'POST', redirect: 'error', headers: {'Content-Type': 'application/json', 'Idempotency-Key': message.id, ...(this.webhookKey ? {Authorization: 'Bearer ' + this.webhookKey} : {})}, body: JSON.stringify(message), signal: AbortSignal.timeout(20000)});
      if (!response.ok) throw Error('Mail webhook returned ' + response.status); await response.body?.cancel(); return;
    }
    const dir = path.join(this.dataDir, 'development-mail'); await mkdir(dir, {recursive: true, mode: 0o700});
    await writeFile(path.join(dir, message.id + '.json'), JSON.stringify(message, null, 2), {mode: 0o600});
  }
  async drain() {
    if (this.working) return this.working;
    this.working = (async () => {
      for (let i = 0; i < 10; i++) {
        const job = this.db.transaction(() => {
          const row = this.db.get("SELECT * FROM mail_jobs WHERE state='pending' AND next_attempt<=? AND leased_until<? ORDER BY created_at LIMIT 1", Date.now(), Date.now());
          if (row) this.db.run('UPDATE mail_jobs SET leased_until=? WHERE id=?', Date.now() + 60000, row.id); return row;
        });
        if (!job) break;
        try { await this.deliver(JSON.parse(this.db.vault.open(job.payload, 'mail').toString())); this.db.run("UPDATE mail_jobs SET state='sent',attempts=attempts+1,error=NULL,leased_until=0 WHERE id=?", job.id); }
        catch (error) { const attempts = job.attempts + 1; this.db.run('UPDATE mail_jobs SET state=?,attempts=?,next_attempt=?,error=?,leased_until=0 WHERE id=?', attempts >= 8 ? 'failed' : 'pending', attempts, Date.now() + Math.min(3600000, 30000 * 2 ** attempts), safeString(error.message, 200), job.id); }
      }
    })();
    try { await this.working; } finally { this.working = null; }
  }
  start() { this.interval = setInterval(() => this.drain().catch(() => {}), 5000); this.interval.unref(); }
  async close() { clearInterval(this.interval); await this.working; }
}
