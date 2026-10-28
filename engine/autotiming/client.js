/**
 * @typedef {{lane: number, column: number, race_time_s: number,
 *   decision: 'auto'|'review', reason: string, confidence: number}} FinishPrediction
 * @typedef {{first_column_race_time_s: number, column_period_s: number}|
 *   {column_race_times_s: number[]}} Timebase
 * @typedef {{request_id: string, heat: {event: string|number, round: string|number,
 *   heat: string|number, race_type: 'laned_sprint'},
 *   strip: {encoding: 'png'|'ref', data_base64?: string, uri?: string,
 *   rows: number, columns: number, channels: number, orientation: 'native'},
 *   timebase: Timebase, start_list: {lane: number, id: string|number}[],
 *   lane_rows?: {lane: number, top_row: number, bottom_row: number}[],
 *   model?: string}} FinishRequest
 * @typedef {{request_id: string, model: string, predictions: FinishPrediction[],
 *   warnings: string[], stub?: boolean}} FinishResponse
 */

/** A sanitized transport, protocol or validation failure. */
export class FinishApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{retryable?: boolean, status?: number}} [options]
   */
  constructor(code, message, { retryable = false, status } = {}) {
    super(message);
    this.name = 'FinishApiError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonemptyString = value => typeof value === 'string' && value.trim().length > 0;
const isLane = value => Number.isSafeInteger(value) && value > 0;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badResponse = () => new FinishApiError('bad_response', 'Finish API returned an invalid response.');
const badRequest = () => new FinishApiError('bad_request', 'Invalid finish prediction request.');

/**
 * Copy predictions in input order and mark both ends of every close pair.
 * Adjacent comparisons in time order also cover chains of three or more lanes.
 * The input objects and array are never mutated.
 * @param {FinishPrediction[]} predictions
 * @param {number} [minGapS]
 * @returns {FinishPrediction[]}
 */
export function enforceClosePolicy(predictions, minGapS = 0.02) {
  if (!Array.isArray(predictions) || !Number.isFinite(minGapS) || minGapS < 0 ||
      predictions.some(p => !isObject(p) || !Number.isFinite(p.race_time_s))) {
    throw new TypeError('Close-finish policy requires finite race times and a nonnegative gap.');
  }
  const result = predictions.map(p => ({ ...p }));
  const ordered = [...result].sort((a, b) => a.race_time_s - b.race_time_s);
  for (let i = 1; i < ordered.length; i++) {
    const before = ordered[i - 1];
    const after = ordered[i];
    // Avoid treating e.g. 10.02 - 10 as less than exactly 0.02 due to rounding.
    const epsilon = Number.EPSILON * Math.max(1, Math.abs(before.race_time_s),
      Math.abs(after.race_time_s), minGapS) * 4;
    if (after.race_time_s - before.race_time_s < minGapS - epsilon) {
      for (const prediction of [before, after]) {
        prediction.decision = 'review';
        prediction.reason = 'close_finish';
      }
    }
  }
  return result;
}

/** Validate the local evidence needed to interpret any returned column. */
function requestContext(req) {
  if (!isObject(req) || !uuidPattern.test(req.request_id) || !isObject(req.strip) ||
      !Number.isSafeInteger(req.strip.columns) || req.strip.columns <= 0 ||
      !Array.isArray(req.start_list) || !isObject(req.timebase)) throw badRequest();
  const lanes = new Set();
  for (const entry of req.start_list) {
    if (!isObject(entry) || !isLane(entry.lane) || lanes.has(entry.lane)) throw badRequest();
    lanes.add(entry.lane);
  }
  const { columns } = req.strip;
  const tb = req.timebase;
  let timeAt;
  if (Object.hasOwn(tb, 'column_race_times_s')) {
    const times = tb.column_race_times_s;
    if (Object.hasOwn(tb, 'first_column_race_time_s') || Object.hasOwn(tb, 'column_period_s') ||
        !Array.isArray(times) || times.length !== columns ||
        times.some((time, i) => !Number.isFinite(time) || (i > 0 && time <= times[i - 1]))) {
      throw badRequest();
    }
    timeAt = column => times[column];
  } else {
    const { first_column_race_time_s: first, column_period_s: period } = tb;
    if (!Number.isFinite(first) || !Number.isFinite(period) || period <= 0 ||
        !Number.isFinite(first + (columns - 1) * period)) throw badRequest();
    timeAt = column => first + column * period;
  }
  return { lanes, columns, timeAt };
}

/** Validate everything before filtering lanes or applying local policy. */
function predictionResponse(body, req, context) {
  if (!isObject(body) || body.request_id !== req.request_id || !nonemptyString(body.model) ||
      !Array.isArray(body.predictions) || !Array.isArray(body.warnings) ||
      body.warnings.some(warning => typeof warning !== 'string') ||
      (Object.hasOwn(body, 'stub') && typeof body.stub !== 'boolean')) throw badResponse();
  const seen = new Set();
  const predictions = body.predictions.map(p => {
    if (!isObject(p) || !isLane(p.lane) || seen.has(p.lane) ||
        !Number.isSafeInteger(p.column) || p.column < 0 || p.column >= context.columns ||
        !['auto', 'review'].includes(p.decision) || !nonemptyString(p.reason) ||
        !Number.isFinite(p.confidence) || p.confidence < 0 || p.confidence > 1 ||
        (Object.hasOwn(p, 'race_time_s') && !Number.isFinite(p.race_time_s))) throw badResponse();
    seen.add(p.lane);
    return { ...p, race_time_s: p.race_time_s ?? context.timeAt(p.column) };
  });
  const warnings = [...body.warnings];
  const allowed = enforceClosePolicy(predictions).filter(p => {
    if (context.lanes.has(p.lane)) return true;
    warnings.push(`Dropped prediction for unknown lane ${p.lane}.`);
    return false;
  });
  return { ...body, predictions: allowed, warnings };
}

/**
 * Create an engine-side v1 client. Request JSON is snapshotted before the first
 * attempt; neither caller mutations nor retries can change its idempotency key.
 * Error messages never interpolate URLs, keys, remote bodies or fetch errors.
 * @param {{baseUrl: string, apiKey?: string, timeoutMs?: number, retries?: number,
 *   fetchImpl?: typeof fetch}} options
 * @returns {{predict: (req: FinishRequest) => Promise<FinishResponse>,
 *   health: () => Promise<{ok: true, model: string, stub?: boolean}>}}
 */
export function createFinishClient({ baseUrl, apiKey, timeoutMs = 8000, retries = 2,
  fetchImpl = globalThis.fetch } = {}) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new TypeError('Invalid finish API base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) throw new TypeError('Invalid finish API base URL.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(retries) ||
      retries < 0 || typeof fetchImpl !== 'function' ||
      (apiKey !== undefined && (typeof apiKey !== 'string' || /[\r\n]/.test(apiKey)))) {
    throw new TypeError('Invalid finish API client options.');
  }
  const root = url.href.replace(/\/+$/, '');
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  async function attempt(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${root}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      let parsed;
      try { parsed = await response.json(); } catch {
        if (controller.signal.aborted) throw new FinishApiError('timeout',
          'Finish API request timed out.', { retryable: true });
        if (response.ok) throw badResponse();
        // HTTP status still controls retryability when an error body is broken.
      }
      if (!response.ok) {
        const code = isObject(parsed?.error) && typeof parsed.error.code === 'string' &&
          /^[a-z][a-z0-9_]{0,63}$/.test(parsed.error.code) ? parsed.error.code : 'http_error';
        throw new FinishApiError(code, `Finish API returned HTTP ${response.status}.`, {
          retryable: response.status === 429 || response.status >= 500 && response.status <= 599,
          status: response.status,
        });
      }
      return parsed;
    } catch (error) {
      if (controller.signal.aborted) throw new FinishApiError('timeout',
        'Finish API request timed out.', { retryable: true });
      if (error instanceof FinishApiError) throw error;
      throw new FinishApiError('network_error', 'Finish API network request failed.', { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(path, body) {
    for (let attemptIndex = 0; ; attemptIndex++) {
      try { return await attempt(path, body); } catch (error) {
        if (!error.retryable || attemptIndex >= retries) throw error;
        const ceiling = Math.min(2000, 100 * 2 ** attemptIndex);
        await new Promise(resolve => setTimeout(resolve, ceiling * (0.5 + Math.random() * 0.5)));
      }
    }
  }

  return {
    async predict(req) {
      let body;
      let snapshot;
      try {
        body = JSON.stringify(req);
        snapshot = JSON.parse(body);
      } catch { throw badRequest(); }
      const context = requestContext(snapshot);
      return predictionResponse(await request('/v1/finish-predictions', body), snapshot, context);
    },
    async health() {
      const body = await request('/v1/health');
      if (!isObject(body) || body.ok !== true || !nonemptyString(body.model) ||
          (Object.hasOwn(body, 'stub') && typeof body.stub !== 'boolean')) throw badResponse();
      return body;
    },
  };
}
