import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {generateKeyPairSync, sign, createHash, randomBytes} from 'node:crypto';
import {createMirevaServer} from '../server/index.mjs';
import {DocumentStore} from '../src/core/store.js';
import {node} from '../src/core/schema.js';
import {totp, SecretVault} from '../server/security.mjs';
import {sendSMTP} from '../server/mail.mjs';
const PASSWORD = 'correct horse battery staple';
async function setup(t, options={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'mireva-platform-')),mail=[];
  const app=await createMirevaServer({dataDir:dir,port:0,passwordN:16384,mail:{transport:async message=>mail.push(message)},...options});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
  return {dir,app,mail,base:`http://127.0.0.1:${app.port}`};
}
function client(base) {
  const cookies=new Map();let csrf='';
  return {
    cookies,get csrf(){return csrf;},
    async request(route,method='GET',body,headers={}) {
      const r=await fetch(base+route,{method,redirect:'manual',headers:{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined});
      for(const cookie of r.headers.getSetCookie()){const [name,value]=cookie.split(';')[0].split('=');cookies.set(name,value);}
      let data;const text=await r.text();try{data=JSON.parse(text);}catch{data=text;}if(data?.csrf)csrf=data.csrf;return{status:r.status,data,headers:r.headers};
    }
  };
}
async function register(env,email='owner@example.test',name='Owner') {
  const c=client(env.base);assert.equal((await c.request('/api/auth/register','POST',{email,name,password:PASSWORD})).status,202);await env.app.mail.drain();
  const message=env.mail.findLast(m=>m.to===email),token=message.text.match(/token=([\w-]+)/)[1];
  assert.equal((await c.request('/api/auth/verify','POST',{token})).status,200);assert.equal((await c.request('/api/auth/login','POST',{email,password:PASSWORD})).status,200);return c;
}
function document() {const s=new DocumentStore('seed');s.add({entity:'project',name:'Private platform fixture',deleted:false},'project');s.add(node('frame',{name:'Screen'}),'frame');s.add(node('text',{parent:'frame',text:'Original text'}),'text');return s;}

test('verified accounts, CSRF, password reset, MFA and revocable sessions',async t=>{
  const env=await setup(t), c=client(env.base);
  assert.equal((await c.request('/api/auth/register','POST',{email:'member@example.test',name:'Member',password:PASSWORD})).status,202);
  assert.equal((await c.request('/api/auth/login','POST',{email:'member@example.test',password:PASSWORD})).status,403);
  await env.app.mail.drain();const token=env.mail[0].text.match(/token=([\w-]+)/)[1];
  assert.equal((await c.request('/api/auth/verify','POST',{token})).status,200);assert.equal((await c.request('/api/auth/verify','POST',{token})).status,400);
  const login=await c.request('/api/auth/login','POST',{email:'member@example.test',password:PASSWORD});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Lax/);
  assert.equal((await c.request('/api/auth/profile','PATCH',{name:'Changed'},{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await c.request('/api/auth/profile','PATCH',{name:'Changed'})).status,200);
  const enroll=await c.request('/api/auth/mfa/enroll','POST',{password:PASSWORD});assert.equal(enroll.status,200);
  const confirm=await c.request('/api/auth/mfa/confirm','POST',{code:totp(enroll.data.secret)});assert.equal(confirm.status,200);assert.equal(confirm.data.recoveryCodes.length,8);
  await c.request('/api/auth/logout','POST',{}); const pending=await c.request('/api/auth/login','POST',{email:'member@example.test',password:PASSWORD});assert.equal(pending.data.needsMfa,true);
  assert.equal((await c.request('/api/orgs')).status,401);
  assert.equal((await c.request('/api/auth/mfa/verify','POST',{code:'000000'})).status,401);
  assert.equal((await c.request('/api/auth/mfa/verify','POST',{code:confirm.data.recoveryCodes[0]})).status,200);
  const sessions=await c.request('/api/auth/sessions');assert.equal(sessions.status,200);assert.ok(sessions.data.sessions.length>=1);
  assert.equal((await c.request('/api/auth/password/reset/request','POST',{email:'member@example.test'})).status,202);await env.app.mail.drain();const reset=env.mail.at(-1).text.match(/reset=([\w-]+)/)[1];
  assert.equal((await c.request('/api/auth/password/reset','POST',{token:reset,password:'another very secure password'})).status,200);
  assert.equal((await c.request('/api/auth/me')).data.user,null);
  const newLogin=await c.request('/api/auth/login','POST',{email:'member@example.test',password:'another very secure password'});assert.equal(newLogin.data.needsMfa,true);
  assert.equal((await c.request('/api/auth/mfa/verify','POST',{code:confirm.data.recoveryCodes[0]})).status,401);
  assert.equal((await c.request('/api/auth/mfa/verify','POST',{code:confirm.data.recoveryCodes[1]})).status,200);
  assert.equal((await c.request('/api/auth/password/reset','POST',{token:reset,password:PASSWORD})).status,400);
  const user=env.app.db.get('SELECT * FROM users WHERE email=?','member@example.test');assert.notEqual(user.password,PASSWORD);assert.equal(Buffer.from(user.mfa_secret).subarray(0,4).toString(),'MVS1');
});

test('organization invitations are email-bound; roles, policy, project access and audit enforced',async t=>{
  const env=await setup(t,{allowAnonymous:false}),owner=await register(env),member=await register(env,'member@example.test','Member'),outsider=await register(env,'outsider@example.test','Outsider');
  assert.equal((await client(env.base).request('/api/rooms','POST',{snapshot:document().snapshot()})).status,401);
  const created=await owner.request('/api/orgs','POST',{name:'Product team'});assert.equal(created.status,201);const id=created.data.id,org='/api/orgs/'+id;
  const invite=await owner.request(org+'/invites','POST',{email:'member@example.test',role:'member'});assert.equal(invite.status,201);
  assert.equal((await outsider.request('/api/orgs/accept','POST',{token:invite.data.token})).status,403);
  assert.equal((await member.request('/api/orgs/accept','POST',{token:invite.data.token})).status,200);
  assert.equal((await member.request('/api/orgs/accept','POST',{token:invite.data.token})).status,400);
  assert.equal((await member.request(org+'/invites','POST',{email:'any@example.test'})).status,403);
  const room=await owner.request('/api/rooms','POST',{orgId:id,snapshot:document().snapshot()});assert.equal(room.status,201);const route='/api/rooms/'+room.data.id;
  assert.equal((await member.request(route)).data.role,'editor');assert.equal((await outsider.request(route)).status,404);
  const people=(await owner.request(org+'/members')).data.members, memberId=people.find(x=>x.email==='member@example.test').id, ownerId=people.find(x=>x.email==='owner@example.test').id;
  assert.equal((await owner.request(org+'/members/'+ownerId,'DELETE')).status,409);
  assert.equal((await owner.request(org+'/members/'+memberId,'PATCH',{role:'viewer'})).status,200);
  assert.equal((await member.request(route+'/ops','POST',{ops:[{id:'frame',values:{x:99},stamp:[50,'member']}]})).status,403);
  assert.equal((await owner.request(org,'PATCH',{settings:{allowGuestInvites:false}})).status,200);
  assert.equal((await owner.request(route+'/invites','POST',{role:'viewer'})).status,403);
  const lib=await owner.request(org+'/library','POST',{name:'Colors',kind:'palette',payload:['#ffffff','#123456']});assert.equal(lib.status,201);
  assert.equal((await member.request(org+'/library/'+lib.data.id)).data.payload[1],'#123456');
  assert.equal((await owner.request(org+'/library/'+lib.data.id,'PUT',{name:'Colors2',kind:'palette',payload:['#ffffff'],revision:0})).status,409);
  const pub=await owner.request(route+'/publish','POST',{});assert.equal(pub.status,201);const publicResult=await fetch(pub.data.url);assert.equal(publicResult.status,200);assert.match(publicResult.headers.get('content-security-policy'),/sandbox/);
  assert.equal((await owner.request(route+'/publish/'+pub.data.id,'DELETE')).status,200);assert.equal((await fetch(pub.data.url)).status,404);
  const audit=(await owner.request(org+'/audit')).data;assert.equal(audit.integrity.valid,true);assert.ok(audit.entries.length>=7);assert.equal((await member.request(org+'/audit')).status,403);
  assert.equal((await owner.request(route+'/archive','POST',{})).status,200);assert.equal((await member.request(route)).status,409);assert.equal((await owner.request(route+'/archive','POST',{archived:false})).status,200);
  assert.equal((await owner.request(org+'/members/'+memberId,'DELETE')).status,200);assert.equal((await member.request(route)).status,404);
});

test('encrypted journal, duplicate receipts, compaction, multi-process synchronization and backup',async t=>{
  const env=await setup(t,{compactEvery:3}),second=await createMirevaServer({dataDir:env.dir,port:0,compactEvery:3});t.after(()=>second.close());
  const c=client(env.base),seed=document(),created=await c.request('/api/rooms','POST',{snapshot:seed.snapshot()}),{id,token}=created.data,room='/api/rooms/'+id;
  const h={Authorization:'Bearer '+token};const other=client(`http://127.0.0.1:${second.port}`);
  const ac=new AbortController(),stream=await fetch(`http://127.0.0.1:${second.port}${room}/events?client=other_process`,{headers:h,signal:ac.signal}),reader=stream.body.getReader();await reader.read();
  let op;seed.on(e=>{if(e.local)op=e.ops;});seed.editText('text',8,0,'concurrent ');
  const first=await c.request(room+'/ops','POST',{ops:op,batchId:'batch-1'},h);assert.equal(first.status,200);
  const duplicate=await c.request(room+'/ops','POST',{ops:op,batchId:'batch-1'},h);assert.equal(duplicate.data.duplicate,true);assert.equal(duplicate.data.revision,first.data.revision);
  const timeout=setTimeout(()=>ac.abort(),4000);let packet='';while(!packet.includes('event: ops'))packet+=new TextDecoder().decode((await reader.read()).value);clearTimeout(timeout);assert.match(packet,/kind.*text/);ac.abort();await reader.cancel().catch(()=>{});
  for(let i=0;i<10;i++)assert.equal((await c.request(room+'/ops','POST',{ops:[{id:'frame',values:{x:i+10},stamp:[100+i,'writer']}]},h)).status,200);
  const data=(await other.request(room,'GET',undefined,h)).data;assert.equal(data.snapshot.records.frame.x,19);assert.match(data.snapshot.records.text.text,/concurrent/);
  const row=env.app.db.get('SELECT * FROM rooms WHERE id=?',id);assert.ok(row.base_revision>=9);assert.equal(Buffer.from(row.snapshot).subarray(0,4).toString(),'MVS1');
  assert.ok(env.app.db.get('SELECT count(*) AS n FROM room_ops WHERE room_id=?',id).n<11);
  assert.equal((await c.request(room+'/ops','POST',{ops:op,batchId:'batch-1'},h)).data.duplicate,true);
  const backup=path.join(env.dir,'backup.sqlite');assert.equal((await env.app.db.backup(backup)).integrity,'ok');assert.ok((await stat(backup)).size>0);
  assert.ok(!(await readFile(backup)).includes(Buffer.from('Original concurrent text')));
  const oldName=row.name;env.app.db.run('UPDATE audit SET payload=? WHERE seq=(SELECT max(seq) FROM audit)','{"tampered":true}');assert.equal(env.app.db.verifyAudit(null).valid,false);assert.ok(oldName);
});

async function identityFixture(t) {
  const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048}),key={...publicKey.export({format:'jwk'}),kid:'fixture',use:'sig',alg:'RS256'},codes=new Map();let base,behavior='valid';
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,base);let data;
    if(url.pathname==='/.well-known/openid-configuration')data={issuer:base,authorization_endpoint:base+'/authorize',token_endpoint:base+'/token',jwks_uri:base+'/keys',response_types_supported:['code'],code_challenge_methods_supported:['S256']};
    else if(url.pathname==='/keys')data={keys:[key]};
    else if(url.pathname==='/authorize'){const code=randomBytes(12).toString('hex');codes.set(code,Object.fromEntries(url.searchParams));const callback=new URL(url.searchParams.get('redirect_uri'));callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code',code);res.writeHead(303,{Location:callback.href});res.end();return;}
    else if(url.pathname==='/token'){
      let body='';for await(const chunk of req)body+=chunk;const params=new URLSearchParams(body),record=codes.get(params.get('code'));codes.delete(params.get('code'));
      if(!record||record.code_challenge!==createHash('sha256').update(params.get('code_verifier')||'').digest('base64url')){res.writeHead(400);res.end('{}');return;}
      const claims={iss:base,sub:'subject-'+behavior,aud:'mireva-test',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,nonce:record.nonce,email:behavior==='existing'?'owner@example.test':'sso@example.test',email_verified:true,name:'SSO Member'};
      if(behavior==='nonce')claims.nonce='wrong';if(behavior==='audience')claims.aud='other';if(behavior==='unverified')claims.email_verified=false;if(behavior==='expired')claims.exp-=1000;
      const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'fixture'})).toString('base64url'),payload=Buffer.from(JSON.stringify(claims)).toString('base64url'),unsigned=header+'.'+payload,signature=sign('sha256',Buffer.from(unsigned),privateKey).toString('base64url');data={id_token:unsigned+'.'+(behavior==='signature'?signature.slice(0,-6)+'AAAAAA':signature),access_token:'fixture-access',token_type:'Bearer'};
    }else{res.writeHead(404);res.end();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return{base,set behavior(value){behavior=value;}};
}
test('OIDC code+PKCE flow verifies signatures, nonce, audience, verified email, expiry and single-use state',async t=>{
  const fixture=await identityFixture(t),env=await setup(t,{allowInsecureTest:true,oidcProviders:[{id:'company',name:'Company',issuer:fixture.base,clientId:'mireva-test',clientSecret:'fixture-secret'}]});
  const c=client(env.base);
  const flow=async(browser)=>{const start=await browser.request('/api/auth/oidc/company/start');assert.equal(start.status,303);const authorize=await fetch(start.headers.get('location'),{redirect:'manual'});return new URL(authorize.headers.get('location'));};
  const callback=await flow(c),signed=await c.request(callback.pathname+callback.search);assert.equal(signed.status,303);assert.equal((await c.request('/api/auth/me')).data.user.email,'sso@example.test');assert.equal((await c.request(callback.pathname+callback.search)).status,400);
  const org=await c.request('/api/orgs','POST',{name:'SSO team',settings:{ssoProvider:'company'}});assert.equal(org.status,201);
  for(const kind of ['nonce','audience','unverified','expired','signature']){fixture.behavior=kind;const fresh=client(env.base),cb=await flow(fresh),result=await fresh.request(cb.pathname+cb.search);assert.equal(result.status,401,kind+JSON.stringify(result.data));}
  fixture.behavior='valid';const fresh=client(env.base),cb=await flow(fresh);assert.equal((await client(env.base).request(cb.pathname+cb.search)).status,401);
  await register(env);fixture.behavior='existing';const conflicting=client(env.base),conflictCallback=await flow(conflicting);assert.equal((await conflicting.request(conflictCallback.pathname+conflictCallback.search)).status,409);
});

test('AI requests exercise real HTTP transports, image input, validation, retry, cancellation, budgets and persistent history',async t=>{
  let mode='valid',requests=0,last;const provider=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;last=JSON.parse(body);requests++;if(mode==='retry'&&requests===1){res.writeHead(503);res.end('{}');return;}if(mode==='slow'){await new Promise(r=>setTimeout(r,1500));}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({nodes:mode==='bad'?[{id:'x',type:'text',parent:'x',x:0,y:0,w:10,h:10}]:[{id:'f',type:'frame',parent:'',x:0,y:0,w:400,h:800,name:'Generated screen'}]})}}],usage:{prompt_tokens:12,completion_tokens:30}}));});await new Promise(r=>provider.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{provider.close(r);provider.closeAllConnections();}));
  const env=await setup(t,{aiProviders:[{id:'fixture',kind:'chat',url:`http://127.0.0.1:${provider.address().port}/chat`,model:'fixture-model',key:'fixture-secret',vision:true}]}),c=client(env.base),created=await c.request('/api/rooms','POST',{snapshot:document().snapshot()}),route='/api/rooms/'+created.data.id+'/ai',h={Authorization:'Bearer '+created.data.token};
  const generated=await c.request(route,'POST',{prompt:'Design a settings screen',image:'data:image/png;base64,iVBORw0KGgo='},h);assert.equal(generated.status,200);assert.equal(generated.data.nodes[0].type,'frame');assert.equal(last.messages[1].content[1].type,'image_url');
  mode='bad';assert.equal((await c.request(route,'POST',{prompt:'Invalid fixture'},h)).status,502);
  mode='retry';requests=0;assert.equal((await c.request(route,'POST',{prompt:'Retry fixture'},h)).status,200);assert.equal(requests,2);
  mode='slow';const job=await c.request(route+'/jobs','POST',{prompt:'Cancellation fixture'},h);assert.equal(job.status,202);assert.equal((await c.request(route+'/jobs/'+job.data.id,'DELETE',{},h)).status,200);assert.equal((await c.request(route+'/jobs/'+job.data.id,'GET',undefined,h)).data.status,'cancelled');
  const history=await c.request(route+'/jobs','GET',undefined,h);assert.ok(history.data.jobs.some(j=>j.status==='completed'));assert.ok(history.data.jobs.some(j=>j.status==='failed'));
  const scope=created.data.id,period=new Date().toISOString().slice(0,10);env.app.db.run('UPDATE usage SET requests=100 WHERE org_id=? AND period=?',scope,period);assert.equal((await c.request(route,'POST',{prompt:'Over budget'},h)).status,429);
});

test('SMTP transport delivers MIME and refuses unencrypted production-style credentials',async t=>{
  const messages=[];const server=net.createServer(socket=>{socket.write('220 fixture SMTP\r\n');let buffer='',data=false,message='';socket.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+2);if(data){if(line==='.'){messages.push(message);data=false;socket.write('250 stored\r\n');}else message+=line+'\n';}else if(line.startsWith('EHLO'))socket.write('250 fixture\r\n');else if(line==='DATA'){data=true;socket.write('354 continue\r\n');}else if(line==='QUIT'){socket.write('221 bye\r\n');}else socket.write('250 ok\r\n');}});});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const config={host:'127.0.0.1',port:server.address().port,allowInsecureTest:true},message={id:'test',from:'Mireva <mail@example.test>',to:'user@example.test',subject:'Verify account',text:'Use this link',html:'<p>Use this link</p>'};
  await sendSMTP(config,message);assert.equal(messages.length,1);assert.match(messages[0],/multipart\/alternative/);assert.match(messages[0],/VXNlIHRoaXMgbGluaw==/);
  await assert.rejects(()=>sendSMTP({...config,allowInsecureTest:false,user:'secret',password:'secret'},message),/STARTTLS/);
});
