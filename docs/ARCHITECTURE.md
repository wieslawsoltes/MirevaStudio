# Architecture — 0.2

## Boundaries and dependencies

The browser is plain HTML/CSS/ES modules. The bundler is a small local script; it embeds those same modules and CSS into one HTML file. Rendering, document operations, vector geometry and format parsing are separate libraries. The Node backend uses only standard-library HTTP, crypto, TLS, zlib, filesystem and SQLite facilities. Browser-native Canvas, WebGPU, workers, IndexedDB, Streams and contenteditable provide platform services.

## Document and collaboration model

A native version-1 document is a map of records. Scene/project/comment fields carry `[logicalClock, actorId]` stamps and merge as last-writer-wins registers. Fields are validated at import, local editing and network boundaries. Record IDs and references have a restricted alphabet; colors and style enums are validated rather than interpolating arbitrary CSS. Record count, image bytes, paths, hierarchy depth and text histories have explicit bounds.

Text, button and input nodes may also contain a versioned character state. Each character has a deterministic identity, a left neighbor, a birth stamp, a visibility register and independent formatting registers. Initial seed characters have stable IDs derived from the seed text. Incoming insertions can be reordered, and placeholders preserve earlier visibility/format operations. Tombstones keep identities stable for offline replicas. The materialized string is derived from the character state, not independently overwritten by a late plain-text field register.

Range formats attach to character identities. Independent marks merge; concurrent writes to the same mark use their stamps. Caret/selection bookmarks reference neighboring identities, so preceding remote insertions do not simply displace an integer cursor. History records which local stamps it owns. Undo compensates only still-owned fields, visibility and marks, leaving newer remote changes intact. A checkpoint restore replaces visible text through new character operations rather than unioning an obsolete text history into the current one.

Ordinary geometry properties remain LWW; simultaneous drag operations are not semantic geometry merges. A deterministic effective-parent projection breaks cycles for traversal. Deep acyclic hierarchies above 128 levels are rejected. Scene flattening and descendant traversal are iterative.

## Durable operation pipeline

1. A room request authenticates its cookie or guest capability and checks current organization/project policy.
2. The server loads the encrypted base snapshot and replays journal entries after its base revision.
3. A write runs in `BEGIN IMMEDIATE`. Affected records are cloned into a fork; the batch is validated and applied there.
4. A monotonically numbered encrypted journal event and a content-hash retry receipt are written transactionally. The response is sent after commit.
5. Every 100 revisions by default, a new encrypted base snapshot is stored. Recent journal entries remain for live catch-up; older history can be removed without losing document state.
6. SSE sends committed edits, snapshots when necessary, identity-bound presence and role changes. Polling the shared local database also observes commits from another OS process. Each reconnect refreshes authorization.

SQLite uses WAL, full synchronous commits, foreign keys and a busy timeout. Application payloads are gzip-compressed then AES-256-GCM encrypted. Accounts, indexes, display names and certain operational metadata remain SQL-readable; this is not whole-database encryption. Key generation publishes a fully written key atomically. A per-process room cache is capped by room count; it is not a universal memory quota.

The supported multi-process topology is one host with one local SQLite file and the same payload key/configuration. No cross-host consensus, network-filesystem support, leader election or multi-region replication is implemented. Presence polling is intentionally simple and should be capacity-tested for the deployed workload.

## Identity and administration

Local accounts require email verification. Passwords use scrypt with a production cost floor. Password resets, email-verification tokens and session credentials are random, purpose-bound and stored as hashes where retrieval is unnecessary. HttpOnly SameSite cookies identify sessions; writes require a session-derived CSRF token. TOTP requires time-window validation and monotonic replay protection, with one-use recovery codes.

OIDC uses operator-configured providers, discovery, authorization codes, PKCE, state/nonce, JWKS signature verification and issuer/audience/time validation. An existing email does not silently link a new external identity. An organization may require a particular provider; enabling this policy requires a session from that provider, and project access checks it again.

Organization owners/admins manage members, policies and shared assets. A member's project role cannot bypass an organization viewer cap or SSO rule. The last owner cannot be removed through member administration. Guest invitations and public prototypes are separately controlled. Audit entries form a hash chain, with retained chain anchors when old entries are deleted. This detects accidental or unauthorized changes only while the database/head are protected; it is not an external immutable audit service.

## Rendering and geometry

WebGPU batches analytic rectangles/ellipses and atlas sprites. The compositor supports transformed rounded ancestor clips. Text, arbitrary paths, images and masks use retained Canvas-rendered atlas content. A separate Canvas 2D renderer survives unavailable adapters or device loss. Text layout is shared with SVG export so mixed font/color runs are not flattened into one style.

The vector library parses SVG path commands, converts arcs/quadratics to cubic representation, computes cubic extrema, splits Bézier segments and exposes adaptive flattening. Boolean operations build and classify a planar arrangement, retain holes and stitch selected boundary edges. The explicit tolerance controls curve flattening. A native Worker keeps this calculation off the main thread and enforces calculation budgets; this is not an exact-predicate CAD kernel.

Anchor editing uses a preview map and commits one transaction on completion. Remote modification of the same path cancels the stale local geometry edit rather than overwriting it blindly. Boolean results retain hidden source operands.

## Formats and isolation

Native JSON and native ZIP retain the complete editable project, including character histories and embedded images. Editable SVG contains validated metadata for its visible exported subset plus ordinary SVG graphics. Untrusted SVG is parsed as a detached XML tree and reconstructed as supported scene primitives: it is never inserted as active markup. ZIP inputs are bounded before and during decompression; local/central headers, filenames, overlaps and CRCs are checked.

The REST JSON and Sketch adapters implement documented subsets and return conversion warnings. Imported fonts refer to installed fonts; font binaries are not bundled. Unsupported scripts, remote resources and opaque binary project formats do not receive a pretend-compatible parser.

Public prototypes use a snapshot and a sandboxed response policy, not the editable live document or its credentials. HTML prototypes implement navigation, overlays, links and triggers, not a generated backend application.

## Model jobs

The browser selects an operator-allowlisted provider; it cannot supply an arbitrary fetch URL. Provider keys stay on the server. Requests support text, image input and optional design context; valid output is a bounded acyclic design schema, not executable HTML. Jobs have budgets, timeout/cancellation, retry behavior and encrypted response history. Only prompt hashes are persisted as job metadata. The provider still receives the submitted content, so deployment-specific data terms and model quality must be reviewed.
