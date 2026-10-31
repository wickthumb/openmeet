import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODEL = 'stub-truth-0';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLane = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === 'string' && value.trim().length > 0 ||
  Number.isSafeInteger(value) && value >= 0;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shaPattern = /^[0-9a-f]{64}$/i;

class StubError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalid = () => new StubError(400, 'bad_request', 'Invalid finish API request.');

function send(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const json = JSON.stringify({ ...body, stub: true, model: MODEL });
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new StubError(415, 'unsupported_media_type', 'Use application/json.');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    req.resume();
    throw new StubError(413, 'payload_too_large', 'JSON body exceeds 64 MiB.');
  }
  const chunks = [];
  let length = 0;
  // Event listeners allow a 413 response without destroying the request socket.
  await new Promise((resolveBody, rejectBody) => {
    const cleanup = () => {
      req.off('data', onData); req.off('end', onEnd);
      req.off('error', onError); req.off('aborted', onAborted);
    };
    const fail = error => {
      cleanup();
      chunks.length = 0;
      // Keep draining an oversized request, without retaining its accepted prefix.
      // An aborted IncomingMessage can emit error after aborted; consume it until close.
      const ignoreError = () => {};
      req.on('error', ignoreError); req.once('close', () => req.off('error', ignoreError));
      req.resume();
      rejectBody(error);
    };
    const onData = chunk => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) {
        fail(new StubError(413, 'payload_too_large', 'JSON body exceeds 64 MiB.'));
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => { cleanup(); resolveBody(); };
    const onError = error => fail(error);
    const onAborted = () => fail(invalid());
    req.on('data', onData); req.once('end', onEnd);
    req.once('error', onError); req.once('aborted', onAborted);
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
}

function validateTruth(body) {
  if (!isObject(body) || typeof body.strip_sha256 !== 'string' ||
      !shaPattern.test(body.strip_sha256) || !Array.isArray(body.truth)) throw invalid();
  const lanes = new Set();
  for (const entry of body.truth) {
    if (!isObject(entry) || !isLane(entry.lane) || lanes.has(entry.lane) ||
        !Number.isFinite(entry.time_s)) throw invalid();
    lanes.add(entry.lane);
  }
}

/** Validate v1 input and return an immutable-evidence lookup and time mapper. */
function validatePrediction(body) {
  if (!isObject(body) || typeof body.request_id !== 'string' || !uuidPattern.test(body.request_id) ||
      !isObject(body.heat) || !identifier(body.heat.event) || !identifier(body.heat.round) ||
      !identifier(body.heat.heat) || body.heat.race_type !== 'laned_sprint' ||
      !isObject(body.strip) || !Array.isArray(body.start_list) || !isObject(body.timebase)) {
    throw invalid();
  }
  if (Object.hasOwn(body, 'model')) {
    if (typeof body.model !== 'string' || !body.model.trim()) throw invalid();
    if (body.model !== MODEL) throw new StubError(400, 'unsupported_model', 'Requested model is unavailable.');
  }
  const strip = body.strip;
  if (!Number.isSafeInteger(strip.rows) || strip.rows <= 0 ||
      !Number.isSafeInteger(strip.columns) || strip.columns <= 0 ||
      ![1, 2, 3, 4].includes(strip.channels) || strip.orientation !== 'native') throw invalid();
  let hash;
  if (strip.encoding === 'png') {
    if (Object.hasOwn(strip, 'uri') || typeof strip.data_base64 !== 'string' ||
        !strip.data_base64.length || strip.data_base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(strip.data_base64)) {
      throw invalid();
    }
    const bytes = Buffer.from(strip.data_base64, 'base64');
    if (bytes.toString('base64') !== strip.data_base64) throw invalid();
    hash = createHash('sha256').update(bytes).digest('hex');
  } else if (strip.encoding === 'ref') {
    if (Object.hasOwn(strip, 'data_base64') || typeof strip.uri !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/i.test(strip.uri)) throw invalid();
    hash = strip.uri.slice(7).toLowerCase();
  } else {
    throw invalid();
  }
  const lanes = new Set();
  for (const entry of body.start_list) {
    if (!isObject(entry) || !isLane(entry.lane) || lanes.has(entry.lane) || !identifier(entry.id)) throw invalid();
    lanes.add(entry.lane);
  }
  if (Object.hasOwn(body, 'lane_rows')) {
    if (!Array.isArray(body.lane_rows)) throw invalid();
    const mapped = new Set();
    for (const entry of body.lane_rows) {
      if (!isObject(entry) || !lanes.has(entry.lane) || mapped.has(entry.lane) ||
          !Number.isSafeInteger(entry.top_row) || !Number.isSafeInteger(entry.bottom_row) ||
          entry.top_row < 0 || entry.bottom_row < entry.top_row || entry.bottom_row >= strip.rows) throw invalid();
      mapped.add(entry.lane);
    }
  }
  const tb = body.timebase;
  let timeAt;
  if (Object.hasOwn(tb, 'column_race_times_s')) {
    const times = tb.column_race_times_s;
    if (Object.hasOwn(tb, 'first_column_race_time_s') || Object.hasOwn(tb, 'column_period_s') ||
        !Array.isArray(times) || times.length !== strip.columns ||
        times.some((time, i) => !Number.isFinite(time) || (i > 0 && time <= times[i - 1]))) throw invalid();
    timeAt = column => times[column];
  } else {
    const { first_column_race_time_s: first, column_period_s: period } = tb;
    if (!Number.isFinite(first) || !Number.isFinite(period) || period <= 0 ||
        !Number.isFinite(first + (strip.columns - 1) * period)) throw invalid();
    timeAt = column => first + column * period;
  }
  return { hash, lanes, timeAt };
}

// Canonical JSON makes equivalent object key orders share an idempotency entry.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function nearestColumn(time, columns, timeAt) {
  let low = 0;
  let high = columns - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (timeAt(middle) < time) low = middle + 1;
    else high = middle;
  }
  return low > 0 && time - timeAt(low - 1) <= timeAt(low) - time ? low - 1 : low;
}

function predict(body, { hash, lanes, timeAt }, truth, flaky) {
  const predictions = [];
  const warnings = [];
  for (const entry of truth) {
    if (!lanes.has(entry.lane)) continue;
    if (entry.time_s < timeAt(0) || entry.time_s > timeAt(body.strip.columns - 1)) {
      warnings.push(`Truth finish for lane ${entry.lane} is outside the strip.`);
      continue;
    }
    const seed = createHash('sha256').update(`${body.request_id}:${hash}:${entry.lane}`).digest();
    const column = Math.min(body.strip.columns - 1,
      nearestColumn(entry.time_s, body.strip.columns, timeAt) + (seed[0] & 1));
    predictions.push({ lane: entry.lane, column, race_time_s: timeAt(column),
      decision: 'auto', reason: 'detected', confidence: 0.99 });
  }
  if (flaky && predictions.length) {
    Object.assign(predictions[0], { decision: 'review', reason: 'low_confidence', confidence: 0.55 });
  }
  const ordered = [...predictions].sort((a, b) => a.race_time_s - b.race_time_s);
  for (let i = 1; i < ordered.length; i++) {
    const before = ordered[i - 1];
    const after = ordered[i];
    const epsilon = Number.EPSILON * Math.max(1, Math.abs(before.race_time_s), Math.abs(after.race_time_s)) * 4;
    if (after.race_time_s - before.race_time_s < 0.02 - epsilon) {
      for (const p of [before, after]) Object.assign(p, { decision: 'review', reason: 'close_finish' });
    }
  }
  return { request_id: body.request_id, predictions, warnings };
}

/**
 * Create an unbound local truth stand-in. All state is private to this server.
 * Bind to loopback with server.listen(8787, '127.0.0.1'), or port 0 in tests.
 * No pixels are interpreted and no model is loaded.
 * @param {{latencyMs?: number, failRate?: number}} [options]
 * @returns {import('node:http').Server}
 */
export function createStubServer({ latencyMs = 0, failRate = 0 } = {}) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0 || !Number.isFinite(failRate) || failRate < 0 || failRate > 1) {
    throw new TypeError('Latency must be nonnegative and fail rate must be between 0 and 1.');
  }
  const truthByHash = new Map();
  const responsesById = new Map();
  const delay = () => latencyMs ? new Promise(resolveDelay => setTimeout(resolveDelay, latencyMs)) : Promise.resolve();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/v1/health' && req.method === 'GET') {
      send(res, 200, { ok: true });
      return;
    }
    if (!['/v1/health', '/v1/stub/truth', '/v1/finish-predictions'].includes(url.pathname)) {
      throw new StubError(404, 'not_found', 'Unknown finish API endpoint.');
    }
    if (req.method !== 'POST' || url.pathname === '/v1/health') {
      throw new StubError(405, 'method_not_allowed', 'Method is not supported for this endpoint.');
    }
    const body = await readJson(req);
    if (url.pathname === '/v1/stub/truth') {
      validateTruth(body);
      const hash = body.strip_sha256.toLowerCase();
      truthByHash.set(hash, body.truth);
      send(res, 200, { ok: true, strip_sha256: hash });
      return;
    }
    const context = validatePrediction(body);
    const fingerprint = createHash('sha256').update(canonicalJson(body)).digest('hex');
    const cached = responsesById.get(body.request_id);
    if (cached && cached.fingerprint !== fingerprint) {
      throw new StubError(409, 'idempotency_conflict', 'Request ID was already used for different input.');
    }
    if (cached) {
      await delay();
      send(res, 200, cached.response);
      return;
    }
    await delay();
    // Another caller may have completed while this request was delayed.
    const concurrent = responsesById.get(body.request_id);
    if (concurrent) {
      if (concurrent.fingerprint !== fingerprint) {
        throw new StubError(409, 'idempotency_conflict', 'Request ID was already used for different input.');
      }
      send(res, 200, concurrent.response);
      return;
    }
    if (Math.random() < failRate) {
      throw new StubError(503, 'service_unavailable', 'Injected stand-in failure.');
    }
    const truth = truthByHash.get(context.hash);
    if (!truth) throw new StubError(404, 'unknown_strip', 'No truth registered for this strip.');
    const response = predict(body, context, truth, url.searchParams.get('flaky') === '1');
    // Cache before writing: a disconnected/timed-out caller can safely replay.
    responsesById.set(body.request_id, { fingerprint, response });
    send(res, 200, response);
  }

  return createServer((req, res) => {
    handle(req, res).catch(error => {
      const known = error instanceof StubError;
      const status = known ? error.status : 500;
      send(res, status, { error: { code: known ? error.code : 'internal_error',
        message: known ? error.message : 'Stand-in request failed.',
        retryable: status === 429 || status >= 500 } });
    });
  });
}

function parseFlags(args) {
  const options = { port: 8787, latencyMs: 0, failRate: 0 };
  const names = { '--port': 'port', '--latency-ms': 'latencyMs', '--fail-rate': 'failRate' };
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = args[i].split('=');
    if (!Object.hasOwn(names, name)) throw new Error('Use --port, --latency-ms and --fail-rate.');
    const value = inline ?? args[++i];
    if (value === undefined || value.trim() === '' || !Number.isFinite(Number(value))) {
      throw new Error('Flags require numeric values.');
    }
    options[names[name]] = Number(value);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('Port must be an integer from 0 to 65535.');
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { port, ...options } = parseFlags(process.argv.slice(2));
    const server = createStubServer(options);
    server.once('error', () => {
      console.error('Finish API stand-in could not listen.');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Finish API contract stand-in: http://127.0.0.1:${server.address().port} (stub: true, model: ${MODEL})`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        server.close();
        server.closeIdleConnections();
      });
    }
  } catch {
    console.error('Invalid stand-in options. Use --port <0..65535> --latency-ms <0 or more> --fail-rate <0..1>.');
    process.exitCode = 1;
  }
}
