# Network camera backend

The user-supplied 2026-10-31 handoff is integrated into plain Node and the app's
engine process. Opening the app makes no device connection. Real hardware has
not been tested. See [the coverage ledger](backend-handoff-coverage.md).

## Camera workflow

From the repository root:

```sh
node engine/cameras/cli.js template > camera-profile.json
node engine/cameras/cli.js probe camera-profile.json
node engine/cameras/cli.js inspect-device camera-profile.json
node engine/cameras/cli.js record camera-profile.json ./camera-test-001 30
node engine/cameras/cli.js preview camera-profile.json ./alignment-test-001 10
node engine/cameras/cli.js decode ./camera-test-001 camera-profile.json ./decoded-001
node engine/cameras/cli.js inspect camera-traffic.pcap
```

Fill in the device's address and marker before probing. The supplied ordinary
marker is `0x4b69726b` (1265201771 in JSON); it remains an explicit configuration.
The clock-only probe sends one read and closes. `inspect-device` also reads
identity and the 1024-byte configuration, checks the rolling checksum and
preserves raw evidence. Neither writes settings.

Recording needs the 19 parameter words, six reset words, clock origin, unique
epoch and remaining profile fields. Alternatively `parameterSettings` supplies
explicit values/gates to the packer. Test-fixture words are arbitrary and must
not be used as a device configuration. Unknown template facts remain null.
`queueEpochTrusted` must be set deliberately before starts enter the meet journal.
`delivery` defaults to `tcp`, or explicitly `udp`; there is no silent fallback.

To decode images, configure `imageProfile`, for example:

```json
{"family":3,"height":640,"tickScale":8,"columnPeriod":0.000125}
```

These are illustrative values, not a discovered device profile. Height is encoded
height; supply `reconstruction` separately for staggered sensors. Family 2 covers
specified packed/gray branches; family 3 covers documented predictor modes and
depths 3–7. Unsupported branches stop the decoded projection and record an error
while raw acquisition continues. The opaque fourth working byte stays explicit.

Native columns store their individual camera timestamps. Timing-model requests
use the exact vector and returned columns resolve back to it. Invalid or
non-increasing times cannot silently become finish times. No simulator truth is
fabricated for a real camera.

Alignment needs an `alignment` object with depth, dimensions, alignmentParameter,
width, rate and optional AEC/runtime controls. Preview derives reset words, uses
status-led UDP retrieval and writes a PNG only after a complete frame boundary.
Close and prepare a new ordinary session before recording races.

`record` polls status, requests stop, observes drain, requests end and closes.
Ctrl-C closes locally. Mutation timeouts are not automatically resent. An
uncertain status requires explicit retry of the same logical generation.
`transportDrained` describes the observed packaged range and empty parser/queue;
it does not prove a physical final-scan boundary. `captureComplete` remains false.

## Recording and replay

| Files | Contents |
| --- | --- |
| session.json | Supplied profile, isolated clock, epoch and recording layout |
| stream.dat / stream.jsonl | Exact TCP bytes before parsing, with receipt offsets |
| blocks.dat / blocks.jsonl | Length-prefixed bodies, indices, SHA256 and diagnostics |
| events.jsonl | Requests/replies, outcomes, starts, decoded TIME tuples and close |
| image/ | Native image columns, exact times and start reference |

Recording and replay destinations must be fresh. Accepted batches are synchronized
before their index is committed. TCP bytes synchronize on the default 20 ms
collection interval, commands and close. A crash or disk failure can leave a torn
tail; no zero-loss claim is made. Replay checks lengths, offsets and hashes,
reports a decoded prefix separately from full decode and preserves source files.

## Service and engine RPC

`createNetworkCameraService` is exported from `engine/index.js`. `open` binds
locally; `prepare` initializes networking. Serialized commands are `prepare`,
`start`, `stop`, `end`, `pollStatus`, `retryStatus`, `refreshClock`, `armRace`,
`readConfiguration`, `readIdentity`, `fetchNextBlock`, `readSyncSample`,
`prepareSyncSample`, `applySyncSample`, and `setClockRaw`. A raw clock write
revokes the epoch and requires explicit rebinding.

Other service methods: `probe`, `inspect`, `image`, `bindStart`, `drain`,
`synchronize`, `snapshot`, `close`, `closeAll`. Group synchronization requires an
explicit interface/subnet, origin, generation and members, before capture preparation. Local broadcast,
sample freshness, member application and physical agreement remain distinct.

The host exposes `camera.network.{probe,inspect,open,command,status,image,
bindStart,drain,synchronize,close}`. It chooses fresh destinations under the meet
or user-data directory, registers decoded images with existing capture APIs and
closes owned resources on shutdown/IPC disconnect. Start binding requires a
journal trigger from the same clock. One local owner per peer is allowed; this
does not lock other controlling processes/computers. No UI code is changed.
