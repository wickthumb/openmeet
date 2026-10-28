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

Both camera views have **Lanes ▾** appearance controls. Lane overlays are decorative and are saved per meet/camera. They do not change the private timing service's calibration.

Private model weights, training data and inference implementations are never bundled. Only API clients and the labelled simulator stand-in ship with the app. CI checks the public source boundary before building.

Review a suggested finish directly in the sidebar with **Accept time**; selection centers and zooms the scan. **Lane / Finish** changes roster order. **Follow live** resumes tracking the newest columns at the current zoom after scrolling.

Use **Restart race** under Capture options to retain the old capture and prepare a new attempt. Earlier attempts can be selected in the Race panel during the session; full capture restoration across app restarts remains future work. Each saved attempt gets a LIF snapshot alongside its raw capture.

Front-camera overlay setup supports a chosen lane count, first/last placement and perspective sizing, followed by individual refinement. The line-scan overlay has an independent, opt-in **Lane guides in model input** switch. This creates a derived image containing horizontal lane boundaries only, records preprocessing in `model-inputs.jsonl`, and leaves original pixels and timestamps untouched. It makes no claim of improved model accuracy.
