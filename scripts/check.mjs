import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const walk=async dir=>{const files=[];for(const f of await readdir(dir,{withFileTypes:true})){if(['node_modules','.git','.mireva-data','dist'].includes(f.name))continue;const p=path.join(dir,f.name);if(f.isDirectory())files.push(...await walk(p));else if(/\.(js|mjs)$/.test(f.name))files.push(p);}return files;};let failed=false;const files=await walk('.');for(const file of files){const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(r.status){failed=true;console.error(file,r.stderr);}}if(failed)process.exit(1);console.log(`Syntax OK: ${files.length} JavaScript modules.`);
