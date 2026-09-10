/** Cookie sessions are intentionally never stored in IndexedDB or project files. */
export class WorkspaceClient {
 constructor(server=globalThis.document?.querySelector('meta[name="mireva-hosting"]')?.content==='static'?'':location.protocol.startsWith('http')?location.origin:''){this.server=server.replace(/\/$/,'');this.state={user:null,csrf:'',providers:[]};this.onChange=()=>{};}
 async request(path,{method='GET',body,signal}={}){if(!this.server)throw Error('Open the editor through the included server to use accounts');const response=await fetch(this.server+path,{method,credentials:'include',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(this.state.csrf?{'X-CSRF-Token':this.state.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body),signal});const data=await response.json().catch(()=>({error:'The server did not return JSON'}));if(!response.ok)throw Object.assign(Error(data.error||'Request failed'),{status:response.status,code:data.code});if(data.csrf)this.state={...this.state,csrf:data.csrf};return data;}
 async refresh(){this.state=await this.request('/api/auth/me');this.onChange(this.state);return this.state;}
 async auth(path,body,method='POST'){const data=await this.request('/api/auth/'+path,{method,body});if(['login','mfa/verify','logout','logout-all','profile','password/change','mfa/confirm','mfa/disable'].includes(path))await this.refresh();return data;}
 headers(){return this.state.csrf?{'X-CSRF-Token':this.state.csrf}:{};}
 async connect(sync,id,orgId){await this.refresh();if(!this.state.user)throw Error('Sign in before opening this project');await sync.connect({server:this.server,id,account:true,orgId},{fresh:true});}
 async create(sync,snapshot,orgId=null){const result=await this.request('/api/rooms',{method:'POST',body:{snapshot,...(orgId?{orgId}:{})}});await sync.connect({server:this.server,...result},{fresh:false});return result;}
}
