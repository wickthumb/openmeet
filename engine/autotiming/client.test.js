import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createFinishClient, FinishApiError } from './client.js';
import { createStubServer } from '../../services/finish-api-stub/server.js';
import { makeRequest, makeResponse, stripHash, listen, post, sendJson } from './fixtures.js';

async function responseServer(t, respond) {
  const seen = [];
  const baseUrl = await listen(t, createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const body = text ? JSON.parse(text) : undefined;
    seen.push({ body, headers: req.headers, url: req.url });
    respond(req, res, body, seen.length);
  }));
  return { baseUrl, seen };
}

test('client health and predictions work end to end against the truth stand-in', async t => {
  const baseUrl = await listen(t, createStubServer());
  const client = createFinishClient({ baseUrl });
  assert.deepEqual(await client.health(), { ok: true, stub: true, model: 'stub-truth-0' });
  assert.equal((await post(baseUrl, '/v1/stub/truth', { strip_sha256: stripHash,
    truth: [{ lane: 1, time_s: 10.1 }, { lane: 2, time_s: 10.5 }] })).status, 200);
  const req = makeRequest();
  const response = await client.predict(req);
  assert.equal(response.request_id, req.request_id);
  assert.equal(response.stub, true);
  assert.equal(response.model, 'stub-truth-0');
  assert.deepEqual(response.warnings, []);
  assert.deepEqual(response.predictions.map(p => p.lane), [1, 2]);
  for (const [i, p] of response.predictions.entries()) {
    assert.ok(p.column === [100, 500][i] || p.column === [101, 501][i]);
    assert.equal(p.race_time_s, 10 + p.column * 0.001);
    assert.equal(p.decision, 'auto');
  }
  assert.deepEqual(await client.predict(req), response);
});

test('timeout aborts, then retries the real stand-in with identical JSON and request_id', async t => {
  const server = createStubServer();
  const seen = [];
  let aborted = false;
  server.prependListener('request', (req, res) => {
    if (req.url !== '/v1/finish-predictions') return;
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => seen.push(Buffer.concat(chunks).toString()));
    if (seen.length === 0) {
      const end = res.end.bind(res);
      res.end = (...args) => { setTimeout(() => end(...args), 350); return res; };
    }
  });
  const baseUrl = await listen(t, server);
  await post(baseUrl, '/v1/stub/truth', { strip_sha256: stripHash, truth: [{ lane: 1, time_s: 10.1 }] });
  const req = makeRequest();
  const originalId = req.request_id;
  let attempts = 0;
  const client = createFinishClient({ baseUrl, timeoutMs: 100, retries: 1,
    fetchImpl: (url, options) => {
      attempts++;
      options.signal.addEventListener('abort', () => { aborted = true; });
      // Mutating caller-owned data after predict() starts cannot change retries.
      req.request_id = randomUUID();
      return fetch(url, options);
    } });
  const result = await client.predict(req);
  assert.equal(aborted, true);
  assert.equal(attempts, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(JSON.parse(seen[0]).request_id, originalId);
  assert.equal(result.request_id, originalId);
});

test('HTTP 400 is not retried even when the server calls it retryable', async t => {
  const { baseUrl, seen } = await responseServer(t, (req, res) => sendJson(res, 400,
    { error: { code: 'bad_request', message: 'No.', retryable: true } }));
  await assert.rejects(createFinishClient({ baseUrl }).predict(makeRequest()), error => {
    assert.ok(error instanceof FinishApiError);
    assert.equal(error.code, 'bad_request');
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(seen.length, 1);
});

test('429 and 5xx retry, preserving the original request', async t => {
  for (const status of [429, 500, 503]) {
    await t.test(String(status), async t => {
      const { baseUrl, seen } = await responseServer(t, (req, res, body, count) => {
        if (count === 1) sendJson(res, status, { error: { code: 'busy', message: 'Wait.', retryable: false } });
        else sendJson(res, 200, makeResponse(body));
      });
      const req = makeRequest();
      assert.equal((await createFinishClient({ baseUrl }).predict(req)).request_id, req.request_id);
      assert.equal(seen.length, 2);
      assert.deepEqual(seen[0].body, seen[1].body);
    });
  }
});

test('network errors retry and exhaustion reports sanitized transport errors', async t => {
  const { baseUrl, seen } = await responseServer(t, (req, res, body) => sendJson(res, 200, makeResponse(body)));
  let calls = 0;
  const client = createFinishClient({ baseUrl, fetchImpl: (...args) => {
    if (++calls === 1) throw new Error('Disconnected');
    return fetch(...args);
  } });
  await client.predict(makeRequest());
  assert.equal(calls, 2);
  assert.equal(seen.length, 1);
  let failures = 0;
  await assert.rejects(createFinishClient({ baseUrl, retries: 1, fetchImpl: () => {
    failures++;
    throw new Error('Disconnected');
  } }).predict(makeRequest()), { code: 'network_error', retryable: true });
  assert.equal(failures, 2);
});

test('timeout includes reading the response body and reports timeout on exhaustion', async t => {
  const { baseUrl, seen } = await responseServer(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{'); // Headers arrive, body never finishes.
  });
  await assert.rejects(createFinishClient({ baseUrl, retries: 0, timeoutMs: 60 }).predict(makeRequest()),
    { code: 'timeout', retryable: true });
  assert.equal(seen.length, 1);
});

test('a stalled 400 error body never turns a terminal HTTP status into a retry', async t => {
  const { baseUrl, seen } = await responseServer(t, (req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.write('{');
  });
  await assert.rejects(createFinishClient({ baseUrl, timeoutMs: 60 }).predict(makeRequest()),
    { code: 'http_error', status: 400, retryable: false });
  assert.equal(seen.length, 1);
});

test('a connection lost while reading a successful response body is retried', async t => {
  const { baseUrl, seen } = await responseServer(t, (req, res, body, count) => {
    if (count === 1) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1000 });
      res.write('{');
      setTimeout(() => res.destroy(), 10);
    } else {
      sendJson(res, 200, makeResponse(body));
    }
  });
  const req = makeRequest();
  assert.equal((await createFinishClient({ baseUrl }).predict(req)).request_id, req.request_id);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].body, seen[1].body);
});

test('malformed successful responses reject the entire result without retrying', async t => {
  let transform;
  const { baseUrl, seen } = await responseServer(t, (req, res, body) => sendJson(res, 200, transform(makeResponse(body))));
  const client = createFinishClient({ baseUrl });
  const cases = [
    ['wrong request ID', b => ({ ...b, request_id: randomUUID() })],
    ['missing model', b => { delete b.model; return b; }],
    ['empty model', b => ({ ...b, model: '' })],
    ['missing predictions', b => { delete b.predictions; return b; }],
    ['missing warnings', b => { delete b.warnings; return b; }],
    ['bad warning', b => ({ ...b, warnings: [42] })],
    ['bad stub marker', b => ({ ...b, stub: 'true' })],
    ['duplicate lane', b => ({ ...b, predictions: [...b.predictions, ...b.predictions] })],
    ['null prediction', b => ({ ...b, predictions: [...b.predictions, null] })],
    ...[
      ['lane', 0], ['lane', '1'], ['column', -1], ['column', 2000], ['column', 1.5],
      ['race_time_s', null], ['race_time_s', '10.1'], ['decision', 'approved'],
      ['reason', ''], ['confidence', -0.1], ['confidence', 1.1], ['confidence', null],
    ].map(([field, value]) => [`invalid ${field}: ${value}`, b => {
      b.predictions.push({ ...b.predictions[0], lane: 2, [field]: value });
      return b;
    }]),
    ['malformed unknown lane cannot be silently dropped', b => {
      b.predictions.push({ ...b.predictions[0], lane: 99, confidence: 'high' });
      return b;
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      transform = mutate;
      const before = seen.length;
      await assert.rejects(client.predict(makeRequest()), { code: 'bad_response', retryable: false });
      assert.equal(seen.length, before + 1);
    });
  }
});

test('invalid JSON raises bad_response with no retry', async t => {
  const { baseUrl, seen } = await responseServer(t, (req, res) => { res.writeHead(200); res.end('{'); });
  await assert.rejects(createFinishClient({ baseUrl }).predict(makeRequest()), { code: 'bad_response' });
  assert.equal(seen.length, 1);
});

test('client enforces close finishes using returned race times', async t => {
  const { baseUrl } = await responseServer(t, (req, res, body) => {
    const reply = makeResponse(body);
    reply.predictions = [
      { ...reply.predictions[0], lane: 1, column: 10, race_time_s: 10.1 },
      { ...reply.predictions[0], lane: 2, column: 500, race_time_s: 10.115 },
      { ...reply.predictions[0], lane: 3, column: 1000, race_time_s: 10.13 },
    ];
    sendJson(res, 200, reply);
  });
  const response = await createFinishClient({ baseUrl }).predict(makeRequest());
  assert.ok(response.predictions.every(p => p.decision === 'review' && p.reason === 'close_finish'));
});

test('missing race times are computed from constant and irregular hardware timebases', async t => {
  const { baseUrl } = await responseServer(t, (req, res, body) => {
    const p = makeResponse(body).predictions[0];
    delete p.race_time_s;
    sendJson(res, 200, { ...makeResponse(body), predictions: [{ ...p, column: 0 }, { ...p, lane: 2, column: 1 }] });
  });
  for (const timebase of [
    { first_column_race_time_s: -0.01, column_period_s: 0.015 },
    { column_race_times_s: [-0.01, 0.005, 0.1] },
  ]) {
    const req = makeRequest();
    req.strip.columns = 3;
    req.timebase = timebase;
    const { predictions } = await createFinishClient({ baseUrl }).predict(req);
    assert.equal(predictions[0].race_time_s, -0.01);
    assert.ok(Math.abs(predictions[1].race_time_s - 0.005) < 1e-12);
    assert.ok(predictions.every(p => p.reason === 'close_finish'));
  }
});

test('unknown lanes are dropped with a warning after applying close-finish review', async t => {
  const { baseUrl } = await responseServer(t, (req, res, body) => {
    const reply = makeResponse(body);
    reply.predictions.push({ ...reply.predictions[0], lane: 99, race_time_s: 10.101 });
    sendJson(res, 200, reply);
  });
  const result = await createFinishClient({ baseUrl }).predict(makeRequest());
  assert.deepEqual(result.predictions.map(p => p.lane), [1]);
  assert.equal(result.predictions[0].reason, 'close_finish');
  assert.match(result.warnings[0], /unknown lane 99/);
});

test('API key is only in Authorization and never appears in thrown messages', async t => {
  const apiKey = 'test-secret-do-not-reflect';
  const { baseUrl, seen } = await responseServer(t, (req, res, body) => sendJson(res, 400,
    { error: { code: 'bad_request', message: apiKey, retryable: false } }));
  await assert.rejects(createFinishClient({ baseUrl, apiKey }).predict(makeRequest()), error => {
    assert.equal(error.message.includes(apiKey), false);
    assert.equal(error.stack.includes(apiKey), false);
    return true;
  });
  assert.equal(seen[0].headers.authorization, `Bearer ${apiKey}`);
  assert.equal(seen[0].url.includes(apiKey), false);
  assert.equal(JSON.stringify(seen[0].body).includes(apiKey), false);
  const networkClient = createFinishClient({ baseUrl, apiKey, retries: 0,
    fetchImpl: () => { throw new Error(`fetch rejected ${apiKey}`); } });
  await assert.rejects(networkClient.predict(makeRequest()), error => {
    assert.equal(error.code, 'network_error');
    assert.equal(error.message.includes(apiKey), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('health validates the response and uses Authorization', async t => {
  const { baseUrl, seen } = await responseServer(t, (req, res) => sendJson(res, 200, { ok: 'true', model: 'bad' }));
  await assert.rejects(createFinishClient({ baseUrl, apiKey: 'key' }).health(), { code: 'bad_response' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/v1/health');
  assert.equal(seen[0].headers.authorization, 'Bearer key');
});
