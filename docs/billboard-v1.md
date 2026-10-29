# Line-scan billboards: first pass

Open **Camera setup → Billboards**, or **⋯ → Billboards** on the scan toolbar.
Billboard creation and editing open in a modal over the timing workspace. There is no separate top-level billboard tab. Camera setup can stream an independent
preview without starting a race. The toolbar shortcut opens the same editor over
the current race view without starting or stopping capture.

The layout follows the scoreboard editor: a list of billboards, a preview and
settings for the selected item, and a collapsed **Customize with AI** section. Each
item is a horizontal band repeating through the **entire received line-scan**,
like a virtual LED advertising panel. The default design uses the exact shared
OpenMeet wordmark geometry from the app header, followed by the current meet name.
The meet name follows the loaded meet unless overridden. The initial band is off.

Use **New billboard** for another band. Customize the selected billboard by editing its text/logo or opening **Customize with AI**. The first AI request creates its artwork file automatically. Multiple bands can be visible at once and keep independent positions,
sizes, designs and visibility. The list has a show checkbox and remove button for
every item; **Undo removal** restores the last removed item. Removing all items
keeps the list empty. Existing single-billboard settings migrate into one list item.
Custom artwork can also be deleted separately with an inline confirmation.

Placement is saved per meet and scan camera. **Pattern offset** and **Repeat width**
use original source-time seconds, before start corrections; top and height use
native sensor rows. **Place on scan** closes the editor dialog so the selected band can be dragged directly on the scan. A small placement toolbar provides **Edit design** and **Done**. Its top and bottom handles resize it; the repeat size scales with its height. No drag-mode switch is required. Compact handles remain available outside the editor. Arrow keys move a
focused handle by one source column/row; Shift moves ten. **Bring into view** brings the band into the visible rows without changing its size. Scrolling, zoom, Flip and height
framing only change its projection. The pattern flips with the source image.
Hidden spans preserve the pattern phase from original source columns and retain
time-break markers. Canvas pattern fills keep rendering bounded even when a long
recording contains millions of repeats. Animation is deferred.

Text, colors and a locally imported logo work without a coding agent. **Use
OpenMeet logo** restores the built-in wordmark. **Import design** accepts a local SVG. **Generate design** runs an installed
Muse, Codex or Grok CLI to create one repeat tile, streams output, and keeps an
**Undo last change** snapshot. Add design images for the agent to embed in its SVG.
The static preview shows repeats before a race is recorded.

The billboard respects the selected Runner mask. With Learned selected it uses the matching learned foreground mask if ready; it can
request the existing stopped-capture mask when the configured service is ready.
Live capture, unconfigured services and failures use the existing Simple mask. Selecting Simple keeps that method even if a learned mask is cached.
This applies even if Lanes or its Behind runners preference is off, and changes
neither preference. There is no private inference implementation here. Mask
samples hide artwork over runners; missing mask coverage leaves the original
image visible. Masks remain experimental: disable the billboard for inspecting
uncertain edges. Finish markers, time breaks and rulers remain above the design.

Masking is limited to the artwork's bounded rectangle with an empty-band byte
query before per-pixel work. A 192-pixel overscan cache translates during
horizontal follow/pan; it does not read and rebuild a viewport mask on every
horizontal RAF. Received column changes, source/capture identity, mask request
revision, native geometry, scale, framing, flip and crop projection invalidate the
cache. The received artwork is clipped to the smoothly advancing presentation
edge between packets. Very large full-height artwork and changing zoom still
cost more than small artwork; no real-camera performance claim is made.

## Files and APIs

`engine/billboard/index.js` reuses the existing scoreboard template containment,
asset copy, snapshot/restore and agent runner helpers. It never changes the
scoreboard library. `app/billboard-host.mjs` registers independent engine methods
at `<userData>/billboards`, with folders containing `index.html`, `template.json`,
`assets/billboard.svg`, optional source logos and `.history/`.

- `billboard.list {}` / `billboard.create {name, from?}` / `billboard.delete {name}`.
- `billboard.read {name, asset?}` returns an image data URL (default
  `assets/billboard.svg`), with an 8 MiB limit and contained image path.
- `billboard.addAsset {name, path}` imports a local image.
- `billboard.importSvg {name, path}` validates and installs an SVG, returning an
  undo `snapshotId`.
- `billboard.agent {name, request, preset}` emits `billboard.agentOutput` and
  returns `{code, snapshotId, restored, aborted, error?}`.
- `billboard.restore {name, snapshotId}` restores the named snapshot.

The runner uses exactly `AGENT_PRESETS` from the scoreboard module. No extra
permission, approval-bypass or sandbox flags are added. Its prompt asks for
`assets/billboard.svg` only; the index wrapper must remain intact and continue
loading the scoreboard runtime, as required by the reused runner. A second
billboard check restores the snapshot if the asset is absent/invalid or the
wrapper changes. A nonzero exit with a valid asset remains reviewable and
undoable. cwd/prompt constraints are the existing CLI policy, not an OS sandbox.
Validation checks a complete self-contained SVG shape and rejects scripts,
event handlers, foreign objects and external resources; it is not a complete
XML parser. Standard XML text escapes are supported. SVGs are decoded as images,
never injected into the app DOM. Embedded logos must be raster data images.

`app/renderer/billboard.mjs` owns display settings, drawing, caching, handles and
the library UI. Console integration calls it after original scan drawing and
before timing decorations. No capture pixels, times, lane geometry, model input
assembly, marks, results, or evidence exports depend on billboard settings.
`app/package.json` includes the new host module; the existing JS-only engine
filter includes the library and reused helpers. No dependencies/models are added.

## Verification

Run `node --test app/test/*.test.mjs engine/billboard/*.test.js` for the app
suite, geometry/mask/cache/collection tests, library validation, fake CLI rollback/undo,
separate host RPC and a JS-only packaged-layout test. Run
`node app/test/visual-billboard.mjs` for a disposable headless Electron profile
and random debugging port. It uses generated pixels, fake local mask/crop workers
and a fake Muse executable, stripping inherited provider configuration. It never
connects to or reloads an existing app.

The UI check covers Simple during live capture, learned masking with both lane
preferences off, exact original-canvas restoration when disabled, protected
runner pixels, drag/resize, Flip/zoom, height framing, hidden-time breaks, multiple bands and remove/undo, static
preview, fake build/undo, artwork deletion and unchanged lane preferences. SHA-256 checks preserve
`columns.bin`, `times.f64` and the exact native PNG submitted to the fake mask
worker before/after artwork editing. Timing marks stay identical. Performance
instrumentation reports live RAF cadence and mask rebuild counts, plus a
45-frame pan cache check. These synthetic checks do not establish mask accuracy
or frame rate on actual camera footage, nor validate installed coding CLIs.
