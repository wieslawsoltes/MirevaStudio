/** Offline restore to a NEW directory; online SQLite backup; payload/audit verification. */
import {access,mkdir,readdir,readFile,copyFile,chmod,rm} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Database} from './database.mjs';
import {SecretVault} from './security.mjs';
import {validateSnapshot} from '../src/core/schema.js';
const command=process.argv[2],args=process.argv.slice(3),data=path.resolve(process.env.DATA_DIR||'.mireva-data');
async function existing(dir){await access(path.join(dir,'mireva.sqlite'));if(!process.env.DATA_KEY)await access(path.join(dir,'data.key'));return new Database(path.join(dir,'mireva.sqlite'),await SecretVault.open(dir,process.env.DATA_KEY||''));}
function verify(db){const integrity=db.get('PRAGMA integrity_check').integrity_check;if(integrity!=='ok')throw Error('Database integrity check failed');let documents=0,journal=0;for(const row of db.all('SELECT snapshot FROM rooms')){validateSnapshot(db.unpack(row.snapshot));documents++;}for(const row of db.all('SELECT ops FROM room_ops')){const batch=db.unpack(row.ops);if(!Array.isArray(batch.ops))throw Error('Invalid operation journal');journal++;}for(const row of db.all('SELECT snapshot FROM checkpoints UNION ALL SELECT snapshot FROM publications'))validateSnapshot(db.unpack(row.snapshot));for(const row of db.all("SELECT id AS org FROM orgs UNION SELECT 'system' AS org")){const status=db.verifyAudit(row.org);if(!status.valid)throw Error('Audit chain is invalid: '+row.org);}return{integrity,documents,journal,audit:'valid'};}
try{
 if(command==='backup'){
  if(!args[0])throw Error('Usage: DATA_DIR=... node server/admin.mjs backup /secure/new-backup.sqlite');const db=await existing(data);try{const result=await db.backup(path.resolve(args[0]));console.log(JSON.stringify({...result,note:'Back up data.key separately, or preserve DATA_KEY in your secret manager. The database alone cannot decrypt document payloads.'},null,2));}finally{db.close();}
 }else if(command==='check'){
  const db=await existing(data);try{console.log(JSON.stringify(verify(db),null,2));}finally{db.close();}
 }else if(command==='restore'){
  if(args.length!==3)throw Error('Usage: node server/admin.mjs restore /backup.sqlite /NEW-empty-directory /secure/data.key');const [source,destination,key]=args.map(p=>path.resolve(p));await access(source);await access(key);const secret=await readFile(key);if(secret.length!==32)throw Error('Recovery key must contain exactly 32 bytes');await mkdir(destination,{recursive:true,mode:0o700});if((await readdir(destination)).length)throw Error('Restore destination must be empty. Never restore over a running server.');const copy=new DatabaseSync(source,{readOnly:true});try{if(copy.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup integrity check failed');}finally{copy.close();}
  await copyFile(source,path.join(destination,'mireva.sqlite'));await copyFile(key,path.join(destination,'data.key'));await chmod(path.join(destination,'mireva.sqlite'),0o600);await chmod(path.join(destination,'data.key'),0o600);let db;try{db=await existing(destination);console.log(JSON.stringify({...verify(db),directory:destination,note:'Start the server with DATA_DIR pointing to this restored directory.'},null,2));}catch(error){console.error('Restored copy did not verify. Do not start a server against it.');throw error;}finally{db?.close();}
 }else throw Error('Commands: backup <new.sqlite> | check | restore <backup.sqlite> <new-directory> <data.key>');
}catch(error){console.error(error.message);process.exitCode=1;}
