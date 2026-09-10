import {richRuns,richString} from '../core/richtext.js';
import {uid,clone,validateSnapshot} from '../core/schema.js';
export class LocalVault{
 async open(){if(this.db)return this;this.db=await new Promise((resolve,reject)=>{const r=indexedDB.open('mireva-studio',1);r.onupgradeneeded=()=>{const db=r.result;db.createObjectStore('documents',{keyPath:'id'});db.createObjectStore('versions',{keyPath:'id'});db.createObjectStore('settings');};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});return this;}
 async op(table,mode,fn){await this.open();return new Promise((resolve,reject)=>{const tx=this.db.transaction(table,mode),r=fn(tx.objectStore(table));let result;r.onsuccess=()=>result=r.result;r.onerror=()=>reject(r.error);tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Storage transaction aborted'));});}
 get(id){return this.op('documents','readonly',s=>s.get(id));}
 list(){return this.op('documents','readonly',s=>s.getAll());}
 async save(id,snapshot,extras={}){const record={id,name:snapshot.records.project?.name||'Untitled project',updatedAt:Date.now(),snapshot,...extras};await this.op('documents','readwrite',s=>s.put(record));return record;}
 delete(id){return this.op('documents','readwrite',s=>s.delete(id));}
 setting(k,value){return arguments.length>1?this.op('settings','readwrite',s=>s.put(value,k)):this.op('settings','readonly',s=>s.get(k));}
 async checkpoint(doc,snapshot,name){const v={id:uid('v'),doc,name:name||'Checkpoint',createdAt:Date.now(),snapshot};await this.op('versions','readwrite',s=>s.put(v));const versions=await this.versions(doc);for(const old of versions.slice(20))await this.op('versions','readwrite',s=>s.delete(old.id));return v;}
 async versions(doc){return(await this.op('versions','readonly',s=>s.getAll())).filter(v=>v.doc===doc).sort((a,b)=>b.createdAt-a.createdAt);}
}
export function restoreAsEdits(store,snapshot){validateSnapshot(snapshot);store.transact('Restore version',()=>{for(const r of store.records.values())if(!snapshot.records[r.id]&&!r.deleted)store.set(r.id,{deleted:true});for(const[id,r]of Object.entries(snapshot.records)){const{_stamps,id:rid,richText,...values}=clone(r),old=store.records.get(id);if(old&&r.entity==='node'&&['text','button','input'].includes(r.type)){const text=richText?richString(richText):r.text||'';delete values.text;store.set(id,values);if(r.deleted)continue;store.editText(id,0,[...(store.get(id).text||'')].length,text,{});let start=0;for(const run of richRuns({richText,text})){const count=[...run.text].length;store.formatText(id,start,count,run.marks);start+=count;}}else store.set(id,{...values,...(richText?{richText}:{})});}});}
