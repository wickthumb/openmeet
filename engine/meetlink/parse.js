// Readers for the meet manager's shared-folder files: lynx.evt (start lists),
// lynx.ppl (people) and lynx.sch (schedule). Layouts follow the FinishLynx
// database-file manual; see docs/blueprint.md section 2.

import { decodeMeetText, isSkippable, parseFields, splitLines } from './text.js';

/**
 * @typedef {object} EvtEntry
 * @property {string | null} id      Competitor ID; null when blank or 0.
 * @property {number | null} lane    null when blank or 0.
 * @property {string} last
 * @property {string} first
 * @property {string} affiliation
 * @property {string | null} status  Pre-set status from a `\CODE` line (upper case), else null.
 * @property {string[]} raw          Fields after the leading marker, as read.
 */

/**
 * @typedef {object} EvtHeat
 * @property {string} event          Kept as text: `18B` is a valid event.
 * @property {number} round
 * @property {number} heat
 * @property {string} name
 * @property {number | null} wind
 * @property {string | null} windUnit
 * @property {number | null} distance
 * @property {string | null} startTime
 * @property {string[]} raw          Header fields as read.
 * @property {EvtEntry[]} entries
 */

/**
 * @typedef {object} PplPerson
 * @property {string | null} id
 * @property {string} last
 * @property {string} first
 * @property {string} affiliation
 * @property {string} license
 * @property {string} user1
 * @property {string} user2
 * @property {string} user3
 */

/** @typedef {{event: string, round: number, heat: number}} SchItem */

/**
 * Integer field. Blank -> `blank`; anything that is not digits throws, so a
 * file caught mid-write fails loudly instead of yielding a wrong heat number.
 * @param {string | undefined} s
 * @param {number} blank
 * @param {string} what
 * @param {number} lineNo
 */
function intField(s, blank, what, lineNo) {
  const t = (s ?? '').trim();
  if (t === '') return blank;
  if (!/^\d+$/.test(t)) throw new Error(`line ${lineNo}: ${what} "${t}" is not an integer`);
  return Number.parseInt(t, 10);
}

/** @param {string | undefined} s */
function numOrNull(s) {
  const t = (s ?? '').trim();
  if (t === '') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** @param {string | undefined} s */
function strOrNull(s) {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
}

/** ID 0 (or blank) means "no ID". @param {string | undefined} s */
function idField(s) {
  const t = (s ?? '').trim();
  if (t === '' || /^0+$/.test(t)) return null;
  return t;
}

/** Lane blank, 0 or non-numeric means "no lane". @param {string | undefined} s */
function laneField(s) {
  const t = (s ?? '').trim();
  if (!/^\d+$/.test(t)) return null;
  const v = Number.parseInt(t, 10);
  return v === 0 ? null : v;
}

/** @param {string[]} f @param {string | null} status @returns {EvtEntry} */
function entryFrom(f, status) {
  return {
    id: idField(f[0]),
    lane: laneField(f[1]),
    last: f[2] ?? '',
    first: f[3] ?? '',
    affiliation: f[4] ?? '',
    status,
    raw: f,
  };
}

/**
 * Parse lynx.evt.
 * - Header line: `event, round, heat, event name, [wind], [wind unit], template,
 *   capture time, capture duration, distance, [start time], wind mode, laptime info`.
 * - Competitor line starts with `,`, tab or space: `,ID, lane, last, first, affiliation, ...`.
 * - Pre-set status line starts with `\`: `\DNS,22,2,Jones,Bob`.
 * - Competitor/status lines before the first header are ignored.
 * @param {string | Uint8Array} input  Text, or the raw file bytes (windows-1252).
 * @returns {EvtHeat[]}
 */
export function parseEvt(input) {
  const lines = splitLines(decodeMeetText(input));
  /** @type {EvtHeat[]} */
  const heats = [];
  /** @type {EvtHeat | null} */
  let current = null;
  lines.forEach((line, idx) => {
    if (isSkippable(line)) return;
    const lineNo = idx + 1;
    const c = line[0];
    if (c === ',' || c === '\t' || c === ' ') {
      if (!current) return;
      let rest = line.replace(/^[ \t]+/, '');
      if (rest[0] === ',') rest = rest.slice(1);
      current.entries.push(entryFrom(parseFields(rest), null));
      return;
    }
    if (c === '\\') {
      if (!current) return;
      const f = parseFields(line.slice(1));
      const status = (f.shift() ?? '').toUpperCase();
      if (status === '') throw new Error(`line ${lineNo}: status line without a code`);
      current.entries.push(entryFrom(f, status));
      return;
    }
    const f = parseFields(line);
    const event = f[0];
    if (!event) throw new Error(`line ${lineNo}: header line without an event`);
    current = {
      event,
      round: intField(f[1], 1, 'round', lineNo),
      heat: intField(f[2], 1, 'heat', lineNo),
      name: f[3] ?? '',
      wind: numOrNull(f[4]),
      windUnit: strOrNull(f[5]),
      distance: numOrNull(f[9]),
      startTime: strOrNull(f[10]),
      raw: f,
      entries: [],
    };
    heats.push(current);
  });
  return heats;
}

/**
 * Parse lynx.ppl: `ID, last, first, affiliation, license, user1, user2, user3`.
 * @param {string | Uint8Array} input
 * @returns {PplPerson[]}
 */
export function parsePpl(input) {
  /** @type {PplPerson[]} */
  const people = [];
  for (const line of splitLines(decodeMeetText(input))) {
    if (isSkippable(line)) continue;
    const f = parseFields(line);
    people.push({
      id: idField(f[0]),
      last: f[1] ?? '',
      first: f[2] ?? '',
      affiliation: f[3] ?? '',
      license: f[4] ?? '',
      user1: f[5] ?? '',
      user2: f[6] ?? '',
      user3: f[7] ?? '',
    });
  }
  return people;
}

/**
 * Parse lynx.sch: `event, round, heat` in run order. Missing round or heat = 1.
 * @param {string | Uint8Array} input
 * @returns {SchItem[]}
 */
export function parseSch(input) {
  /** @type {SchItem[]} */
  const items = [];
  splitLines(decodeMeetText(input)).forEach((line, idx) => {
    if (isSkippable(line)) return;
    const f = parseFields(line);
    if (!f[0]) return;
    items.push({
      event: f[0],
      round: intField(f[1], 1, 'round', idx + 1),
      heat: intField(f[2], 1, 'heat', idx + 1),
    });
  });
  return items;
}

/**
 * Find a heat in parsed lynx.evt output.
 * @param {EvtHeat[]} heats
 * @param {{event: string, round: number, heat: number}} key
 * @returns {EvtHeat | undefined}
 */
export function findHeat(heats, key) {
  return heats.find(
    (h) => h.event === String(key.event) && h.round === key.round && h.heat === key.heat,
  );
}
