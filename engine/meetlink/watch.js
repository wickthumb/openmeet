// Watch the meet folder for lynx.evt / lynx.ppl / lynx.sch changes.
// fs.watch (debounced) for speed, plus mtime/size polling because mapped
// network drives (SMB) often never deliver watch events.

import { watch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEvt, parsePpl, parseSch } from './parse.js';

/** @typedef {import('./parse.js').EvtHeat} EvtHeat */
/** @typedef {import('./parse.js').EvtEntry} EvtEntry */
/** @typedef {import('./parse.js').PplPerson} PplPerson */
/** @typedef {import('./parse.js').SchItem} SchItem */

/**
 * @typedef {object} MeetFolderSnapshot
 * @property {EvtHeat[]} events     Last good parse of lynx.evt ([] if absent).
 * @property {PplPerson[]} people   Last good parse of lynx.ppl.
 * @property {SchItem[]} schedule   Last good parse of lynx.sch.
 * @property {string[]} changed     Canonical names of the files that changed, e.g. ['lynx.evt'].
 */

/** @type {Record<string, (b: Uint8Array) => unknown[]>} */
const PARSERS = { 'lynx.evt': parseEvt, 'lynx.ppl': parsePpl, 'lynx.sch': parseSch };
export const MEET_FILES = Object.freeze(Object.keys(PARSERS));

/** @param {import('node:fs').Stats} s */
const sigOf = (s) => `${s.size}:${s.mtimeMs}:${s.ino}`;

/**
 * Watch `dir` and call `onChange` with the re-parsed files whenever any of
 * them changes. File names are matched case-insensitively (LYNX.EVT works).
 *
 * Mid-write safety: a new size/mtime/inode must hold still for `settleMs`
 * (seen on a later scan) before the file is read; the stat is repeated after
 * the read; an empty file or a parse error keeps the last good data and is
 * retried on the next scan. Nothing is emitted for those.
 *
 * Coarse timestamps: a same-size rewrite within the file system's mtime
 * resolution leaves the stat unchanged (a lane swap can do that), so every
 * `rereadMs` the bytes are re-read and compared as well.
 *
 * @param {string} dir
 * @param {(snapshot: MeetFolderSnapshot) => void} onChange
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=250]  Quiet time after an fs.watch event.
 * @param {number} [opts.pollMs=1000]     Polling interval (the fallback).
 * @param {number} [opts.settleMs]        Stability window; defaults to debounceMs.
 * @param {number} [opts.rereadMs=5000]  Content re-check interval for unchanged stats (0 = off).
 * @param {boolean} [opts.fsWatch=true]   false = polling only.
 * @param {(err: Error, file: string) => void} [opts.onError]  Parse errors, once per file version.
 * @returns {() => Promise<void>} close(): stops watching; resolves when an in-flight scan ends.
 */
export function watchMeetFolder(dir, onChange, opts = {}) {
  const debounceMs = opts.debounceMs ?? 250;
  const pollMs = opts.pollMs ?? 1000;
  const settleMs = opts.settleMs ?? debounceMs;
  const rereadMs = opts.rereadMs ?? 5000;
  const useFsWatch = opts.fsWatch ?? true;
  const onError = opts.onError ?? (() => {});

  /** @type {Record<string, {sig: string|null, pendingSig: string|null, pendingSince: number, checkedAt: number, errSig: string|null, bytes: Buffer|null, data: unknown[]}>} */
  const files = {};
  for (const name of MEET_FILES) {
    files[name] = { sig: null, pendingSig: null, pendingSince: 0, checkedAt: 0, errSig: null, bytes: null, data: [] };
  }

  let closed = false;
  /** @type {Promise<void> | null} */
  let running = null;
  let rerun = false;
  /** @type {NodeJS.Timeout | null} */
  let debounceTimer = null;
  /** @type {NodeJS.Timeout | null} */
  let settleTimer = null;
  /** @type {import('node:fs').FSWatcher | null} */
  let watcher = null;

  function requestScan() {
    if (closed) return;
    if (running) {
      rerun = true;
      return;
    }
    running = scan()
      .catch((err) => onError(/** @type {Error} */ (err), ''))
      .finally(() => {
        running = null;
        if (rerun && !closed) {
          rerun = false;
          requestScan();
        }
      });
  }

  /** @param {number} delay */
  function scheduleSettle(delay) {
    if (closed || settleTimer) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      requestScan();
    }, Math.max(1, delay));
  }

  /** Remember a newly seen file version and when it was first seen. */
  function sighting(/** @type {typeof files[string]} */ f, /** @type {string} */ sig) {
    f.pendingSig = sig;
    f.pendingSince = Date.now();
    scheduleSettle(settleMs);
  }

  async function scan() {
    /** @type {string[]} */
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return; // folder missing or unreachable (network drop); keep last good data
    }
    /** @type {Map<string, string>} */
    const actual = new Map();
    for (const n of names) {
      const lower = n.toLowerCase();
      if (Object.hasOwn(PARSERS, lower) && !actual.has(lower)) actual.set(lower, n);
    }
    /** @type {string[]} */
    const changed = [];
    for (const name of MEET_FILES) {
      const f = files[name];
      const real = actual.get(name);
      if (!real) {
        if (f.bytes !== null) {
          Object.assign(f, { sig: null, pendingSig: null, bytes: null, data: [] });
          changed.push(name);
        }
        continue;
      }
      const path = join(dir, real);
      try {
        const s1 = await stat(path);
        const sig = sigOf(s1);
        if (sig === f.sig) {
          if (!rereadMs || Date.now() - f.checkedAt < rereadMs) continue;
          f.checkedAt = Date.now();
          const again = await readFile(path);
          if (f.bytes && again.equals(f.bytes)) continue;
          f.sig = null; // same stat, different bytes: treat as a new version
          sighting(f, sig);
          continue;
        }
        if (sig !== f.pendingSig) {
          sighting(f, sig); // new version: wait for it to hold still
          continue;
        }
        const waited = Date.now() - f.pendingSince;
        if (waited < settleMs) {
          scheduleSettle(settleMs - waited);
          continue;
        }
        if (s1.size === 0) continue; // being rewritten; retry next scan
        const bytes = await readFile(path);
        const s2 = await stat(path);
        if (sigOf(s2) !== sig || bytes.length !== s1.size) {
          sighting(f, sigOf(s2));
          continue;
        }
        let data;
        try {
          data = PARSERS[name](bytes);
        } catch (err) {
          if (f.errSig !== sig) {
            f.errSig = sig;
            onError(/** @type {Error} */ (err), name);
          }
          continue; // retry next scan
        }
        f.sig = sig;
        f.checkedAt = Date.now();
        if (f.bytes && f.bytes.equals(bytes)) continue; // touched, not changed
        f.bytes = bytes;
        f.data = data;
        changed.push(name);
      } catch {
        continue; // vanished between readdir and stat/read (atomic replace); retry
      }
    }
    if (changed.length && !closed) {
      onChange({
        events: /** @type {EvtHeat[]} */ (files['lynx.evt'].data),
        people: /** @type {PplPerson[]} */ (files['lynx.ppl'].data),
        schedule: /** @type {SchItem[]} */ (files['lynx.sch'].data),
        changed,
      });
    }
  }

  function startWatcher() {
    if (!useFsWatch || watcher || closed) return;
    try {
      watcher = watch(dir, { persistent: true }, (_type, filename) => {
        const lower = filename ? String(filename).toLowerCase() : null;
        if (lower && !Object.hasOwn(PARSERS, lower)) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          requestScan();
        }, debounceMs);
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null; // polling continues; re-armed on the next poll
      });
    } catch {
      watcher = null; // unsupported or missing folder: polling only
    }
  }

  const pollTimer = setInterval(() => {
    startWatcher();
    requestScan();
  }, pollMs);
  startWatcher();
  requestScan();

  return async function close() {
    closed = true;
    clearInterval(pollTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (settleTimer) clearTimeout(settleTimer);
    watcher?.close();
    watcher = null;
    if (running) await running;
  };
}

/**
 * @typedef {object} HeatDiff
 * @property {boolean} changed
 * @property {EvtEntry[]} added
 * @property {EvtEntry[]} removed
 * @property {{id: string|null, last: string, first: string, from: number|null, to: number|null}[]} laneChanges
 * @property {{id: string|null, lane: number|null, from: {last: string, first: string}, to: {last: string, first: string}}[]} nameChanges
 * @property {{id: string|null, lane: number|null, from: string, to: string}[]} affiliationChanges
 * @property {{id: string|null, lane: number|null, from: string|null, to: string|null}[]} statusChanges
 * @property {{field: string, from: unknown, to: unknown}[]} headerChanges  Event name / distance.
 */

/**
 * Key entries by ID; entries without an ID by lane. Duplicates get `#n`.
 * @param {EvtEntry[]} entries
 */
function keyed(entries) {
  /** @type {Map<string, EvtEntry>} */
  const map = new Map();
  for (const e of entries) {
    const base = e.id !== null ? `id:${e.id}` : `lane:${e.lane}`;
    let k = base;
    for (let n = 2; map.has(k); n++) k = `${base}#${n}`;
    map.set(k, e);
  }
  return map;
}

/**
 * What changed between two versions of a heat's start list. Entries match by
 * ID (by lane when they have no ID, so their lane changes show as
 * removed + added). Used to warn when the meet manager re-seeds an armed heat.
 * @param {EvtHeat | null | undefined} oldHeat
 * @param {EvtHeat | null | undefined} newHeat
 * @returns {HeatDiff}
 */
export function diffHeat(oldHeat, newHeat) {
  const a = keyed(oldHeat?.entries ?? []);
  const b = keyed(newHeat?.entries ?? []);
  /** @type {HeatDiff} */
  const d = {
    changed: false, added: [], removed: [], laneChanges: [], nameChanges: [],
    affiliationChanges: [], statusChanges: [], headerChanges: [],
  };
  for (const [k, e] of a) if (!b.has(k)) d.removed.push(e);
  for (const [k, n] of b) {
    const o = a.get(k);
    if (!o) {
      d.added.push(n);
      continue;
    }
    if (o.lane !== n.lane) d.laneChanges.push({ id: n.id, last: n.last, first: n.first, from: o.lane, to: n.lane });
    if (o.last !== n.last || o.first !== n.first) {
      d.nameChanges.push({ id: n.id, lane: n.lane, from: { last: o.last, first: o.first }, to: { last: n.last, first: n.first } });
    }
    if (o.affiliation !== n.affiliation) d.affiliationChanges.push({ id: n.id, lane: n.lane, from: o.affiliation, to: n.affiliation });
    if (o.status !== n.status) d.statusChanges.push({ id: n.id, lane: n.lane, from: o.status, to: n.status });
  }
  if (oldHeat && newHeat) {
    for (const field of /** @type {const} */ (['name', 'distance'])) {
      if (oldHeat[field] !== newHeat[field]) d.headerChanges.push({ field, from: oldHeat[field], to: newHeat[field] });
    }
  }
  d.changed = d.added.length + d.removed.length + d.laneChanges.length + d.nameChanges.length
    + d.affiliationChanges.length + d.statusChanges.length + d.headerChanges.length > 0;
  return d;
}
