# Private learned occlusion adapter

`app/private-occlusion.mjs` contains transport and validation for an optional private learned BODY mask preview on a **stopped line-scan capture**. **Learned is the saved display preference; Simple is the live/unavailable fallback.** Model code, weights, preprocessing and inference remain outside this repository and its installers. There is no persistent server, autostart or automatic retry.

The engine supplies a **derived PNG Buffer**, with a unique request ID, from `stripPng` for a registered capture or a known registered alternate scan source. Only this derived image is sent to the configured worker. The adapter accepts no recording paths and writes no files. Original recordings, timing data and original pixels remain untouched. The worker must preserve the sent PNG's exact native width and height; the adapter checks both response metadata and decoded mask geometry. The caller owns cache invalidation and must discard a result when its source image or view changes. A white mask pixel means runner BODY: hide the overlay at that pixel. Black means leave the overlay visible, including shadows. Preserve the original image beneath the overlay.

This research model has no validation for front-camera video. Front-camera occlusion continues to use its independent background-subtraction path.

## Engine-facing API

```js
import { occlusionInfo, requestOcclusion } from './private-occlusion.mjs';

const info = await occlusionInfo();
// { configured, ready, contract: 'openmeet-occlusion-v1', foreground: 'white',
//   limits, model?: { id, validation }, error?: 'OCCLUSION_...' }

const result = await requestOcclusion({ png: derivedPngBuffer, requestId });
// { request_id, image_sha256, width, height, mask_png_base64,
//   model: { id, validation }, foreground: 'white' }
```

`occlusionInfo()` is asynchronous. An unconfigured adapter returns `configured: false, ready: false` without launching anything. A configured worker is probed once for health; invalid configuration, unavailability or a busy adapter returns `ready: false` and a stable error code. Health reports provider metadata; it does not certify model accuracy.

`requestOcclusion()` snapshots the input Buffer before awaiting, validates the PNG and hashes its exact encoded bytes with SHA-256. It returns only the documented fields after validation. IDs must contain 1–128 printable, non-space ASCII characters. `model.id` must contain 1–160 printable, non-space ASCII characters; the private bridge embeds the pinned checkpoint digest in this field. `model.validation` is `experimental` or `independently-validated`. The latter is reserved for a provider with independent real-image validation evidence; the current bridge always returns `experimental`.

## Configuration and worker wire format

Configure `OPENMEET_OCCLUSION_COMMAND` with a JSON argument array, or optionally `OPENMEET_OCCLUSION_URL` with an HTTP(S) base URL. URL takes precedence, matching the cropper adapter. URL credentials and redirects are rejected. Keep actual connection details, credentials and model paths outside the repository. The authorized development connection array is stored only in `/tmp/openmeet-occlusion-command.json` (mode 0600):

```sh
OPENMEET_OCCLUSION_COMMAND="$(cat /tmp/openmeet-occlusion-command.json)" npm --prefix app start
```

The adapter does **not** automatically read that file. The command is executed directly with `shell: false`; it reads one JSON document from stdin through EOF, writes one JSON document to stdout, and exits. Logs belong on stderr. Startup and model loading count toward the request deadline. The adapter never echoes worker stdout, stderr or connection details in errors.

A health command receives:

```json
{"operation":"health","contract":"openmeet-occlusion-v1"}
```

It must return:

```json
{"ready":true,"contract":"openmeet-occlusion-v1","foreground":"white","model":{"id":"private-model-sha256:...","validation":"experimental"}}
```

An image command receives:

```json
{
  "contract": "openmeet-occlusion-v1",
  "request_id": "unique-view-request",
  "image_sha256": "sha256-of-derived-png-bytes",
  "width": 2992,
  "height": 640,
  "image": {"encoding": "png", "data_base64": "..."}
}
```

Return the exact request ID, digest and dimensions with `mask_png_base64`, `model` and `foreground: "white"`. The mask must be a native-size, non-interlaced, 8-bit grayscale PNG containing only 0 and 255. Convert the private model's BODY class to 255 and every other class to 0 on the private worker. Its raw class-ID PNG is not a valid wire mask. Base64 must be canonical, padded, and contain no whitespace or data-URL prefix.

HTTP workers use `GET /health` and `POST /v1/occlusion`, with the same JSON response contracts. POST receives the image command above with `Content-Type: application/json`. The configured base URL's path is replaced by these absolute paths. The client bounds streamed response bytes as well as a declared Content-Length; redirects fail without forwarding the image.

Workers can return `{"error":{"code":"refused"}}`, `{"refused":true}`, or `{"status":"refused"}` for a classifier refusal. The client throws `OCCLUSION_REFUSED` without retrying. Other worker error documents throw `OCCLUSION_PROVIDER`. All failures leave overlay handling to the caller; do not reuse a stale mask as though inference succeeded.

## Resource limits and rejection behavior

| Resource | Bound |
|---|---:|
| Derived PNG / mask PNG | 16 MiB each |
| Width or height | 32,768 pixels each |
| Total image area | 16,777,216 pixels |
| Input PNG formats | 8-bit grayscale, RGB or RGBA; non-interlaced |
| Mask format | 8-bit grayscale; only 0 and 255 |
| Image response / command stdout or stderr | 24 MiB each |
| Health response / command stdout or stderr | 16 KiB each |
| Image request deadline | 120 seconds |
| Health deadline | 3 seconds |
| In-flight operations | 1 per adapter module; no queue |
| Command configuration | At most 64 arguments, at most 8,192 bytes each |

Both input and output PNG validation checks signature, chunk bounds and CRCs, header uniqueness, dimensions, format, complete ending, decompression bounds, exact pixel-data length and row filters. Animated PNGs and trailing bytes are rejected. Output identity, dimensions and polarity must match the request before a result can reach the renderer. No source images or masks are retained after the call settles.

Errors expose `.code`: `OCCLUSION_INPUT`, `OCCLUSION_CONFIG`, `OCCLUSION_UNCONFIGURED`, `OCCLUSION_BUSY`, `OCCLUSION_PNG`, `OCCLUSION_INVALID_RESPONSE`, `OCCLUSION_REFUSED`, `OCCLUSION_PROVIDER`, `OCCLUSION_LIMIT`, `OCCLUSION_TIMEOUT`, or `OCCLUSION_TRANSPORT`. Command deadlines/output overflow kill the launched process with SIGKILL; HTTP deadlines abort fetch. Remote workers must enforce their own lifetime so an interrupted SSH connection cannot leave inference running indefinitely.

## Validation status and integration

The development worker pins a shipped research checkpoint and runs CPU inference outside OpenMeet. Its status is **experimental**, pending independent real-image validation. It does not automatically switch to an in-progress training run. A successful transport check does not certify mask accuracy.

OpenMeet exposes the model under **Line-scan Lanes → Advanced → Runner mask → Learned preview**. The selected stopped capture or registered alternate camera image is sent once. Model masks are stored as derived display files beside the capture and reused only for their matching source. Live capture uses Simple; failures keep Simple available. Finish hairlines remain above the image.

The engine IPC methods are `occlusion.info` and `occlusion.predict({captureId, viewPng?})`. Only registered captures and known scan sources are accepted. The caller retains original pixels, clocks and model inputs. The private adapter is included in the app packaging allowlist; the proprietary worker, code, checkpoint and training assets are excluded.

Run `node --test app/test/private-occlusion.test.mjs` for transport validation. The checks cover real command stdin/stdout, literal arguments, health, refusal without retry, HTTP transport, input snapshotting, mismatched responses, PNG integrity and decompression bounds, binary-mask polarity, deadlines, output caps and concurrency-slot recovery.

A development smoke through the actual private CPU model preserved exact 2992 × 640 geometry and the original source, returning a binary display mask in about 1.1 seconds including startup and transport. Simulator inputs were used; no sealed TEST data was opened. Actual camera footage and independent accuracy validation remain outstanding.
