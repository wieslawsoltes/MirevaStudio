import {uid} from '../core/schema.js';
/** SSE downstream, authenticated POST upstream. Durable LWW operations + ephemeral presence. */
export class CollaborationClient{
 constructor(store,{onStatus=()=>{},onPresence=()=>{},onQueue=()=>{},onError=()=>{},accountHeaders=()=>({})}={}){
  this.store=store;this.accountHeaders=accountHeaders;this.client=uid('client');this.onStatus=onStatus;this.onPresence=onPresence;this.onQueue=onQueue;this.onError=onError;this.peers=new Map();this.queue=[];this.role='local';this.status='local';this.config=null;this.stopped=true;this.lastPresence=0;this.generation=0;this.durable=Promise.resolve();this.retry=null;
  this.unsubscribe=store.on(e=>{if(e.local&&this.config){this.queue.push(...e.ops);this.durable=Promise.resolve(this.onQueue(this.queue)).catch(e=>this.onError(e.message));this.flush();}});
 }
 setStatus(status){this.status=status;this.onStatus(status,this.role);}
 url(path=''){return this.config.server.replace(/\/$/,'')+'/api/rooms/'+this.config.id+path;}
 async request(path='',{method='GET',body,signal}={}){const r=await fetch(this.url(path),{method,credentials:this.config.account?'include':'omit',headers:{...(this.config.account?this.accountHeaders():{Authorization:'Bearer '+this.config.token}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal});if(!r.ok){const e=await r.json().catch(()=>({error:'Server error'}));throw Object.assign(Error(e.error||'Request failed'),{status:r.status});}return r;}
 async create(server,snapshot,createKey=''){const r=await fetch(server.replace(/\/$/,'')+'/api/rooms',{method:'POST',headers:{'Content-Type':'application/json',...(createKey?{'X-Create-Key':createKey}:{})},body:JSON.stringify({snapshot})});const b=await r.json();if(!r.ok)throw Error(b.error||'Could not create room');await this.connect({server,...b},{fresh:false});return b;}
 async connect(config,{fresh=true,queue=[]}={}){this.disconnect();this.config=config;this.stopped=false;this.queue=queue;this.setStatus('connecting');const response=await this.request();const b=await response.json();this.role=b.role;this.grantId=b.grantId;
  if(fresh)this.store.load(b.snapshot);else this.store.merge(b.snapshot);this.revision=b.revision;this.onQueue(this.queue);this.stream(this.generation);this.heartbeat=setInterval(()=>this.presence(this.lastPresenceData||{}),10000);
 }
 async stream(generation){let delay=600;while(!this.stopped&&generation===this.generation){try{this.controller=new AbortController();const r=await this.request('/events?client='+this.client,{signal:this.controller.signal});if(generation!==this.generation)return;this.streamConnected=true;this.setStatus('online');delay=600;const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='';while(!this.stopped&&generation===this.generation){const{done,value}=await reader.read();if(done||generation!==this.generation)break;buffer+=decoder.decode(value,{stream:true});let boundary;while((boundary=buffer.indexOf('\n\n'))!==-1){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const event=block.match(/^event: (.*)$/m)?.[1],text=block.match(/^data: (.*)$/m)?.[1];if(text)this.message(event,JSON.parse(text));}}if(!this.stopped&&generation===this.generation){this.streamConnected=false;this.setStatus('offline');}}
  catch(e){if(this.stopped||generation!==this.generation)break;this.streamConnected=false;if([401,403].includes(e.status)){this.setStatus('revoked');this.onError(e.message);this.stopped=true;this.role='viewer';this.onStatus('revoked',this.role);break;}this.setStatus('offline');}
  if(!this.stopped&&generation===this.generation){await new Promise(r=>setTimeout(r,delay));delay=Math.min(12000,delay*1.6);}}
 }
 message(event,b){
  if(event==='hello'){this.role=b.role;this.grantId=b.grantId;this.revision=b.revision;this.store.merge(b.snapshot);this.peers=new Map((b.presence||[]).filter(p=>p.client!==this.client).map(p=>[p.client,p]));this.onPresence(this.peers);this.onStatus(this.status,this.role);this.flush();this.presence(this.lastPresenceData||{});}
  if(event==='snapshot'){this.revision=b.revision;this.store.merge(b.snapshot);}
  if(event==='ops'){this.revision=b.revision;this.store.receive(b.ops);}
  if(event==='presence'&&b.client!==this.client){this.peers.set(b.client,b);this.onPresence(this.peers);}
  if(event==='leave'){this.peers.delete(b.client);this.onPresence(this.peers);}
 }
 async flush(){
  if(this.sending||!['online','offline'].includes(this.status)||!this.queue.length||this.stopped)return;
  this.sending=true;const generation=this.generation,ops=this.queue.slice(0,400);
  try{
   await this.durable;if(generation!==this.generation)return;
   await this.request('/ops',{method:'POST',body:{ops,client:this.client}});
   if(generation!==this.generation)return;
   this.queue.splice(0,ops.length);this.durable=Promise.resolve(this.onQueue(this.queue)).catch(e=>this.onError(e.message));
   if(this.status==='offline'&&this.streamConnected)this.setStatus('online');
  }catch(e){
   if(generation!==this.generation)return;
   if([400,401,403,413].includes(e.status)){this.setStatus('blocked');this.onError('Changes kept locally: '+e.message);}
   else{this.setStatus('offline');clearTimeout(this.retry);this.retry=setTimeout(()=>{if(generation===this.generation)this.flush();},1000);}
  }finally{
   if(generation===this.generation){this.sending=false;if(this.queue.length&&this.status==='online')queueMicrotask(()=>this.flush());}
  }
 }
 presence(data){this.lastPresenceData=data;if(this.status!=='online'||Date.now()-this.lastPresence<80)return;this.lastPresence=Date.now();this.request('/presence',{method:'POST',body:{client:this.client,...data}}).catch(()=>{});}
 async invite(role,label,days=30){return(await this.request('/invites',{method:'POST',body:{role,label,days}})).json();}
 async invites(){return(await this.request('/invites')).json();}
 async revoke(id){return(await this.request('/invites/'+id,{method:'DELETE'})).json();}
 async versions(){return(await this.request('/versions')).json();}
 async checkpoint(name){return(await this.request('/versions',{method:'POST',body:{name}})).json();}
 async version(id){return(await this.request('/versions/'+id)).json();}
 async generate(prompt,device,image){return(await this.request('/ai',{method:'POST',body:{prompt,device,image}})).json();}
 shareLink(token=this.config?.token){const url=new URL(location.href);url.hash=new URLSearchParams({room:this.config.id,...(this.config.account&&(!token||token===this.config.token)?{account:'1'}:{token}),server:this.config.server}).toString();return url.href;}
 disconnect(){this.generation++;this.stopped=true;this.streamConnected=false;this.sending=false;clearTimeout(this.retry);this.controller?.abort();clearInterval(this.heartbeat);this.config=null;this.queue=[];this.peers.clear();this.role='local';this.setStatus('local');this.onPresence(this.peers);}
 destroy(){this.disconnect();this.unsubscribe();}
}
