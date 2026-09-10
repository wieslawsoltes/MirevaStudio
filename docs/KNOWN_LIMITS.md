# Capability boundaries — 0.2

The previous missing-account, whole-text overwrite, whole-room rewrite and absent-vector-tool boundaries have been substantially replaced by working systems. The distinctions below remain important.

## Implemented in this release

Verified local accounts, recovery, revocable sessions, MFA, OIDC SSO/linking, organizations and roles, email invitations, shared libraries, policy/budget administration, audit retention, public prototype snapshots, character-level collaborative editing, range formatting, Bézier controls, four vector Boolean operations, an encrypted incremental SQLite journal, multi-process local synchronization, backup/restore and expanded interchange adapters are implemented and exercised by the included tests.

## Not claimed complete

**Private-format parity:** native Mireva round-trip is supported. Editable SVG, documented design REST JSON and Sketch ZIP adapters are implemented subsets. A private binary `.fig` parser, another service's private project database/API, arbitrary proprietary archives, native third-party export and exact all-feature round-trip are not implemented. Unsupported input receives an error or conversion warnings, not a renamed JSON file presented as compatibility.

**Hosted platform:** no billing/subscription engine, customer-support service, SCIM provisioning, SAML assertion service, custom enterprise identity-policy engine, organization domains/DNS verification, managed service-level agreement or multi-region failover is provided. OIDC is the implemented SSO protocol. Account deletion/data-erasure orchestration and verified email-address changes need further product workflows; profile name, password, sessions, recovery and MFA are available.

**External verification:** actual SMTP protocol, signed OIDC and HTTP model transports were exercised using controlled local fixtures. No external tenant/client secret, outbound production mailbox service or live text/vision provider credential was supplied. Consequently delivered model quality, provider-specific edge cases, reputation/deliverability and a real tenant login are not asserted as tested. Configure and test these before inviting users.

**Operations/security:** SQLite is local-host storage, not cross-host consensus. Multiple processes on one machine can share its local file, but network filesystems, multi-region replicas, sustained 1,024-connection workloads and long-duration production traffic were not certified. The cache has a room-count cap, not a total-byte LRU. SQL metadata is not encrypted by the application payload key. Full-disk encryption, secret management, reverse-proxy limits, retention/backups, dependency/runtime patching, disk monitoring and an independent audit remain deployment responsibilities. Audit hashes are not a substitute for an externally protected log. Automatic key rotation is not supplied.

**Text:** character CRDT histories are bounded (100,000 atoms and 20,000 visible characters per element). There is no coordinated tombstone garbage-collection epoch for indefinitely offline replicas. Pasted input is plain text; arbitrary rich HTML clipboard conversion, full bidirectional/complex-script shaping controls, collaborative IME behavior on every device, custom fonts and typography fidelity across browser engines are not certified. Geometry and comments are still field-register edits rather than character/geometry CRDTs.

**Vectors/rendering:** Boolean boundaries are tolerance-flattened polylines; input Bézier editing preserves cubic handles. Exact curved Boolean reconstruction, a general arrangement theorem-proof kernel, pressure-sensitive brushes, sophisticated mesh/alpha/luminance masks, advanced filters and color-management are not implemented. Native GPU geometry is hybrid with raster text/path/image atlases. Their bounded texture resolution can soften very large zooms. Physical GPU, Safari/Firefox, physical touch devices and complete accessibility have not been audited.

**Layout/components/prototypes:** row/column auto-layout supports gap/padding/alignment/stretch, not a complete responsive solver. Imported wrap/hug/justify metadata is retained but not fully evaluated by the layout engine. Linked component instances propagate styles/dimensions; structural master edits and independent property overrides are not a complete component-variant system. Prototype navigation is interactive, but it is not a generated database, authentication backend or arbitrary application state machine. PDF/video export is not included.

**Interchange detail:** SVG text positioning, unsupported CSS/filter/mask behavior, third-party symbol overrides, remote image references, complex gradients and external fonts can require conversion or manual correction. See FORMAT_COMPATIBILITY.md for the precise supported subsets. The Sketch fixture conforms to documented structure, but import was not certified by opening an exported project in the original application.

