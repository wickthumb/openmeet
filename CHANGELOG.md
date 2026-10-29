# Changelog

## Alpha 0.0.1 — 2026-10-28

Our first day of OpenMeet: an open-source desktop workspace for keeping a track meet moving. This alpha is for exploring the timing workflow with simulated inputs and recorded replays.

### Ready to try

- Run a heat, receive columns as the race unfolds, stop capture manually and move to the next race.
- Review finishes on a zoomable, reversible line-scan. Mark by mouse or keyboard, nudge one native column at a time and enter lane or hip numbers.
- Accept suggested times, set DNS/DNF/DQ/FS, switch between lane and finish order, and retain earlier race attempts.
- Record start triggers and reassign a race's start without rewriting captured timestamps.
- Browse events and heats, revisit work, and keep recording while setup dialogs are open.
- Arrange camera and information tiles, resize the workspace, and link zoom/finish marks for views at the same finish.
- Name camera locations and positions, choose each heat's timing source, and record every registered replay line-scan independently. Camera moves preserve earlier setup snapshots.
- Calibrate lane guides and front-camera labels; customize overlays and repeating billboards behind runners.
- Create, customize and publish local network scoreboards. Classic sorts by place and labels times awaiting review.
- Exchange start lists and result files through a shared meet folder. Connect optional private timing, empty-span hiding and occlusion services through separate APIs.

### Know before you try

- **This is an early prototype for evaluation, not a certified race-timing system.** Physical camera, start-sensor, wind-gauge and hardware-scoreboard adapters are still planned. Real meet-manager interoperability needs meet-day validation.
- The built-in timing stand-in echoes simulator truth. Real-recorded replay can reveal recorded reference results as time advances. Neither demonstrates timing-model accuracy.
- Private models, weights, training code and real-meet datasets are not included. Learned occlusion is experimental; the app can fall back to a simple display mask. Optional empty-span hiding is reversible and never deletes original capture columns.
- Race attempts can be revisited during the session. Restoring a complete timing session after app restart remains future work. Continuous all-day recording/compression is still research.
- Desktop installers are unsigned and updates are manual. macOS may require right-click → Open; Windows may show an unknown-publisher prompt. Windows/macOS packaging and automated checks do not replace hands-on meet testing.

### Getting started

Download the installer for your operating system and architecture from the release page. OpenMeet starts with its built-in sample meet; use **Start** to explore a simulated race. Larger TTP simulator recordings and real-meet replay inputs are provided separately.

To run from source with a current Node 22 LTS release or newer:

```sh
npm --prefix app ci
npm --prefix app start
```

See the [desktop guide](app/README.md), [design blueprint](docs/blueprint.md) and [project roadmap](docs/roadmap.md). Feedback and reproducible bug reports are welcome in [GitHub Issues](https://github.com/wickthumb/openmeet/issues).
