# Verification report — Mireva Studio 0.2.0

**Executed:** 10 September 2026. This report describes checks that ran against the delivered implementation. It does not substitute protocol fixtures for external provider validation, or local load checks for production certification. Screenshots are captures of the running application, not concepts.

## Environment

| Component | Executed configuration |
| --- | --- |
| Server/runtime | Node.js 22.16.0, npm 10.9.2, Linux; built-in SQLite API |
| Browser | Chromium 144.0.7559.96 on Linux |
| Harness | Python 3.13.5 with Playwright and an installed Chromium executable |
| GPU | Software Vulkan adapter; `isFallbackAdapter: true` |
| Display | Headed Chromium under Xvfb for GPU presentation/readback |
| Viewports | Desktop 1600 × 1000; responsive check 390 × 844 CSS pixels |
| Browser security | Normal CSP enforcement; no `bypass_csp` exemption |
| Accounts/mail | New test accounts, isolated browser cookies, private development outbox |
| Identity/model services | Controlled local HTTP/TCP fixtures; signed RSA/JWKS OIDC responses |
| Collaboration | Actual HTTP/SSE, separate browser contexts, and separately spawned Node OS processes |

A local browser policy allowlist was temporarily needed in this test environment to reach the loopback server and local files. This is not part of the product. No external production account, mailbox, tenant or model credential is included in the source or evidence.

## Results

| Suite/check | Observed result |
| --- | --- |
| `npm run check` | **46 JavaScript modules passed** syntax checking. |
| `npm test` | **57 test cases passed; 0 failed, cancelled, skipped or todo.** This is the Node runner's count including nested subtests. |
| `npm run build` | **25 frontend modules** bundled into the standalone HTML; approximately 384 KiB. |
| Original browser regression | **12 groups passed**, including actual editing, export, prototype navigation, collaboration, offline recovery and permissions. |
| New workspace/editor browser acceptance | **12 groups passed**, including account verification, organization administration, shared palettes, public publishing, native rich text, worker Boolean operations and Bézier pointer gestures. |
| Interchange and CSP browser acceptance | **6 groups passed**, including active-script rejection, SVG round-trip, public REST JSON input and native ZIP reopening. |
| Concurrent native rich-text sessions | Both offline writers' insertions and formatting survived reconnect; replicas converged; caret anchor and selective undo preserved the other writer's work. |
| Standalone HTML | Both **HTTP-served and `file://` modes passed** startup, insertion, atomic undo, prototype script/navigation and autosave/reload. |
| WebGPU readback | The real canvas texture contained **464,724 nontransparent pixels** at **1042 × 856**, format `rgba8unorm`. |
| WebGPU loss | Destroying the device switched to Canvas 2D while retaining all 106 sample nodes. |
| OS-process crash recovery | Two separately spawned Node processes exchanged edits; both were killed with **SIGKILL** after acknowledged writes; a new process replayed SQLite WAL state correctly. |
| Administrative recovery | Online backup restored into a new directory; SQLite integrity, decrypted payloads and audit chain verified. |
| Bounded local load | **8 writers, 1,001 records, 240 acknowledged batches, 0 failures**; final values and revision verified. |

Raw reports are under `docs/test-evidence/`. `build-and-node.log` includes intentional rejection-path server messages: the model fixture returns an invalid parent once, and the unconfigured model endpoint rejects a request. Those messages are expected tests, not hidden suite failures.

## Unit and integration coverage

### Scene, text and vector engines

The original scene tests cover field/resource validation, graph references, concurrent register convergence, duplicate messages, atomic rollback, cycle handling, selective undo/redo, tombstones, transforms/hit testing, clipping, grouping, duplication remapping, constraints/layout, linked styles, template families and a 3,500-node snapshot.

Character-level tests cover concurrent insertions, reordered deletion/formatting packets, independent range marks, Unicode, snapshot merge, plain-text setters producing character operations and local undo that does not remove a concurrent insertion. A checkpoint restoration test verifies that restoring old text creates new character operations instead of incorrectly unioning historical character IDs.

Vector tests cover SVG command normalization, smooth/quadratic/arc conversion, cubic extrema and De Casteljau splitting, all four Boolean operators, holes, identical operands, disjoint islands, shared/touching edges, concave boundaries, tolerance-flattened curves, resizing, and randomized rectangle-area comparison against analytic expectations. These tests do not prove a general exact geometric kernel.

Format tests cover a complete native ZIP snapshot with Unicode and rich text; bounded deflate; CRC errors, ZIP expansion bombs and unsafe paths; public design REST nodes with nested transforms, curves and text ranges; a documented Sketch ZIP structure with attributed text, curves and embedded raster assets; and CSS/color/depth validation.

### Identity, teams and services

Integration tests cover verification and password reset, CSRF, session revocation, TOTP/recovery codes, email-bound team invitations, roles and last-owner protection, SSO policy enforcement, project access, versioned libraries and audit integrity. The OIDC fixture runs a real code/PKCE exchange with discovery, JWKS and signed tokens, including invalid signature/nonce/audience/expiry and reused-state rejection.

SMTP runs through a real local TCP exchange and rejects insecure credential use. Model transport tests send actual HTTP requests to controlled endpoints, including image payloads, structured-output validation, retries, cancellation, usage budgets and persistent job history. They verify integration behavior, **not external model quality, third-party availability or production mail deliverability**.

Persistent collaboration tests cover room credentials, viewer/commenter restrictions, invitation revocation, parallel edits, actual SSE streams, receipt deduplication, invalid-batch atomicity, version checkpoints, encrypted payload storage, journal replay and compaction. The independent-process test is not merely two server objects in one process: it forks two OS processes, observes cross-process event delivery, kills both without graceful shutdown, and opens the same local database in a new process. This remains a local filesystem test, not a power-loss or cross-host consensus test.

## Browser behavior checked

The original 12-group suite exercises canvas startup, element insertion and inspector changes, nudging and history, actual side-grip resizing, duplicate/delete, double-click editing, icon/library use, PNG/SVG/native/HTML downloads, sandboxed preview navigation, IndexedDB persistence, two-way collaboration, presence, offline recovery, comments, read-only protection, responsive/dark UI, GPU initialization and device-loss recovery.

The new 12-group suite registers and verifies an account through an emitted email link, signs in with cookies, creates an organization and cloud project, invites a member, changes a sharing policy, publishes a design library and a palette, checks the audit chain, changes the profile, publishes a prototype that opens without an account, formats a real contenteditable range, executes a Boolean operation through inspector controls, edits an anchor, and draws a Bézier curve with mouse gestures. It checks unhandled browser errors.

The separate rich-text test opens the same text in two actual contenteditables, takes both browsers offline, appends in one and prepends/formats in the other, reconnects, checks identical character state, then exercises anchored typing and selective undo. The test's materialized convergence string is `BABA`, starting from `AB`.

The interchange suite uses the native file input and actual downloads. It imports SVG transforms, cubic paths, clipping, gradient stops and mixed text without executing embedded active content; parses the export as XML; reimports editable metadata; loads a public REST JSON fixture; and exports/reopens a portable ZIP. It also verifies that adding an inline script without the server nonce does not execute.

## Bounded performance observation

`load-check.json` records one synthetic loopback run on this container: 240 edit batches in 426.8 ms, approximately 562.3 batches/second, median request latency 9.27 ms, p95 47.28 ms and maximum 82.16 ms. Reported RSS delta was 40 MB. Each of eight clients sent its own sequence of 30 small updates to a 1,001-record document; final server state and revision 240 were verified.

These are **observations for that exact bounded workload**, not service-level targets, a sustained benchmark, Internet latency, large-document capacity or a claim about 1,024 simultaneous live connections. Measurements will change with hardware, database size, update payload, retention, crypto and traffic patterns. The editor's own render timing is not a physical-GPU frame-rate benchmark.

## Reproduce

The Node checks require only the runtime:

```sh
npm run check
npm test
npm run build
REPORT=./test-artifacts/load-check.json node tests/load_check.mjs
```

Start the server in a separate terminal. Keep test runtime data outside any published static directory:

```sh
PORT=4173 DATA_DIR=/tmp/mireva-acceptance-data npm start
```

Browser harnesses need Python, Playwright and Chromium installed in the test environment; they are development tools, not application runtime dependencies. Chromium must be allowed to reach localhost. Configure the binary using `CHROMIUM_PATH` where supported; `upgrade_browser_test.py` uses `/usr/bin/chromium` directly.

```sh
export MIREVA_URL=http://127.0.0.1:4173/
export MIREVA_MAIL_DIR=/tmp/mireva-acceptance-data/development-mail
export MIREVA_TEST_OUTPUT=./test-artifacts
python tests/upgrade_browser_test.py
python tests/interchange_browser_test.py
python tests/richtext_browser_test.py
python tests/standalone_test.py
```

The original regression suite includes a GPU assertion. Run it and the readback test with a working GPU-capable Chromium configuration. The exact software-Vulkan configuration used here was:

```sh
export DISPLAY=:99
export VK_ICD_FILENAMES=/usr/lib/chromium/vk_swiftshader_icd.json
export MIREVA_HEADLESS=0
export MIREVA_BROWSER_ARGS='--no-sandbox --enable-unsafe-webgpu --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface'
python tests/browser_test.py
python tests/gpu_readback_test.py
```

An Xvfb server must already be running at that display; paths/flags are environment-specific. `--no-sandbox` and unsafe-GPU flags above are test-container settings, not recommended ordinary browsing or production deployment settings.

Backup and restore commands, key handling and production configuration are documented in DEPLOYMENT.md. The checked-in evidence contains a sanitized recovery result, not the backup database, its key, development mail or session cookies.

## Still unverified

No physical-GPU benchmark, Safari/Firefox matrix, real mobile/assistive-technology audit, external identity tenant, delivered production mailbox, live commercial text/vision model, original-application import certification, Docker runtime deployment, multi-region infrastructure, long-duration load soak or independent security penetration test was performed. Generated design quality and complete proprietary file parity are not inferred from successful fixture tests.
