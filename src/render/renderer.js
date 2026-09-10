import {WebGPURenderer} from './gpu.js';
import {paintScene} from './paint.js';
import {flatten,intersects,SpatialIndex} from '../core/geometry.js';
export class Renderer{
 constructor(host,store,{onFrame=()=>{},onMode=()=>{}}={}){this.host=host;this.store=store;this.onFrame=onFrame;this.onMode=onMode;this.camera={x:50,y:70,z:.7};this.preview=new Map();this.items=[];this.index=new SpatialIndex();this.dirty=true;this.sceneDirty=true;this.wireframe=false;this.stats={};this.createCanvas();this.unsubscribe=store.on(()=>{this.sceneDirty=true;this.invalidate();});this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(host);this.resize();}
 createCanvas(){this.canvas?.remove();this.canvas=document.createElement('canvas');this.canvas.className='scene-canvas';this.canvas.setAttribute('aria-label','Design canvas');this.host.prepend(this.canvas);}
 async init(){try{if(new URLSearchParams(location.search).get('renderer')==='canvas')throw Error('Canvas mode requested');this.gpu=await WebGPURenderer.create(this.canvas,reason=>this.fallback(reason));this.mode='WebGPU';this.onMode(this.mode);this.invalidate();}catch(e){this.fallback(e.message);}}
 fallback(reason){if(this.mode==='Canvas 2D')return;this.gpu=null;this.createCanvas();this.ctx=this.canvas.getContext('2d',{alpha:true});this.mode='Canvas 2D';this.fallbackReason=reason;this.resize();this.onMode(this.mode,reason);this.invalidate();}
 resize(){const rect=this.host.getBoundingClientRect();this.width=Math.max(1,rect.width);this.height=Math.max(1,rect.height);this.dpr=Math.min(devicePixelRatio||1,2);this.canvas.width=Math.round(this.width*this.dpr);this.canvas.height=Math.round(this.height*this.dpr);this.invalidate();}
 invalidate(){if(this.pending)return;this.pending=requestAnimationFrame(()=>{this.pending=0;this.render();});}
 scene(){if(this.sceneDirty){this.items=flatten(this.store,this.preview);this.index.rebuild(this.items);this.sceneDirty=false;}return this.items;}
 setPreview(map){this.preview=map;this.sceneDirty=true;this.invalidate();}
 render(){if(!this.mode)return;const start=performance.now(),items=this.scene(),view={x:-this.camera.x/this.camera.z,y:-this.camera.y/this.camera.z,w:this.width/this.camera.z,h:this.height/this.camera.z},visible=items.filter(i=>intersects(i.bounds,view)&&i.opacity>0&&intersects(i.bounds,i.clip));
 if(this.gpu)this.stats=this.gpu.render(visible,this.camera,{width:this.width,height:this.height,dpr:this.dpr,wireframe:this.wireframe,invalidate:()=>this.invalidate()})||{};
 else paintScene(this.ctx,visible,{camera:this.camera,dpr:this.dpr,wireframe:this.wireframe,invalidate:()=>this.invalidate()});
 this.stats={...this.stats,visible:visible.length,total:items.length,ms:performance.now()-start};this.host.style.backgroundPosition=`${this.camera.x}px ${this.camera.y}px`;this.host.style.backgroundSize=`${Math.max(8,24*this.camera.z)}px ${Math.max(8,24*this.camera.z)}px`;this.onFrame(this.stats);
 }
 world(p){return{x:(p.x-this.camera.x)/this.camera.z,y:(p.y-this.camera.y)/this.camera.z};}
 screen(p){return{x:p.x*this.camera.z+this.camera.x,y:p.y*this.camera.z+this.camera.y};}
 zoom(z,at={x:this.width/2,y:this.height/2}){z=Math.min(8,Math.max(.04,z));const w=this.world(at);this.camera={x:at.x-w.x*z,y:at.y-w.y*z,z};this.invalidate();}
 fit(b,padding=60){const z=Math.max(.04,Math.min(1.5,(this.width-padding*2)/Math.max(1,b.w),(this.height-padding*2)/Math.max(1,b.h)));this.camera={x:(this.width-b.w*z)/2-b.x*z,y:(this.height-b.h*z)/2-b.y*z,z};this.invalidate();}
 destroy(){this.unsubscribe();this.observer.disconnect();cancelAnimationFrame(this.pending);this.gpu?.destroy();}
}
