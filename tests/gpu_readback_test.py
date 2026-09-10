import json,os,base64,shlex,shutil
from pathlib import Path
OUT=Path(os.environ.get('MIREVA_TEST_OUTPUT','test-artifacts'));OUT.mkdir(parents=True,exist_ok=True)
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome'),headless=os.environ.get('MIREVA_HEADLESS','0')!='0',args=shlex.split(os.environ.get('MIREVA_BROWSER_ARGS','--no-sandbox')))
 page=b.new_page(viewport={'width':1600,'height':1000},bypass_csp=False)
 page.goto(os.environ.get('MIREVA_URL','http://127.0.0.1:4173/'));page.wait_for_function('()=>window.__MIREVA_READY__');page.wait_for_timeout(700)
 print(page.evaluate('async()=>{const a=await navigator.gpu.requestAdapter();return {mode:mireva.renderer.mode,info:{...a.info,device:a.info.device,description:a.info.description,isFallbackAdapter:a.info.isFallbackAdapter},stats:mireva.renderer.stats}}'))
 page.screenshot(path=str(OUT/'mireva-gpu-headed.png'))
 info=page.evaluate('''async()=>{const r=mireva.renderer,g=r.gpu,d=g.device,w=r.canvas.width,h=r.canvas.height;g.ctx.configure({device:d,format:g.format,alphaMode:'premultiplied',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});r.render();const stride=Math.ceil(w*4/256)*256,b=d.createBuffer({size:stride*h,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});const e=d.createCommandEncoder();e.copyTextureToBuffer({texture:g.ctx.getCurrentTexture()},{buffer:b,bytesPerRow:stride},{width:w,height:h});d.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);const a=new Uint8Array(b.getMappedRange()),c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d'),image=ctx.createImageData(w,h),bgra=g.format.startsWith('bgra');let pixels=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*stride+x*4,o=(y*w+x)*4;image.data[o]=a[i+(bgra?2:0)];image.data[o+1]=a[i+1];image.data[o+2]=a[i+(bgra?0:2)];image.data[o+3]=a[i+3];if(a[i+3])pixels++;}b.unmap();b.destroy();ctx.putImageData(image,0,0);return{pixels,w,h,format:g.format,png:c.toDataURL()};}''')
 open(str(OUT/'mireva-gpu-framebuffer.png'),'wb').write(base64.b64decode(info.pop('png').split(',')[1]));print('FRAMEBUFFER',info)
 open(str(OUT/'mireva-gpu-readback.json'),'w').write(json.dumps(info,indent=2))
 assert info['pixels']>100000, 'GPU framebuffer did not contain the expected artboards'
 b.close()
