// Append-only capture store, one directory per heat:
//   meta.json     written once, at the first hello
//   columns.bin   raw pixel data, column-major, rows*channels bytes per column
//   times.f64     one little-endian Float64 hardware timestamp per column
//   events.jsonl  hello / start_pulse / end / warnings / recovery, one JSON per line
// Existing bytes are never rewritten. Reopening after a crash keeps every
// complete column; only a torn tail is cut (see openCaptureStore).

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, statSync, truncateSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { columnBytes, validateMessage } from './protocol.js';

/** @typedef {import('./protocol.js').CameraMsg} CameraMsg */

/**
 * @typedef {object} CaptureMeta
 * @property {'openmeet-capture'} format
 * @property {1} version
 * @property {string} model
 * @property {number} rows
 * @property {number} channels
 * @property {number} columnPeriod
 * @property {string} createdAt
 */

/**
 * @typedef {object} CaptureStore
 * @property {string} dir
 * @property {(msg: CameraMsg) => ({from: number, to: number} | undefined)} append  Returns the new column range for `columns`.
 * @property {() => number} columnCount
 * @property {(from: number, to: number) => Buffer} readColumns  Columns [from, to), column-major bytes.
 * @property {(col: number) => number} timeOf       Hardware time of a column.
 * @property {(col: number) => number} raceTimeOf   timeOf(col) - latest start pulse hwTime; throws if no start pulse.
 * @property {(from: number, to: number) => Float64Array} timesOf  Hardware times of columns [from, to) (a copy).
 * @property {() => number | null} startHwTime  Latest start pulse, or null.
 * @property {() => CaptureMeta | null} meta
 * @property {() => object[]} events  Logged events, oldest first (a copy).
 * @property {{columnsBytesCut: number, timesBytesCut: number, eventsBytesCut: number}} recovery  What reopening cut.
 * @property {() => void} close
 */

const FILES = { meta: 'meta.json', columns: 'columns.bin', times: 'times.f64', events: 'events.jsonl' };

/** @param {number} fd @param {Uint8Array} buf */
function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
}

/** @param {string} p */
const sizeOf = (p) => (existsSync(p) ? statSync(p).size : 0);

/** @param {string} dir */
function fsyncDir(dir) {
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // not supported on Windows
  }
}

/**
 * Open (or create) a capture store in `dir`.
 *
 * Reopening an existing store loads it for reading and further appends.
 * Crash recovery: the column count is min(whole columns in columns.bin,
 * whole timestamps in times.f64). Bytes past that are a torn tail (a partial
 * column, or a column whose timestamp never landed) and are truncated; a
 * partial last line of events.jsonl is truncated too. Anything cut is logged
 * as a `recovered` event. With `readOnly`, nothing is cut or written.
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {boolean} [opts.readOnly=false]
 * @param {number} [opts.syncIntervalMs=250]  fsync columns at most this often (0 = every chunk). hello/start/end always fsync.
 * @param {() => number} [opts.now=Date.now]  Wall clock for event `at` stamps.
 * @returns {CaptureStore}
 */
export function openCaptureStore(dir, opts = {}) {
  const readOnly = opts.readOnly ?? false;
  const syncIntervalMs = opts.syncIntervalMs ?? 250;
  const now = opts.now ?? Date.now;
  if (!readOnly) mkdirSync(dir, { recursive: true });
  const p = {
    meta: join(dir, FILES.meta), columns: join(dir, FILES.columns),
    times: join(dir, FILES.times), events: join(dir, FILES.events),
  };

  /** @type {CaptureMeta | null} */
  let meta = existsSync(p.meta) ? JSON.parse(readFileSync(p.meta, 'utf8')) : null;
  const binSize = sizeOf(p.columns);
  const timesSize = sizeOf(p.times);
  if (!meta && (binSize > 0 || timesSize > 0)) {
    throw new Error(`capture store ${dir}: column data without meta.json`);
  }
  let colBytes = meta ? columnBytes(meta) : 0;
  let count = meta ? Math.min(Math.floor(binSize / colBytes), Math.floor(timesSize / 8)) : 0;
  const recovery = {
    columnsBytesCut: binSize - count * colBytes,
    timesBytesCut: timesSize - count * 8,
    eventsBytesCut: 0,
  };

  // Load timestamps.
  let times = new Float64Array(Math.max(1024, count * 2));
  if (count > 0) {
    const raw = readFileSync(p.times).subarray(0, count * 8);
    for (let i = 0; i < count; i++) times[i] = raw.readDoubleLE(i * 8);
  }

  // Load events; a torn last line is cut.
  /** @type {any[]} */
  const events = [];
  if (existsSync(p.events)) {
    const text = readFileSync(p.events, 'utf8');
    const lastNl = text.lastIndexOf('\n');
    const whole = text.slice(0, lastNl + 1);
    recovery.eventsBytesCut = Buffer.byteLength(text) - Buffer.byteLength(whole);
    for (const line of whole.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ type: 'unreadable_event', raw: line });
      }
    }
  }
  let startHw = null;
  for (const e of events) if (e.type === 'start_pulse') startHw = e.hwTime;

  /** @type {{bin: number, times: number, events: number, read: number | null}} */
  const fds = { bin: -1, times: -1, events: -1, read: null };
  let closed = false;
  let lastSync = 0;

  /** @param {object} e */
  function logEvent(e) {
    const rec = { ...e, col: count, at: now() };
    writeAll(fds.events, Buffer.from(JSON.stringify(rec) + '\n'));
    fsyncSync(fds.events);
    events.push(rec);
  }

  if (!readOnly) {
    if (recovery.columnsBytesCut > 0) truncateSync(p.columns, count * colBytes);
    if (recovery.timesBytesCut > 0) truncateSync(p.times, count * 8);
    if (recovery.eventsBytesCut > 0) truncateSync(p.events, sizeOf(p.events) - recovery.eventsBytesCut);
    fds.bin = openSync(p.columns, 'a');
    fds.times = openSync(p.times, 'a');
    fds.events = openSync(p.events, 'a');
    if (recovery.columnsBytesCut || recovery.timesBytesCut || recovery.eventsBytesCut) {
      logEvent({ type: 'recovered', ...recovery });
    }
  }
  if (existsSync(p.columns)) fds.read = openSync(p.columns, 'r');

  function assertOpen() {
    if (closed) throw new Error('capture store is closed');
  }

  /** @param {number} col */
  function checkCol(col) {
    if (!Number.isInteger(col) || col < 0 || col >= count) {
      throw new RangeError(`column ${col} out of range [0, ${count})`);
    }
  }

  /** @param {number} from @param {number} to */
  function checkRange(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > count) {
      throw new RangeError(`column range [${from}, ${to}) out of [0, ${count}]`);
    }
  }

  /** @param {CaptureMeta} m @param {import('./protocol.js').HelloMsg} h */
  function sameGeometry(m, h) {
    return m.rows === h.rows && m.channels === h.channels;
  }

  function syncColumns() {
    fsyncSync(fds.bin);
    fsyncSync(fds.times);
    lastSync = now();
  }

  /** @type {CaptureStore} */
  const store = {
    dir,
    recovery,

    append(msg) {
      assertOpen();
      if (readOnly) throw new Error('capture store opened read-only');
      validateMessage(msg, meta);
      switch (msg.type) {
        case 'hello': {
          if (!meta) {
            meta = {
              format: 'openmeet-capture', version: 1, model: msg.model, rows: msg.rows,
              channels: msg.channels, columnPeriod: msg.columnPeriod, createdAt: new Date(now()).toISOString(),
            };
            const tmp = `${p.meta}.tmp`;
            writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n');
            const fd = openSync(tmp, 'r+');
            try { fsyncSync(fd); } finally { closeSync(fd); }
            renameSync(tmp, p.meta);
            fsyncDir(dir);
            colBytes = columnBytes(meta);
          } else if (!sameGeometry(meta, msg)) {
            throw new Error(`hello ${msg.rows}x${msg.channels} does not match this capture (${meta.rows}x${meta.channels})`);
          }
          logEvent({ type: 'hello', model: msg.model, rows: msg.rows, channels: msg.channels, columnPeriod: msg.columnPeriod });
          return undefined;
        }
        case 'start_pulse':
          logEvent({ type: 'start_pulse', hwTime: msg.hwTime });
          startHw = msg.hwTime;
          return undefined;
        case 'columns': {
          if (!meta) throw new Error('columns before hello');
          if (count > 0 && msg.firstHwTime <= times[count - 1]) {
            // Never drop capture data over a clock glitch; record it instead.
            logEvent({ type: 'warning', kind: 'non_monotonic_time', prev: times[count - 1], next: msg.firstHwTime });
          }
          const tbuf = Buffer.allocUnsafe(msg.count * 8);
          for (let i = 0; i < msg.count; i++) tbuf.writeDoubleLE(msg.firstHwTime + i * msg.period, i * 8);
          // Pixels first, then timestamps: recovery trusts only columns that have both.
          writeAll(fds.bin, msg.data);
          writeAll(fds.times, tbuf);
          if (count + msg.count > times.length) {
            const grown = new Float64Array(Math.max(times.length * 2, count + msg.count));
            grown.set(times.subarray(0, count));
            times = grown;
          }
          for (let i = 0; i < msg.count; i++) times[count + i] = tbuf.readDoubleLE(i * 8);
          const from = count;
          count += msg.count;
          if (fds.read === null) fds.read = openSync(p.columns, 'r');
          if (syncIntervalMs === 0 || now() - lastSync >= syncIntervalMs) syncColumns();
          return { from, to: count };
        }
        case 'end':
          syncColumns();
          logEvent({ type: 'end' });
          return undefined;
        default:
          return undefined;
      }
    },

    columnCount() {
      return count;
    },

    readColumns(from, to) {
      assertOpen();
      checkRange(from, to);
      const out = Buffer.alloc((to - from) * colBytes);
      if (out.length === 0) return out;
      let off = 0;
      while (off < out.length) {
        const n = readSync(/** @type {number} */ (fds.read), out, off, out.length - off, from * colBytes + off);
        if (n === 0) throw new Error('columns.bin is shorter than its column count');
        off += n;
      }
      return out;
    },

    timeOf(col) {
      assertOpen();
      checkCol(col);
      return times[col];
    },

    raceTimeOf(col) {
      assertOpen();
      checkCol(col);
      if (startHw === null) throw new Error('no start pulse recorded');
      return times[col] - startHw;
    },

    timesOf(from, to) {
      assertOpen();
      checkRange(from, to);
      return times.slice(from, to);
    },

    startHwTime() {
      return startHw;
    },

    meta() {
      return meta ? { ...meta } : null;
    },

    events() {
      return events.map((e) => ({ ...e }));
    },

    close() {
      if (closed) return;
      closed = true;
      if (!readOnly) {
        syncColumns();
        for (const fd of [fds.bin, fds.times, fds.events]) closeSync(fd);
      }
      if (fds.read !== null) closeSync(fds.read);
    },
  };
  return store;
}
