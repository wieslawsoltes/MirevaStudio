import json,os,shutil
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
BASE=os.environ.get('MIREVA_URL','http://127.0.0.1:4173/').rstrip('/')+'/'
OUT=Path(os.environ.get('MIREVA_TEST_OUTPUT','test-artifacts'));OUT.mkdir(parents=True,exist_ok=True)
from playwright.sync_api import sync_playwright
results=[]
with sync_playwright() as p:
 b=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome'),headless=True,args=['--no-sandbox'])
 for url in [BASE+'mireva-studio.html?renderer=canvas',(ROOT/'mireva-studio.html').as_uri()+'?renderer=canvas']:
  errors=[];page=b.new_page(viewport={'width':1440,'height':900},bypass_csp=False);page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(url);page.wait_for_function('()=>window.__MIREVA_READY__');assert page.evaluate('()=>mireva.store.all().length')==106
  page.locator('[data-component="button"]').click();assert page.evaluate('()=>mireva.store.all().length')==107
  page.locator('[data-cmd="undo"]').click();assert page.evaluate('()=>mireva.store.all().length')==106
  page.evaluate('()=>mireva.editor.select([])');page.locator('[data-cmd="preview"]').first.click()
  frame=page.locator('#prototype-frame').element_handle().content_frame();frame.wait_for_function('()=>window.mirevaPrototype')
  before=frame.evaluate('()=>mirevaPrototype.screen');frame.locator('[data-action="navigate"]:visible').first.click();assert frame.evaluate('()=>mirevaPrototype.screen')!=before
  page.locator('[data-cmd="close-preview"]').click();page.evaluate('()=>mireva.store.set("project",{name:"Single-file persistence"})');page.evaluate('()=>mireva.saveNow()');page.reload();page.wait_for_function('()=>window.__MIREVA_READY__');assert page.locator('#project-name').inner_text()=='Single-file persistence'
  assert not errors,errors;results.append({'mode':'file' if url.startswith('file:') else 'HTTP','passed':True,'checks':['startup','insert','atomic undo','prototype script','navigation','autosave/reload','no JS errors']});page.close()
 b.close()
print(json.dumps(results,indent=2));open(OUT/'mireva-standalone-results.json','w').write(json.dumps(results,indent=2))
