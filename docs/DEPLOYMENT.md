# Deployment and recovery — 0.2

## Local use

```sh
npm start
# http://localhost:4173
npm run check
npm test
npm run build
```

Node 22.16.0 was used for this delivery. The project has no install-time/runtime npm dependencies. Python Playwright and a Chromium executable are needed only for optional browser tests, not to run the application.

The default data path is `.mireva-data` beside the source. Use an absolute `DATA_DIR` outside the web root for a hosted deployment. Never publish that directory, `.env`, SMTP/model/SSO secrets, private backups or the development mail directory.

## Hosted topology

Serve the editor, `/api`, `/auth` and `/p` through the included server on the same public HTTPS origin. Put a trusted TLS reverse proxy in front; keep the Node listener private. Set production mode and its exact origin:

```sh
NODE_ENV=production PUBLIC_ORIGIN=https://design.example.com \
HOST=127.0.0.1 PORT=4173 DATA_DIR=/srv/mireva/private \
node --env-file=.env server/index.mjs
```

Copy `.env.example` to a private `.env` and set appropriate values. Production anonymous room creation is off unless explicitly enabled. Registration may be turned off; otherwise provide a functioning mail transport. A production server without mail cannot pretend that verification messages were delivered.

The reverse proxy must forward the public Host, allow long-lived SSE, disable response buffering on `/api/rooms/*/events`, and limit request bodies/connections. Account cookies use the public origin. Do not put the local data file on NFS or share it between hosts. Multiple Node processes may share the same local SQLite file/key on one host, but separately benchmark the polling/fanout costs. The included test validates two independent processes, not arbitrary cluster size.

The Dockerfile runs as the non-root `node` user with a persistent `/data` volume. Configure secrets at deployment, not in the image. Docker/Pages definitions are included but were not built or deployed in this session. Static Pages publication provides only the local editor; it does not deploy the account/collaboration server.

## Email

Configure SMTP:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=0
SMTP_USER=your-service-user
SMTP_PASSWORD=replace-in-private-environment
MAIL_FROM=Mireva Studio <design@example.com>
```

Port 587 uses STARTTLS; `SMTP_SECURE=1` selects implicit TLS (normally port 465). Production requires secure transport. Alternatively set `MAIL_WEBHOOK_URL=https://your-mail-service.example/send` and optional `MAIL_WEBHOOK_KEY`; the service receives JSON with `to`, `subject`, `text`, `html` and `from` fields and must actually deliver the email. Webhook URLs are operator configuration, not user input. Queued jobs retry transient failures; inspect delivery behavior before inviting a team.

Without these providers, development mode writes private JSON messages under `DATA_DIR/development-mail`. They contain real one-use links for that local server, but are not internet email delivery.

## OIDC SSO

Register an OIDC client at the chosen provider. The redirect URI is exactly:

```text
https://design.example.com/auth/oidc/company/callback
```

Configure the matching ID:

```dotenv
OIDC_PROVIDERS=[{"id":"company","name":"Company sign-in","issuer":"https://identity.example.com/realms/design","clientId":"mireva-client","clientSecret":"replace-secret","tokenAuth":"client_secret_basic"}]
```

The issuer must publish matching discovery and JWKS data and return a verified email claim. Supported token auth modes are the implemented basic/post/none modes; use provider metadata and test with your tenant. RS256 and ES256 identity tokens are accepted with the validation in `server/oidc.mjs`.

Existing local users explicitly link a provider in Workspace → Account & security after reauthenticating. Do not turn an email match into automatic linking. An organization owner may enforce its provider only after signing in through it, so ordinary policy changes do not immediately lock out their author. Test recovery and owner continuity before enforcement.

## Model generation

Configure a provider compatible with one of the implemented request formats. Examples below are operator templates, not credentials or assertions that a particular model is available:

```dotenv
AI_PROVIDERS=[{"id":"design-model","name":"Design model","kind":"chat","url":"https://model.example.com/v1/chat/completions","model":"your-vision-model","key":"replace-secret","vision":true,"timeout":90000}]
```

`kind` may be `chat`, `responses`, or `ollama`; the URL is a full endpoint. Production requires HTTPS. Development permits a loopback model server over HTTP. `vision:true` is a capability declaration and must match the actual model; it does not create image support in a text-only provider. Legacy `AI_URL`, `AI_MODEL`, `AI_KEY` settings are also recognized.

In Workspace → AI, choose the provider, enter a prompt and optionally attach an image/context. Administrators can set an encrypted organization model/key override for a configured provider, but cannot create arbitrary endpoints through the UI. Jobs have status, cancellation, bounded retries, output validation and organization request budgets. Local Compose templates remain available without any model and are explicitly deterministic.

No live external model or tenant credentials were provided during delivery; validate actual transport behavior, model quality and data handling in your environment.

## Backup and restore

Application-encrypted payloads require both a consistent SQLite backup and the correct key. Losing the key loses access to the payloads. Keep it separately in controlled recovery storage, not next to a publicly downloadable database backup.

```sh
DATA_DIR=/srv/mireva/private node server/admin.mjs check
DATA_DIR=/srv/mireva/private node server/admin.mjs backup /secure/backups/mireva-new.sqlite
```

Backup uses the SQLite online backup API and verifies the destination's integrity. It refuses an existing destination. It does not copy the payload key automatically. The default raw key is `DATA_DIR/data.key`. With `DATA_KEY`, retain that exact 32-byte key via your secret manager (hex/base64 input is accepted by the server).

Restore **only to a new empty directory**, never over a running server:

```sh
node server/admin.mjs restore /secure/backups/mireva-new.sqlite \
  /srv/mireva/restored /secure/recovery/data.key
DATA_DIR=/srv/mireva/restored node server/index.mjs
```

The restore command checks database integrity, decrypts stored document/journal/checkpoint/publication payloads and verifies audit chains. Set appropriate ownership/permissions before switching traffic. The supplied test evidence includes an actual local online backup followed by a verified restore into a new directory. Power-loss/device failure, external backup media and disaster-recovery procedures still need environment-specific drills.

## Migration from 0.1

The server imports legacy room JSON into the new database, retaining old capability hashes and checkpoints where present. It renames originals to `.json.migrated-backup`. Those retained originals remain plaintext. Verify the new room state and your backup, then archive/remove the legacy originals according to policy. Existing native document version 1 remains supported; text state is initialized on first character edit.

## Monitoring and limits

`GET /api/health` reports the running storage/features. `GET /api/metrics` requires `Authorization: Bearer <METRICS_KEY>` and reports counts, live connections, cache, jobs, mail and memory. Do not expose its key in the editor. Logs carry request IDs and avoid returning internal SQLite errors to clients.

Default limits include 30,000 records/project, 128 hierarchy levels, 100 MB expanded packed payload, 512 operations/batch, 128 live connections/project, 16 per identity, 1,024 per server process, 8 concurrent model jobs and a 64-room per-process cache. These are bounds, not measured safe capacities. Monitor actual disk/RSS/CPU, tune your external gateway and exercise realistic projects before scaling.


## This repository's GitHub Pages deployment

The `Publish editor to Pages` workflow runs after pushes to `main` and can also be run manually. It checks syntax, runs the Node suite, builds the static editor and uploads only `dist/`. Configure **Settings → Pages → Source → GitHub Actions** if Pages has not been enabled for the repository.

The static build is tagged as local-only so it does not issue account API requests against the shared `github.io` origin. It retains local editing and export capabilities; Workspace explains how to run the backend. The generic standalone `mireva-studio.html` is not tagged static, so it can still use server APIs when served by the included Node server.

`dist/build-info.json` records the package version and build commit. `tests/pages_test.py` starts its own local server under `/MirevaStudio/` and checks project-path startup, insertion/undo, prototype navigation, persistent local saves and the static-hosting notice.
