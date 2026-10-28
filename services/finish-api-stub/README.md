# Finish API stand-in

This is a **contract stand-in that echoes simulator truth**. It is not a finish
model and does not infer anything from image pixels. Every response, including
errors, contains `stub: true` and `model: 'stub-truth-0'` so demo output is clear.
It uses Node built-ins only; no install step or model weights are needed.

From the repository root:

```sh
node services/finish-api-stub/server.js
# Optional retry/timeout testing:
node services/finish-api-stub/server.js --port 8787 --latency-ms 250 --fail-rate 0.25
```

It listens on `127.0.0.1:8787` by default. `--port 0` chooses a free port.
`--latency-ms` delays prediction requests; `--fail-rate` injects HTTP 503 before
uncached predictions. Health and truth registration stay available. In-memory
truth and idempotency records last until exit. The server is for local demos;
it has no authentication and should stay on loopback.

The engine first hashes the **exact strip PNG bytes** with SHA-256 and posts
`{strip_sha256, truth: [{lane, time_s}]}` to `/v1/stub/truth`. It then calls
`/v1/finish-predictions` with the same bytes as base64 (or a local
`sha256:<hash>` reference), dimensions, hardware timebase and start list.
Unregistered strips return 404 `unknown_strip`. Times map to the nearest capture
column plus reproducible jitter of zero or one column. A missing truth lane
produces no prediction. Add `?flaky=1` to the prediction URL to mark one result
for review; close finishes always require review as well.

Example engine-side use (paths relative to repository root):

```js
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFinishClient } from './engine/autotiming/client.js';

const baseUrl = 'http://127.0.0.1:8787';
const png = await readFile('/path/to/simulator-strip.png');
const strip_sha256 = createHash('sha256').update(png).digest('hex');
const registration = await fetch(`${baseUrl}/v1/stub/truth`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ strip_sha256, truth: [{ lane: 1, time_s: 10.94 }] }),
});
if (!registration.ok) throw new Error('Truth registration failed');

const client = createFinishClient({ baseUrl });
console.log(await client.health());
const result = await client.predict({
  request_id: randomUUID(),
  heat: { event: 3, round: 1, heat: 1, race_type: 'laned_sprint' },
  strip: { encoding: 'png', data_base64: png.toString('base64'),
    rows: 480, columns: 20000, channels: 3, orientation: 'native' },
  timebase: { first_column_race_time_s: 0, column_period_s: 0.001 },
  start_list: [{ lane: 1, id: 'athlete-42' }],
});
console.log(result); // stub: true; predictions are simulator truth plus jitter
```

The real TTP model replaces this stand-in by changing **`baseUrl`**. Set `apiKey`
in `createFinishClient` if the real deployment requires it; the key is sent only
in the Authorization header. Simulator truth registration is a local-only
extension and is unnecessary for the real service. See the full
[v1 contract](../../docs/finish-model-api-v1.md) for fields, time mapping,
idempotency and review policy.

Run the client and service tests from the repository root:

```sh
node --test engine/autotiming services/finish-api-stub
```

For in-process use, `createStubServer({latencyMs, failRate})` returns an unbound
`node:http` server. Call `listen(0, '127.0.0.1')` for an isolated test instance.
