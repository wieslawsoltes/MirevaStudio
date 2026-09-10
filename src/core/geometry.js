export const IDENTITY=[1,0,0,1,0,0];
export const mul=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
export const point=(m,x,y)=>({x:m[0]*x+m[2]*y+m[4],y:m[1]*x+m[3]*y+m[5]});
export function inverse(m){const d=m[0]*m[3]-m[1]*m[2];return Math.abs(d)<1e-12?IDENTITY:[m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];}
export function localMatrix(n){const a=(n.rotation||0)*Math.PI/180,c=Math.cos(a),s=Math.sin(a),cx=n.w/2,cy=n.h/2;const m=[c,s,-s,c,n.x+cx-c*cx+s*cy,n.y+cy-s*cx-c*cy];return n.transform?mul(n.transform,m):m;}
export function bounds(m,w,h){const p=[point(m,0,0),point(m,w,0),point(m,w,h),point(m,0,h)];const x=Math.min(...p.map(p=>p.x)),y=Math.min(...p.map(p=>p.y));return{x,y,w:Math.max(...p.map(p=>p.x))-x,h:Math.max(...p.map(p=>p.y))-y};}
export function union(rects){if(!rects.length)return{x:0,y:0,w:1,h:1};const x=Math.min(...rects.map(r=>r.x)),y=Math.min(...rects.map(r=>r.y));return{x,y,w:Math.max(...rects.map(r=>r.x+r.w))-x,h:Math.max(...rects.map(r=>r.y+r.h))-y};}
export const intersects=(a,b)=>a.x<=b.x+b.w&&a.x+a.w>=b.x&&a.y<=b.y+b.h&&a.y+a.h>=b.y;
export const contains=(r,p)=>p.x>=r.x&&p.y>=r.y&&p.x<=r.x+r.w&&p.y<=r.y+r.h;
export const intersect=(a,b)=>{const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);return{x,y,w:Math.max(0,Math.min(a.x+a.w,b.x+b.w)-x),h:Math.max(0,Math.min(a.y+a.h,b.y+b.h)-y)};};
export const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));

/** Flatten once per document/preview change, with inherited transforms, opacity, and clips. */
export function flatten(store,preview=new Map()){
  const parents=store.effectiveParents?.(),nodes=store.all(),byParent=new Map(),out=[],visited=new Set();
  for(const raw of nodes){const n={...raw,...preview.get(raw.id)};const p=parents?.get(n.id)??n.parent??'';if(!byParent.has(p))byParent.set(p,[]);byParent.get(p).push(n);}
  for(const list of byParent.values())list.sort((a,b)=>(a.order||0)-(b.order||0)||a.id.localeCompare(b.id));
  const stack=[{parent:'',m:IDENTITY,clip:{x:-1e9,y:-1e9,w:2e9,h:2e9},opacity:1,locked:false,clips:[]}];
  while(stack.length){const state=stack.pop();if(state.item){out.push(state.item);continue;}
    const list=byParent.get(state.parent)||[];
    for(let k=list.length-1;k>=0;k--){const n=list[k];if(visited.has(n.id)||n.hidden)continue;visited.add(n.id);
      const matrix=mul(state.m,localMatrix(n)),b=bounds(matrix,n.w,n.h),item={n,matrix,bounds:b,clip:state.clip,clips:state.clips,opacity:state.opacity*(n.opacity??1),locked:state.locked||n.locked};
      const clips=n.clip||n.maskPath?[...state.clips,{matrix,n}]:state.clips;
      stack.push({parent:n.id,m:matrix,clip:n.clip?intersect(state.clip,b):state.clip,clips,opacity:item.opacity,locked:item.locked});stack.push({item});
    }
  }return out;
}
export class SpatialIndex{
  constructor(cell=256){this.cell=cell;this.cells=new Map();this.large=[];this.items=[];}
  rebuild(items){this.cells.clear();this.large=[];this.items=items;items.forEach((item,i)=>{const b=item.bounds,c=this.cell,x0=Math.floor(b.x/c),x1=Math.floor((b.x+b.w)/c),y0=Math.floor(b.y/c),y1=Math.floor((b.y+b.h)/c);if((x1-x0+1)*(y1-y0+1)>200){this.large.push(i);return;}for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const key=x+','+y;if(!this.cells.has(key))this.cells.set(key,[]);this.cells.get(key).push(i);}});}
  at(p){const ids=[...this.large,...(this.cells.get(Math.floor(p.x/this.cell)+','+Math.floor(p.y/this.cell))||[])];return [...new Set(ids)].sort((a,b)=>b-a).map(i=>this.items[i]);}
  hit(p,{frames=true,locked=false}={}){return this.at(p).find(item=>{const {n,matrix,clip}=item;if((item.locked&&!locked)||(!frames&&n.type==='frame')||n.type==='group'||!contains(clip,p))return false;const q=point(inverse(matrix),p.x,p.y);if(!contains({x:0,y:0,w:n.w,h:n.h},q))return false;if(n.type==='ellipse')return((q.x-n.w/2)/(n.w/2))**2+((q.y-n.h/2)/(n.h/2))**2<=1;return true;});}
}
export function snappedDelta(items,selected,dx,dy,zoom,grid=false){
  const targets=items.filter(i=>!selected.has(i.n.id)&&i.n.type!=='group'),moving=items.filter(i=>selected.has(i.n.id));const b=union(moving.map(i=>i.bounds));let bestX=6/zoom,bestY=6/zoom,sx=dx,sy=dy,guides=[];
  if(grid){sx=Math.round((b.x+dx)/8)*8-b.x;sy=Math.round((b.y+dy)/8)*8-b.y;}
  for(const t of targets){for(const x of [t.bounds.x,t.bounds.x+t.bounds.w/2,t.bounds.x+t.bounds.w])for(const mx of [b.x,b.x+b.w/2,b.x+b.w]){const d=x-(mx+dx);if(Math.abs(d)<bestX){bestX=Math.abs(d);sx=dx+d;guides=guides.filter(g=>g.axis!=='x');guides.push({axis:'x',v:x});}}for(const y of[t.bounds.y,t.bounds.y+t.bounds.h/2,t.bounds.y+t.bounds.h])for(const my of[b.y,b.y+b.h/2,b.y+b.h]){const d=y-(my+dy);if(Math.abs(d)<bestY){bestY=Math.abs(d);sy=dy+d;guides=guides.filter(g=>g.axis!=='y');guides.push({axis:'y',v:y});}}}
  return{dx:sx,dy:sy,guides};
}
