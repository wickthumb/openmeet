# OpenMeet demo: run the race, keep the meet moving

This walkthrough uses the current desktop prototype. Camera inputs are simulated; the bundled finish service echoes simulator truth and is visibly labelled **STAND-IN**. It demonstrates the operator workflow, not model accuracy. Proprietary timing and crop models are separate services and are not included in the repository or installers.

## 1. Load the meet

Open **Meet Link** and select a folder containing `lynx.evt`, `lynx.ppl` and `lynx.sch`, or open the separately supplied simulator demo meet. The schedule and lane roster come from those files. Use a fresh meet folder for testing.

Choose the top **Camera alignment** tab to preview the simulated camera before a race. **Alignment** adds a center crosshair; **Overlays** lets you position lane guides. Stop the preview to keep a still image for editing, then **Return to race** or select **Run**. Setup does not start a race, record start triggers or write a race capture.

## 2. Capture without losing control

Press **Start (SIM)**. The line-scan streams from the gun. It condenses only to a readable zoom floor, then scrolls. Suggested finishes arrive during capture. Leave **Capture options → Auto-stop** off: the camera keeps recording until the operator presses **Stop capture**, even after the replay's finish window ends.

Optionally choose **After timeout** or **All runners marked** before starting another heat. These are explicit modes. A runner's status can resolve a DNS, DNF or DQ without manufacturing a finish time.

## 3. Review and correct a finish

Click a column, type `4`, then Enter to assign it to lane 4. Entry accepts multiple digits, including `20` when that number is in the roster. Backspace edits the pending number; Escape cancels it. A missing or ambiguous roster number does not change a finish.

Drag any finish hairline along its full height. Select and delete it, then create a replacement. Operator edits are retained when later suggestions arrive. Close finishes remain available for review.

Select a reviewed finish in the sidebar to center and zoom its hairline, then choose **Accept time**. Switch the roster between **Lane** and **Finish** order. After scrolling away during capture, **Follow live** returns to the newest columns.

Hover the primary or backup line-scan to inspect the corresponding front-camera frame. Each view can be zoomed and panned.

Move rapidly between columns: available cached front-camera frames should paint without waiting on repeated video seeks. The displayed frame number follows the actual decoded frame; a pending cold load says **Loading frame…**. Hover during capture to inspect an earlier moment, then leave the scan to resume the live camera view.

## 4. Fit the display to the venue

Use **Lanes ▾** on the line-scan or front-camera panel. On the front camera, choose the lane count and position the first and last labels. Intermediate positions and font sizes are interpolated with perspective; switch to individual mode to fine-tune. Alt + wheel adjusts an individual number’s size. Show or hide numbers, adjust font size and weight, colors, thickness and opacity, and enable dragging to position the guides. Appearance is remembered per meet/camera. By default these are decorative guides. The separate **Lane guides in model input** option makes a derived scan containing opaque horizontal boundaries, without labels or finish marks. Original pixels and timestamps remain unchanged, and a request ledger records the preprocessing. Whether this helps a private model needs evaluation.

On the line-scan, enable **Edit boundary lines** and drag one line or its number. Only that shared edge moves, resizing the lanes above and below it. **Guides behind runners** hides guide segments where the image differs from the initial empty-track reference. Compare the toggle on and off; finish markers stay visible. This display feature is separate from the opaque lines optionally included in model-input copies.

In Camera alignment, choose the main and comparison scan sources. A main zoom should show the same time window and vertical fraction in the comparison, including when image heights differ. Roles apply to new captures; saved attempts keep their original source. Additional demo scan sources can represent another finish location, but real multi-camera capture and verified hardware synchronization are not implemented yet.

## 5. Correct an accidental start trigger

The **Starts** tab retains meet-wide start triggers and assignment history. Record another simulated trigger, then assign the correct trigger to the heat. All elapsed times update while the captured finish columns stay fixed. Re-save to update exported results.

The small red **Restart** button beside the main action opens a confirmation dialog before arming a fresh attempt. While recording, **Stop/reset** offers **Stop capture** or **Stop & restart**. Cancel leaves the race running. Use the Race panel’s attempt selector to inspect earlier attempts during this session. Original capture files and start-trigger history are retained on disk; saved LIF snapshots are also copied into each capture folder.

Physical start-sensor integration is still pending; the journal and assignment interface are implemented.

## 6. Save and move on

The sidebar presents one main action for the current state. When every athlete has a finish or status, **Save results** writes `EEE-R-HH.lif` atomically. The next heat loads, and Auto-arm optionally arms it. Confirm AthleticLOCAL import on a test meet before relying on the integration at a real meet; result status conventions still require hands-on verification.

## 7. Show the scoreboard

Open **Scoreboard** to preview a live board, open it on another display, or use its LAN address with OBS. Create, delete and restore boards. **Build with AI** delegates a requested visual change to an installed, authenticated coding agent. Meta Muse Code, Codex and Grok have separate account requirements; do not claim a successful Meta build unless it actually ran.

## Before recording a submission

- Record the actual working build and identify replay inputs and any time compression.
- Keep **STAND-IN** visible when using the truth-based timing demonstration.
- Do not show private timing/crop model code, weights or datasets.
- Use only demonstration footage and backgrounds cleared for public display.
- Show completed functionality. Distance-runner identification and real camera integration remain roadmap items until implemented and verified.
