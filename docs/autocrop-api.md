# Built-in empty-span model

OpenMeet hides empty spans as a reversible view. `columns.bin`, `times.f64`, the recording's time origin and finish columns remain unchanged. **Show all columns** restores the complete view. Visible breaks indicate skipped time; separated pieces are never treated as continuous time.

The approved TTP auto-cropper is included in every app bundle. Its 11,065 float32 parameters occupy 44,260 bytes. The native JavaScript CPU runtime runs in a worker thread owned by the engine, so the operator interface remains responsive. There is no Python dependency, local server, SSH connection, model download, or network requirement. Lane geometry continues to come from camera calibration.

The export retains the frozen threshold (0.05), 32-row BOX pooling, per-row median centering, float16 descriptor quantization, five convolution layers, and both original range policies. The model checksum is `8b3895b390fd36f8840c988a97fb9ac354ed3d3f2935ea51041834acd821aac3`; the original approved checkpoint checksum is recorded in `app/autocrop/model.json`. Builds and runtime both verify the weight file. This specific cropper is the authorized exception to the public model boundary; timing/occlusion weights and training assets remain external.

Native parity was checked against the frozen PyTorch CPU implementation on 36 images (49,324 columns): 8 simulator validation images, 8 web real-photo finishes, 8 demo camera views, and 12 procedural edge cases. All descriptors and both range maps matched exactly. Maximum probability difference was 1.2e-7. This verifies the port, not a new accuracy claim for the model on unseen races.

## Optional external provider

The bundled model is the default. For an explicit override, choose either an HTTP provider with `OPENMEET_CROP_URL`, or a separate executable with a JSON argument array in `OPENMEET_CROP_COMMAND`:

```sh
OPENMEET_CROP_COMMAND='["/path/to/private-worker","--json"]' npm --prefix app start
```

The command is launched directly, without a shell. It reads one JSON request from stdin and writes one JSON response to stdout. Logging belongs on stderr. A private adapter may call the approved cropper on another machine; the public app does not contain connection credentials or model paths.

A health request is `{ "operation": "health" }`; respond with `{ "ready": true, "contract": "autocrop-ranges-v2" }`. HTTP providers expose this at `GET /health` and image processing at `POST /v1/column-ranges`.

An image request contains `request_id`, `image_sha256`, `image: {encoding: "png", data_base64: "..."}` and `mode: "both"`. Respond with the same request ID and SHA-256 plus `result`, the cropper's complete `autocrop-ranges-v2` document.

## Maps and modes

Both modes use ordered, disjoint half-open original-column ranges `[start, end)` and a strictly increasing `cropped_to_original` array equal to their concatenation.

| Mode | Padding | Merge gaps strictly below | Use |
|---|---:|---:|---|
| `storage-display` | 8 columns | 0 | Hidden-span display |
| `inference-safe` | 160 columns | 320 columns | Retained for a timing consumer that understands separate ranges |

OpenMeet checks approval, image width, mode policy, range bounds and exact map/range agreement. It binds the response to the requested image by ID and SHA-256, then stores the result in the capture's `autocrop.json`. Invalid responses keep the full view. Empty/full-width results leave the view unchanged. Known finish marks and unresolved suggestions must all remain inside the returned display ranges before hiding is enabled.

Every selection, hairline, keyboard step and export still refers to original columns. Linked comparison scans use the same time projection, even when their resolutions or native sample rates differ. The timing client continues to read the original capture; it does not receive a spliced display image.

## Operator workflow

After capture stops, use the pinned **Hide empty spans** button. Fresh/default toolbar pins are Follow live, Zoom, Unzoom, Lanes, and Hide empty spans. Existing operator customizations remain saved. The result is cached for that attempt, so **Show all columns / Hide empty spans** switches views without another model call. The control can be pinned through **Customize toolbar**.

`node app/test/visual-native-crop.mjs` checks a disposable Electron capture without any crop service configuration. It also accepts `<app-directory> <unpacked-app-binary>` to exercise the bundled runtime. `npm --prefix app test` checks frozen Python reference vectors, mode edges, worker execution, local engine integration, and unchanged original bytes. The older provider contract and simulator integration checks remain available.

The integration check uses disposable OpenMeet simulator recordings. It checks known finish retention, mapping, keyboard steps and unchanged original bytes. It is not a new certification of real-camera accuracy or the lane model.
