# OpenMeet v1 design blueprint

Status: first pass, Oct 28 2026. This is the plan, not a description of working software.

The clickable layout replica is [docs/mockup/index.html](mockup/index.html). Open it in any browser; it needs no network access.

- In the replica, every device, every athlete and the auto-timing service are simulated.
- Add `?speed=4` to the URL to run heats four times faster.

## 1. What v1 does

v1 runs the timing side of a meet:

1. Load the next heat.
2. Arm.
3. Receive the start.
4. Capture the finish line-scan.
5. Mark finishes, by hand or from auto-timing proposals.
6. Set DNS, DNF and DQ.
7. Save results to the shared folder.
8. Move to the next heat.

The bar is "times the meet very well". That means never losing capture data, being exact to the column, and being fast to the next heat.

| v1 does | v1 leaves to the meet manager or to later |
|---|---|
| Heat loading from the meet manager's start lists | Entries, seeding, lane draws (RunMeet / Hy-Tek) |
| Arm / start / capture / review / save state per heat | Scoring, team points, publishing results (RunMeet) |
| Line-scan view: scroll, zoom, mark, nudge | Field events (AthleticFIELD / LynxPad) |
| DNS / DNF / DQ / FS per athlete | Distance races, lap counting, bib reading (later) |
| Auto-timing proposals with operator accept/override | Real camera drivers (later; v1 uses simulated cameras) |
| Writing LIF results files RunMeet already imports | Scoreboards and video boards (later) |

## 2. How it fits with RunMeet: the shared folder

Athletic.net RunMeet is cloud meet operations. Its Windows bridge, AthleticLOCAL, already talks to FinishLynx through plain files in one folder. That folder protocol is published by both FinishLynx and Athletic.net. Hy-Tek Meet Manager, MeetPro and OpenTrack use the same protocol. If OpenMeet speaks it exactly, every one of those systems works with OpenMeet on day one, with no changes on their side.

```
RunMeet (cloud) ⇄ AthleticLOCAL (Windows) ⇄ Meets folder ⇄ OpenMeet
                    writes lynx.evt/.ppl/.sch     ←read      ←watch
                    uploads *.lif                 written→   ←write
```

**Files OpenMeet reads.** The meet manager owns these, and OpenMeet never writes them. They are comma-delimited plain text; `;` starts a comment line, and a field containing a comma is double-quoted.

| File | Line layout |
|---|---|
| `lynx.evt` (start lists) | Header: `event, round, heat, event name, [wind], [wind unit], template, capture time, capture duration, distance, [start time], wind mode, laptime info` |
| | Competitor line, starting with `,`: `,ID, lane, last, first, affiliation, ...` (lane blank or 0 = no lane) |
| | A pre-set status line starts with `\`: `\DNS,22,2,Jones,Bob` |
| `lynx.ppl` (people) | `ID, last, first, affiliation, license, user1, user2, user3` |
| `lynx.sch` (schedule) | `event, round, heat`, in run order. A missing round or heat defaults to 1. It drives Next and Previous. |

**File OpenMeet writes**, one per heat: `EEE-R-HH.lif`, for example `003-1-01.lif`.

- Header line: `event, round, heat, event name, wind, wind unit, , , , , start time-of-day`
- Result line: `place, ID, lane, last, first, affiliation, time, license, delta, reaction time, "splits", time-trial start, user1, user2, user3, ...`
- Times are written in **thousandths**, as AthleticLOCAL requires (FinishLynx "Time Precision: Thousandths"). RunMeet does the official round-up to hundredths.

The layouts above were checked against FinishLynx's database-file manual and against public LIF samples from djmorton42/LifTools and nimarion/OmegaDH-Client. One open item: we need a FinishLynx-written LIF that contains DNS/DNF/DQ to confirm the status column before the first real meet.

**Folder rules**, from FinishLynx and Athletic.net guidance:

- The folder lives on the timing computer, so a network drop never stops timing.
- On Windows, the meet-software computer maps it as a drive letter. AthleticLOCAL rejects `\\server\share` paths.
- Use a fresh folder per meet.
- OpenMeet writes LIFs atomically: it writes to `.tmp`, then renames, so AthleticLOCAL never reads half a file.
- Re-saving a heat rewrites its LIF, which is how corrections reach RunMeet.

**What OpenMeet does with the folder:**

- It watches `lynx.evt`. RunMeet's "Listen Live" rewrites the file when seeding changes. If the loaded heat changed after it was armed, the sidebar shows a warning with the differences. It never swaps silently.
- It keeps every capture and decision in its own `openmeet/` subfolder, next to the meet manager's files and never mixed into them.

**Should we decompile AthleticLOCAL?** No.

- The file protocol is already documented. Decompiling adds licence and terms-of-service risk and teaches us nothing we need for v1.
- We test it as a black box instead: run AthleticLOCAL against an OpenMeet folder, upload to a test RunMeet meet, and confirm that times and statuses import. This is the v1 acceptance test (section 9).
- If we later want deeper integration, such as a push API, we ask Athletic.net for partner access.

## 3. Architecture: engine + console

The timing work and the screen are split, so a UI crash, a browser tab, or a slow laptop can never cost capture data.

The engine is Node in an Electron utility process (decision, Oct 28: see section 7). It is a library with no UI and no Electron imports, so it also runs headless. Real camera drivers that need native speed come later, as Node native add-ons or a small sidecar binary behind the same camera protocol.

```
┌──────────────── OpenMeet Engine (one local process) ────────────────┐
│ Camera drivers ─▶ Capture store (append-only, per heat)              │
│   sim-replay, sim-render; later GigE Vision / USB3 Vision / vendor    │
│ Timebase: start pulse = T0, column → time, time-of-day               │
│ Heat state machine          Meet link: folder watch, parse, LIF write │
│ Auto-timing client (API)    Accessories: front cam, wind, scoreboard  │
│ Console API: HTTP + WebSocket (line-scan tiles, state events)         │
└───────────────────────────────▲───────────────────────────────────────┘
                                │ localhost (or the camera LAN for a 2nd station)
┌───────────────────────────────┴───────────────────────────────────────┐
│ OpenMeet Console (web UI): header · sidebar · workspace · line-scan    │
└────────────────────────────────────────────────────────────────────────┘
```

**Capture store.**

- Columns are appended in chunks with their hardware timestamps, plus a JSON sidecar per heat.
- It never rewrites data in place. Marks and statuses are an event log on top of the raw capture, so every result can be traced back to the columns it came from.

**Timebase.**

- Every column carries the camera's timestamp. T0 is the start pulse.
- Time = column timestamp − T0. The column index is never assumed to be a fixed rate.
- The selected-column readout shows exactly this value.

**Heat state machine:** `Loaded → Armed → Running → Review → Saved`.

- Save is blocked until every athlete has a time or a status (DNS, DNF, DQ, FS, SC).
- `Saved → Reopened → Saved` keeps the history and rewrites the LIF.
- Save then auto-loads the next heat in `lynx.sch` and arms it.

## 4. The simulated camera (v1's only camera)

A simulated camera is a driver like any other. It sends the same messages a real camera will, so nothing above the driver knows it is simulated:

```
hello {model, rows, column period, colour}
start_pulse {hw_time}
columns {first_hw_time, period, n, bytes}
end
```

| Source | What it replays | Ground truth |
|---|---|---|
| **sim-replay** | A real photo-finish image from the web. It is turned to native orientation (time increasing to the right). The time axis comes from its printed scale, or is inferred from the finishers' official times, and it is streamed at that rate. | Official results from the same meet |
| **sim-render** | A race from the TTP simulator (render-g): configurable lanes, speeds, lean and occlusion | Exact, from the simulator |

**The demo meet uses sim-render.** render-g renders four heats from one set of 3D runners:

- the primary line-scan, with the camera outside lane 8;
- a backup line-scan from the infield side;
- a front camera placed past the finish, looking back up the straight;
- the lane-line rows at the finish plane, which the lane overlay draws.

The backgrounds are synthetic, so no real meet imagery appears in a public video. The meet's `lynx.evt/.ppl/.sch` files come with the renders.

The truth file goes only to an evaluation harness and is never shown in the console. With it we can measure the two numbers that matter, automatically, per heat:

- times delivered correctly (to the hundredth, after round-up), with the right athlete;
- operator time from the last finisher to "Saved".

Real drivers come after v1:

- GigE Vision and USB3 Vision line-scan cameras, which are open standards.
- Vendor cameras, only where their protocol is documented or licensed.

### Camera flexibility: native scans and video-derived scans

**Architecture decision, Oct 28.** A finish source need not be a dedicated photo-finish camera. A supported area-scan camera, USB camera or Raspberry Pi camera can supply frames from which OpenMeet samples a calibrated finish-line strip. Operators can use the same review, marking, start assignment and comparison views. Physical adapters remain planned until their integration details are verified; the present executable uses simulated input.

| Source kind | Original evidence | Derived view |
|---|---|---|
| Native line-scan | Original columns, source timestamps and clock identity | Time-indexed scan |
| Area-scan / video | Original received frames, exposure timestamps, sequence numbers and source settings | A sampled finish-line strip referencing each original frame |
| Replay / simulator | Source raster or frames plus replay timing metadata | The same operator views, clearly labelled simulated |

Each adapter advertises its capabilities instead of relying on a camera's brand: supported resolutions and native rates, pixel formats, sensor ROI limits, exposure controls, global/rolling shutter, timestamp meaning, start-trigger support and clock synchronization. Unsupported capabilities are shown as unavailable. Camera identity, finish location and recording role are separate from the view an operator selects.

**Capture modes and alignment.** Camera alignment shows the full available frame and lets the operator position the sampling line or narrow strip at the finish plane. Store this calibration as a versioned recipe: source ID, frame size, endpoints, strip width, sampling rule and direction. A video-derived column references its frame ID and timestamp; averaging a strip or drawing it wider never creates extra temporal samples. The original received frames remain available for review. Several cameras can have independent resolutions, rates, clocks and finishes; only views mapped to the same finish and verified timebase are linked as timing comparisons.

**Sensor ROI and view zoom are separate controls.** A sensor ROI changes what the device reads/transmits; display Zoom changes only what the operator sees. Basler documents that reducing sensor ROI, especially its height, can increase frame rate on supported models. The achievable rate still depends on the device and settings. A narrow vertical strip is therefore not a universal speed boost. See [Basler Image ROI](https://docs.baslerweb.com/image-roi) and [Resulting Acquisition Frame Rate](https://docs.baslerweb.com/resulting-acquisition-frame-rate). Raspberry Pi exposes camera modes and requested frame rates; select an available mode, then measure the delivered timestamps and dropped frames. See [Raspberry Pi camera mode controls](https://github.com/raspberrypi/documentation/blob/master/documentation/asciidoc/computers/camera/rpicam_options_common.adoc) and [video controls](https://github.com/raspberrypi/documentation/blob/master/documentation/asciidoc/computers/camera/rpicam_options_vid.adoc).

**Timing evidence.** 60 fps samples about every 16.67 ms; 100 fps every 10 ms; 300 fps every 3.33 ms. These intervals are not accuracy guarantees. Store exposure duration, timestamp origin (sensor or host arrival), rolling-shutter readout where available, dropped-frame gaps, and the mapping to the meet's start clock. Display the measured rate and timing limitations. Do not interpolate missing frames or duplicate columns and present them as measured finish times. Private model processing is a separate API and must explicitly support the source type, sampling interval and calibration. The current fixed-period replay path must gain per-sample clock handling before claiming support for variable-rate or unsynchronized live cameras.

**Storage and starts.** Original evidence is append-only. Zoom, overlays and derived scans are reversible recipes; no view operation removes pixels. Start triggers remain meet-wide events and can be reassigned without rewriting source times. Continuous all-day recording and compression are under separate research; no storage ceiling is promised. Hardware packet details, discovery and controls will be bound to these contracts once the camera/scoreboard integration breakdown is available.

## 5. Screen layout

The replica is in `docs/mockup/`.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ HEADER: OPENMEET · tabs (Run, Network, Meet Link, Auto-Timing, Settings) │
│         · status: camera LAN, meet folder, internet, auto-timing API      │
├──────────────┬───────────────────────────────────────────────────────────┤
│ SIDEBAR      │ OPERATOR WORKSPACE                                        │
│ event + heat │ race clock/info · front camera · backup line-scan ·       │
│ controls     │ accessories · auto-timing proposals                       │
│ warning      ├───────────────────────────────────────────────────────────┤
│ lanes /      │ LINE-SCAN BAR: selected-column timestamp (only, for now)  │
│ athletes /   │ LINE-SCAN: scroll, zoom, mark finishes               │
│ status       │                                                           │
└──────────────┴───────────────────────────────────────────────────────────┘
```

**Labels.** Labels that only repeat what the screen already shows are removed: the "Selected column" caption, the per-panel SIM and IP tags (they live in Network), the list header row, and duplicate state text.

**Header.**

- System status is quiet: a dot and a word per system, with detail on hover. Only a problem gets colour and words.
- OpenMeet settings open as a panel over the workspace. They never cover the line-scan or the sidebar, because the operator must not lose the race view mid-heat.
- **Network** has two separate networks:
  - the closed-loop camera LAN (static IPs; camera and accessory devices);
  - the internet uplink (RunMeet, auto-timing API).
- **Meet Link** shows the folder path, the files found, and the last LIF written, with a preview.
- **Auto-Timing** shows the endpoint, the model version, the policy and the status.
- Other options will be added once we agree on them.

**Sidebar** (≈330 px):

- current event, round and heat, with its place in the schedule;
- controls: previous/next heat, arm or disarm, start (simulated start system), save, and an **Auto-arm** switch that arms each heat as soon as it loads, which includes the automatic move to the next heat after a save;
- one warning slot, for the most important problem;
- athletes by lane, with bib, name, school and status (pending, time, DNS, DNF, DQ). Statuses are set from the row.

**Workspace** (top half): a running clock and race info, accessory camera streams (a front-facing camera), a backup line-scan, a list of accessories with their status, and the auto-timing proposals.

The workspace is a **tiling layout, like Hyprland**: a split tree, so panels never overlap.

- Drag a panel's header onto another panel: the centre swaps them, and an edge splits that side.
- Drag the gaps between panels to resize.
- Close a panel with its ×, and bring it back from the + control in the corner, which also resets the layout.
- Double-click a header to maximise that panel.
- The layout is saved per computer.

**Line-scan** (bottom region, full width minus the sidebar).

Drag the horizontal divider above it to change workspace and scan heights. Both regions keep a usable minimum height; the scan cannot become a side-by-side panel. The split is remembered per computer. Keyboard Up/Down adjusts the divider; Home/End reaches the limits; Enter restores an even split.

Click the main scan's camera name or the comparison card's camera name to choose a source. During review, the selected view changes while the original recording and finish times remain intact. Different camera heights and sampling periods are mapped through race time. Calibrated lane/body regions guide linked vertical zoom; without calibration the fallback is a normalized image region. Sidebar review relinks and centers the selected runner. Independent comparison navigation remains available.

Lane numbers occupy a separate gutter immediately left of the image. Each row identifies one lane; each shared divider can be dragged there or over the image. Adjacent lanes need not have equal heights. Lane settings group placement, optional race checks, appearance and advanced model-input processing. Optional highlighting flags roster lanes awaiting an accepted finish or a race status; DNS/DNF/DQ/FS resolves a lane without creating a time.

- The top bar shows the selected column's timestamp, with no caption, and the line-scan tools.

| Tool | What it does |
|---|---|
| Zoom | Drag a box to zoom to it (one use, then it switches off; Shift+drag works any time) |
| Unzoom | Fit the whole capture (Esc); shown only while the view is zoomed |
| Flip | Mirror the image, so the winner is on the left or the right, whichever the operator prefers. The choice is remembered. |
| Lanes | Overlay lane lines, drawn from the camera's lane geometry |
| Auto-mark, with an Auto switch | Ask the auto-timing service for proposals now. With Auto on, suggestions arrive as athletes finish, with a final request after capture stops. |
| Clear | Remove every mark in the heat. Statuses stay. |
| Revert | Back to the last saved results, or, before the first save, to the capture as it closed |

| Action | Input |
|---|---|
| Scroll | Mouse wheel / trackpad |
| Zoom in time | Ctrl + wheel |
| Pan | Drag |
| Zoom to box | Shift + drag, or the Zoom tool. Esc fits the image again. Original pixels are retained. |
| Select a column | Click |
| Nudge the column | ← / → (Shift = 10 columns) |
| Mark the selected athlete at that column | Enter, or double-click |

- Marks are hairlines tagged with the lane number.
- Auto-timing proposals are drawn differently from operator marks until they are accepted.

**Theme.** The Track Tools Pro brand tokens, as the TTP web and marketing sites use them:

| Token | Value | Use |
|---|---|---|
| ink | `#081022` | Page background |
| deep | `#0b1327` | Header and sidebar |
| panel | `#101a31` | Panels |
| paper | `#f7f8fa` | Text |
| blue | `#6ba5e7` | Primary |
| mint | `#45e0b0` | Success and accepted marks |
| finish | `#f05a5a` | Finish line |
| amber | `#ffb020` | Review needed (from the TTP timing console) |

- 2 px radius ("pixel geometry"), monospace labels, tabular numbers, and the pixel wordmark in `#9de5f6`.
- An outdoor light mode follows the TTP console's direct-sunlight palette.

## 6. Auto-timing API (the signature feature)

OpenMeet is open source; the finish model is TTP's service behind a public contract (see [finish-model-api-v1.md](finish-model-api-v1.md)). v1 adds the operational rules.

**Framing: AI-suggested finish times for operator review, not automatic timing.**

- On the first unseen-meet test, wrong auto-accepts were 1.5–2.2% of finishers, against a 0.5% target.
- So the model now marks a finish `auto` only when two independent lane-geometry sources agree. Expect nearly everything to come back `review`, with its time filled in.
- The full model can take minutes per heat on a CPU, so the call is asynchronous. The console shows "Timing…" and stays usable. Suggestions fill only lanes the operator hasn't already marked.

**Request:** `POST /v1/finish-predictions`

- heat id and race type (laned sprint);
- the strip, or a reference to it, with T0, the per-column timestamps and the orientation;
- the start list (lane → athlete);
- lane geometry, if known (the model can also infer it).

**Response:** per athlete:

- the column and time;
- the lane;
- the confidence;
- `decision: auto | review`, and a reason (for example `close_finish`);
- the model version.

**Rules in the console:**

- `auto` proposals are accepted when they arrive and are tagged AUTO. `review` proposals wait for an explicit check.
- Finishes within 0.02 s of a neighbour are always `review`.
- The operator can override anything, and an override is logged next to the proposal.
- The goal is 99.5% of delivered results correct, while auto-accepting as many as possible.
- If the API is unreachable, the heat is timed by hand exactly as before. The header shows the state.
- Capture never waits on the API.

The camera network is a closed loop; the internet comes from a second connection (Wi-Fi or a hotspot). The API rides the uplink. Running the model on the timing computer, so it works offline, is a later option.

## 7. Windows, macOS, Linux: does a PWA make sense?

**Not as the main app.** A browser cannot do the two things OpenMeet must do:

| Need | PWA in a browser | Desktop app (native engine + web UI) |
|---|---|---|
| Watch and write the meet manager's shared folder all day | Chromium only. Permission prompts again every session. No reliable folder watching. Safari and Firefox lack it. | Plain file system access, watching, atomic renames |
| Talk to cameras on a closed-loop Ethernet (UDP/TCP, GigE Vision) | No raw sockets | Full network stack, bound to the camera network card |
| Capture for minutes without dropping a column | Background tabs are throttled; a tab crash loses state | Engine process separate from the UI |
| Run with no internet | Possible | Yes |

**Decision (Oct 28): Electron.**

- Electron ships the same Chromium on Windows, macOS and Linux, so the line-scan renders identically everywhere. Tauri's weakest point, WebKitGTK on Linux, disappears.
- Node in the main and utility processes provides file watching, atomic renames and UDP/TCP sockets. One language, JavaScript, runs from camera driver to screen, which is what a sprint needs.
- The cost is a ~150 MB install and more memory. That does not matter on a timing laptop.
- The **engine** runs in its own utility process, so a renderer crash never loses capture data. The **console** is the web UI from the replica.
- Installers: electron-builder (.exe/.msi, .dmg, AppImage/.deb).
- The engine also serves the console to any browser on the camera LAN. That gives a second review station, or a tablet for the clerk. **That** is where a PWA fits: as an extra client, not as the timing core.
- **Windows first** for testing, since that is where AthleticLOCAL and most timers already are. The cheapest real setup is OpenMeet and AthleticLOCAL on the same laptop, with a local folder.

## 8. Meta hackathon slot

OpenMeet is the Meta Global AI Developer Hackathon entry.

- **Submissions are due Nov 4, 9:00 PM ET** (8:00 PM Central; US daylight saving ends Nov 1).
- The two tracks are indie and startup. The startup track is judged on technical execution and whether it holds up in production.
- The models on offer are Muse Spark, Muse Wonder, Muse Image and SAM 3.1 through the Meta Model API, the open-weights models (for example Muse Glimmer, which runs on a single GPU or a Mac mini), and the Muse Code coding agent.
- The official rules were not on the event page when checked; confirm whether existing code is allowed.
- **The Meta feature is a separate idea and is deliberately not designed here yet.** It plugs in as its own module next to the auto-timing client, so it can be added without reshaping v1.

## 9. Build order and acceptance

| # | Milestone | Done when |
|---|---|---|
| 1 | Meet link | Parse `lynx.evt/.ppl/.sch` from a real RunMeet folder. Write a LIF that AthleticLOCAL uploads and RunMeet imports (black-box test). |
| 2 | Engine + sim-replay | A web photo finish streams as a camera. Capture survives killing the console mid-heat. |
| 3 | Console Run view | The full loop: load, arm, start, mark, statuses, save, next heat, on Windows and macOS. |
| 4 | Auto-timing client | Proposals drawn, accepted and overridden. The manual path works with the API off. |
| 5 | sim-render + eval harness | Per-heat delivered accuracy and operator time, measured against truth. |
| 6 | Meta module | To be defined. |

Scope: all milestones, built in parallel. It's a sprint.

## 10. Decisions log

- **Oct 28.** The operator chooses the line-scan direction with Flip. The default is native, with time increasing to the right.
- **Oct 28.** Electron, with the engine in its own process.
- **Oct 28.** No scope cut for Nov 4.
- **Oct 28.** Tiling workspace, auto-arm, the line-scan tools, the lane overlay, a quieter header, and no redundant labels.
- **Oct 28.** The demo meet is rendered by the TTP simulator, with the front camera placed properly.
- **Open:** this repo is public; the model service stays private, as the README says.

Sources:

- [FinishLynx database files](https://support.finishlynx.com/manual/finishlynx/features/databases/files)
- [How meet software shares files with FinishLynx](https://support.finishlynx.com/troubleshoot/networking/meet-management-connections/how-meet-software-shares-files-with-finishlynx)
- [Using RunMeet with fully automatic timing](https://support.athletic.net/article/5h21gv5rct-using-run-meet-with-fully-automatic-timing)
- [RunMeet timing training](https://support.athletic.net/article/h3fqgd9uuz-4-run-meet)
- [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details)

## 11. Guided hardware setup with AI assistance

**Planned; no hardware compatibility claim yet.** OpenMeet should help an operator who knows only “I plugged the camera in” as well as an experienced timer who supplies a precise model and protocol. This applies to physical scoreboards, photo-finish cameras, start sensors, wind gauges and other peripherals.

### Operator experience

1. Start from **Scoreboard → Connect a physical board** or **Network → Add equipment**. A conversational assistant can start the same flow from questions such as “Do you see my camera?” or “How do I connect this?”
2. Discover supported devices on the chosen local connection and report what was actually observed. If the device cannot be identified, accept a photo of its label, connectors or controller display, or let the operator choose the manufacturer/model manually.
3. Choose a prebuilt integration profile where available. Otherwise research the exact equipment using manufacturer documentation. Explain one concrete action at a time, with ordinary language and an optional technical-details view.
4. Propose the required setup values, including any manufacturer-specific operating code, cable/port settings or network parameters. Codes must come from a matching model/controller manual or a verified profile; never substitute a plausible-looking code. Keep source references and the manual version with the recommendation.
5. Apply settings supported by the adapter, and guide the operator through anything requiring physical controls or cables.
6. Run an observable test. For a scoreboard, send a distinctive pattern such as `444` and ask “Do you see 444 on the scoreboard?” Then test a running clock and ask whether it advances correctly. Offer **Yes**, **No**, and **Something different**; the last choice can accept a description or photo.
7. Record the result and save a reusable equipment profile. A failed test leads to targeted troubleshooting and another test, rather than declaring success because data was sent.

### Prebuilt integrations and the AI assistant

The preferred path is a tested adapter plus a model-specific setup profile. Initial candidates include Daktronics scoreboards and FinishLynx cameras, but their exact supported hardware, available protocols and driver requirements must be established before implementation.

The assistant orchestrates the same tools used by manual setup:

- Discover devices and inspect connection state.
- Read supported device identity, firmware and capabilities.
- Retrieve source-backed setup instructions for the matching equipment.
- Read/apply adapter configuration and send a bounded diagnostic test.
- Inspect returned status and compare the requested test with the operator's observation.
- Save the working profile and its verification record.

The scoreboard design agent and the hardware setup assistant have different jobs: the former edits an HTML template; the latter configures physical equipment through supported adapters. Reuse the conversational interface where helpful without confusing those two tasks. An unfamiliar device can produce an integration specification and an isolated adapter draft, but compatibility remains unverified until the actual hardware tests pass. Do not install or activate untested generated drivers during a live race.

### What “connected” means

Expose the capability that has been verified, rather than one blanket green indicator:

| Equipment | Evidence to obtain |
|---|---|
| Physical scoreboard | Device/transport detected; requested test pattern visible; running clock visible and advancing; results fields tested where supported. |
| Photo-finish camera | Device identified; frames received; capture written; start pulse received; timestamp/start alignment checked separately. |
| Start sensor | Trigger observed and recorded in the meet-wide journal; the expected race is assigned that trigger. |
| Wind gauge | Readings received; units and event association checked. |

A visible test pattern verifies that display path, not the precision of race timing. Finding a camera on Ethernet does not establish that images or synchronized timestamps are available. Surface the remaining step clearly, e.g. “Camera found; waiting for images.”

### Engine and data contract

Add a hardware adapter registry to the native engine. Each adapter declares identification criteria, supported operating systems, transport, supported actions, profile schema and diagnostic tests. Keep discovery and configuration out of the renderer. Connection profiles store device identity, selected interface, model/controller details, public manual references, configuration, test observations and the last verified capability set. Test traffic is labelled and isolated from official race results.

AI/vision inference remains behind separate service APIs. This public app ships integration code, profiles and API clients; proprietary timing/cropping models, weights, training data and model implementations remain outside the repository and installers.

Acceptance for the first real integration: a novice can identify and connect one specified physical device, see a diagnostic output, confirm it, run the normal meet output, and reconnect from its saved profile. Hardware-in-the-loop evidence is required before listing that model as supported.
