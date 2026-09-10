# File compatibility — 0.2

## Native formats

`.mireva` is version-1 JSON with validated record fields and field stamps. It includes embedded raster assets, project settings, scene nodes, comments and character histories. Importing it replaces the current local document after saving it, disconnects from the previous shared project and creates a new local project identity.

`.mireva.zip` contains `manifest.json` and `document.mireva`. It is an actual bounded ZIP, not JSON with a ZIP extension. Export/import preserves the complete native snapshot. It does not embed server account sessions or invitations. Assets remain data URLs inside the native document in this release.

## SVG

**Export:** ordinary vector graphics plus an optional `mireva-editable` metadata element. The graphics include transformed shapes and cubic paths, clips, gradient stops, dash patterns, embedded images and mixed text styles. Other SVG consumers may ignore Mireva metadata.

**Editable import:** validated Mireva metadata recreates the visible exported subset with new record IDs. This is not a full-project backup: hidden content, omitted selections, comments and server state are not included by a visible SVG export. Use the native document/package for a complete project.

**General SVG import:** nested groups, affine transforms, common presentation/CSS properties, rect/circle/ellipse/line/polyline/polygon/path, cubic/quadratic/arc commands, text/tspan style runs, local `use` references, embedded raster images, principal-axis linear gradients and supported user-space clips. A viewBox is transformed to the viewport. Scripts and embedded HTML are not executed. External declarations, external images and unsafe resources are rejected or omitted.

Positioned tspans become one editable flow. Nested SVG viewports are grouped with a warning; advanced filter effects, radial/pattern/mesh gradients, complex gradient transforms, object-bounding-box clip semantics, arbitrary font embedding, alpha/luminance masks and all CSS layout rules are not exact round-trip features. Complex paths are normalized into the cubic editor representation. Arc primitives are represented as cubic approximations.

## Documented design REST JSON

Import a file-response JSON with a `document` tree, or the supported document/root node tree. Supported nodes include frames/sections, groups/components/instances, rectangles, ellipses, text, lines and path-equipped vector/Boolean shapes. Nested transforms, sizes, fills/strokes, typography, character style overrides, embedded component references and legacy navigation references are mapped into editable records.

For the public Figma REST schema, request `geometry=paths` so the result contains vector paths, local sizes and `relativeTransform`; absolute bounds alone cannot uniquely reconstruct rotated geometry. Image-reference URLs are not fetched automatically. Multiple paints, complex effects, masks, advanced layout modes and external component libraries produce warnings or limited representations. Import does not require a browser-stored third-party access token; obtain an authorized JSON export separately.

The binary `.fig` archive is **not** this documented REST schema and is rejected explicitly. No private API or undocumented endpoint is invoked.

## Sketch ZIP

The adapter reads the documented ZIP structure: `document.json`, referenced `pages/*.json`, layers and embedded images. Supported subset: artboards, groups, symbol masters/instances with embedded children, rectangles/ovals, attributed text, shape paths, common transforms/styles and prototype destination references.

Embedded supported bitmap encodings are converted into validated data URLs. Text ranges become character formatting. Paths retain editable cubic handles. External symbol libraries, complete override semantics, arbitrary effects/masks and all modern document fields are not reconstructed. No native Sketch export is claimed. JSON/schema-compatible fixture tests are included; no original-application fidelity certification was performed.

## ZIP safety

Inputs are capped at 80 MB, 5,000 members, 30 MB per expanded member and 80 MB total expanded content. Excessive compression ratios, directory traversal, duplicate paths, overlapping members, inconsistent headers, CRC mismatches, encryption, unsupported compression and ZIP64/multivolume archives are rejected. Deflate is decompressed with a bounded stream. Files are not extracted to arbitrary filesystem locations.

## Primary specifications consulted

- Sketch documented archive structure: https://developer.sketch.com/file-format/
- Figma public REST node schema: https://developers.figma.com/docs/rest-api/file-node-types/
- SVG path and coordinate-system specifications: https://www.w3.org/TR/SVG2/paths.html and https://www.w3.org/TR/SVG2/coords.html

These specifications identify the interchange representation. They do not establish that this implementation covers every field or that private product project formats are equivalent to exported SVG/JSON.
