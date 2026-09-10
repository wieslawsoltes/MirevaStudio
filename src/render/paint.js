import {paintRichText,richFontFamily} from './richlayout.js';
import {ICONS} from '../ui/icons.js';
export function rgba(hex){if(!hex||hex==='transparent'||hex==='none')return[0,0,0,0];let h=hex.replace('#','');if(h.length===3||h.length===4)h=h.split('').map(c=>c+c).join('');return[parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255,h.length===8?parseInt(h.slice(6,8),16)/255:1];}
export const cssColor=c=>!c||c==='none'?'transparent':c;
export const fontName=richFontFamily;
export const fontString=n=>`${n.italic?'italic ':''}${n.fontWeight||400} ${Math.max(1,n.fontSize||16)}px ${fontName(n.fontFamily)}`;
export function textLines(ctx,n){
 const isText=n.type==='text',pad=isText?0:n.type==='input'?15:8,max=Math.max(1,n.w-pad*2),lines=[];ctx.font=fontString(n);
 if('letterSpacing'in ctx)ctx.letterSpacing=(n.letterSpacing||0)+'px';
 for(const paragraph of String(n.text||'').split('\n')){
  if(!paragraph){lines.push('');continue;}let line='';
  const words=paragraph.match(/\S+\s*|\s+/gu)||[paragraph];
  for(const word of words){const test=line+word;if(ctx.measureText(test.trimEnd()).width<=max){line=test;continue;}if(line.trim()){lines.push(line.trimEnd());line='';}if(ctx.measureText(word.trimEnd()).width<=max){line=word;continue;}for(const char of word){if(line&&ctx.measureText(line+char).width>max){lines.push(line);line='';}line+=char;}}
  lines.push(line.trimEnd());
 }
 return lines;
}
export const imageCache=new Map();
export function loadBitmap(src,invalidate=()=>{}){if(!src)return null;if(!imageCache.has(src)){const img=new Image();const entry={img,ready:false,promise:null};entry.promise=new Promise(resolve=>{img.onload=()=>{entry.ready=true;invalidate();resolve(img);};img.onerror=()=>resolve(null);});img.src=src;imageCache.set(src,entry);}return imageCache.get(src);}
function shapePath(ctx,n){ctx.beginPath();if(n.type==='ellipse')ctx.ellipse(n.w/2,n.h/2,n.w/2,n.h/2,0,0,Math.PI*2);else if(n.type==='line'){ctx.moveTo(0,0);ctx.lineTo(n.w,n.h);}else ctx.roundRect(0,0,n.w,n.h,Math.min(n.radius||0,n.w/2,n.h/2));}
export function drawText(ctx,n){paintRichText(ctx,n);}
export function paintNode(ctx,n,{textOnly=false,wireframe=false,invalidate=()=>{}}={}){
 if(n.type==='group'||n.type==='hotspot')return;
 ctx.save();
 const pathType=['path','icon','line'].includes(n.type);
 if(!textOnly && n.type!=='text' && n.type!=='image'){
  let fill=cssColor(wireframe?'#ffffff':n.fill),stroke=cssColor(wireframe?'#9a96a4':n.stroke),width=wireframe?1:n.strokeWidth||0;
  if(n.gradient&&n.gradient!=='none'&&!wireframe){const gr=ctx.createLinearGradient(0,0,n.gradient==='horizontal'?n.w:0,n.gradient==='horizontal'?0:n.h);for(const stop of n.gradientStops||[{offset:0,color:n.fill},{offset:1,color:n.fill2||n.fill}])gr.addColorStop(stop.offset,cssColor(stop.color));fill=gr;}
  ctx.fillStyle=fill;ctx.strokeStyle=stroke;ctx.lineWidth=width;ctx.lineCap=n.strokeCap||'round';ctx.lineJoin=n.strokeJoin||'round';ctx.miterLimit=n.miterLimit||10;ctx.setLineDash((n.strokeDash||'').split(/[ ,]+/).map(Number).filter(v=>Number.isFinite(v)&&v>0).slice(0,32));
  if(n.type==='icon'){ctx.strokeStyle=cssColor(n.color||n.fill);ctx.lineWidth=1.7;ctx.lineCap='round';ctx.lineJoin='round';ctx.scale(n.w/24,n.h/24);ctx.stroke(new Path2D(ICONS[n.icon]||ICONS.star));}
  else if(n.type==='path'){try{const path=new Path2D(n.path||'');ctx.scale(n.w/(n.pathW||n.w),n.h/(n.pathH||n.h));ctx.fill(path,n.fillRule==='evenodd'?'evenodd':'nonzero');if(width)ctx.stroke(path);}catch{}}
  else {shapePath(ctx,n);if(n.type!=='line')ctx.fill();if(width||n.type==='line'){ctx.strokeStyle=n.type==='line'?cssColor(n.stroke||n.color):stroke;ctx.lineWidth=n.type==='line'?Math.max(1,width):width;ctx.lineCap='round';ctx.stroke();}}
 }
 if(!textOnly&&n.type==='image'){
  const entry=loadBitmap(n.src,invalidate);shapePath(ctx,n);ctx.clip();
  if(entry?.ready){const im=entry.img,scale=Math.max(n.w/im.naturalWidth,n.h/im.naturalHeight);ctx.drawImage(im,(n.w-im.naturalWidth*scale)/2,(n.h-im.naturalHeight*scale)/2,im.naturalWidth*scale,im.naturalHeight*scale);}
  else {ctx.fillStyle='#ede9f3';ctx.fillRect(0,0,n.w,n.h);ctx.strokeStyle='#a89abf';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,n.h);ctx.lineTo(n.w*.4,n.h*.3);ctx.lineTo(n.w*.65,n.h*.6);ctx.lineTo(n.w,n.h*.2);ctx.stroke();}
 }
 if(['text','button','input'].includes(n.type))drawText(ctx,n);
 ctx.restore();
}
export function paintScene(ctx,items,{camera={x:0,y:0,z:1},dpr=1,width=ctx.canvas.width,height=ctx.canvas.height,wireframe=false,invalidate=()=>{},background=null}={}){
 ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,width,height);if(background){ctx.fillStyle=background;ctx.fillRect(0,0,width,height);}ctx.setTransform(dpr*camera.z,0,0,dpr*camera.z,dpr*camera.x,dpr*camera.y);
 for(const item of items){const {n,matrix,clip,opacity}=item;if(n.type==='group'||n.type==='hotspot')continue;ctx.save();ctx.beginPath();ctx.rect(clip.x,clip.y,clip.w,clip.h);ctx.clip();for(const c of item.clips||[]){ctx.transform(...c.matrix);if(c.n.maskPath)ctx.clip(new Path2D(c.n.maskPath),c.n.fillRule==='evenodd'?'evenodd':'nonzero');else{shapePath(ctx,c.n);ctx.clip();}ctx.setTransform(dpr*camera.z,0,0,dpr*camera.z,dpr*camera.x,dpr*camera.y);}ctx.transform(...matrix);ctx.globalAlpha=opacity;
 if((n.shadow||n.type==='frame')&&!wireframe){ctx.save();ctx.shadowColor='#25183814';ctx.shadowBlur=16;ctx.shadowOffsetY=5;ctx.fillStyle=cssColor(n.fill);shapePath(ctx,n);ctx.fill();ctx.restore();}
 paintNode(ctx,n,{wireframe,invalidate});ctx.restore();}
}
