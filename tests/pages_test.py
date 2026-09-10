"""Verify the built editor under the same project subpath as GitHub Pages.

Requires Python Playwright. A system Chromium/Chrome is used when present;
otherwise install Playwright's Chromium. No application backend is started.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import os
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get("MIREVA_TEST_OUTPUT", "test-artifacts"))
OUT.mkdir(parents=True, exist_ok=True)
assert (ROOT / "dist/index.html").is_file(), "Run npm run build first"

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

results = []
with tempfile.TemporaryDirectory(prefix="mireva-pages-") as temporary:
    site = Path(temporary)
    shutil.copytree(ROOT / "dist", site / "MirevaStudio")
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(site)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            executable = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium") or shutil.which("google-chrome")
            browser = playwright.chromium.launch(executable_path=executable, headless=True, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1440, "height": 900}, bypass_csp=False)
            errors, api_requests = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: api_requests.append(request.url) if "/api/" in request.url else None)
            url = f"http://127.0.0.1:{server.server_port}/MirevaStudio/"
            response = page.goto(url + "?renderer=canvas")
            assert response.status == 200
            page.wait_for_function("()=>window.__MIREVA_READY__")
            assert page.evaluate("()=>mireva.store.all().length") == 106
            assert page.locator('meta[name="mireva-hosting"]').get_attribute("content") == "static"
            page.screenshot(path=str(OUT / "pages-editor.png"))
            results.append("Project-subpath startup with 106 editable sample objects")
            page.locator('[data-component="button"]').click()
            assert page.evaluate("()=>mireva.store.all().length") == 107
            page.locator('[data-cmd="undo"]').click()
            assert page.evaluate("()=>mireva.store.all().length") == 106
            results.append("Component insertion and atomic undo")
            page.locator('[data-cmd="workspace"]').click()
            page.get_by_text("This editor is running without the Mireva server.", exact=True).wait_for()
            page.locator('[data-cmd="close-dialog"]').first.click()
            assert not api_requests, api_requests
            results.append("Server-services notice without requests to GitHub Pages account APIs")
            page.evaluate("()=>mireva.editor.select([])")
            page.locator('[data-cmd="preview"]').first.click()
            frame = page.locator("#prototype-frame").element_handle().content_frame()
            frame.wait_for_function("()=>window.mirevaPrototype")
            before = frame.evaluate("()=>mirevaPrototype.screen")
            frame.locator('[data-action="navigate"]:visible').first.click()
            assert frame.evaluate("()=>mirevaPrototype.screen") != before
            page.locator('[data-cmd="close-preview"]').click()
            results.append("Interactive prototype navigation")
            page.evaluate('()=>mireva.store.set("project",{name:"Pages persistence check"})')
            page.evaluate("()=>mireva.saveNow()")
            page.reload()
            page.wait_for_function("()=>window.__MIREVA_READY__")
            assert page.locator("#project-name").inner_text() == "Pages persistence check"
            results.append("IndexedDB saves persist after reload")
            metadata = page.request.get(url + "build-info.json").json()
            assert metadata["version"] == "0.2.0" and metadata["hosting"] == "static"
            assert page.request.get(url + ".nojekyll").status == 200
            assert not errors, errors
            assert not api_requests, api_requests
            results.append("Build metadata, .nojekyll and no unhandled JavaScript errors")
            page.screenshot(path=str(OUT / "pages-after-edit.png"))
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
report = {"passed": True, "groups": len(results), "checks": results}
(OUT / "pages-results.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
