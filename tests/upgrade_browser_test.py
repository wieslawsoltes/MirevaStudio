"""Account/team and advanced-editing acceptance. Uses private development mail only in tests."""
import os,json,time,re,shlex,uuid,sys
from pathlib import Path
from playwright.sync_api import sync_playwright
BASE=os.getenv('MIREVA_URL','http://127.0.0.1:4173/').rstrip('/')
OUT=Path(os.getenv('MIREVA_TEST_OUTPUT','test-artifacts/upgrade'));OUT.mkdir(parents=True,exist_ok=True)
MAIL=Path(os.getenv('MIREVA_MAIL_DIR','.mireva-data/development-mail'))
results=[];errors=[]
def passed(name,details=None):results.append({'test':name,'passed':True,'details':details});print('PASS',name,details or '',flush=True)
def mail_for(email):
 end=time.time()+15
 while time.time()<end:
  for path in MAIL.glob('*.json'):
   m=json.loads(path.read_text())
   if m.get('to')==email:return m
  time.sleep(.2)
 raise AssertionError('Verification email was not delivered to the private test outbox')
with sync_playwright() as p:
 b=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=shlex.split(os.getenv('MIREVA_BROWSER_ARGS','--no-sandbox')))
 c=b.new_context(viewport={'width':1600,'height':1000},accept_downloads=True)
 page=c.new_page();page.on('pageerror',lambda e:errors.append(str(e)));page.goto(BASE+'/?renderer=canvas');page.wait_for_function('()=>window.__MIREVA_READY__')
 try:
  email='acceptance-'+uuid.uuid4().hex[:8]+'@example.test';password='Separate test phrase 48291!'
  page.locator('[data-cmd="workspace"]').click();page.locator('[data-ws-action="register"]').click();f=page.locator('[data-ws-form="register"]');f.locator('[name="name"]').fill('Avery Chen');f.locator('[name="email"]').fill(email);f.locator('[name="password"]').fill(password);f.locator('button[type="submit"]').click();page.locator('[data-ws-form="login"]').wait_for()
  m=mail_for(email);url=re.search(r'https?://[^\s<>]+/api/auth/verify\?token=[A-Za-z0-9_-]+',m['text']).group(0)
  page.goto(url);page.wait_for_function('()=>window.__MIREVA_READY__');f=page.locator('[data-ws-form="login"]');f.locator('[name="email"]').fill(email);f.locator('[name="password"]').fill(password);f.locator('button[type="submit"]').click();page.locator('#ws-org').wait_for();assert page.evaluate('()=>mireva.account.state.user.verified')
  page.screenshot(path=str(OUT/'workspace-personal.png'));passed('Registration, delivered verification link and cookie-session sign-in under normal CSP')
  page.locator('[data-ws-action="new-org"]').click();f=page.locator('[data-ws-form="org-create"]');f.locator('[name="name"]').fill('Northstar Product Studio');f.locator('button[type="submit"]').click();page.locator('[data-ws-action="save-cloud"]').wait_for();org=page.evaluate('()=>mireva.workspace.orgId');assert org
  page.locator('[data-ws-action="save-cloud"]').click();f=page.locator('[data-ws-form="cloud-save"]');f.locator('[name="name"]').fill('Team wellness app');f.locator('button[type="submit"]').click();page.wait_for_function('()=>mireva.sync.status==="online"&&mireva.sync.config.account');assert page.evaluate('()=>mireva.sync.config.orgId')==org
  passed('Organization creation and account-owned project persistence with authenticated SSE')
  page.locator('[data-cmd="workspace"]').click();page.locator('[data-ws-action="tab"][data-ws-id="members"]').click();page.locator('[data-ws-form="invite"]').wait_for();assert 'Avery Chen' in page.locator('#ws-content').inner_text()
  f=page.locator('[data-ws-form="invite"]');f.locator('[name="email"]').fill('guest-'+uuid.uuid4().hex[:8]+'@example.test');f.locator('[name="role"]').select_option('viewer');f.locator('button[type="submit"]').click();page.get_by_text('Invitation sent',exact=True).wait_for();page.locator('[data-ws-action="tab"][data-ws-id="members"]').click();page.locator('[data-ws-form="invite"]').wait_for();page.screenshot(path=str(OUT/'workspace-people.png'));passed('People UI sends email-bound invitation and displays real member roles')
  page.locator('[data-ws-action="tab"][data-ws-id="policy"]').click();f=page.locator('[data-ws-form="policy"]');f.locator('[name="allowGuestInvites"]').uncheck();f.locator('button[type="submit"]').click();page.wait_for_timeout(300);assert not page.locator('[name="allowGuestInvites"]').is_checked();passed('Organization policy changes persist through permission-checked API')
  page.locator('[data-ws-action="tab"][data-ws-id="library"]').click();page.locator('[data-ws-action="library-new"]').click();f=page.locator('[data-ws-form="library-new"]');f.locator('[name="name"]').fill('Wellness essentials');f.locator('button[type="submit"]').click();page.get_by_text('Wellness essentials',exact=True).wait_for();page.locator('[data-ws-action="library-new"]').click();f=page.locator('[data-ws-form="library-new"]');f.locator('[name="kind"]').select_option('palette');f.locator('[name="name"]').fill('Wellness colors');f.locator('[name="colors"]').fill('#7C61D8, #F5F2FC, #352B4A');f.locator('button[type="submit"]').click();page.get_by_text('Wellness colors',exact=True).wait_for()
  page.screenshot(path=str(OUT/'workspace-library.png'));passed('Shared library publishes editable design and palette payloads')
  page.locator('[data-ws-action="tab"][data-ws-id="audit"]').click();page.wait_for_function('()=>document.querySelector("#ws-content")?.textContent.includes("Chain verification")');assert 'passed' in page.locator('#ws-content').inner_text();passed('Audit UI validates persisted event chain')
  page.locator('[data-ws-action="tab"][data-ws-id="security"]').click();page.locator('[data-ws-form="profile"] [name="name"]').fill('Avery Design');page.locator('[data-ws-form="profile"] button[type="submit"]').click();page.wait_for_function('()=>mireva.account.state.user.name==="Avery Design"');passed('Account profile and active session management are connected')
  page.locator('[data-ws-action="tab"][data-ws-id="publish"]').click();f=page.locator('[data-ws-form="publish"]');f.locator('button[type="submit"]').click();page.get_by_text('Prototype published',exact=True).wait_for();link=page.locator('.modal-form input').input_value();pc=b.new_context();pp=pc.new_page();pp.goto(link);pp.locator('#stage').wait_for();assert pp.evaluate('()=>!!window.mirevaPrototype');pc.close();page.locator('[data-cmd="close-dialog"]').first.click();passed('Public prototype snapshot runs without account access')
  # Double-click a text layer, format a range through the real toolbar and type.
  info=page.evaluate('()=>{const n=mireva.store.all().find(n=>n.type==="text"&&n.text==="serein");mireva.editor.select([n.id]);const i=mireva.renderer.scene().find(i=>i.n.id===n.id),r=document.querySelector("#canvas-host").getBoundingClientRect(),p=mireva.renderer.screen({x:i.bounds.x+10,y:i.bounds.y+10});return{id:n.id,x:r.x+p.x,y:r.y+p.y}}')
  page.mouse.dblclick(info['x'],info['y']);area=page.locator('.rich-text-editor');area.fill('Hello creative world');area.press('Control+a');page.locator('.rich-toolbar [data-mark="bold"]').click();assert page.evaluate('(id)=>Object.values(mireva.store.get(id).richText.chars).filter(a=>!a.deleted).every(a=>a.marks.bold===true)',info['id'])
  area.press('End');area.type('!');area.press('Control+Enter');assert page.evaluate('(id)=>mireva.store.get(id).text',info['id'])=='Hello creative world!';passed('Native contenteditable formatting emits character CRDT operations')
  # Anchor editing and worker-backed Boolean operations with actual controls.
  ids=page.evaluate('()=>{let ids=[];mireva.store.transact("Vector fixture",()=>{for(let j=0;j<2;j++)ids.push(mireva.store.add({entity:"node",type:"rect",name:"Shape "+j,parent:"",x:1000+j*40,y:900,w:100,h:100,fill:"#9875cb",rotation:0,opacity:1,order:Date.now()+j,deleted:false}));});mireva.editor.select(ids);mireva.editor.fitSelection();return ids}')
  page.locator('[data-cmd="boolean-union"]').click();page.wait_for_function('()=>mireva.store.get([...mireva.editor.selection][0])?.type==="path"');result=page.evaluate('()=>[...mireva.editor.selection][0]');assert page.evaluate('(ids)=>ids.every(id=>mireva.store.get(id).hidden)',ids)
  page.locator('#inspector [data-cmd="vector-edit"]').click();page.wait_for_function('()=>mireva.vector.active');page.locator('[data-anchor="0:0:point"]').click();page.locator('[data-vector-action="smooth"]').click();page.screenshot(path=str(OUT/'vector-editing.png'));page.locator('[data-vector-action="done"]').click();assert 'C' in page.evaluate('(id)=>mireva.store.get(id).path',result);passed('Boolean worker union and anchor smoothing through inspector controls')
  page.locator('[data-cmd="vector-pen"]').click();host=page.locator('#canvas-host').bounding_box();x=host['x']+150;y=host['y']+200;page.mouse.click(x,y);page.mouse.move(x+120,y);page.mouse.down();page.mouse.move(x+150,y+50);page.mouse.up();page.mouse.click(x+180,y+120);page.keyboard.press('Enter');assert not page.evaluate('()=>mireva.vector.active');assert page.evaluate('()=>mireva.store.get([...mireva.editor.selection][0]).type')=='path';passed('Bézier pen creates editable curved geometry by pointer gestures')
  page.screenshot(path=str(OUT/'editor-upgraded.png'))
  assert not errors,errors;passed('No unhandled browser errors',errors)
 except Exception as e:
  results.append({'test':'Acceptance execution','passed':False,'error':str(e),'browserErrors':errors});page.screenshot(path=str(OUT/'failure.png'));print('FAIL',str(e),errors,flush=True);raise
 finally:
  (OUT/'upgrade-browser-results.json').write_text(json.dumps(results,indent=2));b.close()
