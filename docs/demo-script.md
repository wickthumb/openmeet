# OpenMeet demo: run the race, keep the meet moving

This walkthrough uses the current desktop prototype. Camera inputs are simulated; the bundled finish service echoes simulator truth and is visibly labelled **STAND-IN**. It demonstrates the operator workflow, not model accuracy. Proprietary timing and crop models are separate services and are not included in the repository or installers.

## 1. Load the meet

Open **Meet Link** and select a folder containing `lynx.evt`, `lynx.ppl` and `lynx.sch`, or open the separately supplied simulator demo meet. The schedule and lane roster come from those files. Use a fresh meet folder for testing.

## 2. Capture without losing control

Press **Start (SIM)**. The line-scan streams from the gun. It condenses only to a readable zoom floor, then scrolls. Suggested finishes arrive during capture. Leave **Capture options → Auto-stop** off: the camera keeps recording until the operator presses **Stop capture**, even after the replay's finish window ends.

Optionally choose **After timeout** or **All runners marked** before starting another heat. These are explicit modes. A runner's status can resolve a DNS, DNF or DQ without manufacturing a finish time.

## 3. Review and correct a finish

Click a column, type `4`, then Enter to assign it to lane 4. Entry accepts multiple digits, including `20` when that number is in the roster. Backspace edits the pending number; Escape cancels it. A missing or ambiguous roster number does not change a finish.

Drag any finish hairline along its full height. Select and delete it, then create a replacement. Operator edits are retained when later suggestions arrive. Close finishes remain available for review.

Hover the primary or backup line-scan to inspect the corresponding front-camera frame. Each view can be zoomed and panned.

## 4. Fit the display to the venue

Use **Lanes ▾** on the line-scan or front-camera panel. Show or hide numbers, adjust font size and weight, colors, thickness and opacity, and enable dragging to position the guides. Appearance is remembered per meet/camera; decorative guides do not alter timing or the private model's input geometry.

## 5. Correct an accidental start trigger

The **Starts** tab retains meet-wide start triggers and assignment history. Record another simulated trigger, then assign the correct trigger to the heat. All elapsed times update while the captured finish columns stay fixed. Re-save to update exported results.

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
