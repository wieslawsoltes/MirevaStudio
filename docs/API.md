# API map — 0.2

JSON requests use `Content-Type: application/json`. Error responses contain `error`, an HTTP status and a request ID. Successful list endpoints return the named collection rather than an unpaginated universal document dump. The frontend modules are executable examples of request/response usage.

## Authentication

Cookie requests use `credentials: include`. Obtain state/CSRF from `GET /api/auth/me`; attach `X-CSRF-Token` to protected writes. Cookie tokens are not put in project documents or browser IndexedDB. Guest room calls instead use `Authorization: Bearer <invitation-token>` and do not grant organization administration.

| Route under `/api/auth` | Method | Purpose |
| --- | --- | --- |
| `/me` | GET | User, MFA state, CSRF and provider catalog. |
| `/register` | POST | Name/email/password; queue verification. |
| `/verify` | GET or POST | Consume verification token. |
| `/verification/resend` | POST | Request another verification message. |
| `/login` | POST | Local email/password sign-in or pending MFA. |
| `/password/reset/request` | POST | Queue an account recovery message. |
| `/password/reset` | POST | Consume reset token and set password. |
| `/password/change` | POST | Reauthenticated password change. |
| `/mfa/enroll`, `/mfa/confirm` | POST | Begin/confirm authenticator setup. |
| `/mfa/verify`, `/mfa/disable` | POST | Verify pending sign-in or disable after reauthentication. |
| `/profile` | PATCH | Display name. |
| `/sessions` | GET | Active account sessions. |
| `/sessions/:id` | DELETE | Revoke a session. |
| `/logout`, `/logout-all` | POST | Revoke current/all sessions. |
| `/identities` | GET | Linked identity providers. |

OIDC uses `/auth/oidc/:provider/start` and `/auth/oidc/:provider/callback`; explicit linking/unlinking routes validate a current account and reauthentication. See `server/oidc.mjs` for exact payload contracts and provider error handling.

## Organizations

`GET/POST /api/orgs` lists/creates organizations. `POST /api/orgs/accept` consumes an email-bound invitation token after verification. Under `/api/orgs/:id`:

- GET/PATCH/DELETE organization and policies (delete requires explicit confirmation/reauthentication).
- GET `/members`, PATCH/DELETE `/members/:userId`.
- GET/POST `/invites`, DELETE `/invites/:id`.
- GET `/projects` with optional `?archived=true`.
- GET/POST `/library`, GET/PUT/DELETE `/library/:id`; updates carry the previous revision for optimistic concurrency. Payload is a native snapshot for components/templates or a hex-color array for palettes.
- GET `/audit?after=<sequence>&limit=<count>`; DELETE `/audit` applies configured retention while preserving a chain anchor.

Role checks, project/member/storage limits, SSO and last-owner protection run on the server. A UI-hidden control is not the security boundary.

## Projects

`POST /api/rooms` accepts `{snapshot, orgId?}`. Account-owned results include `account:true`; allowed anonymous results include an owner capability. `GET /api/rooms` lists personal projects for a verified user.

Under `/api/rooms/:id`:

| Route | Method | Purpose |
| --- | --- | --- |
| root | GET | Authorized snapshot, revision, role and identity. |
| `/events?client=<id>` | GET | SSE hello, ops/snapshot catch-up, presence, leave and role notifications. |
| `/ops` | POST | `{ops, client, batchId?}`; transactional journal and retry deduplication. |
| `/presence` | POST | Cursor, selection and optional text bookmarks; identity bound to principal. |
| `/invites` | GET/POST | Guest capability administration. |
| `/invites/:id` | DELETE | Revoke a guest grant. |
| `/members` | GET/PUT | Verified account project-role overrides. |
| `/members/:id` | DELETE | Remove an override. |
| `/versions` | GET/POST | List/create checkpoints. |
| `/versions/:id` | GET/DELETE | Read/remove a checkpoint. |
| `/archive` | POST | `{archived:true|false}`. |
| `/publish` | GET/POST | Expiring prototype snapshots. |
| `/publish/:id` | DELETE | Disable/revoke a publication. |
| `/ai/providers` | GET/PUT | Catalog and allowed organization credential/model override. |
| `/ai` | POST | Synchronous generation. |
| `/ai/jobs` | GET/POST | Job history and asynchronous generation. |
| `/ai/jobs/:id` | GET/DELETE | Job result/status or cancellation. |

The prototype URL is `/p/:publicationId`, not direct access to room credentials or database rows.

## Operations

An ordinary operation is `{id, values, stamp:[logicalClock,actorId]}`. Character operations use `kind:"text"`, `id`, `seed`, `stamp`, and bounded `insert`, `visibility` and/or `format` arrays. See `src/core/richtext.js` for the validated atom/mark grammar. Character operations require a text/button/input entity on the server. Packets are not arbitrary JSON Patch, executable scripts or SQL.

`GET /api/health` is a non-secret health/configuration summary. `GET /api/metrics` needs a separately configured metrics bearer key. There is no public backup-download or private-data-directory route.
