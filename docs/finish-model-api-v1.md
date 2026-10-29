# Finish-model API v1

This is the public contract between the OpenMeet engine and TTP's finish service.
It refines [the draft](finish-model-api.md) and blueprint section 6. Model weights
stay on the server. Responses are predictions, not official approvals. The
engine retains the original strip, hardware timestamps and operator decision log;
capture must never wait for an API call. Failed inference leaves manual timing
available.

## Transport and health

Use HTTPS for a remote service; HTTP is supported for the local stand-in.
Requests and responses use `application/json`. An optional service key is sent
**only** as `Authorization: Bearer <apiKey>`, never in a URL or JSON payload.
Credentials must not appear in logs or error messages.

`GET /v1/health` returns HTTP 200 with `{ "ok": true, "model": "<version>" }`.
The local stand-in adds `"stub": true` to **every** JSON response, including
errors, and always reports `"model": "stub-truth-0"`.

## POST /v1/finish-predictions

```json
{
  "request_id": "4df97620-9b94-4650-94d6-a84c4c01eb73",
  "heat": { "event": 3, "round": 1, "heat": 1, "race_type": "laned_sprint" },
  "strip": {
    "encoding": "png",
    "data_base64": "<base64 of the exact PNG bytes>",
    "rows": 480,
    "columns": 20000,
    "channels": 3,
    "orientation": "native"
  },
  "timebase": { "first_column_race_time_s": 0, "column_period_s": 0.001 },
  "start_list": [{ "lane": 1, "id": "athlete-42" }],
  "lane_rows": [{ "lane": 1, "top_row": 0, "bottom_row": 59 }],
  "model": "<optional requested version>"
}
```

- `request_id` is a client-generated UUID and the idempotency key.
- `heat.event`, `heat.round`, and `heat.heat` are nonempty strings or nonnegative
  integer identifiers. v1 supports only `race_type: "laned_sprint"`.
- The strip has exactly one representation: `encoding: "png"` with nonempty
  standard base64 `data_base64`, or `encoding: "ref"` with a nonempty absolute
  `uri`. A reference must resolve to immutable PNG bytes through a transport
  agreed with the service. References must not carry service API credentials.
  Dimensions are positive integers; `channels` is 1, 2, 3, or 4. `orientation`
  is always `"native"`: time increases with column. Rows and columns are
  zero-based; row zero is the top of the image. A prediction's `column` is an
  integer in `[0, columns - 1]`.
- `timebase` has **exactly one** of these forms:
  - `{ "first_column_race_time_s": <finite number>, "column_period_s": <positive finite number> }`;
  - `{ "column_race_times_s": [<finite number for every column>] }`.
  Explicit timestamps must be strictly increasing and have length `columns`.
  Negative race times are allowed for pre-start capture. No rounding is applied.
- `start_list` contains unique positive integer `lane` values and opaque `id`
  values (nonempty strings or nonnegative integers). An empty list is allowed.
- Optional `lane_rows` contains at most one entry per start-list lane, with
  inclusive integer row bounds `0 <= top_row <= bottom_row < rows`.
- Optional `model` is a nonempty version string. An unavailable version returns
  HTTP 400 `unsupported_model`; the response always identifies the actual model.

HTTP 200 response:

```json
{
  "request_id": "4df97620-9b94-4650-94d6-a84c4c01eb73",
  "model": "ttp-finish-v1",
  "predictions": [
    {
      "lane": 1,
      "column": 10942,
      "race_time_s": 10.942,
      "decision": "auto",
      "reason": "detected",
      "confidence": 0.99
    }
  ],
  "warnings": []
}
```

Each lane has at most one prediction. `decision` is `"auto"` or `"review"`;
`reason` is a nonempty machine-readable string; `confidence` is a finite number
in `[0, 1]`. `warnings` is an array of strings. A lane with no detected finish is
simply absent: no fabricated time and no placeholder prediction. Additional
response fields are allowed (including the stand-in's `stub` flag).

`race_time_s` is the race time of the column's **capture start**, not its centre
or end. For a constant timebase it is
`first_column_race_time_s + column * column_period_s`; otherwise it is
`column_race_times_s[column]`. The service must return it. For interoperability,
the client also accepts its omission and derives it from the engine's supplied
timebase. The original hardware timestamps remain the engine's source evidence.

Any pair of delivered finishes **less than 0.02 seconds apart** must both have
`decision: "review"` and `reason: "close_finish"`, regardless of confidence.
The client repeats this check using race times. The threshold excludes exactly
0.02 seconds (allowing for floating-point representation). All members of a
chain of neighbouring close finishes need review, even if the two endpoints
are farther apart. Client-side checks include all well-formed predictions
before dropping unknown lanes, so a stray lane cannot suppress a review.

The client rejects an entire malformed response as `bad_response`, including a
mismatched request ID, duplicate lane, out-of-range column, or invalid field.
It never returns a valid-looking subset of a malformed response. Well-formed
predictions for lanes outside `start_list` are dropped with a warning. Review
predictions require an operator check; auto predictions can enter the console's
AUTO flow and remain subject to operator override and the decision log.

## Errors, timeout and idempotency

Non-2xx responses use an appropriate HTTP status and this JSON shape:

```json
{ "error": { "code": "unknown_strip", "message": "No truth registered for this strip.", "retryable": false } }
```

Typical errors: 400 `bad_request` / `unsupported_model`, 401 `unauthorized`,
403 `forbidden`, 404 `unknown_strip`, 409 `idempotency_conflict`, 413
`payload_too_large`, 429 `rate_limited`, and 5xx `service_unavailable`.
Only network failures, timeouts, HTTP 429 and HTTP 5xx are retried; all other
4xx errors and malformed successful responses are terminal. The client derives
retryability from transport/status even if an error body disagrees. Remote
error messages are not exposed by the client, to avoid credential reflection.

The client defaults to an **8,000 ms timeout per attempt**, including reading
the response body, and **two retries** (three attempts total). It aborts timed-out
requests and uses jittered exponential backoff, capped at 2 seconds between
attempts. `health()` uses the same transport policy. Capture remains independent
of retries. An exhausted timeout raises `FinishApiError` with code `timeout`.

Every retry sends the same request ID and identical JSON. Replaying an ID with
the same JSON value returns the same successful response, including model,
jitter and warnings. A service must coalesce concurrent copies, including when
the first caller times out. Changing any request field while reusing an ID
returns HTTP 409 `idempotency_conflict`; use a fresh UUID for new evidence or
options. Errors before a successful prediction may be retried as above and are
not cached. Production services must retain successful responses for at least
24 hours; the stand-in retains them until process exit. JSON object key order
does not affect identity; array order does. Query options on the first successful
request are included in its cached outcome; a replay does not change that outcome.

## Local simulator truth extension (stand-in only)

The stand-in is a **contract stand-in that echoes simulator truth**, not a model.
Before prediction the engine registers:

```text
POST /v1/stub/truth
{ "strip_sha256": "<64 hex characters>", "truth": [{ "lane": 1, "time_s": 10.942 }] }
```

The hash covers the exact PNG bytes, not their base64 text. `time_s` is finite;
lanes are unique positive integers. Registration returns HTTP 200
`{ "ok": true, "strip_sha256": "...", "stub": true, "model": "stub-truth-0" }`.
An empty truth list yields no predictions. Unregistered bytes return 404
`unknown_strip`. The stand-in accepts inline PNG bytes and, for local demos,
`ref` URIs of the form `sha256:<64 hex characters>` identifying those same bytes.
It does not fetch arbitrary remote URLs or inspect PNG pixels.

Each truth time maps to the nearest column capture start (ties choose the
earlier column), plus seeded jitter of zero or one column toward later time,
clamped to the image bounds. Truth outside the capture range is omitted with a
warning. Output times are recomputed from the selected columns. The seed uses
the request ID, strip hash and lane, making replays reproducible. Unknown
start-list lanes are omitted. `?flaky=1` marks one returned prediction for review
with reason `low_confidence`; the close-finish rule can supersede that reason.

`--latency-ms` adds a delay before prediction responses; `--fail-rate` injects
HTTP 503 failures before inference, in `[0, 1]`. Health and truth registration
remain available. Cached successes are still replayable when failures are
enabled. The local service uses a 64 MiB JSON body limit and keeps truth and
idempotency records in memory. It is intended only for local demos and tests.
Replacing it with the real TTP service requires changing only `baseUrl` (and
supplying the deployment's service key when authentication is enabled).
