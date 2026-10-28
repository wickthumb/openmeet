# OpenMeet desktop

Use Node 22.12+ (Node 26 also works). From the repo root:

```sh
npm --prefix app ci
npm --prefix app start
npm --prefix engine test
```

Installers land in `app/dist/`, with version and architecture in every filename:

```sh
npm --prefix app run dist        # this OS, configured architectures
npm --prefix app run dist:win    # x64: NSIS setup + portable exe (Windows host)
npm --prefix app run dist:mac    # arm64 + x64: dmg (macOS host)
npm --prefix app run dist:linux  # x64 + arm64: AppImage + deb (Linux host)
npm --prefix app run pack -- --linux --arm64  # unpacked smoke-test build
node app/test/smoke-packaged.mjs app/dist/linux-arm64-unpacked/openmeet
```

The smoke test uses Node's built-in WebSocket and headless Chromium/CDP to call the
packaged utility-process engine; it fails unless `ping` returns `core: true`.
The engine ships as `resources/app/engine/` (JS + package.json only). Asar is
disabled so the utility process can load ESM directly; dev still loads `../engine/`.
Builds are unsigned, never published, and have no auto-updater. On macOS,
Gatekeeper needs **right-click → Open** on OpenMeet after copying it from the DMG.

Pushes to `blueprint-v1` and `packaging`, and **Actions → Build installers → Run
workflow**, build all three OSes. Download `OpenMeet-Windows-installers`,
`OpenMeet-macOS-installers`, or `OpenMeet-Linux-installers` from the run's
**Artifacts** section within 14 days. Windows installation and RunMeet shared-folder
interoperability still need hands-on testing on Windows.

## Operator controls

Capture stops manually by default. Before a heat, expand **Capture options** to enable timeout or all-runners-marked auto-stop. **Stop capture** is always available during a run. The simulator continues streaming empty-track columns after its prerecorded finish window.

Click a finish column, type a roster number, then Enter; multiple digits are supported. Drag hairlines to edit, or delete and replace them. **Starts** keeps trigger history and changes the elapsed-time origin without moving finish columns. Save corrected heats again to update LIF files.

Both camera views have **Lanes ▾** appearance controls. On the line-scan, **Edit boundary lines** lets you drag a single shared edge or its number. The adjacent lane heights change while every other edge stays fixed; lines cannot cross. Numbers identify the lane immediately below the edge. Old band-based profiles are reconciled into shared boundaries. Lane overlays are saved per meet/camera and do not change the private timing service's calibration.

**Guides behind runners** is on by default. A compact display mask compares incoming pixels with an initial empty-track reference, allowing guides to remain on the background while athletes cover them. The check tolerates small background noise; shadows and lighting changes can also hide guides, and similar foreground/background colors can be missed. This is display processing, not a timing or identity model. Finish hairlines remain visible above the image. Original capture pixels and timestamps are unchanged.

The mask compensates for broad lighting changes and requires coherent foreground support, rather than treating isolated pixel noise as an athlete. Tests cover noise, lighting, shadows, thin limbs, overlaps and streaming tile seams. On the eight current demo strips, the measured empty-window guide interruption rate fell from 10.72% to 1.41%; this is a fixture diagnostic, not a real-camera accuracy claim. Remaining weaknesses include coherent background changes, very low-contrast clothing, and ambiguity between a dark garment and a shadow. The feature remains optional.

Private model weights, training data and inference implementations are never bundled. Only API clients and the labelled simulator stand-in ship with the app. CI checks the public source boundary before building.

Review a suggested finish directly in the sidebar with **Accept time**; selection centers and zooms the scan. **Lane / Finish** changes roster order. **Follow live** resumes tracking the newest columns at the current zoom after scrolling.

The compact red **Restart** control stays beside the main race action. During capture it reads **Stop/reset** and offers **Stop capture** or **Stop & restart** in a confirmation dialog. Restart retains the old capture and prepares a new attempt. Earlier attempts can be selected in the Race panel during the session; full capture restoration across app restarts remains future work. Each saved attempt gets a LIF snapshot alongside its raw capture.

Choose the top **Camera alignment** tab before a race to stream a preview for alignment and overlay placement. The label follows the terminology in the [FinishLynx Camera Alignment Tools manual](https://support.finishlynx.com/manual/finishlynx/features/additional-features/camera-alignment-tools). Switch between **Alignment** (with a center crosshair) and **Overlays**, or pause the preview to adjust guides on a still image. **Return to race** or the **Run** tab stops preview and restores the selected heat. Preview does not create a capture directory, start trigger or race result, and keeps only a rolling image buffer in memory. This build previews simulated input; physical camera drivers remain planned.

Front-camera overlay setup supports a chosen lane count, first/last placement and perspective sizing, followed by individual refinement. The line-scan overlay has an independent, opt-in **Lane guides in model input** switch. This creates a derived image containing horizontal lane boundaries only, records preprocessing in `model-inputs.jsonl`, and leaves original pixels and timestamps untouched. It makes no claim of improved model accuracy.

Front-camera scrubbing uses available indexed demo frames, a cache of at most 48 decoded frames, and nearby-frame prefetch. Cached frames paint on the next draw; stale loading completions cannot replace the latest requested frame. Hovering also works during capture, and leaving the scan resumes live playback. Video-only recordings retain a coalesced seek fallback; they do not have the same cache-hit latency. Guide-mask paths are reused while the viewport stays fixed so pointer movement does not recompute segmentation.

## Multiple line-scan views

Choose **Main line-scan** and **Comparison** in Camera alignment or Network. These are roles assigned to source identities, not fixed first/second hardware slots. The prototype discovers `primary.png/json`, `backup.png/json`, and additional `scan-<name>.png/json` pairs per demo heat. A metadata `camera_name` supplies a readable label. Each source retains its own pixel height, lane profile and column period; overlay placement is saved per camera. New captures record their source identity in `source.json`. A role change prepares new captures; earlier attempts retain their recorded main source.

The comparison view follows the main scan's visible race-time interval and vertical image fraction. For example, the middle 50% of a 2000-row image maps to the middle 50% of a 1000-row image even when their panels have different widths. Zooming the main scan relinks the comparison; independent comparison pan/zoom remains available, with double-click to relink. Normalized image regions do not imply pixel-perfect athlete correspondence between different camera angles.

This is simulated source selection. Real concurrent camera drivers, shared hardware-clock verification, finish-location/race-direction profiles and camera-specific geometric alignment remain integration work.

## Visual regression check

After installing the app dependencies, run the real Electron preview against a local demo meet:

```sh
node app/test/visual-cameras.mjs "$PWD/app" /path/to/demo /tmp/openmeet-visual-check
```

The check captures every demo heat with both scan roles, normal/flipped direction, and zoom. Screenshots stay local. Use it alongside `npm --prefix app test` and `npm --prefix engine test`; the synthetic tests also check native resolutions, clock periods, cache eviction and stale-request handling. Actual camera footage and additional hardware still require validation.
