# Private auto-cropper integration

OpenMeet hides empty spans as a reversible view. `columns.bin`, `times.f64`, the recording's time origin and finish columns remain unchanged. **Show all columns** restores the complete view. Visible breaks indicate skipped time; separated pieces are never treated as continuous time.

The cropper implementation and weights are separate from this repository and every installer. The app contains only transport, validation and display mapping. Lane geometry continues to come from camera calibration.

## Connect a private worker

Choose either an HTTP provider with `OPENMEET_CROP_URL`, or a separate executable with a JSON argument array in `OPENMEET_CROP_COMMAND`:

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

After capture stops, use **More → Hide empty spans**. The private provider must be configured. The result is cached for that attempt, so **Show all columns / Hide empty spans** switches views without another model call. The control can be pinned through **Customize toolbar**.

The integration check uses disposable OpenMeet simulator recordings. It checks known finish retention, mapping, keyboard steps and unchanged original bytes. It is not a new certification of real-camera accuracy or the lane model.
