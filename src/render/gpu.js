import {inverse,mul} from '../core/geometry.js';
import {rgba,paintNode} from './paint.js';
// Native SDF shape rasterization. Text, icons, arbitrary SVG paths, and images use a
// retained texture atlas; every visible layer is composited by WebGPU in paint order.
const SHADER=`
struct Item { transform:vec4f, box:vec4f, fill:vec4f, stroke:vec4f, params:vec4f, uv:vec4f, clip:vec4f, second:vec4f, extra:vec4f }
struct View { size:vec2f, zoom:f32, pad:f32, pan:vec2f, unused:vec2f }
@group(0) @binding(0) var<uniform> view:View;
@group(0) @binding(1) var<storage,read> items:array<Item>;
struct Clip { inverse:vec4f, box:vec4f, params:vec4f }
@group(0) @binding(2) var<storage,read> clips:array<Clip>;
@group(1) @binding(0) var atlas:texture_2d<f32>;
@group(1) @binding(1) var smp:sampler;
struct Out { @builtin(position) position:vec4f, @location(0) uv:vec2f, @location(1) world:vec2f, @location(2) @interpolate(flat) index:u32 }
@vertex fn vs(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out {
 let corners=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));
 let uv=corners[vertex];let i=items[instance];let local=uv*i.box.zw;
 let world=vec2f(i.transform.x*local.x+i.transform.z*local.y,i.transform.y*local.x+i.transform.w*local.y)+i.box.xy;
 let p=world*view.zoom+view.pan;var o:Out;o.position=vec4f(p/view.size*vec2f(2,-2)+vec2f(-1,1),0,1);o.uv=uv;o.world=world;o.index=instance;return o;
}
@fragment fn fs(o:Out)->@location(0) vec4f {
 let i=items[o.index];if(any(o.world<i.clip.xy)||any(o.world>i.clip.xy+i.clip.zw)){discard;}
 for(var k=u32(i.extra.y);k<u32(i.extra.y+i.extra.z);k++){let c=clips[k];let p=vec2f(c.inverse.x*o.world.x+c.inverse.z*o.world.y,c.inverse.y*o.world.x+c.inverse.w*o.world.y)+c.box.xy;let half=c.box.zw*0.5;let q=abs(p-half)-half+vec2f(c.params.x);let distance=length(max(q,vec2f(0)))+min(max(q.x,q.y),0.0)-c.params.x;if(distance>0.0){discard;}}
 if(i.params.w>1.5){let t=textureSampleLevel(atlas,smp,i.uv.xy+o.uv*i.uv.zw,0.0);let alpha=t.a*i.params.z;return vec4f(t.rgb*alpha,alpha);}
 let halfSize=i.box.zw*0.5;let p=o.uv*i.box.zw-halfSize;var distance:f32;
 if(i.params.w>0.5){distance=(length(p/max(halfSize,vec2f(0.001)))-1.0)*min(halfSize.x,halfSize.y);}
 else {let r=min(i.params.x,min(halfSize.x,halfSize.y));let q=abs(p)-halfSize+vec2f(r);distance=length(max(q,vec2f(0)))+min(max(q.x,q.y),0.0)-r;}
 let aa=0.75/(view.zoom*max(1.0,view.unused.x));let coverage=1.0-smoothstep(-aa,aa,distance);
 var color=i.fill;if(i.extra.x>0.5){color=mix(i.fill,i.second,select(o.uv.y,o.uv.x,i.extra.x>1.5));}
 if(i.params.y>0.0){let inner=smoothstep(-i.params.y-aa,-i.params.y+aa,distance);color=mix(color,i.stroke,inner);}
 let alpha=color.a*coverage*i.params.z;return vec4f(color.rgb*alpha,alpha);
}`;
class Atlas {
 constructor(device,layout){this.device=device;this.layout=layout;this.size=2048;this.pages=[];this.cache=new Map();this.sampler=device.createSampler({magFilter:'linear',minFilter:'linear'});this.addPage();}
 addPage(){const texture=this.device.createTexture({size:[this.size,this.size],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});const page={texture,x:2,y:2,row:0};page.bind=this.device.createBindGroup({layout:this.layout,entries:[{binding:0,resource:texture.createView()},{binding:1,resource:this.sampler}]});this.pages.push(page);return page;}
 begin(){if(this.pages.length>8||this.cache.size>5000)this.clear();}
 clear(){for(const p of this.pages)p.texture.destroy();this.pages=[];this.cache.clear();this.addPage();}
 get(n,scale,textOnly,wireframe,invalidate,item=null){
  // Position is intentionally excluded: dragging never re-rasterizes a glyph.
  const key=JSON.stringify([n.type,n.w,n.h,n.text,n.fontFamily,n.fontSize,n.fontWeight,n.lineHeight,n.letterSpacing,n.color,n.fill,n.fill2,n.stroke,n.strokeWidth,n.radius,n.align,n.verticalAlign,n.italic,n.underline,n.path,n.pathW,n.pathH,n.fillRule,n.strokeCap,n.strokeJoin,n.strokeDash,n.gradient,n.gradientStops,n.richText,n.icon,n.src,scale,textOnly,wireframe,item?.clips?.filter(c=>c.n.maskPath).map(c=>[c.n.maskPath,mul(inverse(item.matrix),c.matrix)])]);
  if(this.cache.has(key))return this.cache.get(key);
  const s=Math.min(scale,1020/Math.max(n.w,n.h)),w=Math.max(1,Math.ceil(n.w*s)),h=Math.max(1,Math.ceil(n.h*s));let page=this.pages.at(-1);
  if(page.x+w+2>this.size){page.x=2;page.y+=page.row+2;page.row=0;}
  if(page.y+h+2>this.size)page=this.addPage();
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.scale(s,s);for(const c of item?.clips||[]){if(!c.n.maskPath)continue;ctx.transform(...mul(inverse(item.matrix),c.matrix));ctx.clip(new Path2D(c.n.maskPath),c.n.fillRule==='evenodd'?'evenodd':'nonzero');ctx.setTransform(s,0,0,s,0,0);}paintNode(ctx,n,{textOnly,wireframe,invalidate:()=>{this.cache.delete(key);invalidate();}});
  this.device.queue.copyExternalImageToTexture({source:canvas},{texture:page.texture,origin:[page.x,page.y]},{width:w,height:h});
  const sprite={page,uv:[page.x/this.size,page.y/this.size,w/this.size,h/this.size]};page.x+=w+2;page.row=Math.max(page.row,h);this.cache.set(key,sprite);return sprite;
 }
}
export class WebGPURenderer{
 static async create(canvas,onLost){
  if(!navigator.gpu)throw Error('WebGPU is not available');const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('No WebGPU adapter');const device=await adapter.requestDevice();const renderer=new WebGPURenderer(canvas,device,onLost);try{await renderer.init();return renderer;}catch(error){device.destroy();throw error;}
 }
 constructor(canvas,device,onLost){this.canvas=canvas;this.device=device;this.onLost=onLost;this.capacity=0;this.lost=false;device.lost.then(info=>{this.lost=true;this.onLost?.(info.message||'Device lost');});device.addEventListener('uncapturederror',e=>{this.error=e.error.message;console.error('Mireva WebGPU:',this.error);this.onLost?.(this.error);});}
 async init(){const d=this.device;this.ctx=this.canvas.getContext('webgpu');if(!this.ctx)throw Error('Could not acquire a WebGPU context');this.format=navigator.gpu.getPreferredCanvasFormat();this.ctx.configure({device:d,format:this.format,alphaMode:'premultiplied'});
 const mod=d.createShaderModule({label:'Mireva SDF + atlas',code:SHADER});const compilation=await mod.getCompilationInfo();const errors=compilation.messages.filter(m=>m.type==='error');if(errors.length)throw Error(errors.map(e=>e.message).join('\n'));
 this.pipeline=await d.createRenderPipelineAsync({layout:'auto',vertex:{module:mod,entryPoint:'vs'},fragment:{module:mod,entryPoint:'fs',targets:[{format:this.format,blend:{color:{srcFactor:'one',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]},primitive:{topology:'triangle-list'}});
 this.clipCapacity=4096;this.clipBuffer=d.createBuffer({size:this.clipCapacity*48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});this.uniform=d.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.atlas=new Atlas(d,this.pipeline.getBindGroupLayout(1));this.allocate(1024);
 }
 allocate(count){if(count<=this.capacity)return;this.buffer?.destroy();this.capacity=2**Math.ceil(Math.log2(count));this.data=new Float32Array(this.capacity*36);this.buffer=this.device.createBuffer({size:this.data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});this.bind=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.buffer}},{binding:2,resource:{buffer:this.clipBuffer}}]});}
 render(items,camera,{width,height,dpr=1,wireframe=false,invalidate=()=>{}}){
 if(this.lost)return;this.atlas.begin();const clipValues=[];for(const item of items){item.clipStart=clipValues.length/12;for(const c of item.clips||[]){if(c.n.maskPath)continue;const m=inverse(c.matrix);clipValues.push(m[0],m[1],m[2],m[3],m[4],m[5],c.n.w,c.n.h,Math.min(c.n.radius||0,c.n.w/2,c.n.h/2),0,0,0);}item.clipCount=clipValues.length/12-item.clipStart;}if(clipValues.length/12>this.clipCapacity){this.clipBuffer.destroy();this.clipCapacity=2**Math.ceil(Math.log2(clipValues.length/12));this.clipBuffer=this.device.createBuffer({size:this.clipCapacity*48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});this.capacity=0;}const commands=[];let scale=Math.max(.25,Math.min(2,Math.ceil(camera.z*dpr*4)/4));
 const push=(item,kind,sprite=null,overrides={})=>commands.push({item,kind,sprite,...overrides});
 for(const item of items){const n=item.n;if(n.type==='group'||n.type==='hotspot')continue;
  if(['frame','rect','ellipse','button','input'].includes(n.type)&&!(n.gradientStops?.length>2)&&!n.strokeDash&&!item.clips?.some(c=>c.n.maskPath)){
   if((n.shadow||n.type==='frame')&&!wireframe)for(let j=3;j>0;j--)push(item,0,null,{shadow:j});
   push(item,n.type==='ellipse'?1:0);
   if(n.text&&['button','input'].includes(n.type))push(item,2,this.atlas.get(n,scale,true,wireframe,invalidate,item));
  }else push(item,2,this.atlas.get(n,scale,false,wireframe,invalidate,item));
 }
 this.allocate(Math.max(1,commands.length));let idx=0;
 for(const {item,kind,sprite,shadow}of commands){const {n,matrix:m,clip,opacity}=item,off=idx++*36;const fill=shadow?[.13,.09,.22,.018]:rgba(wireframe&&kind<2?'#ffffff':n.fill);const stroke=rgba(wireframe?'#9a96a4':n.stroke);const pad=shadow*2||0;
 this.data.set([m[0],m[1],m[2],m[3],m[4]-pad,m[5]-pad+(shadow?4:0),n.w+pad*2,n.h+pad*2,...fill,...stroke,(n.radius||0)+pad,shadow?0:wireframe?1:n.strokeWidth||0,opacity,kind,...(sprite?.uv||[0,0,0,0]),clip.x,clip.y,clip.w,clip.h,...rgba(n.fill2||n.fill),wireframe?0:n.gradient==='horizontal'?2:n.gradient==='vertical'?1:0,item.clipStart,item.clipCount,0],off);
 }
 if(clipValues.length)this.device.queue.writeBuffer(this.clipBuffer,0,new Float32Array(clipValues));this.device.queue.writeBuffer(this.uniform,0,new Float32Array([width,height,camera.z,0,camera.x,camera.y,dpr,0]));if(commands.length)this.device.queue.writeBuffer(this.buffer,0,this.data,0,commands.length*36);
 const enc=this.device.createCommandEncoder(),pass=enc.beginRenderPass({colorAttachments:[{view:this.ctx.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.bind);
 let start=0,drawCalls=0;
 while(start<commands.length){const page=commands[start].sprite?.page||this.atlas.pages[0];let end=start+1;while(end<commands.length&&(commands[end].sprite?.page||this.atlas.pages[0])===page)end++;pass.setBindGroup(1,page.bind);pass.draw(6,end-start,0,start);drawCalls++;start=end;}
 pass.end();this.device.queue.submit([enc.finish()]);return{instances:commands.length,drawCalls,atlasPages:this.atlas.pages.length};
 }
 destroy(){this.lost=true;this.atlas?.clear();this.buffer?.destroy();this.clipBuffer?.destroy();this.uniform?.destroy();this.device.destroy();}
}
