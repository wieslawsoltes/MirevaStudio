# Security model — 0.2

This is implemented defense-in-depth, not an independent penetration-test report or compliance certification.

## Authentication and sessions

Passwords use scrypt (`N=131072, r=8, p=1` production floor), independent salts and constant-time digest comparison. Hash concurrency is bounded. Password length is bounded; a small weak-password list is only an additional guard, not a breached-password database. Verification and recovery use random expiring one-use tokens. Session tokens are hashed at rest; cookies are HttpOnly, SameSite=Lax and Secure in production. Mutating account/org requests require a session-derived CSRF token. Session revocation and organization access are rechecked by live connections.

TOTP enrollment requires reauthentication, the secret is encrypted and confirmed before activation, previously used steps cannot be replayed, and recovery codes are one-use hashes. OIDC uses PKCE, nonce, browser-bound one-use state and validated signed claims. Account linking is explicit; matching an email alone cannot seize an existing account. Only configured issuer/endpoint providers are allowed.

## Authorization

Organization and project permissions are enforced by the server, not just disabled controls. Last-owner protections, identity-bound member invitations, SSO-required policies, guest-sharing restrictions and public-prototype switches are applied across corresponding routes. Commenters cannot edit another identity's comments or design nodes. Guest capability links are still bearer credentials: treat them as secrets, choose the least privileged role and revoke them when no longer needed.

## Data handling

Document bases, journal payloads, checkpoints, library payloads, public snapshots, model results, mail jobs, MFA material and provider secrets use context-bound AES-256-GCM encryption where their modules require retrievable secrets. Compression is applied to document payloads before encryption. Passwords, sessions, invitation tokens and recovery tokens are hashed where retrieval is not required.

This is not full-database encryption. User emails, display names, project names, audit descriptions, presence, role indexes, job metadata and other operational columns may be readable to the database owner. Use encrypted storage and access-controlled backups for those fields. Possession of the database and its payload key defeats at-rest secrecy. No built-in key rotation service is supplied.

The data directory is private on creation, key/database files use restricted permissions, and the server serves an explicit static-file allowlist. It does not expose the database, development email directory, environment file, source server modules or backups. A legacy migration retains original JSON files as `.migrated-backup`; those original copies are plaintext. After independently verifying migration and backups, archive or securely remove them according to your storage policy.

## Browser and input controls

The server uses nonces for executable page scripts, disallows inline event-handler attributes, sends nosniff/referrer/permissions policies, and enables HSTS in production. Prototype snapshots use a sandbox without same-origin access. Styles remain inline-capable because the editor/prototype has dynamic per-node styles. Downloaded standalone exports do not automatically inherit the server's security headers.

SVG is parsed detached and reconstructed; scripts/foreignObject and remote resources do not become active DOM. ZIP names, offsets, size budgets and CRCs are checked. The scene schema rejects arbitrary CSS style values and non-embedded image URLs. Vector and text workloads have finite budgets. Geometry workers have cancellation/time bounds. General oversized valid data can still consume CPU/memory; request limits and workload monitoring are required.

## Server controls

Origin checks and cookie CSRF checks protect writes; production validates its configured public Host. Global/API-specific rate controls, finite body sizes, timeouts, bounded live sessions, model-job limits and SQL transactions are included. Organization payload quotas include journal entries, checkpoints, publications, libraries and model responses, not just live room snapshots. Quotas do not predict exact filesystem/WAL, index or metadata overhead; monitor actual disk usage.

The reverse proxy must retain the public Host, avoid buffering SSE, enforce an external request/body/connection policy and provide TLS. The app does not blindly trust X-Forwarded-For. Behind a proxy, IP-based counters can therefore aggregate users; design and test upstream per-user/per-IP controls rather than enabling spoofable forwarded headers. An operator-supplied metrics bearer key gates `/api/metrics`.

## Mail and models

SMTP supports implicit TLS or required STARTTLS; production does not intentionally send credentials over cleartext. An HTTPS webhook is another configurable delivery mechanism. Development email files are not proof of delivery to a real mailbox.

Model URLs are allowlisted by the operator; a browser cannot select an arbitrary internal URL. Keys stay on the server and are masked in catalog output. Generation results are validated data rather than executable provider HTML. Model prompts/screenshots still leave the application when a provider is used. Review provider storage/privacy, tenant restrictions and output quality before enabling confidential work.

## Operational verification required

Review the deployment with your security team before exposing it publicly. Test real email and identity providers, configure the domain/TLS, back up both database and key, restore a copy, monitor resource usage and apply runtime patches. The delivered tests exercise protocol and authorization behavior but cannot establish the absence of every vulnerability. Billing, regulated retention, data-erasure workflows, external immutable audit storage and enterprise compliance are not included.

Primary references: OIDC Core https://openid.net/specs/openid-connect-core-1_0.html ; OWASP password guidance https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html ; OWASP authentication guidance https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html ; Node SQLite API https://nodejs.org/api/sqlite.html .
