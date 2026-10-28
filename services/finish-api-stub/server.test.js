import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createStubServer } from './server.js';
import { makeRequest, makeStripBytes, stripHash, listen, post } from '../../engine/autotiming/fixtures.js';

function assertStub(body) {
  assert.equal(body.stub, true);
  assert.equal(body.model, 'stub-truth-0');
}

async function register(baseUrl, truth = [{ lane: 1, time_s: 10.1 }, { lane: 2, time_s: 10.5 }]) {
  const result = await post(baseUrl, '/v1/stub/truth', { strip_sha256: stripHash, truth });
  assert.equal(result.status, 200);
  assertStub(result.body);
  return result.body;
}

test('health identifies the stand-in; unknown strip returns 404 unknown_strip', async t => {
  const baseUrl = await listen(t, createStubServer());
  const health = await fetch(`${baseUrl}/v1/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, stub: true, model: 'stub-truth-0' });
  const result = await post(baseUrl, '/v1/finish-predictions', makeRequest());
  assert.equal(result.status, 404);
  assertStub(result.body);
  assert.deepEqual(result.body.error, { code: 'unknown_strip',
    message: 'No truth registered for this strip.', retryable: false });
});

test('truth registration then prediction returns column-start times plus 0–1 column jitter', async t => {
  const baseUrl = await listen(t, createStubServer());
  const registered = await register(baseUrl);
  assert.equal(registered.strip_sha256, stripHash);
  const req = makeRequest();
  const result = await post(baseUrl, '/v1/finish-predictions', req);
  assert.equal(result.status, 200);
  assertStub(result.body);
  assert.equal(result.body.request_id, req.request_id);
  assert.deepEqual(result.body.warnings, []);
  assert.deepEqual(result.body.predictions.map(p => p.lane), [1, 2]);
  for (const [i, p] of result.body.predictions.entries()) {
    assert.ok(p.column === [100, 500][i] || p.column === [101, 501][i]);
    assert.equal(p.race_time_s, 10 + p.column * 0.001);
    assert.equal(p.decision, 'auto');
    assert.equal(p.reason, 'detected');
    assert.equal(p.confidence, 0.99);
  }
  assert.deepEqual((await post(baseUrl, '/v1/finish-predictions', req)).body, result.body);
});

test('a multi-megabyte PNG stays within the contract and does not overflow base64 validation', async t => {
  const baseUrl = await listen(t, createStubServer());
  const bytes = makeStripBytes(16384, 512, 0);
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal((await post(baseUrl, '/v1/stub/truth', { strip_sha256: hash,
    truth: [{ lane: 1, time_s: 10.1 }] })).status, 200);
  const req = makeRequest();
  Object.assign(req.strip, { columns: 16384, rows: 512, data_base64: bytes.toString('base64') });
  const result = await post(baseUrl, '/v1/finish-predictions', req);
  assert.equal(result.status, 200);
  assert.equal(result.body.predictions.length, 1);
  assertStub(result.body);
});

test('cached response survives re-registration and query changes; changed JSON conflicts', async t => {
  const baseUrl = await listen(t, createStubServer());
  await register(baseUrl);
  const req = makeRequest();
  const first = await post(baseUrl, '/v1/finish-predictions?flaky=1', req);
  await register(baseUrl, [{ lane: 3, time_s: 11 }]);
  const reordered = Object.fromEntries(Object.entries(req).reverse());
  reordered.heat = { heat: 1, round: 1, race_type: 'laned_sprint', event: 3 };
  assert.deepEqual((await post(baseUrl, '/v1/finish-predictions', reordered)).body, first.body);
  const changed = structuredClone(req);
  changed.start_list[0].id = 'someone-else';
  const conflict = await post(baseUrl, '/v1/finish-predictions', changed);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
  assert.equal(conflict.body.error.retryable, false);
  assertStub(conflict.body);
});

test('concurrent duplicates return exactly the same prediction', async t => {
  const baseUrl = await listen(t, createStubServer({ latencyMs: 30 }));
  await register(baseUrl);
  const req = makeRequest();
  const results = await Promise.all(Array.from({ length: 4 }, () =>
    post(baseUrl, '/v1/finish-predictions?flaky=1', req)));
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, results[0].body);
  }
});

test('flaky marks exactly one separated finish for low-confidence review', async t => {
  const baseUrl = await listen(t, createStubServer());
  await register(baseUrl);
  const { status, body } = await post(baseUrl, '/v1/finish-predictions?flaky=1', makeRequest());
  assert.equal(status, 200);
  assert.equal(body.predictions.filter(p => p.decision === 'review').length, 1);
  assert.equal(body.predictions[0].reason, 'low_confidence');
  assert.ok(body.predictions[0].confidence < body.predictions[1].confidence);
  assertStub(body);
});

test('stand-in applies close-finish review to a three-finisher chain', async t => {
  const baseUrl = await listen(t, createStubServer());
  await register(baseUrl, [{ lane: 1, time_s: 10.1 }, { lane: 2, time_s: 10.115 }, { lane: 3, time_s: 10.13 }]);
  const { body } = await post(baseUrl, '/v1/finish-predictions?flaky=1', makeRequest());
  assert.equal(body.predictions.length, 3);
  assert.ok(body.predictions.every(p => p.decision === 'review' && p.reason === 'close_finish'));
});

test('reference strips and irregular timestamps use the same registered bytes', async t => {
  const baseUrl = await listen(t, createStubServer());
  await register(baseUrl, [{ lane: 1, time_s: 10.1 }, { lane: 2, time_s: 10.5 }]);
  const req = makeRequest();
  delete req.strip.data_base64;
  Object.assign(req.strip, { encoding: 'ref', uri: `sha256:${stripHash.toUpperCase()}`, columns: 5 });
  req.timebase = { column_race_times_s: [10, 10.09, 10.2, 10.49, 10.8] };
  const { status, body } = await post(baseUrl, '/v1/finish-predictions', req);
  assert.equal(status, 200);
  assert.equal(body.predictions.length, 2);
  for (const [i, p] of body.predictions.entries()) {
    assert.ok(p.column === [1, 3][i] || p.column === [2, 4][i]);
    assert.equal(p.race_time_s, req.timebase.column_race_times_s[p.column]);
  }
  assertStub(body);
});

test('missing lanes and truth outside capture are absent; the last column clamps jitter', async t => {
  const baseUrl = await listen(t, createStubServer());
  await register(baseUrl, [{ lane: 1, time_s: 9 }, { lane: 2, time_s: 11.999 }, { lane: 99, time_s: 10.1 }]);
  const { body } = await post(baseUrl, '/v1/finish-predictions', makeRequest());
  assert.deepEqual(body.predictions.map(p => p.lane), [2]);
  assert.equal(body.predictions[0].column, 1999);
  assert.match(body.warnings[0], /lane 1.*outside/);
});

test('empty registered truth returns empty predictions without fabricating finishes', async t => {
  const baseUrl = await listen(t, createStubServer());
  await register(baseUrl, []);
  const result = await post(baseUrl, '/v1/finish-predictions?flaky=1', makeRequest());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.predictions, []);
  assert.deepEqual(result.body.warnings, []);
  assertStub(result.body);
});

test('unknown strip error is not cached and registration allows a later replay', async t => {
  const baseUrl = await listen(t, createStubServer());
  const req = makeRequest();
  assert.equal((await post(baseUrl, '/v1/finish-predictions', req)).status, 404);
  await register(baseUrl);
  assert.equal((await post(baseUrl, '/v1/finish-predictions', req)).status, 200);
});

test('latency and fail-rate options inject retryable 503 without delaying health', async t => {
  const baseUrl = await listen(t, createStubServer({ latencyMs: 30, failRate: 1 }));
  await register(baseUrl);
  const start = performance.now();
  const result = await post(baseUrl, '/v1/finish-predictions', makeRequest());
  assert.ok(performance.now() - start >= 20);
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'service_unavailable');
  assert.equal(result.body.error.retryable, true);
  assertStub(result.body);
  assert.equal((await fetch(`${baseUrl}/v1/health`)).status, 200);
});

test('invalid request data returns structured errors with stand-in metadata', async t => {
  const baseUrl = await listen(t, createStubServer());
  const cases = [
    ['request_id', req => { req.request_id = 'not-a-uuid'; }],
    ['race type', req => { req.heat.race_type = 'distance'; }],
    ['rows', req => { req.strip.rows = 0; }],
    ['orientation', req => { req.strip.orientation = 'rotated'; }],
    ['channels', req => { req.strip.channels = 5; }],
    ['ambiguous strip', req => { req.strip.uri = 'sha256:abc'; }],
    ['bad base64', req => { req.strip.data_base64 = '???='; }],
    ['period', req => { req.timebase.column_period_s = 0; }],
    ['timestamp count', req => { req.timebase = { column_race_times_s: [10, 11] }; }],
    ['unordered timestamps', req => { req.strip.columns = 3; req.timebase = { column_race_times_s: [10, 11, 10.5] }; }],
    ['mixed timebases', req => { req.timebase.column_race_times_s = []; }],
    ['duplicate lane', req => { req.start_list.push(req.start_list[0]); }],
    ['lane bounds', req => { req.lane_rows = [{ lane: 1, top_row: 0, bottom_row: 8 }]; }],
    ['unknown geometry lane', req => { req.lane_rows = [{ lane: 99, top_row: 0, bottom_row: 1 }]; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const req = makeRequest();
      mutate(req);
      const result = await post(baseUrl, '/v1/finish-predictions', req);
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, 'bad_request');
      assert.equal(result.body.error.retryable, false);
      assertStub(result.body);
    });
  }
  const req = makeRequest();
  req.model = 'real-model-does-not-exist';
  const unsupported = await post(baseUrl, '/v1/finish-predictions', req);
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.code, 'unsupported_model');
  assertStub(unsupported.body);
});

test('malformed truth, JSON, media types, methods and routes carry stub metadata', async t => {
  const baseUrl = await listen(t, createStubServer());
  for (const truth of [
    { strip_sha256: 'bad', truth: [] },
    { strip_sha256: stripHash, truth: [{ lane: 0, time_s: 10 }] },
    { strip_sha256: stripHash, truth: [{ lane: 1, time_s: '10' }] },
    { strip_sha256: stripHash, truth: [{ lane: 1, time_s: 10 }, { lane: 1, time_s: 11 }] },
  ]) {
    const result = await post(baseUrl, '/v1/stub/truth', truth);
    assert.equal(result.status, 400);
    assertStub(result.body);
  }
  for (const [path, options, status] of [
    ['/v1/stub/truth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }, 400],
    ['/v1/stub/truth', { method: 'POST', body: '{}' }, 415],
    ['/v1/stub/truth', {}, 405],
    ['/does-not-exist', {}, 404],
  ]) {
    const result = await fetch(`${baseUrl}${path}`, options);
    assert.equal(result.status, status);
    const body = await result.json();
    assertStub(body);
    assert.equal(body.error.retryable, false);
  }
});

test('CLI runs on a random port and accepts testing flags', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url)),
    '--port', '0', '--latency-ms=1', '--fail-rate', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  let output = '';
  const baseUrl = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Stand-in exited before listening.')));
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) resolve(match[0]);
    });
  });
  assert.match(output, /stub: true, model: stub-truth-0/);
  const response = await fetch(`${baseUrl}/v1/health`);
  assert.equal(response.status, 200);
  assertStub(await response.json());
});

test('CLI rejects invalid flags instead of starting with unexpected values', () => {
  for (const args of [['--fail-rate', '2'], ['--latency-ms', '-1'], ['--port', '65536'], ['--unknown', '1']]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url)), ...args],
      { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid stand-in options/);
  }
});
