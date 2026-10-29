# OpenMeet scoreboards v1

The engine serves a template folder to a TV, browser window, screen share or OBS
browser source. No renderer or Electron dependency is required. This module is
independent of the timing reducer; the console publishes a full state whenever
the meet, heat, start, marks, statuses, results, logo or wind changes. It need not
publish clock ticks.

## Live data contract

`normalizeState(input)` returns a fresh JSON-safe object, drops unknown fields,
and fills defaults for missing or invalid fields without mutating the input.
Numbers must be finite JSON numbers; times are seconds, timestamps are Unix
milliseconds. Strings are plain text, never HTML.

```json
{
  "meet": {"name": "State Championships", "logo": "assets/meet-logo.png"},
  "heat": {"event": "18B", "round": 1, "heat": 2, "of": 3, "name": "Girls 100 metres", "state": "running"},
  "clock": {"running": true, "startedAtMs": 1793200000000, "speed": 1, "frozenS": 0},
  "lanes": [
    {"lane": 4, "id": "204", "first": "Avery", "last": "Jones", "affiliation": "Central", "status": null, "time": 11.82, "place": 1}
  ],
  "results": [
    {"lane": 4, "id": "204", "first": "Avery", "last": "Jones", "affiliation": "Central", "status": null, "time": 11.82, "place": 1}
  ],
  "wind": 1.2,
  "updatedAt": 1793200011820
}
```

- `meet.name` defaults to `""`; `logo` defaults to `null` and must be a safe
  template-relative asset path. Absolute paths, URLs and traversal are rejected.
- `heat.event` is a string (numeric input is converted), `round` and `heat` are
  positive integers defaulting to 1, `of` is a positive integer or `null`, `name`
  defaults to `""`. `state` is `loaded | armed | running | review | saved`, default
  `loaded`.
- `clock.running` defaults to `false`; `startedAtMs` defaults to `null`; `speed`
  defaults to 1 and can be zero; `frozenS` defaults to 0. Negative times/speeds are
  rejected. Running requires a valid `startedAtMs`. Running time is
  `max(0, (Date.now() - startedAtMs) / 1000 * speed)`, otherwise `frozenS`. For a
  resume, the publisher adjusts `startedAtMs` to include elapsed time; `frozenS`
  is not added while running. Display computers should have synchronized clocks.
- `lanes` defaults to `[]`. Each entry has `lane` (positive integer or `null`),
  `id` (string or `null`), `first`, `last`, `affiliation` (default `""`), `status`
  (`null | DNS | DNF | DQ | FS`, case normalized), `time` (nonnegative seconds or
  `null`), `place` (positive integer or `null`), and `review` (boolean, default
  `false`). A pending suggestion retains its time with `review: true`; it does
  not receive an accepted place. A status clears time/place and review.
- `results` defaults to the finishers in `lanes`, filtered to entries with a time,
  place, no status and no pending review, sorted by place, then time and lane. An explicit results
  array uses the same validation and can retain the previous heat's results.
  Tied places are preserved; the scoreboard never assigns places itself.
- Classic shows placed lanes first in place order, then unplaced timed lanes,
  then untimed lanes. Provisional times show **In review** beside their time.
  Accepting a suggestion removes the label and moves it into place order.
- `wind` is a finite number in m/s or `null`. `updatedAt` defaults to `Date.now()`.

## Template and runtime integration

The caller owns the library root, normally `<userData>/scoreboards`. Each named
folder contains `index.html`, `assets/`, and optional `template.json`:

```json
{"name": "Classic", "description": "Race clock and lanes", "size": {"w": 1920, "h": 1080}}
```

Template folder names match `[a-z0-9-]{1,40}`. A library listing returns
`[{name, title, description, size}]`, where `name` is the folder identifier and
`title` is the manifest's display name. Invalid manifests use safe defaults
(1920 × 1080). Built-ins `classic` and `results-ticker` live as HTML strings in JS
under `engine/scoreboard/builtin/`, so Electron's JS-only engine build includes
them. Creating a template writes ordinary HTML and JSON files; it requires no
build tools. Local templates take precedence as copy sources; `builtin:classic`
or `builtin:results-ticker` forces a built-in.

Every index must load the same-origin runtime and render data through `onData`:

```html
<script src="/scoreboard/runtime.js"></script>
<script>
let current;
const unsubscribe = OpenMeetScoreboard.onData(state => {
  current = state;
  document.getElementById('event').textContent = state.heat.name;
});
function frame() {
  if (current) document.getElementById('clock').textContent =
    OpenMeetScoreboard.raceTime(current).toFixed(2);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script>
```

The runtime immediately delivers its current state to new subscribers once the
initial SSE message has arrived. It then delivers each update. `onData` returns
an unsubscribe function. EventSource automatically reconnects; every connection
receives the latest state and per-template versions, including changes missed
while disconnected. Changed template versions reload that page. Watchers cover
nested asset directories with a 150 ms debounce; a 1 s stat poll catches missed
watch events and discovers new directories. Hidden files/history are not served
or watched. The classic is a 16:9 board; the ticker has a transparent canvas with
a lower-third bar for an OBS browser source.

## Engine library API

All functions are exported from `engine/index.js`:

- `normalizeState(input)` → normalized state (synchronous).
- `listTemplates(root)` → listing; missing library → `[]`.
- `createTemplate(root, name, {from = 'classic'})` → template metadata; refuses
  overwrite. `deleteTemplate(root, name)` removes the template and its history.
- `addAsset(root, name, srcPath)` copies a local image (PNG, JPEG, GIF, WebP, SVG,
  AVIF, ICO, BMP), using a safe unique name, and returns `assets/<filename>`.
  Extension validation does not claim to validate image contents.
- `snapshot(root, name)` → timestamp-plus-random snapshot ID. It copies regular
  files into `<template>/.history/<id>/`, excluding history itself.
- `restore(root, name, snapshotId)` → `{name, snapshotId, restored: true}`. It stages
  a checked copy before replacing files, preserving history and removing files
  introduced since the snapshot. Restore is not crash-atomic across all files.
- `createScoreboardServer({root, host = '0.0.0.0', port = 0})` →
  `{listen, close, publish, url, port}`. Await `listen()` before reading `port`
  or calling `url(name)`. `publish(state)` replaces state and returns the normalized
  copy. Await `close()` to release HTTP connections, watchers and timers.
- `runScoreboardAgent({root, name, request, agent, onOutput, signal})` →
  `{code, snapshotId, restored, aborted, error?}`. `onOutput({stream, line})`
  receives complete stdout/stderr lines, including final lines without newline.

HTTP routes are read-only: `/scoreboard/<name>/...`, `/scoreboard/runtime.js`,
`/scoreboard/state` (JSON), `/scoreboard/feed` (SSE). The SSE `state` event contains
the full state directly; the `version` event contains a map of template names to
opaque version tokens. A new connection receives both immediately. A heartbeat
keeps idle feeds open. Responses have `Cache-Control: no-store`, `nosniff`, and:

```text
default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'
```

Traversal (including repeatedly encoded paths), descendant symlinks, hidden paths
and nonregular files are refused. There is no directory listing, CORS allowance,
or network mutation endpoint. The bind address permits trusted LAN displays;
`url(name)` substitutes `127.0.0.1` for wildcard hosts for local windows. A remote
display uses the timing computer's LAN address with the returned port.

## Coding agents

`AGENT_PRESETS` contains the requested argv, without shell execution:

| Preset | Command and arguments | Verification |
| --- | --- | --- |
| `muse` | `muse exec {prompt}` | **UNVERIFIED**: Muse Code is not installed; confirm flags before the hackathon demo. |
| `codex` | `codex exec --approve-for-me -C {dir} {prompt}` | Supplied integration argv; not exercised by these tests. |
| `grok` | `grok -p {prompt} --permission-mode auto --cwd {dir}` | Supplied integration argv; not exercised by these tests. |

The runner takes a snapshot before spawning, substitutes `{prompt}` and `{dir}`
inside argv strings (never a shell), and sets cwd to the template. The prompt
includes the operator request, this document's data contract, current asset file
list, manifest target size, runtime/rendering rules, folder-only editing and no
external fonts, URLs or requests. Packaged builds that omit this document use
the mirrored data contract in `state.js`. No approval-bypass or yolo flags are
added. The coding CLI retains its own permission policy; cwd and prompt rules are
not an OS sandbox. Only run an installed CLI you trust.

On abort, the runner terminates the child (process group on POSIX), escalating to
SIGKILL after 1 s; `code` is 130. A spawn failure returns code -1 and `error`.
After any outcome it validates that a regular `index.html` loads the runtime via
a script tag. Invalid edits automatically restore the snapshot and set
`restored: true`, reporting the reason in `error` and stderr output. A nonzero
agent exit with valid HTML retains the edits for operator review; the snapshot
is always available. One agent per template can run at a time.

## Engine host integration

The appended scoreboard block registers these existing RPC-style methods:

- `scoreboard.start {port?}` → `{url, port}`. Idempotently starts the server at
  `<userData>/scoreboards` on `0.0.0.0`; seeds `classic` if absent. The returned URL
  opens classic locally. Server port defaults to an OS-assigned port.
- `scoreboard.publish {state}` → normalized state (starts the service if needed).
- `scoreboard.list {}` → template listing.
- `scoreboard.create {name, from?}` → metadata.
- `scoreboard.addAsset {name, path}` → relative asset path.
- `scoreboard.agent {name, request, preset = 'muse'}` → runner result, emitting
  `scoreboard.agentOutput` events with `{name, stream, line}` along the way.
- `scoreboard.restore {name, snapshotId}` → restore result.

The console session owns converting timing state to this contract and publishing
it. The host exposes no arbitrary-command RPC. Lifecycle cleanup stops the
scoreboard server and active agents when the utility process disconnects.

## Verification

Run `node --test engine/scoreboard` for state, library containment/restore,
HTTP/SSE/versioning, runtime arithmetic and fake-CLI runner tests. The tests do
not require Electron, network services, a coding agent install or dependencies.

To check the operator-to-scoreboard review flow in Electron, run `node app/test/visual-scoreboard-review.mjs "$PWD/app"`. It uses disposable generated footage and verifies pending times, place order, acceptance, and unchanged capture pixels/timestamps.
