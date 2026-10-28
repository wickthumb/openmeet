// LIF results writer: one `EEE-R-HH.lif` per heat in the meet folder.
// Layout: docs/blueprint.md section 2 (FinishLynx "Time Precision: Thousandths").

import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { encodeWindows1252, formatField } from './text.js';

/**
 * How athletes with a status are written.
 *
 * UNVERIFIED: this convention has not been checked against a LIF written by
 * FinishLynx itself that contains DNS/DNF/DQ. Confirm it with such a file (or
 * an AthleticLOCAL import test) before the first real meet; change it here only.
 */
export const LIF_STATUS_CONVENTION = Object.freeze({
  /** The status code (e.g. `DNF`) is written in the place column. */
  placeColumn: 'code',
  /** Status rows come after every finisher, ordered by lane. */
  order: 'after-finishers',
  /** Statuses that keep their time when they have one; the rest write an empty time. */
  keepsTime: Object.freeze(['DQ']),
  /** Accepted status codes. */
  codes: Object.freeze(['DNS', 'DNF', 'DQ', 'FS', 'SC']),
});

/**
 * Values this close above a whole thousandth are floating-point noise, not a
 * real fraction (1 microsecond; covers hardware epochs up to ~4e9 s).
 */
const CEIL_TOLERANCE_MS = 1e-3;

/**
 * Seconds -> whole thousandths, rounded up. 12.3401 -> 12341; 12.340 and
 * 12.339999999999998 -> 12340.
 * @param {number} seconds
 * @returns {number}
 */
export function thousandthsCeil(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`invalid time ${seconds}`);
  const ms = seconds * 1000;
  const nearest = Math.round(ms);
  return Math.abs(ms - nearest) <= CEIL_TOLERANCE_MS ? nearest : Math.ceil(ms);
}

/**
 * Format whole thousandths: `s.sss` under 60 s, `m:ss.sss` under an hour,
 * `h:mm:ss.sss` from an hour up.
 * @param {number} ms
 */
export function formatThousandths(ms) {
  const frac = String(ms % 1000).padStart(3, '0');
  const totalS = Math.floor(ms / 1000);
  if (totalS < 60) return `${totalS}.${frac}`;
  const s = String(totalS % 60).padStart(2, '0');
  const totalM = Math.floor(totalS / 60);
  if (totalM < 60) return `${totalM}:${s}.${frac}`;
  const m = String(totalM % 60).padStart(2, '0');
  return `${Math.floor(totalM / 60)}:${m}:${s}.${frac}`;
}

/**
 * Race time in seconds -> LIF time text (thousandths, rounded up).
 * @param {number} seconds
 */
export function formatLifTime(seconds) {
  return formatThousandths(thousandthsCeil(seconds));
}

/**
 * Time of day -> `hh:mm:ss.ssss` (nearest ten-thousandth).
 * @param {number | string | Date | null | undefined} tod  Seconds since local midnight, a Date, or preformatted text.
 */
export function formatTimeOfDay(tod) {
  if (tod === null || tod === undefined || tod === '') return '';
  if (typeof tod === 'string') return tod;
  let secs = tod instanceof Date
    ? tod.getHours() * 3600 + tod.getMinutes() * 60 + tod.getSeconds() + tod.getMilliseconds() / 1000
    : tod;
  if (!Number.isFinite(secs) || secs < 0) throw new RangeError(`invalid time of day ${String(tod)}`);
  const ticks = Math.round(secs * 1e4) % (86400 * 1e4);
  const frac = String(ticks % 1e4).padStart(4, '0');
  const total = Math.floor(ticks / 1e4);
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor(total / 60) % 60).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}.${frac}`;
}

/**
 * @typedef {object} LifHeat
 * @property {string | number} event
 * @property {number} round
 * @property {number} heat
 * @property {string} [name]
 * @property {number | string | null} [wind]
 * @property {string | null} [windUnit]
 * @property {number | string | Date | null} [startTimeOfDay]  Seconds since local midnight, Date, or text.
 */

/**
 * @typedef {object} LifResult
 * @property {string | number | null} [id]
 * @property {number | null} [lane]
 * @property {string} [last]
 * @property {string} [first]
 * @property {string} [affiliation]
 * @property {number | null} [time]      Race time in seconds (unrounded).
 * @property {string | null} [status]    DNS | DNF | DQ | FS | SC, or null for a finisher.
 * @property {string} [license]
 * @property {number | string | null} [reactionTime]  Seconds, or preformatted text.
 * @property {string} [splits]
 * @property {number | string | Date | null} [startTimeOfDay]  Time-trial start.
 * @property {string} [user1]
 * @property {string} [user2]
 * @property {string} [user3]
 */

/** @param {number | string | null | undefined} rt */
function formatReaction(rt) {
  if (rt === null || rt === undefined || rt === '') return '';
  return typeof rt === 'number' ? rt.toFixed(3) : rt;
}

/** @param {LifResult} r @param {string} place @param {string} time @param {string} delta */
function resultLine(r, place, time, delta) {
  return [
    place, r.id ?? '', r.lane ?? '', r.last ?? '', r.first ?? '', r.affiliation ?? '',
    time, r.license ?? '', delta, formatReaction(r.reactionTime), r.splits ?? '',
    formatTimeOfDay(r.startTimeOfDay), r.user1 ?? '', r.user2 ?? '', r.user3 ?? '',
  ].map(formatField).join(',');
}

/** @param {LifResult} r */
function describe(r) {
  return `lane ${r.lane ?? '-'} id ${r.id ?? '-'}`;
}

/**
 * Build the LIF text for one heat (CRLF line endings, trailing CRLF).
 * - Finishers (no status, a time) are ranked by exact time; equal times share a place.
 * - Delta: the first finisher's own time, then the gap to the previous finisher,
 *   computed on the written thousandths so the column adds up.
 * - Status athletes follow, per LIF_STATUS_CONVENTION.
 * @param {LifHeat} heat
 * @param {LifResult[]} results
 * @returns {string}
 */
export function buildLif(heat, results) {
  const header = [
    heat.event, heat.round, heat.heat, heat.name ?? '', heat.wind ?? '', heat.windUnit ?? '',
    '', '', '', '', formatTimeOfDay(heat.startTimeOfDay),
  ].map(formatField).join(',');

  /** @type {{r: LifResult, i: number, time: number}[]} */
  const finishers = [];
  /** @type {{r: LifResult, i: number, code: string}[]} */
  const statused = [];
  results.forEach((r, i) => {
    const code = r.status ? String(r.status).toUpperCase() : null;
    if (code) {
      if (!LIF_STATUS_CONVENTION.codes.includes(code)) throw new Error(`${describe(r)}: unknown status ${code}`);
      statused.push({ r, i, code });
    } else if (typeof r.time === 'number' && Number.isFinite(r.time)) {
      finishers.push({ r, i, time: r.time });
    } else {
      throw new Error(`${describe(r)}: neither a time nor a status`);
    }
  });

  finishers.sort((a, b) => a.time - b.time || a.i - b.i);
  const lines = [header];
  let prevMs = 0;
  let place = 0;
  finishers.forEach((f, k) => {
    if (k === 0 || f.time !== finishers[k - 1].time) place = k + 1;
    const ms = thousandthsCeil(f.time);
    const delta = k === 0 ? ms : ms - prevMs;
    prevMs = ms;
    lines.push(resultLine(f.r, String(place), formatThousandths(ms), formatThousandths(delta)));
  });

  statused.sort((a, b) => (a.r.lane ?? Infinity) - (b.r.lane ?? Infinity) || a.i - b.i);
  for (const s of statused) {
    const keep = LIF_STATUS_CONVENTION.keepsTime.includes(s.code)
      && typeof s.r.time === 'number' && Number.isFinite(s.r.time);
    const placeText = LIF_STATUS_CONVENTION.placeColumn === 'code' ? s.code : '';
    lines.push(resultLine(s.r, placeText, keep ? formatLifTime(/** @type {number} */ (s.r.time)) : '', ''));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Characters Windows forbids in file names. */
const BAD_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * LIF file name: `EEE-R-HH.lif`. A numeric event is zero-padded to 3 digits
 * (`3` -> `003`); a non-numeric one stays as-is (`18B`). Characters Windows
 * forbids in names are replaced by `_`.
 * @param {string | number} event
 * @param {number} round
 * @param {number} heat
 */
export function lifName(event, round, heat) {
  const e = String(event).trim();
  const ev = /^\d+$/.test(e) ? e.padStart(3, '0') : e.replace(BAD_NAME_CHARS, '_');
  return `${ev}-${round}-${String(heat).padStart(2, '0')}.lif`;
}

/** @type {Map<string, Promise<unknown>>} */
const writeQueues = new Map();

/** Windows refuses a rename while a reader holds the target open; retry briefly. */
async function renameWithRetry(/** @type {string} */ from, /** @type {string} */ to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err;
      await sleep(25 * (attempt + 1));
    }
  }
}

/** fsync a directory so the rename itself is durable. Not possible on Windows; ignored there. */
async function syncDir(/** @type {string} */ dir) {
  let fh;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch {
    // EISDIR/EPERM on Windows, EINVAL on some network file systems.
  } finally {
    await fh?.close();
  }
}

/**
 * Write a LIF so a reader never sees half a file: write `<fileName>.tmp`,
 * fsync it, rename over `<fileName>`, fsync the directory. Writes to the same
 * file from this process are serialised.
 * @param {string} dir
 * @param {string} fileName  A bare file name, e.g. from lifName().
 * @param {string | Uint8Array} text  LIF text (encoded as windows-1252) or bytes.
 * @returns {Promise<string>} The final path.
 */
export async function writeLifAtomic(dir, fileName, text) {
  if (!fileName || /[/\\]/.test(fileName) || fileName === '.' || fileName === '..') {
    throw new Error(`writeLifAtomic: "${fileName}" is not a bare file name`);
  }
  const bytes = typeof text === 'string' ? encodeWindows1252(text) : text;
  const finalPath = join(dir, fileName);
  const tmpPath = `${finalPath}.tmp`;
  const job = async () => {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await renameWithRetry(tmpPath, finalPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
    await syncDir(dir);
    return finalPath;
  };
  const prev = writeQueues.get(finalPath) ?? Promise.resolve();
  const next = prev.then(job, job);
  writeQueues.set(finalPath, next);
  try {
    return await next;
  } finally {
    if (writeQueues.get(finalPath) === next) writeQueues.delete(finalPath);
  }
}
