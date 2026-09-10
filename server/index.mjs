import http from 'node:http';
import {readFile, readdir, mkdir, rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SecretVault, fail, digest, makeId, sendJSON, equalSecret} from './security.mjs';
import {Database} from './database.mjs';
import {MailQueue} from './mail.mjs';
import {AuthService} from './auth.mjs';
import {OIDCService} from './oidc.mjs';
import {OrganizationService} from './organizations.mjs';
import {AIService} from './ai.mjs';
import {RoomService} from './rooms.mjs';
import {DocumentStore} from '../src/core/store.js';
import {validateSnapshot} from '../src/core/schema.js';
import {htmlExport} from '../src/services/export.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
async function migrateLegacy(db, dataDir) {
  for (const filename of await readdir(dataDir)) {
    if (!/^[a-f0-9]{24}\.json$/.test(filename)) continue;
    const id = filename.slice(0,-5); if (db.get('SELECT 1 FROM rooms WHERE id=?',id)) continue;
    const data = JSON.parse(await readFile(path.join(dataDir,filename),'utf8')); validateSnapshot(data.snapshot);
    db.transaction(()=>{
      const packed = db.pack(data.snapshot), now=Date.now();
      db.run('INSERT INTO rooms(id,name,created_at,updated_at,revision,base_revision,snapshot,storage_bytes,record_count) VALUES(?,?,?,?,?,?,?,?,?)',id,data.snapshot.records.project?.name||'Imported project',data.createdAt||now,now,data.revision||0,data.revision||0,packed,packed.length,Object.keys(data.snapshot.records).length);
      for (const g of data.grants || []) db.run('INSERT INTO grants(id,room_id,hash,role,label,expires_at,revoked,created_at) VALUES(?,?,?,?,?,?,?,?)',g.id,id,g.hash,g.role,g.label||g.role,g.expires||null,g.revoked?1:0,g.createdAt||now);
      for (const v of data.versions || []) db.run('INSERT INTO checkpoints(id,room_id,revision,name,snapshot,author,created_at) VALUES(?,?,?,?,?,?,?)',v.id,id,v.revision||0,v.name||'Checkpoint',db.pack(validateSnapshot(v.snapshot)),'migration',v.createdAt||now);
      db.audit(null,'migration','project.legacy_imported',id);
    });
    await rename(path.join(dataDir,filename),path.join(dataDir,filename+'.migrated-backup'));
  }
}
export async function createMirevaServer(options={}) {
  const dataDir=options.dataDir||process.env.DATA_DIR||path.join(ROOT,'.mireva-data'), host=options.host||process.env.HOST||'127.0.0.1', port=options.port??Number(process.env.PORT||4173), production=options.production??process.env.NODE_ENV==='production';
  const publicOrigin=options.publicOrigin||process.env.PUBLIC_ORIGIN||'', cors=(options.cors??process.env.CORS_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean), createKey=options.createKey??process.env.CREATE_KEY??'', metricsKey=options.metricsKey??process.env.METRICS_KEY??'';
  if(production&&(!publicOrigin||!publicOrigin.startsWith('https://')))throw Error('Production requires PUBLIC_ORIGIN=https://your-host');
  if(publicOrigin&&new URL(publicOrigin).origin!==publicOrigin)throw Error('PUBLIC_ORIGIN must be an origin without a trailing slash or path');
  await mkdir(dataDir,{recursive:true,mode:0o700}); const vault=await SecretVault.open(dataDir,options.dataKey??process.env.DATA_KEY??''),db=new Database(path.join(dataDir,'mireva.sqlite'),vault);
  const mail=new MailQueue(db,{dataDir,production,...options.mail}), auth=new AuthService(db,mail,{origin:publicOrigin,production,allowRegistration:options.allowRegistration??process.env.ALLOW_REGISTRATION!=='0',passwordN:options.passwordN??131072});
  if(production&&auth.passwordN<131072)throw Error('Production password cost cannot be reduced');
  const oidc=new OIDCService(auth,options.oidcProviders??JSON.parse(process.env.OIDC_PROVIDERS||'[]'),{allowInsecureTest:options.allowInsecureTest});
  const orgs=new OrganizationService(db,auth,mail), ai=new AIService(db,{production,allowInsecureTest:options.allowInsecureTest,providers:options.aiProviders??JSON.parse(process.env.AI_PROVIDERS||'[]'),aiURL:options.aiURL??process.env.AI_URL??'',aiKey:options.aiKey??process.env.AI_KEY??'',aiModel:options.aiModel??process.env.AI_MODEL??''});
  await migrateLegacy(db,dataDir);
  const rooms=new RoomService(db,auth,orgs,ai,{createKey,allowAnonymous:options.allowAnonymous??(!production||process.env.ALLOW_ANONYMOUS_ROOMS==='1'),compactEvery:options.compactEvery??100,maxBytes:options.maxBytes??100000000,maxRooms:options.maxRooms??10000});
  const started=Date.now(); let requests=0, failures=0, shuttingDown=false;
  const server=http.createServer(async(req,res)=>{
    requests++; const requestId=makeId(); res.setHeader('X-Request-ID',requestId); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('Cross-Origin-Resource-Policy','same-origin'); res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(production)res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    try{
      if(shuttingDown)throw fail(503,'Server is shutting down');
      const own=auth.origin||`http://${req.headers.host}`, origin=req.headers.origin;
      if(production&&req.headers.host!==new URL(publicOrigin).host)throw fail(421,'Unrecognized host');
      if(origin&&origin!==own){if(!cors.includes(origin))throw fail(403,'Origin is not allowed; configure CORS_ORIGINS');res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin');}
      if(origin){res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Create-Key, X-CSRF-Token, X-Request-ID');res.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');}
      if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
      if(!origin&&req.headers['sec-fetch-site']==='cross-site'&&!['GET','HEAD'].includes(req.method))throw fail(403,'Cross-site request rejected');
      const url=new URL(req.url,own),parts=url.pathname.split('/').filter(Boolean);
      if(parts[0]==='api'){
        if(!db.rate('api:'+digest(req.socket.remoteAddress||''),5000,60000))throw fail(429,'Too many requests');
        if(parts[1]==='health'&&req.method==='GET'){sendJSON(res,{ok:db.get('SELECT 1 AS ok').ok===1,name:'Mireva Studio',version:'0.2.0',collaboration:true,accounts:true,organizations:true,richText:true,storage:'sqlite-wal',ai:ai.providers.length>0,createKeyRequired:!!createKey,anonymousRooms:rooms.allowAnonymous});return;}
        if(parts[1]==='metrics'&&req.method==='GET'){
          if(!metricsKey||!equalSecret(req.headers.authorization,'Bearer '+metricsKey))throw fail(401,'Metrics authentication required');
          sendJSON(res,{uptimeMs:Date.now()-started,requests,failures,liveConnections:rooms.clients.size,cachedProjects:rooms.cache.size,projects:db.get('SELECT count(*) AS n FROM rooms').n,users:db.get('SELECT count(*) AS n FROM users').n,pendingMail:db.get("SELECT count(*) AS n FROM mail_jobs WHERE state='pending'").n,runningAI:db.get("SELECT count(*) AS n FROM ai_jobs WHERE status='running'").n,memory:process.memoryUsage()});return;
        }
        if(parts[1]==='auth')return await auth.route(req,res,url);
        if(parts[1]==='orgs')return await orgs.route(req,res,url);
        if(parts[1]==='rooms')return await rooms.route(req,res,url);
        throw fail(404,'Endpoint not found');
      }
      if(parts[0]==='p'&&parts[1]&&req.method==='GET'){
        const publication=db.get('SELECT p.*,r.org_id,r.archived_at FROM publications p JOIN rooms r ON r.id=p.room_id WHERE p.id=? AND p.enabled=1 AND (p.expires_at IS NULL OR p.expires_at>?)',parts[1],Date.now());
        if(!publication||publication.archived_at)throw fail(404,'Prototype is unavailable');
        if(publication.org_id){const org=db.get('SELECT settings FROM orgs WHERE id=? AND deleted=0',publication.org_id);if(!org||!JSON.parse(org.settings).allowPublicPrototypes)throw fail(404,'Prototype is unavailable');}
        const store=new DocumentStore('preview');store.load(db.unpack(publication.snapshot)); const html=htmlExport(store);
        res.setHeader('Content-Security-Policy',"sandbox allow-scripts allow-popups allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return;
      }
      if(!['GET','HEAD'].includes(req.method))throw fail(405,'Method not allowed');
      const relative=decodeURIComponent(url.pathname).replace(/^\/+/, '')||'index.html';
      if(!['index.html','styles.css','manifest.webmanifest','mireva-studio.html'].includes(relative)&&!relative.startsWith('src/')&&!relative.startsWith('assets/'))throw fail(404,'Not found');
      const file=path.resolve(ROOT,relative);if(!file.startsWith(ROOT+path.sep)||relative.includes('\0'))throw fail(403,'Access denied');let data;try{data=await readFile(file);}catch{throw fail(404,'Not found');}
      const htmlFile=path.extname(file)==='.html',nonce=makeId();if(htmlFile){data=Buffer.from(data.toString().replace(/<head>/i,'<head><meta name="mireva-nonce" content="'+nonce+'">').replace(/<script(?=[\s>])/gi,'<script nonce="'+nonce+'"'));}
      const etag='"'+digest(data).slice(0,32)+'"';if(!htmlFile)res.setHeader('ETag',etag);
      res.setHeader('Content-Security-Policy',`default-src 'self' data: blob:; script-src 'self' 'nonce-${nonce}'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${production?cors.filter(s=>s.startsWith('https://')).join(' '):'https: http:'}; img-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`);
      if(!htmlFile&&req.headers['if-none-match']===etag){res.writeHead(304);res.end();return;}
      res.writeHead(200,{'Content-Type':MIME[path.extname(file)]||'application/octet-stream','Cache-Control':htmlFile?'no-store':'no-cache'});res.end(req.method==='HEAD'?undefined:data);
    }catch(error){failures++;const status=error.status||(error.code?.includes('SQLITE')?500:error instanceof TypeError?400:400);if(status>=500)console.error(JSON.stringify({level:'error',requestId,status,message:error.message}));if(!res.headersSent)sendJSON(res,{error:status>=500&&!error.status?'Internal server error':error.message||'Request failed',code:error.code||undefined,requestId},status);else res.end();}
  });
  server.requestTimeout=120000;server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxHeadersCount=100;
  const sweeper=setInterval(()=>{try{db.prune();db.run('DELETE FROM room_receipts WHERE created_at<?',Date.now()-30*86400000);db.run("UPDATE ai_jobs SET status='failed',error='Worker disconnected before completing the request',updated_at=? WHERE status='running' AND updated_at<?",Date.now(),Date.now()-240000);}catch(error){console.error('Maintenance failed:',error.message);}},30000);sweeper.unref();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);}); if(!publicOrigin)auth.origin=`http://${host.includes(':')?'['+host+']':host}:${server.address().port}`; mail.start();
  let closed=false; return {server,port:server.address().port,db,auth,oidc,orgs,ai,rooms:rooms.cache,roomService:rooms,mail,close:async()=>{
    if(closed)return;closed=true;shuttingDown=true;clearInterval(sweeper);rooms.close();await ai.close();await mail.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});db.close();
  }};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await createMirevaServer();console.log(`\n  Mireva Studio 0.2\n  http://${process.env.HOST||'127.0.0.1'}:${app.port}\n  Accounts · organizations · collaboration · encrypted SQLite journal\n  Mail transport: ${app.mail.mode}\n`);for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
