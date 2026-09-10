import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),modules=new Map();
async function load(id){
 if(modules.has(id))return;let source=await readFile(path.join(root,id),'utf8');const imports=[...source.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?\s*/gm)];modules.set(id,'');
 for(const match of imports){const dep=path.posix.normalize(path.posix.join(path.posix.dirname(id),match[2]));await load(dep);const names=match[1].trim().split(',').map(s=>s.trim().replace(/\s+as\s+/,':')).join(',');source=source.replace(match[0],`const {${names}}=require(${JSON.stringify(dep)});\n`);}
 const exports=[...source.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/g)].map(m=>m[1]);source=source.replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let)\b)/g,'');
 modules.set(id,`factories[${JSON.stringify(id)}]=(require)=>{\n${source}\nreturn {${exports.join(',')}};\n};`);
}
await load('src/app.js');const bundle=`(()=>{'use strict';const factories=Object.create(null),cache=Object.create(null);${[...modules.values()].join('\n')}\nfunction require(id){if(!cache[id])cache[id]=factories[id](require);return cache[id];}require('src/app.js');})();`;
let html=await readFile(path.join(root,'index.html'),'utf8');const css=await readFile(path.join(root,'styles.css'),'utf8'),mark=await readFile(path.join(root,'assets/mark.svg'),'utf8');html=html.replace('href="assets/mark.svg"',`href="data:image/svg+xml,${encodeURIComponent(mark)}"`).replace('<link rel="stylesheet" href="styles.css">',`<style>${css}</style>`).replace('<script type="module" src="src/app.js"></script>',()=>`<script>${bundle.replace(/<\/script/gi,'<\\/script')}</script>`);
await writeFile(path.join(root,'mireva-studio.html'),html);await mkdir(path.join(root,'dist'),{recursive:true});const siteHTML=html.replace('</head>','<meta name="mireva-hosting" content="static">\n</head>');await writeFile(path.join(root,'dist/index.html'),siteHTML);await writeFile(path.join(root,'dist/.nojekyll'),'');const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));await writeFile(path.join(root,'dist/build-info.json'),JSON.stringify({name:pkg.name,version:pkg.version,commit:process.env.MIREVA_COMMIT||process.env.GITHUB_SHA||null,hosting:'static',serverServices:false},null,2)+'\n');console.log(`Built ${modules.size} modules → mireva-studio.html (${Math.round(Buffer.byteLength(html)/1024)} KiB).`);
