# Backend handoff coverage

Source: user-supplied `OpenMeet-Implementation-Handoff-20261031.zip`, SHA256
`020216bc8e5ce6507cac815dc17826e7d58950bf1f0d78b9a845b4a937ca1aff`.
Archive/manifest receipts were checked. Nineteen useful supplied runtime modules
are retained under `engine/integrations/protocol-core`, with hashes and edits in
`IMPORT.json`. New adapters implement actionable prose, including provisional
contracts. Synthetic fixtures are not observed device outputs. Proof bookkeeping
and historical instruction listings are not additional runtime features.

## Runtime coverage

| System | Implementation and integration |
| --- | --- |
| SYS01 exact time | Imported signed48 arithmetic/quantization/formatting; new prefix parser; backend.time RPC |
| SYS02 result state | Existing heat/rank logic; supplied result assignment, participant enrichment and explicit confirmation outcomes; backend.results.assign |
| SYS03 speed/pace/deltas | Ordered provider calculations, preliminary millisecond quantization, operand-first delta rounding and quarter/decimal units; timing/value-format.js and backend.time |
| SYS04 exchange/metadata | Existing folder readers, supplied EVT/PPL/SCH, real schedule providers, lossless versioned metadata reader/writer; backend.participants/event.import/schedule/archive |
| SYS05 recovery/backup | Existing capture store and meet backup; raw evidence store, hash-checked replay, fresh output directories and decoded-prefix diagnostics |
| SYS06 extended results | Eleven-field header, weather, inclusive conceptual cutoff, dual split sources and position-preserving intervals; meetlink/extended.js and backend.results.extended |
| SYS07 settings/profiles | Typed settings trees and stream semantics, atomic app profile CRUD/selection, supplied logical profile transitions; backend.settings/profiles |
| SYS08 scoreboards | Scripts, field bindings, page/cadence planner, camera-clock interpolation, board offsets, first-pending gun and explicit TCP/UDP; scoreboard.wire.*; browser publication feeds configured routes |
| SYS09 remote | Stateful text echo/repeat/XON/XOFF, bounded binary framing/queries/metadata/control/pixels/partial sends, TCP listeners and file-backed capture provider; remote.listen/list/close |
| SYS10 imagery/media | Packed/predictor decode, timing/repair, alignment frames, staggered reconstruction, gain/LUT/histogram, crop/resize, segment/pre-roll/cache, planar color, PNG/TGA/JPEG stills, AVI and movie decisions; backend.media/still.export |
| SYS11 weather | Parsing/rounding, resource directions, sentinels, staged acquisition/history/shared denominator, packet decoding, four persisted versions and word swap; backend.weather and exported controller |
| SYS12 sessions/starts | Ownership, correlation, uncertain mutations, epochs, same-clock journal, primary/offset preservation, group sync and distinct drain/completeness observations |
| SYS13 printing | Presentation/UI and OS printer behavior remain outside this backend integration; explicit remote providers are the extension point |
| SYS14 providers/platform | Plain Node/Electron lifetime, local persistence, explicit sockets/codecs; private ABI and OS registry/serial/printer providers are not synthesized or loaded |

## Entry points and policies

`engine/index.js` exports kernels and services. Additional backend RPC:

- backend.profiles: list/get/create/copy/save/select/delete with atomic persistence.
- backend.settings: decode/encode/load/resolve/serialize.
- backend.time: tuple functions, parseTimePrefix, speedValue, paceValue, deltaValue.
- backend.archive: read/write a complete supported metadata record or root.
- backend.weather: create/reset/parse/format/packet/serialize/deserialize/direction.
- backend.results.extended: logical compatibility export; default safer CSV stays intact.
- backend.still.export: PNG, TGA16/24, JPEG with an explicit codec executable.
- backend.media: plan/avi/planar/decode/encode, with owned bounded buffers.

Remote listeners default to loopback and stay inert until opened. Text handlers
cover image information, archive-open notification and start creation. Other
commands return Unknown pending application/OS providers. Archive open emits
metadata without replacing the UI workspace. Start creation preserves primary
and offset evidence; acknowledgment does not certify a physical pulse. Binary
extended attributes require an explicit provider. The native capture adapter's
replacement seek policy is first column at or after the requested time.

Physical scripts can use the standard logical selectors or explicit field
bindings. The standard mapper emits empty text for unavailable providers;
routes without that mapper reject missing bindings. Configure is inert,
connection is explicit, and local completion never means display receipt.
UDP reconnect is explicitly unsupported; close/configure/connect creates a fresh
route. The app exposes saved equipment, camera checks/alignment/sample recording,
and isolated physical-board tests in [hardware-setup.md](hardware-setup.md).
Camera details are in [network-camera.md](network-camera.md).

JPEG/H264/MP4 encoding and decoding use an explicitly supplied open codec process,
with deadlines, cancellation and output budgets. No codec binary is downloaded or
bundled. Segment and dependency cache logic also accepts explicit codec providers.

## External validation boundaries

Fractional gamma, speed/pace and general angular arithmetic use labelled runtime
policies; they do not assert equivalence at every original floating boundary.
Planar color uses exact rational extended64 tables and exposes the two known
binary64 differences. Weather angles require an explicit angular provider, or
`arithmetic: binary64` through RPC.

The supplied line grammar closes vertical replication factor 1. Other factors,
unknown palettes/modes and ambiguous migrations produce explicit decode errors
while raw data survives. Reconstruction profiles do not establish unknown codec
grammars. Bounds, identities and epochs remain explicit inputs. Old preview UI,
model weights and private race assets are excluded.

Firmware/FPGA/sensor internals describe the device side; no firmware is uploaded
or reconstructed. Private provider formats, undocumented metadata meanings,
printer/serial drivers, device activation, calibration and physical final-scan
boundaries require external evidence. These are not filled with guessed data.

## Verification

The engine suite covers imported conformance, typed settings, metadata truncation
and roundtrip, weather, schedule/profile/export, remote framing and actual TCP,
scoreboard TCP/UDP, camera record/decode/drain/replay, hash failures, reconstruction/
gain, and external codec playback/cleanup. Existing renderer and model tests run
unchanged. The real engine-subprocess test covers a localhost camera, decoded
PNG, native still export, profile/archive/time RPC, an exact timestamp vector
through an external model, remote listener ownership and IPC-disconnect cleanup.
The packaged headless smoke checks backend loading and inert service state.
Hardware validation remains outstanding.
