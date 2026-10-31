// sim-replay: stream a line-scan PNG as if it were a camera.
//
// The PNG is already in native orientation: x = column = time increasing.
// The sidecar gives the time axis; its ground truth is for the evaluation
// harness only and never enters the stream (use loadSimTruth()).

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { decodePng } from './png.js';

/** @typedef {import('../capture/protocol.js').CameraMsg} CameraMsg */
/** @typedef {import('./png.js').DecodedImage} DecodedImage */

/**
 * @typedef {object} SimSidecar
 * @property {number} column_period_s           Seconds per column.
 * @property {number} first_column_race_time_s  Race time of column 0.
 * @property {{lane: number, time_s: number}[]} [truth]  Official results; harness only.
 */

/** Hardware time of the simulated start pulse (an arbitrary epoch). */
export const SIM_START_HW_TIME = 1000.0;
export const SIM_CHUNK_COLUMNS = 64;

/** @param {SimSidecar | string} sidecar */
function readSidecar(sidecar) {
  const sc = typeof sidecar === 'string' ? JSON.parse(readFileSync(sidecar, 'utf8')) : sidecar;
  if (!sc || typeof sc !== 'object') throw new TypeError('sim sidecar must be an object or a JSON file path');
  if (!(typeof sc.column_period_s === 'number' && sc.column_period_s > 0 && Number.isFinite(sc.column_period_s))) {
    throw new TypeError('sidecar.column_period_s must be a positive number');
  }
  if (!(typeof sc.first_column_race_time_s === 'number' && Number.isFinite(sc.first_column_race_time_s))) {
    throw new TypeError('sidecar.first_column_race_time_s must be a finite number');
  }
  return /** @type {SimSidecar} */ (sc);
}

/**
 * Ground truth for the evaluation harness. Never pass this to the console.
 * @param {SimSidecar | string} sidecar  Object or path to the sidecar JSON.
 * @returns {{lane: number, time_s: number}[]}
 */
export function loadSimTruth(sidecar) {
  const sc = readSidecar(sidecar);
  const truth = sc.truth ?? [];
  if (!Array.isArray(truth)) throw new TypeError('sidecar.truth must be an array');
  return truth.map((t, i) => {
    if (!Number.isInteger(t?.lane) || typeof t.time_s !== 'number' || !Number.isFinite(t.time_s)) {
      throw new TypeError(`sidecar.truth[${i}] needs an integer lane and a numeric time_s`);
    }
    return { lane: t.lane, time_s: t.time_s };
  });
}

/**
 * The empty scene as one column-major column: per-row median of the image's first columns
 * (the field is still far from the line there).
 * @param {DecodedImage} img
 * @returns {Uint8Array}
 */
export function backgroundColumn(img, sample = 24) {
  const k = Math.max(1, Math.min(sample, img.width)), ch = img.channels, out = new Uint8Array(img.height * ch), vals = new Array(k);
  for (let y = 0; y < img.height; y++) for (let c = 0; c < ch; c++) {
    for (let x = 0; x < k; x++) vals[x] = img.data[(y * img.width + x) * ch + c];
    vals.sort((a, b) => a - b);
    out[y * ch + c] = vals[k >> 1];
  }
  return out;
}

/**
 * Copy columns [x0, x0+n) of a row-major image into column-major bytes.
 * @param {DecodedImage} img
 * @param {number} x0
 * @param {number} n
 */
export function columnsOf(img, x0, n) {
  const { width, height, channels: ch, data } = img;
  const out = Buffer.allocUnsafe(n * height * ch);
  for (let c = 0; c < n; c++) {
    const x = x0 + c;
    for (let y = 0; y < height; y++) {
      const src = (y * width + x) * ch;
      const dst = (c * height + y) * ch;
      for (let k = 0; k < ch; k++) out[dst + k] = data[src + k];
    }
  }
  return out;
}

/**
 * Simulated camera. Yields hello, start_pulse (hwTime 1000.0), columns in
 * chunks of 64 with hwTime = 1000.0 + first_column_race_time_s + i *
 * column_period_s, then end.
 *
 * With `realtime`, each chunk is released when its last column would have
 * been captured, measured from the start pulse (so the first chunk of a
 * finish-only image arrives first_column_race_time_s after the start).
 *
 * @param {object} o
 * @param {Uint8Array | string | DecodedImage} o.png  PNG bytes, a PNG path, or an already decoded image.
 * @param {SimSidecar | string} o.sidecar            Object or sidecar JSON path.
 * @param {boolean} [o.realtime=false]
 * @param {number} [o.speed=1]           Realtime speed-up factor.
 * @param {number} [o.chunkColumns=64]
 * @param {string} [o.model='sim-replay']
 * @param {number} [o.preRollFrom]   Race time to start streaming from (e.g. 0 = the gun). Columns before the image
 *                                     repeat the empty scene (per-row median of the image's first columns).
 * @param {boolean} [o.holdOpen=false] Continue streaming the empty scene until the operator stops.
 * @param {AbortSignal} [o.signal] Stop capture promptly, including during paced waits.
 * @returns {AsyncGenerator<CameraMsg>}
 */
export async function* simReplay({ png, sidecar, realtime = false, speed = 1, chunkColumns = SIM_CHUNK_COLUMNS, model = 'sim-replay', preRollFrom, holdOpen = false, signal }) {
  const sc = readSidecar(sidecar);
  /** @type {DecodedImage} */
  let img;
  if (typeof png === 'string') img = decodePng(await readFile(png));
  else if (png instanceof Uint8Array) img = decodePng(png);
  else img = png;
  if (!(speed > 0)) throw new TypeError('speed must be > 0');
  if (!Number.isInteger(chunkColumns) || chunkColumns <= 0) throw new TypeError('chunkColumns must be a positive integer');

  const period = sc.column_period_s;
  const firstRace = sc.first_column_race_time_s;
  // A real camera runs from the gun: pre-roll columns of the empty scene up to the image's first column.
  const nPre = preRollFrom == null ? 0 : Math.max(0, Math.round((firstRace - preRollFrom) / period));
  const bg = nPre ? backgroundColumn(img) : null;
  const total = nPre + img.width;
  yield { type: 'hello', model, rows: img.height, channels: img.channels, columnPeriod: period };
  const t0 = performance.now();
  yield { type: 'start_pulse', hwTime: SIM_START_HW_TIME };
  for (let x0 = 0; x0 < total; x0 += chunkColumns) {
    const n = Math.min(chunkColumns, total - x0);
    if (realtime) {
      const dueMs = ((firstRace + (x0 - nPre + n) * period) / speed) * 1000;
      const wait = t0 + dueMs - performance.now();
      if (wait > 0) await sleep(wait, undefined, { signal });
    }
    let data;
    if (x0 >= nPre) data = columnsOf(img, x0 - nPre, n);
    else {
      const colBytes = img.height * img.channels, pre = Math.min(n, nPre - x0);
      data = new Uint8Array(n * colBytes);
      for (let i = 0; i < pre; i++) data.set(bg, i * colBytes);
      if (pre < n) data.set(columnsOf(img, 0, n - pre), pre * colBytes);
    }
    yield {
      type: 'columns',
      firstHwTime: SIM_START_HW_TIME + firstRace + (x0 - nPre) * period,
      period,
      count: n,
      data,
    };
  }
  // The recording ending does not stop a live camera: keep capturing the empty track.
  if (holdOpen) {
    const last = columnsOf(img, img.width - 1, 1), tail = new Uint8Array(chunkColumns * last.length);
    for(let i=0;i<chunkColumns;i++) tail.set(last,i*last.length);
    // The tail only needs the final column. Release the decoded file-backed
    // source image while a manual recording stays open.
    img = null;
    for(let x0=total;!signal?.aborted;x0+=chunkColumns) {
      if(realtime) {
        const wait=t0+((firstRace+(x0-nPre+chunkColumns)*period)/speed)*1000-performance.now();
        if(wait>0) await sleep(wait,undefined,{signal});
      }
      yield { type:'columns', firstHwTime:SIM_START_HW_TIME+firstRace+(x0-nPre)*period, period, count:chunkColumns, data:tail };
    }
  }
  yield { type: 'end' };
}
