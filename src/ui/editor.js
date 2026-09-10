import {node} from '../core/schema.js';
import {point,inverse,localMatrix,bounds,union,contains,intersects,snappedDelta,clamp} from '../core/geometry.js';
import {topSelection,resizeChildren,reflow} from '../core/commands.js';
import {escapeHTML} from '../services/export.js';
const NS='http://www.w3.org/2000/svg';
export class EditorController{
 constructor(renderer,store,{onSelect=()=>{},onTool=()=>{},onText=()=>{},onVector=()=>{},onComment=()=>{},onContext=()=>{},onPresence=()=>{},onError=()=>{},canEdit=()=>true}={}){
  Object.assign(this,{renderer,store,onSelect,onTool,onText,onVector,onComment,onContext,onPresence,onError,canEdit});this.host=renderer.host;this.selection=new Set();this.tool='select';this.snap=true;this.grid=false;this.space=false;this.guides=[];this.peers=new Map();this.pointers=new Map();this.hover=null;
  this.overlay=document.createElementNS(NS,'svg');this.overlay.classList.add('editor-overlay');this.host.append(this.overlay);this.labels=document.createElement('div');this.labels.className='frame-labels';this.host.append(this.labels);
  this.host.addEventListener('pointerdown',e=>this.down(e));this.host.addEventListener('pointermove',e=>this.move(e));this.host.addEventListener('pointerup',e=>this.up(e));this.host.addEventListener('pointercancel',e=>this.cancel(e));this.host.addEventListener('lostpointercapture',e=>{if(this.pointers.has(e.pointerId))this.cancel(e);});this.host.addEventListener('dblclick',e=>this.double(e));this.host.addEventListener('contextmenu',e=>{e.preventDefault();const p=this.position(e),hit=this.renderer.index.hit(this.renderer.world(p));if(hit&&!this.selection.has(hit.n.id))this.select([hit.n.id]);this.onContext(e.clientX,e.clientY);});
  this.host.addEventListener('wheel',e=>{if(e.target.closest('.text-editor'))return;e.preventDefault();const p=this.position(e);if(e.ctrlKey||e.metaKey)this.renderer.zoom(this.renderer.camera.z*Math.exp(-e.deltaY*.012),p);else{this.renderer.camera.x-=e.deltaX;this.renderer.camera.y-=e.deltaY;this.renderer.invalidate();}},{passive:false});
  this.labels.addEventListener('pointerdown',e=>{const el=e.target.closest('[data-frame]');if(el){e.stopPropagation();this.select([el.dataset.frame]);const p=this.position(e);this.pointers.set(e.pointerId,p);this.host.setPointerCapture(e.pointerId);this.beginMove(p,e);}});
 }
 position(e){const r=this.host.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top};}
 setTool(tool){this.tool=tool;this.host.dataset.tool=tool;this.onTool(tool);this.renderer.invalidate();}
 select(ids){this.selection=new Set(ids.filter(id=>this.store.get(id)));this.onSelect(this.selection);this.renderer.invalidate();this.presence();}
 selectionItems(){return this.renderer.scene().filter(i=>this.selection.has(i.n.id));}
 fitSelection(){this.renderer.fit(union(this.selectionItems().map(i=>i.bounds)),90);}
 frameAt(w){return this.renderer.scene().filter(i=>i.n.type==='frame'&&!i.locked&&contains(i.bounds,w)).at(-1);}
 editableRoots(){return topSelection(this.store,[...this.selection]).filter(id=>!this.renderer.scene().find(i=>i.n.id===id)?.locked);}
 down(e){if(e.button===2||e.target.closest('.text-editor')||e.target.closest('[data-frame]')||e.target.closest('[data-comment]'))return;const p=this.position(e),w=this.renderer.world(p);this.pointers.set(e.pointerId,p);this.host.setPointerCapture(e.pointerId);
  if(this.pointers.size===2){this.drag=null;this.renderer.setPreview(new Map());const [a,b]=[...this.pointers.values()],mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};this.pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),z:this.renderer.camera.z,world:this.renderer.world(mid)};return;}
  if(e.button===1||this.tool==='hand'||this.space){this.drag={kind:'pan',start:p,camera:{...this.renderer.camera}};return;}
  const handle=e.target.closest('[data-handle]')?.dataset.handle;
  if(handle&&this.canEdit()){const items=this.selectionItems();if(items.length){this.drag={kind:handle==='rotate'?'rotate':'resize',handle,start:w,items:items.map(i=>({...i,n:{...i.n}})),box:union(items.map(i=>i.bounds))};return;}}
  if(this.tool==='comment'){this.onComment(w,this.frameAt(w)?.n.id||'');return;}
  if(this.tool!=='select'){
   if(!this.canEdit()){this.onError('This invitation is read-only');return;}
   const frame=this.tool==='frame'?null:this.frameAt(w),parent=frame?.n.id||'',matrix=frame?.matrix||[1,0,0,1,0,0],local=point(inverse(matrix),w.x,w.y);this.drag={kind:'draw',tool:this.tool,parent,matrix,start:w,local,points:[w],current:w};return;
  }
  let hit=this.renderer.index.hit(w);if(hit&&!e.metaKey&&!e.ctrlKey){let n=hit.n;const seen=new Set();while(n.parent&&!seen.has(n.id)){seen.add(n.id);const parent=this.store.get(n.parent);if(parent?.type!=='group'||this.selection.has(parent.id))break;n=parent;}if(n.id!==hit.n.id)hit=this.renderer.scene().find(i=>i.n.id===n.id);}
  if(hit){if(e.shiftKey){const next=new Set(this.selection);next.has(hit.n.id)?next.delete(hit.n.id):next.add(hit.n.id);this.select([...next]);}else if(!this.selection.has(hit.n.id))this.select([hit.n.id]);if(this.canEdit()&&!hit.locked)this.beginMove(p,e);}
  else {if(!e.shiftKey)this.select([]);this.drag={kind:'marquee',start:w,current:w,base:e.shiftKey?[...this.selection]:[]};}
 }
 beginMove(p,e){const ids=this.editableRoots();this.drag={kind:'move',start:this.renderer.world(p),screenStart:p,items:ids.map(id=>{const item=this.renderer.scene().find(i=>i.n.id===id),parent=this.store.get(id).parent,pm=this.renderer.scene().find(i=>i.n.id===parent)?.matrix||[1,0,0,1,0,0];return {...item,n:{...item.n},parentInverse:inverse(pm)};}),moved:false};}
 move(e){const p=this.position(e),w=this.renderer.world(p);if(this.pointers.has(e.pointerId))this.pointers.set(e.pointerId,p);this.cursor=w;this.presence();
  if(this.pinch&&this.pointers.size===2){const[a,b]=[...this.pointers.values()],mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},z=clamp(this.pinch.z*Math.hypot(a.x-b.x,a.y-b.y)/Math.max(1,this.pinch.distance),.04,8);this.renderer.camera={x:mid.x-this.pinch.world.x*z,y:mid.y-this.pinch.world.y*z,z};this.renderer.invalidate();return;}
  const d=this.drag;if(!d){const hit=this.renderer.index.hit(w);if(this.hover!==hit?.n.id){this.hover=hit?.n.id;this.renderer.invalidate();}return;}
  if(d.kind==='pan'){this.renderer.camera.x=d.camera.x+p.x-d.start.x;this.renderer.camera.y=d.camera.y+p.y-d.start.y;this.renderer.invalidate();return;}
  if(d.kind==='marquee'){d.current=w;this.renderer.invalidate();return;}
  if(d.kind==='draw'){d.current=w;if(d.tool==='pen'&&Math.hypot(w.x-d.points.at(-1).x,w.y-d.points.at(-1).y)>2/this.renderer.camera.z)d.points.push(w);this.renderer.invalidate();return;}
  const previews=new Map();
  if(d.kind==='move'){
   let dx=w.x-d.start.x,dy=w.y-d.start.y;d.moved=Math.hypot(p.x-d.screenStart.x,p.y-d.screenStart.y)>2;
   if(e.shiftKey){if(Math.abs(dx)>Math.abs(dy))dy=0;else dx=0;}
   if(this.snap&&!e.altKey&&d.items.length){const selected=new Set(d.items.flatMap(i=>[i.n.id,...this.store.descendants(i.n.id).map(n=>n.id)]));const originals=this.renderer.items.filter(i=>!selected.has(i.n.id)||d.items.some(o=>o.n.id===i.n.id)).map(i=>{const orig=d.items.find(o=>o.n.id===i.n.id);return orig||i;});const snap=snappedDelta(originals, new Set(d.items.map(i=>i.n.id)),dx,dy,this.renderer.camera.z,this.grid);dx=snap.dx;dy=snap.dy;this.guides=snap.guides;}
   for(const i of d.items){const m=i.parentInverse;previews.set(i.n.id,{x:i.n.x+m[0]*dx+m[2]*dy,y:i.n.y+m[1]*dx+m[3]*dy});}
  }
  if(d.kind==='rotate'){
   if(d.items.length!==1)return;const i=d.items[0],center=point(i.matrix,i.n.w/2,i.n.h/2),initial=Math.atan2(d.start.y-center.y,d.start.x-center.x),angle=Math.atan2(w.y-center.y,w.x-center.x);let rotation=i.n.rotation+(angle-initial)*180/Math.PI;if(e.shiftKey)rotation=Math.round(rotation/15)*15;if(i.n.type!=='frame')previews.set(i.n.id,{rotation});
  }
  if(d.kind==='resize'){
   if(d.items.length===1){const i=d.items[0],n=i.n,q=point(inverse(i.matrix),w.x,w.y);let left=0,top=0,right=n.w,bottom=n.h;if(d.handle.includes('w'))left=Math.min(q.x,n.w-2);if(d.handle.includes('e'))right=Math.max(2,q.x);if(d.handle.includes('n'))top=Math.min(q.y,n.h-2);if(d.handle.includes('s'))bottom=Math.max(2,q.y);let nw=clamp(right-left,2,20000),nh=clamp(bottom-top,2,20000);
    if(e.shiftKey&&d.handle.length===2){const ratio=n.w/n.h;if(nw/nh>ratio)nh=nw/ratio;else nw=nh*ratio;if(d.handle.includes('w'))left=n.w-nw;if(d.handle.includes('n'))top=n.h-nh;}
    const lm=localMatrix(n),origin=point(lm,left,top),c=Math.cos(n.rotation*Math.PI/180),s=Math.sin(n.rotation*Math.PI/180),cx=nw/2,cy=nh/2;previews.set(n.id,{x:origin.x-(cx-c*cx+s*cy),y:origin.y-(cy-s*cx-c*cy),w:nw,h:nh});
    if(n.type==='group')this.scalePreview(n.id,nw/n.w,nh/n.h,previews);
   }else {let b={...d.box};if(d.handle.includes('w')){b.x=Math.min(w.x,d.box.x+d.box.w-2);b.w=d.box.x+d.box.w-b.x;}if(d.handle.includes('e'))b.w=Math.max(2,w.x-d.box.x);if(d.handle.includes('n')){b.y=Math.min(w.y,d.box.y+d.box.h-2);b.h=d.box.y+d.box.h-b.y;}if(d.handle.includes('s'))b.h=Math.max(2,w.y-d.box.y);const sx=b.w/d.box.w,sy=b.h/d.box.h;for(const i of d.items){const pm=this.renderer.scene().find(p=>p.n.id===i.n.parent)?.matrix||[1,0,0,1,0,0],pos=point(inverse(pm),b.x+(i.bounds.x-d.box.x)*sx,b.y+(i.bounds.y-d.box.y)*sy);previews.set(i.n.id,{x:pos.x,y:pos.y,w:clamp(i.n.w*sx,2,20000),h:clamp(i.n.h*sy,2,20000)});if(i.n.type==='group')this.scalePreview(i.n.id,sx,sy,previews);}}
  }
  this.renderer.setPreview(previews);
 }
 scalePreview(id,sx,sy,map){for(const n of this.store.children(id)){map.set(n.id,{x:n.x*sx,y:n.y*sy,w:clamp(n.w*sx,1,20000),h:clamp(n.h*sy,1,20000)});this.scalePreview(n.id,sx,sy,map);}}
 up(e){this.pointers.delete(e.pointerId);if(this.pinch){if(this.pointers.size<2)this.pinch=null;this.drag=null;return;}const d=this.drag;if(!d)return;this.drag=null;this.guides=[];
  try{
   if(d.kind==='marquee'){const b={x:Math.min(d.start.x,d.current.x),y:Math.min(d.start.y,d.current.y),w:Math.abs(d.current.x-d.start.x),h:Math.abs(d.current.y-d.start.y)};const selected=this.renderer.scene().filter(i=>!i.locked&&i.n.type!=='hotspot'&&intersects(i.bounds,b)&&(i.n.type!=='frame'||contains(b,{x:i.bounds.x,y:i.bounds.y})&&contains(b,{x:i.bounds.x+i.bounds.w,y:i.bounds.y+i.bounds.h}))).map(i=>i.n.id);this.select(topSelection(this.store,[...d.base,...selected]));}
   if(['move','resize','rotate'].includes(d.kind)){
    const preview=this.renderer.preview;
    this.store.transact(d.kind==='move'?'Move selection':d.kind==='resize'?'Resize selection':'Rotate selection',()=>{for(const[id,v]of preview){const old=this.store.get(id);if(!old)continue;this.store.set(id,v);if(old.type==='frame'&&d.kind==='resize'){const orig=d.items.find(i=>i.n.id===id)?.n;if(orig)resizeChildren(this.store,id,orig.w,orig.h,v.w??orig.w,v.h??orig.h);}}if(d.kind==='resize')for(const i of d.items)reflow(this.store,i.n.id);});this.renderer.setPreview(new Map());this.onSelect(this.selection);
   }
   if(d.kind==='draw')this.finishDraw(d);
  }catch(err){this.renderer.setPreview(new Map());this.onError(err.message);}
  this.renderer.invalidate();this.presence();
 }
 finishDraw(d){const p=point(inverse(d.matrix),d.current.x,d.current.y),dx=p.x-d.local.x,dy=p.y-d.local.y,isClick=Math.abs(dx)+Math.abs(dy)<5;const values={order:Math.max(0,...this.store.children(d.parent).map(n=>n.order||0))+1,parent:d.parent,x:Math.min(p.x,d.local.x),y:Math.min(p.y,d.local.y),w:Math.max(2,Math.abs(dx)),h:Math.max(2,Math.abs(dy))};let type=d.tool;
  if(type==='text')Object.assign(values,{w:isClick?240:values.w,h:isClick?42:values.h,text:'Your text here',fontSize:24,fill:'transparent',color:'#302641'});
  if(type==='rect'||type==='ellipse')Object.assign(values,{fill:'#d8ccf0',radius:type==='rect'?12:0,...(isClick?{w:160,h:110}:{})});
  if(type==='frame')Object.assign(values,{name:'Untitled screen',fill:'#ffffff',radius:18,clip:true,...(isClick?{w:360,h:744}:{})});
  if(type==='line'){type='path';values.fill='transparent';values.stroke='#7560d5';values.strokeWidth=3;values.path=`M ${dx<0?values.w:0} ${dy<0?values.h:0} L ${dx<0?0:values.w} ${dy<0?0:values.h}`;}
  if(type==='pen'){type='path';const ps=d.points.map(p=>point(inverse(d.matrix),p.x,p.y)),b=union(ps.map(p=>({...p,w:1,h:1})));Object.assign(values,{x:b.x,y:b.y,w:Math.max(2,b.w),h:Math.max(2,b.h),fill:'transparent',stroke:'#7560d5',strokeWidth:3,path:ps.map((p,i)=>`${i?'L':'M'} ${(p.x-b.x).toFixed(2)} ${(p.y-b.y).toFixed(2)}`).join(' ')});}
  let id;this.store.transact('Draw '+type,()=>id=this.store.add(node(type,values)));this.select([id]);this.setTool('select');if(type==='text')this.onText(id);
 }
 cancel(e){if(e)this.pointers.delete(e.pointerId);else this.pointers.clear();this.pinch=null;this.drag=null;this.guides=[];this.renderer.setPreview(new Map());}
 double(e){const hit=this.renderer.index.hit(this.renderer.world(this.position(e)));if(!hit)return;if(['text','button','input'].includes(hit.n.type)&&!hit.locked&&this.canEdit()){this.select([hit.n.id]);this.onText(hit.n.id);}else if(hit.n.type==='frame'){this.select([hit.n.id]);this.fitSelection();}else if(['path','line','rect','ellipse'].includes(hit.n.type)&&!hit.locked&&this.canEdit()){this.select([hit.n.id]);this.onVector(hit.n.id);}else this.select([hit.n.id]);}
 presence(){this.onPresence({cursor:this.cursor||null,selection:[...this.selection]});}
 renderOverlay(){
  const r=this.renderer,z=r.camera.z,to=p=>r.screen(p),items=r.scene();this.overlay.setAttribute('viewBox',`0 0 ${r.width} ${r.height}`);let svg='';const selected=this.vectorActive?[]:this.selectionItems();const rect=(b,color='#8468dc',dash='')=>{const p=to(b);return`<rect x="${p.x}" y="${p.y}" width="${b.w*z}" height="${b.h*z}" fill="none" stroke="${color}" stroke-width="1.2" ${dash?`stroke-dasharray="${dash}"`:''}/>`;};
  if(this.hover&&!this.selection.has(this.hover)&&!this.drag){const i=items.find(i=>i.n.id===this.hover);if(i)svg+=rect(i.bounds,'#b39ee8');}
  if(selected.length){let positions,box=union(selected.map(i=>i.bounds));
   if(selected.length===1){const i=selected[0],p=[point(i.matrix,0,0),point(i.matrix,i.n.w/2,0),point(i.matrix,i.n.w,0),point(i.matrix,i.n.w,i.n.h/2),point(i.matrix,i.n.w,i.n.h),point(i.matrix,i.n.w/2,i.n.h),point(i.matrix,0,i.n.h),point(i.matrix,0,i.n.h/2)];positions=p.map(to);svg+=`<polygon points="${[0,2,4,6].map(k=>positions[k].x+','+positions[k].y).join(' ')}" fill="none" stroke="#8567d8" stroke-width="1.4"/>`;
   }else{svg+=rect(box);positions=[[0,0],[.5,0],[1,0],[1,.5],[1,1],[.5,1],[0,1],[0,.5]].map(([x,y])=>to({x:box.x+box.w*x,y:box.y+box.h*y}));for(const i of selected)svg+=rect(i.bounds,'#b9a5e9','3 3');}
   if(this.canEdit()&&!selected.some(i=>i.locked)){const names=['nw','n','ne','e','se','s','sw','w'];positions.forEach((p,i)=>svg+=`<rect data-handle="${names[i]}" x="${p.x-4}" y="${p.y-4}" width="8" height="8" rx="1" fill="white" stroke="#8567d8" stroke-width="1.3" style="pointer-events:all;cursor:${names[i]}-resize"/><circle data-handle="${names[i]}" cx="${p.x}" cy="${p.y}" r="9" fill="transparent" style="pointer-events:all;cursor:${names[i]}-resize"/>`);
   if(selected.length===1&&selected[0].n.type!=='frame'){const p=positions[1],c=to(point(selected[0].matrix,selected[0].n.w/2,selected[0].n.h/2)),len=Math.max(1,Math.hypot(p.x-c.x,p.y-c.y)),x=p.x+(p.x-c.x)/len*25,y=p.y+(p.y-c.y)/len*25;svg+=`<line x1="${p.x}" y1="${p.y}" x2="${x}" y2="${y}" stroke="#8567d8"/><circle data-handle="rotate" cx="${x}" cy="${y}" r="5" fill="white" stroke="#8567d8" style="pointer-events:all;cursor:grab"/>`;}}
   const p=to({x:box.x+box.w/2,y:box.y+box.h});svg+=`<rect x="${p.x-38}" y="${p.y+10}" width="76" height="20" rx="5" fill="#8567d8"/><text x="${p.x}" y="${p.y+24}" text-anchor="middle" fill="white" font-size="10" font-family="system-ui">${Math.round(box.w)} × ${Math.round(box.h)}</text>`;
  }
  if(this.drag?.kind==='marquee'){const d=this.drag,p=to({x:Math.min(d.start.x,d.current.x),y:Math.min(d.start.y,d.current.y)});svg+=`<rect x="${p.x}" y="${p.y}" width="${Math.abs(d.current.x-d.start.x)*z}" height="${Math.abs(d.current.y-d.start.y)*z}" fill="#9275d920" stroke="#9275d9"/>`;}
  if(this.drag?.kind==='draw'){const d=this.drag,a=to(d.start),b=to(d.current);if(d.tool==='pen')svg+=`<polyline points="${d.points.map(p=>{const q=to(p);return q.x+','+q.y;}).join(' ')}" fill="none" stroke="#8567d8" stroke-width="2"/>`;else svg+=`<rect x="${Math.min(a.x,b.x)}" y="${Math.min(a.y,b.y)}" width="${Math.abs(a.x-b.x)}" height="${Math.abs(a.y-b.y)}" fill="#9275d925" stroke="#9275d9" stroke-dasharray="4 3"/>`;}
  for(const g of this.guides){const v=g.v*z+(g.axis==='x'?r.camera.x:r.camera.y);svg+=g.axis==='x'?`<line x1="${v}" y1="0" x2="${v}" y2="${r.height}" stroke="#ee8fbe" stroke-dasharray="3 3"/>`:`<line x1="0" y1="${v}" x2="${r.width}" y2="${v}" stroke="#ee8fbe" stroke-dasharray="3 3"/>`;}
  if(this.prototypeMode)for(const i of items.filter(i=>i.n.target&&i.n.action)){const target=items.find(t=>t.n.id===i.n.target);if(!target)continue;const p=to({x:i.bounds.x+i.bounds.w,y:i.bounds.y+i.bounds.h/2}),q=to({x:target.bounds.x,y:target.bounds.y+40});svg+=`<path d="M${p.x} ${p.y} C${p.x+70} ${p.y},${q.x-70} ${q.y},${q.x} ${q.y}" fill="none" stroke="#967bd8" stroke-width="1.5"/><circle cx="${p.x}" cy="${p.y}" r="4" fill="#967bd8"/>`;}
  for(const peer of this.peers.values()){for(const id of peer.selection||[]){const i=items.find(i=>i.n.id===id);if(i)svg+=rect(i.bounds,peer.color,'4 2');}if(peer.cursor){const p=to(peer.cursor);svg+=`<g transform="translate(${p.x} ${p.y})"><path d="M0 0 6 19 10 11 18 8Z" fill="${peer.color}" stroke="white"/><rect x="13" y="17" width="${Math.min(170,peer.name.length*6+16)}" height="22" rx="5" fill="${peer.color}"/><text x="20" y="32" font-family="system-ui" font-size="11" fill="white">${escapeHTML(peer.name)}</text></g>`;}}
  for(const c of this.store.all('comment').filter(c=>!c.thread&&!c.resolved)){const frame=items.find(i=>i.n.id===c.frame),world=frame?point(frame.matrix,c.x,c.y):c,p=to(world);svg+=`<g data-comment="${c.id}" style="pointer-events:all;cursor:pointer" transform="translate(${p.x} ${p.y})"><path d="M0 0H24Q30 0 30 6V22Q30 28 24 28H8L0 35Z" fill="#f5b95d" stroke="#fff" stroke-width="2"/><text x="15" y="19" text-anchor="middle" font-size="12" font-family="system-ui" fill="#704b18">${this.store.all('comment').filter(x=>x.thread===c.id).length+1}</text></g>`;}
  this.overlay.innerHTML=svg;
  this.labels.innerHTML=items.filter(i=>i.n.type==='frame').map(i=>{const p=to(i.bounds);return`<button class="frame-label ${this.selection.has(i.n.id)?'selected':''}" data-frame="${i.n.id}" style="left:${p.x}px;top:${p.y-31}px;width:${Math.max(110,i.n.w*z)}px"><span>${i.n.id===this.store.get('project')?.startFrame?'⌂':'▯'} &nbsp;${escapeHTML(i.n.name)}</span><small>${Math.round(i.n.w)} × ${Math.round(i.n.h)}</small></button>`;}).join('');
 }
}
