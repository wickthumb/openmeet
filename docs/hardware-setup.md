# Camera and physical scoreboard setup

The app now exposes the handoff backend through Camera setup and Scoreboard.
Profiles persist locally and reconnect only when explicitly requested. No live
meet rehearsal, distance identification, or area-scan adapter is included here.

## Camera setup

1. Open **Camera setup → Live network camera**. Enter a name, the camera's runtime
   IPv4 address, and the local interface connected to it. Automatic route uses the
   operating system's routing choice. The app does not change interface settings.
2. Set encoded height and capture rate. Save the profile. Saving makes no network
   connection. **Import…** accepts the camera CLI JSON format; review it before saving.
3. **Check connection** reads the runtime clock, identity and raw configuration.
   This sends no parameter/reset/start/stop/clock-write requests. A reply proves
   only the particular runtime response and reported bounds, not a retail model,
   sensor geometry or calibrated timing. Reversed or unsupported bounds fail.
4. Choose **Alignment source → Area** or **Slit**, then **Preview alignment**.
   This performs a fresh check and starts an owned UDP preview. Area mode requires
   reported runtime support and a complete declared 2D frame boundary. Slit mode
   uses 1D alignment and displays the newest two decoded line samples; it does
   not wait for a 2D boundary. Reported counts and errors are actual observations.
5. Record whether the displayed finish line is aligned. This stores an operator
   observation; it does not certify timing. **Stop and disconnect** stays available
   above the preview. Disconnect before editing the connection profile.
6. **Record 10-second sample** prepares ordinary capture using TCP or UDP as saved,
   preserves raw bytes and decoded columns, and stops automatically. It can also
   be stopped early. The resulting recording path is displayed. Test recordings
   are under app user data, without an official heat or meet start journal.

Advanced settings contain bit depth, alignment dimensions/rate, start-queue policy
and the imported configuration. Inferred defaults are experimental and labelled:
optional triggering, serial routing, synchronization and motion controls are off;
manual gain/single-TDI and the documented geometry/parameter packing are used.
Exposure, color and sensor-specific reconstruction still need a real device check.
The configured interface is used for outgoing camera UDP and TCP connections.
Unknown codec branches preserve raw evidence and report a decoded-image error.

### Shared alignment viewer and simulator

SIM/replay and physical-camera previews use the same **Fit height**, zoom, drag
and **Wider** controls. Every native row is visible at fit height. Width enlargement
only changes the display; a two-column slit remains two samples. Zoom is relative
to fit height. Green aiming guides belong to area display and are transformed with
the image, rather than fixed to the screen.

The current demo provides line-scan recordings and a separate front-camera video;
it does not provide spatial area frames from each line-scan viewpoint. SIM alignment
therefore displays a live `2 × native height` slit, not a scrolling race strip.
**Area** stays unavailable for those sources. A front-camera frame or a horizontal
time strip must not be presented as that camera's area view. Lane overlays and
billboards remain accessible through their setup modes, with the wider strip view.

For a physical area source, **Slit** in the viewer inspects two spatial columns
around the aiming guide; it does not change device acquisition. To acquire real
1D alignment, stop the session and change the saved **Alignment source** to Slit.
Preview observations remain distinct from timing-column calibration.

The camera must already be running a compatible runtime. Firmware boot/download,
network address assignment, firewall changes and alternate-marker probing are not
performed. A cold device that needs another loader can therefore remain unavailable
here. Neither the handoff nor public setup manuals provide a universal production
parameter vector for every physical camera.

## Physical scoreboard

Open **Scoreboard → Connect a physical scoreboard** above the HTML board designer.
Enter a name, board address, port and connection:

- **TCP · connect to board** opens an outgoing connection, optionally from a chosen
  local interface.
- **TCP · listen for board** listens on the explicitly selected local interface and
  admits the configured peer address. Listening and peer-connected are different states.
- **UDP · send to board** sends datagrams. Broadcast is an explicit opt-in and uses
  the chosen local interface. Local completion does not prove display receipt.

**Import…** accepts a decoded device script or profile JSON. Advanced settings show
its script and additional field bindings. A blank script uses a generic text
clock/results example; it is not a driver for an arbitrary binary display.
Standard section defaults and available logical time/event/result fields follow
the handoff. Unsupported or absent data providers remain empty; custom bindings
must supply any additional data a particular script needs.

**Preview output** renders pattern data locally, including byte count, readable
text and hex, with no network activity. **Connect · output paused** establishes
only the selected transport. Nothing is sent until a test or live output is chosen.

Test the pattern, running clock and results independently. Tests use route-local
synthetic data and do not replace the live scoreboard state, capture or results.
For each test, choose **Yes**, **No**, or **Something different** and optionally
record what the board showed. These observations are stored against the exact
connection/script fingerprint. Changing settings invalidates earlier observations.

**Use live meet data** explicitly enables normal output. **Pause output** stops
updates while retaining the connection; **Disconnect** releases it. A test on one
board does not overwrite another board's live data. Physical board reception,
controller operating codes, cabling, baud settings and manufacturer-specific
semantics require the matching manual and hardware. Native OS serial/printer
providers remain outside this workflow.

## Evidence and limits

Tests use synthetic camera/board emulators, not real equipment. A fresh-epoch
transport drain remains distinct from a physical final scan, so recording metadata
still retains `captureComplete: false`. Exact source timestamps are stored, while
calibration, exposure, dropped-data behavior and clock agreement need physical tests.

The reviewed primary guidance distinguishes runtime camera communication from boot
services and lists separate TCP connect/listen and UDP scoreboard transports:
[Camera network guidance](https://support.finishlynx.com/troubleshoot/networking/school-or-managed-network),
[external port settings](https://support.finishlynx.com/manual/finishlynx/resources/port-settings/port-settings).
Separate 1D and 2D alignment views and vertical-fit inspection are described in the
[alignment manual](https://help.finishlynx.com/Content/OnlineManual/StartAlignment.htm)
and [alignment tools](https://support.finishlynx.com/manual/finishlynx/features/additional-features/camera-alignment-tools).
No device firmware, executable, packaged driver script or private model is imported.

Run the headless interaction check separately from `npm --prefix app test`, because
both emulate a camera on fixed port 41925:

```sh
node app/test/visual-hardware-setup.mjs app
```

It verifies saved/inert profiles, read-only checks, alignment PNG, native recording,
local byte preview, isolated output tests, observation persistence, live relay,
shutdown and focused unsaved fields. Screenshots and a report are written to the
printed temporary folder. Tests do not alter the user's profiles or recordings.
