# OpenMeet engine

Engine core as a plain Node ESM library: meet-folder link, capture store, simulated camera, heat state machine. No Electron, no UI, zero dependencies (Node >= 22.2 for `zlib.crc32`; developed on Node 26). Runs inside the engine process (Electron `utilityProcess`). Spec: `docs/blueprint.md` sections 2-4.

## Modules

| File | Exports | Notes |
|---|---|---|
| `meetlink/parse.js` | `parseEvt`, `parsePpl`, `parseSch`, `findHeat` | Accepts bytes (decoded as windows-1252) or text. BOM, CRLF/LF/CR, `;` comments, quoted fields, `""` escapes. Event kept as a string (`18B`). |
| `meetlink/text.js` | `decodeMeetText`, `encodeWindows1252`, `parseFields`, `formatField` | windows-1252 encoder: latin1 + the 0x80-0x9F block; unrepresentable -> `?`. |
| `meetlink/lif.js` | `buildLif`, `writeLifAtomic`, `lifName`, `LIF_STATUS_CONVENTION`, `formatLifTime`, `thousandthsCeil`, `formatThousandths`, `formatTimeOfDay` | Thousandths rounded up (1 us float tolerance). `.tmp` + fsync + rename. Status-row layout is **unverified** against a FinishLynx-written LIF; it lives only in `LIF_STATUS_CONVENTION`. |
| `meetlink/watch.js` | `watchMeetFolder`, `diffHeat`, `MEET_FILES` | `fs.watch` (250 ms debounce) + 1 s stat polling. A new file version must hold still for `settleMs` before it is read; empty or unparsable files keep the last good data. Returns `close()`. |
| `capture/protocol.js` | `validateMessage`, `columnBytes`, `chunkColumnTime`, `MSG_TYPES` | `hello`, `start_pulse`, `columns` (column-major bytes), `end`. |
| `capture/store.js` | `openCaptureStore` | `meta.json`, `columns.bin`, `times.f64` (LE float64 per column), `events.jsonl`. Append-only. Reopen recovers: keeps min(whole columns, whole timestamps), cuts only the torn tail, logs a `recovered` event. |
| `sim/png.js` | `decodePng` | 8-bit, colour types 0/2/6, non-interlaced, filters 0-4, CRCs checked. |
| `sim/replay.js` | `simReplay`, `loadSimTruth`, `columnsOf`, `SIM_START_HW_TIME`, `SIM_CHUNK_COLUMNS` | Async generator of protocol messages; start pulse at hwTime 1000.0; 64-column chunks; `realtime`/`speed` pacing. Truth never enters the stream. |
| `heat/state.js` | `reduce`, `apply`, `places`, `missingResults`, `lifInput`, `HeatError`, `HEAT_STATES`, `STATUS_CODES`, `MARK_SOURCES`, `EVENT_TYPES` | Pure reducer over an event log. First event is `load {heat}`. |
| `index.js` | everything above | |

Heat events: `load {heat}`, `arm`, `disarm`, `start {hwTime, timeOfDay}`, `recall`, `capture_close`, `proposals {items, model}`, `mark {lane, col, src?}`, `clear_mark {lane}`, `clear_all_marks`, `status {lane, code|null}`, `revert`, `save {fileName}`. Mark `src` is derived (`manual` / `checked` / `edited`; `auto` only from proposals); a given `src` must match or the event throws.

## Tests

```
cd engine && npm test        # node --test; fixtures in test/fixtures, PNG test encoder in testing/
```

`test/fixtures/im-*.png` were written by ImageMagick 7 (libpng adaptive filters); `im-*.raw` are ImageMagick's own decodes of them, so the PNG decoder is checked against an independent implementation.

## Example

```js
import {
  watchMeetFolder, findHeat, reduce, apply, openCaptureStore, simReplay,
  lifInput, buildLif, lifName, writeLifAtomic,
} from './index.js';

const meet = 'M:/Meets/2026-state';
const tod = (d = new Date()) => d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;

let folder; // latest {events, people, schedule}
const close = watchMeetFolder(meet, (snap) => { folder = snap; /* diffHeat() vs the armed heat -> warn */ });

// ...once folder has arrived:
const key = folder.schedule[0];
let heat = reduce([{ type: 'load', heat: findHeat(folder.events, key) }, { type: 'arm' }]);
const store = openCaptureStore(`${meet}/openmeet/${key.event}-${key.round}-${key.heat}/capture`);
for await (const msg of simReplay({ png: 'race.png', sidecar: 'race.json', realtime: true })) {
  store.append(msg);
  if (msg.type === 'start_pulse') heat = apply(heat, { type: 'start', hwTime: msg.hwTime, timeOfDay: tod() });
  if (msg.type === 'end') heat = apply(heat, { type: 'capture_close' });
}
heat = apply(heat, { type: 'mark', lane: 4, col: 812 });     // ...one per lane
heat = apply(heat, { type: 'status', lane: 6, code: 'DNS' });
const fileName = lifName(key.event, key.round, key.heat);    // 003-1-01.lif
heat = apply(heat, { type: 'save', fileName });              // HeatError 'incomplete' if a lane lacks a mark/status
const { heat: h, results } = lifInput(heat, (col) => store.raceTimeOf(col));
await writeLifAtomic(meet, fileName, buildLif(h, results));
store.close();
await close();
```

Persist the heat event log yourself (e.g. `openmeet/<heat>/heat.jsonl`); `reduce(log)` rebuilds the state after a restart.

## Start triggers

`timing/starts.js` keeps a meet-wide, fsynced journal in `openmeet/starts.jsonl`. Every received trigger retains its source, clock domain, timestamp, wall-clock display time and optional capture ID. Assignments reference a heat, a selected trigger and the capture's original start trigger; each reassignment appends history. Different clock domains cannot be mixed. The console subtracts the selected start offset from elapsed times while leaving captured columns and front-camera synchronization fixed. Re-save corrected heats to update LIF exports. The current camera and manual trigger button are simulated; a future sensor adapter calls `starts.record` for every pulse, including unassigned pulses.

## Network camera backend

`createNetworkCameraService` adds explicit UDP control, TCP raw recording and
start-journal integration for the experimental network-camera profile. It is
available through the engine host and `node engine/cameras/cli.js`. The renderer
continues to use its existing capture paths. Device configuration is explicit;
timed image decoding, alignment preview and raw replay are integrated; hardware
validation remains outstanding. See
[network-camera.md](../docs/network-camera.md) for setup and recording formats.

`networkCameraProtocol`, `meetDataProtocol` and `scoreboardWireProtocol` expose
the imported independent protocol helpers without replacing existing behavior.

The wider handoff adapters (settings/profiles, versioned metadata, extended results,
weather, physical scoreboards, remote protocols and media) are documented in
[backend-handoff-coverage.md](../docs/backend-handoff-coverage.md).
