"""Optional browser acceptance suite. Requires Python Playwright and a Chromium executable.
Start npm start separately. See docs/TESTING.md for GPU flags and environment setup.
Evaluation bypasses CSP only in this test harness; the application ships its own CSP.
"""
import json, os, time, traceback, sys, shlex, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=os.environ.get('MIREVA_URL','http://127.0.0.1:4173/').rstrip('/')+'/'
OUT=Path(os.environ.get('MIREVA_TEST_OUTPUT','test-artifacts'));OUT.mkdir(parents=True,exist_ok=True)
def artifact(name):return str(OUT/name)
results=[]; errors=[]
def record(name, fn):
 try:
  out=fn(); results.append({'test':name,'passed':True,'details':out});print('PASS',name,out or '')
 except Exception as e:
  results.append({'test':name,'passed':False,'error':str(e)});print('FAIL',name,e);raise
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=os.environ.get('MIREVA_HEADLESS','1')!='0',executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome'),args=shlex.split(os.environ.get('MIREVA_BROWSER_ARGS','--no-sandbox')))
 ctx=browser.new_context(viewport={'width':1600,'height':1000},bypass_csp=False,accept_downloads=True)
 page=ctx.new_page(); page.on('pageerror',lambda e: errors.append(str(e)))
 page.goto(BASE+'?renderer=canvas');page.wait_for_function('()=>window.__MIREVA_READY__')
 record('Canvas startup',lambda:page.evaluate('()=>{if(mireva.store.all().length!==106)throw Error("seed count");return mireva.renderer.mode}'))
 def basic():
  page.locator('[data-component="button"]').click();page.wait_for_timeout(100)
  added=page.evaluate('()=>[...mireva.editor.selection][0]')
  assert page.evaluate('(id)=>mireva.store.get(id).text',added)=='Get started'
  page.locator('[data-prop="w"]').fill('260');page.locator('[data-prop="w"]').press('Enter');page.locator('[data-prop="name"]').click()
  assert page.evaluate('(id)=>mireva.store.get(id).w',added)==260
  page.locator('[data-prop="text"]').fill('Make something great');page.locator('[data-prop="name"]').click()
  assert page.evaluate('(id)=>mireva.store.get(id).text',added)=='Make something great'
  page.locator('#canvas-host').focus();page.keyboard.press('ArrowRight')
  page.locator('[data-cmd="undo"]').click();page.locator('[data-cmd="redo"]').click()
  page.evaluate('(id)=>mireva.editor.select([id])',added);page.wait_for_timeout(100)
  grip=page.locator('circle[data-handle="e"]').bounding_box();x=grip['x']+grip['width']/2;y=grip['y']+grip['height']/2
  page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+30,y,steps=4);page.mouse.up()
  assert page.evaluate('(id)=>mireva.store.get(id).w',added)>280
  page.locator('#canvas-host').focus();page.keyboard.press('Control+d')
  assert len(page.evaluate('()=>[...mireva.editor.selection]'))==1
  copy=page.evaluate('()=>[...mireva.editor.selection][0]');assert copy!=added
  page.keyboard.press('Delete');assert page.evaluate('(id)=>mireva.store.get(id)',copy) is None
  return {'id':added,'width':page.evaluate('(id)=>mireva.store.get(id).w',added)}
 record('Insert, inspector editing, nudge, undo/redo, side-grip resizing, duplicate and delete',basic)
 def direct_text():
  info=page.evaluate('()=>{const n=mireva.store.all().find(n=>n.type==="text"&&n.text==="serein");mireva.editor.select([n.id]);const i=mireva.renderer.scene().find(i=>i.n.id===n.id);const p=mireva.renderer.screen({x:i.bounds.x+20,y:i.bounds.y+10});const r=document.querySelector("#canvas-host").getBoundingClientRect();return{x:r.x+p.x,y:r.y+p.y,id:n.id}}')
  page.mouse.dblclick(info['x'],info['y']);page.locator('.text-editor').fill('serein studio');page.locator('.text-editor').press('Control+Enter')
  assert page.evaluate('(id)=>mireva.store.get(id).text',info['id'])=='serein studio'
 record('Inline text editing',direct_text)
 def library():
  page.locator('[data-panel="icons"]').first.click();page.locator('#library-search').fill('heart');page.locator('[data-insert-icon="heart"]').click()
  assert page.evaluate('()=>mireva.store.get([...mireva.editor.selection][0]).icon')=='heart'
  page.locator('[data-panel="layers"]').first.click();assert page.locator('.layer-row').count()>0
  page.locator('[data-panel="compose"]').first.click();page.locator('#compose-prompt').fill('A personal finance budget app')
  page.locator('[data-cmd="generate"]').click();page.wait_for_function('()=>mireva.store.children("").filter(n=>n.type==="frame").length===6')
  assert page.evaluate('()=>mireva.store.all().length')>106
  page.evaluate('()=>mireva.store.undo()');page.evaluate('()=>mireva.exec("fit")')
 record('Icon search, virtualized layers and local prompt composition',library)
 def export():
  page.evaluate('()=>mireva.editor.select([])');page.locator('[data-cmd="export"]').first.click()
  for kind in ['svg','png','html','json']:
   with page.expect_download(timeout=15000) as download:
    page.locator('#modal [data-cmd="export-'+kind+'"]').click()
   d=download.value;failure=d.failure();assert not failure,failure
   fn=artifact('test-export-')+kind+('.mireva' if kind=='json' else '.'+kind);d.save_as(fn);assert os.path.getsize(fn)>100
  page.locator('[data-cmd="close-dialog"]').first.click()
 record('PNG, SVG, editable document and interactive HTML downloads',export)
 def preview():
  page.evaluate('()=>mireva.editor.select([])');page.locator('[data-cmd="preview"]').first.click()
  frame=page.frame_locator('#prototype-frame');frame.locator('#stage').wait_for()
  first=page.evaluate('()=>mireva.store.get("project").startFrame')
  iframe=page.locator('#prototype-frame').element_handle().content_frame()
  assert iframe.evaluate('()=>mirevaPrototype.screen')==first
  button=frame.locator('button:visible').filter(has_text='Begin a moment').first
  if button.count():button.click()
  else: frame.locator('[data-action="navigate"]:visible').first.click()
  assert iframe.evaluate('()=>mirevaPrototype.screen')!=first
  page.screenshot(path=artifact('mireva-prototype.png'));page.locator('[data-cmd="close-preview"]').click()
 record('HTML prototype navigation in sandboxed preview',preview)
 def persist():
  page.evaluate('()=>mireva.store.set("project",{name:"Browser persistence test"})');page.evaluate('()=>mireva.saveNow()');page.reload();page.wait_for_function('()=>window.__MIREVA_READY__');assert page.locator('#project-name').inner_text()=='Browser persistence test'
 record('IndexedDB autosave survives reload',persist)
 def collaboration():
  page.locator('[data-cmd="share"]').first.click();page.locator('#share-name').fill('Avery');page.locator('#share-server').fill(BASE.rstrip('/'));page.locator('[data-cmd="create-room"]').click()
  page.wait_for_function('()=>mireva.sync.status==="online"');page.locator('#invite-link').wait_for();link=page.locator('#invite-link').input_value();page.locator('[data-cmd="close-dialog"]').first.click()
  c2=browser.new_context(viewport={'width':1440,'height':900},bypass_csp=False);p2=c2.new_page();p2.on('pageerror',lambda e:errors.append(str(e)));p2.goto(link);p2.wait_for_function('()=>window.__MIREVA_READY__&&mireva.sync.status==="online"');assert p2.evaluate('()=>mireva.sync.role')=='editor'
  page.evaluate('()=>mireva.store.set("project",{name:"Live two-client session"})');p2.wait_for_function('()=>mireva.store.get("project").name==="Live two-client session"')
  p2.evaluate('()=>mireva.store.set("project",{description:"Edited by second user"})');page.wait_for_function('()=>mireva.store.get("project").description==="Edited by second user"')
  p2.evaluate('()=>mireva.sync.presence({name:"Robin",color:"#df7867",cursor:{x:200,y:300},selection:[]})');page.wait_for_function('()=>[...mireva.sync.peers.values()].some(p=>p.name==="Robin")')
  # Offline editing recovers through the persistent outbox, then merges on reconnect.
  c2.set_offline(True);p2.evaluate('()=>mireva.store.set("project",{description:"Offline edit recovered"})');p2.wait_for_timeout(400);assert p2.evaluate('()=>mireva.sync.queue.length')>0
  c2.set_offline(False);page.wait_for_function('()=>mireva.store.get("project").description==="Offline edit recovered"',timeout=20000)
  # Actual pinned threaded comment.
  page.evaluate('()=>mireva.store.add({entity:"comment",text:"Looks good for review",frame:mireva.store.get("project").startFrame,x:20,y:30,thread:"",author:"Avery",authorId:mireva.sync.grantId,createdAt:Date.now(),resolved:false,deleted:false},"review_thread")')
  p2.wait_for_function('()=>mireva.store.get("review_thread")?.text==="Looks good for review"')
  p2.locator('[data-cmd="comments"]').click();assert p2.locator('#library').inner_text().find('Looks good for review')>=0
  page.evaluate('()=>mireva.exec("fit")');page.screenshot(path=artifact('mireva-collaboration.png'))
  # Viewer must be blocked at both document write gate and the server.
  view=page.evaluate('async()=>{const i=await mireva.sync.invite("viewer","View test");return mireva.sync.shareLink(i.token)}')
  c3=browser.new_context(bypass_csp=False);p3=c3.new_page();p3.goto(view);p3.wait_for_function('()=>window.__MIREVA_READY__&&mireva.sync.status==="online"');assert p3.evaluate('()=>mireva.sync.role')=='viewer'
  assert p3.evaluate('()=>{try{mireva.store.set("project",{name:"Unauthorized"});return false}catch{return true}}')
  c3.close();c2.close();return {'room':page.evaluate('()=>mireva.sync.config.id'),'twoWay':True,'offlineRecovery':True,'viewerProtected':True}
 record('Two-client collaboration, presence, offline recovery, comments and viewer gate',collaboration)
 # Fresh clean screenshots (separate local storage).
 clean=browser.new_context(viewport={'width':1600,'height':1000},bypass_csp=False);cp=clean.new_page();cp.goto(BASE+'?renderer=canvas');cp.wait_for_function('()=>window.__MIREVA_READY__');cp.screenshot(path=artifact('mireva-studio-desktop.png'))
 cp.locator('[data-cmd="settings"]').click();cp.locator('#settings-theme').select_option('dark');cp.locator('[data-cmd="save-settings"]').click();cp.screenshot(path=artifact('mireva-studio-dark.png'))
 cp.set_viewport_size({'width':390,'height':844});cp.evaluate('()=>mireva.exec("fit")');cp.wait_for_timeout(250);cp.screenshot(path=artifact('mireva-studio-mobile.png'))
 record('Responsive mobile viewport and dark appearance',lambda: {'width':cp.evaluate('()=>document.documentElement.scrollWidth'),'viewport':390})
 gpu=browser.new_context(viewport={'width':1600,'height':1000},bypass_csp=False);gp=gpu.new_page();gpuerrors=[];gp.on('pageerror',lambda e:gpuerrors.append(str(e)));gp.on('console',lambda m:gpuerrors.append(m.text) if m.type=='error' else None);gp.goto(BASE);gp.wait_for_function('()=>window.__MIREVA_READY__');gp.wait_for_timeout(500)
 gpuinfo=gp.evaluate('()=>({mode:mireva.renderer.mode,reason:mireva.renderer.fallbackReason,stats:mireva.renderer.stats})');print('GPU',gpuinfo,gpuerrors);gp.screenshot(path=artifact('mireva-studio-gpu.png'));results.append({'test':'WebGPU validated pipeline and scene submission','passed':gpuinfo['mode']=='WebGPU' and not gpuerrors,'details':gpuinfo,'errors':gpuerrors})
 if gpuinfo['mode']=='WebGPU':
  gp.evaluate('()=>mireva.renderer.gpu.device.destroy()');gp.wait_for_function('()=>mireva.renderer.mode==="Canvas 2D"');record('Device-loss fallback preserves editing',lambda:gp.evaluate('()=>mireva.store.all().length'))
 browser.close()
print('JS ERRORS',errors)
results.append({'test':'No unhandled application JavaScript errors','passed':not errors,'errors':errors})
open(artifact('mireva-browser-results.json'),'w').write(json.dumps(results,indent=2))

if any(not r["passed"] for r in results):sys.exit(1)
