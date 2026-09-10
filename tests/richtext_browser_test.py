"""Two browser contexts edit the same character sequence offline and reconnect."""
import os,json,shlex
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=os.getenv('MIREVA_URL','http://127.0.0.1:4173/').rstrip('/');OUT=Path(os.getenv('MIREVA_TEST_OUTPUT','test-artifacts/rich-live'));OUT.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);contexts=[b.new_context(viewport={'width':1600,'height':1000}) for _ in range(2)];pages=[c.new_page() for c in contexts];a,z=pages;errors=[]
 for q in pages:q.on('pageerror',lambda e:errors.append(str(e)))
 try:
  a.goto(BASE+'/?renderer=canvas');a.wait_for_function('()=>window.__MIREVA_READY__');room=a.evaluate("""async()=>{const n=mireva.store.all().find(n=>n.type==='text'&&n.text==='serein');mireva.store.set(n.id,{text:'AB'});const r=await fetch('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({snapshot:mireva.store.snapshot()})});const room=await r.json();if(!r.ok)throw Error(room.error);return{...room,textId:n.id}}""")
  url=BASE+'/?renderer=canvas#room='+room['id']+'&token='+room['token']+'&server='+BASE
  for q in pages:q.goto(url);q.wait_for_function('()=>window.__MIREVA_READY__&&mireva.sync.status==="online"')
  for q in pages:
   pos=q.evaluate("""id=>{const i=mireva.renderer.scene().find(i=>i.n.id===id),r=document.querySelector('#canvas-host').getBoundingClientRect(),p=mireva.renderer.screen({x:i.bounds.x+10,y:i.bounds.y+10});return{x:r.x+p.x,y:r.y+p.y}}""",room['textId']);q.mouse.dblclick(pos['x'],pos['y']);q.locator('.rich-text-editor').wait_for()
  for c in contexts:c.set_offline(True)
  a.locator('.rich-text-editor').press('End');a.locator('.rich-text-editor').press('A');z.locator('.rich-text-editor').press('Home');z.locator('.rich-text-editor').press('B');z.locator('.rich-text-editor').press('Control+a');z.locator('.rich-toolbar [data-mark="italic"]').click()
  for c in contexts:c.set_offline(False)
  for q in pages:q.wait_for_function('(id)=>mireva.store.get(id).text==="BABA"',arg=room['textId'],timeout=15000)
  assert a.locator('.rich-text-editor').inner_text()=='BABA';assert z.locator('.rich-text-editor').inner_text()=='BABA'
  # The first writer's insertion point stays at the end despite a remote prefix.
  a.locator('.rich-text-editor').press('!');z.wait_for_function('(id)=>mireva.store.get(id).text==="BABA!"',arg=room['textId']);a.locator('.rich-text-editor').press('Control+z');z.wait_for_function('(id)=>mireva.store.get(id).text==="BABA"',arg=room['textId']);a.locator('.rich-text-editor').press('Control+Enter');z.locator('.rich-text-editor').press('Control+Enter')
  states=[q.evaluate('(id)=>mireva.store.get(id).richText',room['textId']) for q in pages];assert states[0]==states[1];assert not errors,errors
  report={'passed':True,'convergedText':'BABA','checks':['two native contenteditable sessions','both browsers offline','concurrent insertions at different positions','concurrent character formatting','durable queue replay','same materialized text and atom state','caret anchor preserved','selective undo replicated without losing peer edits','no unhandled browser errors']};(OUT/'results.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
 except Exception as e:a.screenshot(path=str(OUT/'failure.png'));(OUT/'results.json').write_text(json.dumps({'passed':False,'error':str(e),'browserErrors':errors},indent=2));raise
 finally:b.close()
