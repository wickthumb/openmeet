// Heat state machine as an event log: reduce(events) -> state.
//
//   loaded --arm--> armed --start--> running --capture_close--> review --save--> saved
//   armed --disarm--> loaded        running --recall--> armed (false start)
//   saved --any mark/status/clear change--> review (reopened)
//
// The log is the source of truth (persist it); state is derived and is plain
// JSON. apply() never mutates its input and throws HeatError on anything
// illegal. Marks and statuses are keyed by lane: v1 heats are laned.

/** @typedef {'loaded'|'armed'|'running'|'review'|'saved'} HeatStatus */
/** @typedef {'DNS'|'DNF'|'DQ'|'FS'|'SC'} StatusCode */
/** @typedef {'auto'|'checked'|'edited'|'manual'} MarkSrc */

export const HEAT_STATES = Object.freeze(['loaded', 'armed', 'running', 'review', 'saved']);
export const STATUS_CODES = Object.freeze(['DNS', 'DNF', 'DQ', 'FS', 'SC']);
/**
 * auto    applied from an `auto` proposal, no operator action
 * checked operator accepted a proposal at its own column
 * edited  operator placed the mark at a different column than the proposal
 * manual  no proposal for that lane
 */
export const MARK_SOURCES = Object.freeze(['auto', 'checked', 'edited', 'manual']);

/**
 * @typedef {object} HeatEntry
 * @property {number} lane
 * @property {string | null} id
 * @property {string} last
 * @property {string} first
 * @property {string} affiliation
 * @property {string} [license]
 * @property {string} [user1]
 * @property {string} [user2]
 * @property {string} [user3]
 */

/**
 * @typedef {object} ProposalItem
 * @property {number} lane
 * @property {number} col
 * @property {'auto'|'review'} decision
 * @property {string} [reason]
 * @property {number} [conf]
 */

/** @typedef {ProposalItem & {model: string | null, set: number}} Proposal */
/** @typedef {{col: number, src: MarkSrc, proposal: Proposal | null}} Mark */

/**
 * @typedef {object} HeatState
 * @property {HeatStatus} status
 * @property {{event: string, round: number, heat: number, name: string, distance: number|null, wind: number|string|null, windUnit: string|null}} heat
 * @property {HeatEntry[]} entries   Sorted by lane.
 * @property {{hwTime: number, timeOfDay: number|string|null} | null} start
 * @property {{hwTime: number, timeOfDay: number|string|null}[]} falseStarts
 * @property {Record<string, Mark>} marks          By lane.
 * @property {Record<string, StatusCode>} statuses  By lane.
 * @property {Record<string, Proposal>} proposals  Latest proposal per lane.
 * @property {{seq: number, model: string | null, items: (ProposalItem & {ignored?: string})[]}[]} proposalSets  Every set received, verbatim.
 * @property {{marks: Record<string, Mark>, statuses: Record<string, StatusCode>} | null} baseline  Revert target.
 * @property {{seq: number, fileName: string, snapshot: {marks: Record<string, Mark>, statuses: Record<string, StatusCode>}}[]} saves
 * @property {number} reopens   Times a saved heat went back to review.
 * @property {number} seq       Events applied.
 */

export class HeatError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'illegal') {
    super(message);
    this.name = 'HeatError';
    this.code = code;
  }
}

/** Event type -> states it is legal in (null = no state yet). */
const ALLOWED = {
  load: [null, 'loaded', 'armed'],
  arm: ['loaded'],
  disarm: ['armed'],
  start: ['armed'],
  recall: ['running'],
  capture_close: ['running'],
  proposals: ['review', 'saved'],
  mark: ['review', 'saved'],
  clear_mark: ['review', 'saved'],
  clear_all_marks: ['review', 'saved'],
  status: ['loaded', 'armed', 'running', 'review', 'saved'],
  revert: ['review', 'saved'],
  save: ['review', 'saved'],
};
export const EVENT_TYPES = Object.freeze(Object.keys(ALLOWED));

/** @param {unknown} v */
const isNonNegInt = (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 0;

/** @param {any} heat @returns {Pick<HeatState, 'heat' | 'entries' | 'statuses'>} */
function loadHeat(heat) {
  if (!heat || typeof heat !== 'object' || !Array.isArray(heat.entries)) {
    throw new HeatError('load needs heat.entries', 'invalid');
  }
  if (heat.event === undefined || heat.event === null || String(heat.event) === '') throw new HeatError('load needs heat.event', 'invalid');
  /** @type {HeatEntry[]} */
  const entries = [];
  /** @type {Record<string, StatusCode>} */
  const statuses = {};
  const seen = new Set();
  for (const e of heat.entries) {
    if (!Number.isInteger(e?.lane) || e.lane <= 0) {
      throw new HeatError(`entry ${e?.id ?? '?'} has no lane; v1 heats must be laned`, 'invalid');
    }
    if (seen.has(e.lane)) throw new HeatError(`two entries in lane ${e.lane}`, 'invalid');
    seen.add(e.lane);
    /** @type {HeatEntry} */
    const entry = { lane: e.lane, id: e.id ?? null, last: e.last ?? '', first: e.first ?? '', affiliation: e.affiliation ?? '' };
    for (const k of /** @type {const} */ (['license', 'user1', 'user2', 'user3'])) if (e[k] !== undefined) entry[k] = e[k];
    entries.push(entry);
    const preset = e.status ? String(e.status).toUpperCase() : null;
    if (preset && STATUS_CODES.includes(preset)) statuses[e.lane] = /** @type {StatusCode} */ (preset);
  }
  entries.sort((a, b) => a.lane - b.lane);
  return {
    heat: {
      event: String(heat.event),
      round: Number.isInteger(heat.round) ? heat.round : 1,
      heat: Number.isInteger(heat.heat) ? heat.heat : 1,
      name: heat.name ?? '',
      distance: heat.distance ?? null,
      wind: heat.wind ?? null,
      windUnit: heat.windUnit ?? null,
    },
    entries,
    statuses,
  };
}

/** @param {HeatState} s @param {unknown} lane */
function requireLane(s, lane) {
  if (!Number.isInteger(lane) || !s.entries.some((e) => e.lane === lane)) {
    throw new HeatError(`no entry in lane ${String(lane)}`, 'invalid');
  }
  return String(lane);
}

/** @param {HeatState} s */
function reopenIfSaved(s) {
  if (s.status === 'saved') {
    s.status = 'review';
    s.reopens += 1;
  }
}

/**
 * Lanes that still need a mark or a status before save.
 * @param {HeatState} state
 * @returns {number[]}
 */
export function missingResults(state) {
  return state.entries.filter((e) => !state.marks[e.lane] && !state.statuses[e.lane]).map((e) => e.lane);
}

/**
 * Apply one event. Returns a new state; throws HeatError if the event is
 * invalid or illegal in the current state.
 * @param {HeatState | undefined | null} state
 * @param {any} event
 * @returns {HeatState}
 */
export function apply(state, event) {
  const type = event?.type;
  if (!Object.hasOwn(ALLOWED, type)) throw new HeatError(`unknown heat event ${JSON.stringify(type)}`, 'invalid');
  const current = state ? state.status : null;
  if (!ALLOWED[/** @type {keyof typeof ALLOWED} */ (type)].includes(/** @type {any} */ (current))) {
    throw new HeatError(`${type} is illegal ${current ? `in state ${current}` : 'before load'}`);
  }

  if (type === 'load') {
    const loaded = loadHeat(event.heat);
    if (!state) {
      return {
        status: 'loaded', ...loaded, start: null, falseStarts: [], marks: {}, proposals: {},
        proposalSets: [], baseline: null, saves: [], reopens: 0, seq: 1,
      };
    }
    // Re-seed before the start (the operator accepted the meet manager's change).
    return { ...structuredClone(state), ...loaded, seq: state.seq + 1 };
  }

  const s = structuredClone(/** @type {HeatState} */ (state));
  s.seq += 1;
  switch (type) {
    case 'arm':
      s.status = 'armed';
      break;
    case 'disarm':
      s.status = 'loaded';
      break;
    case 'start': {
      if (typeof event.hwTime !== 'number' || !Number.isFinite(event.hwTime)) throw new HeatError('start needs a finite hwTime', 'invalid');
      s.start = { hwTime: event.hwTime, timeOfDay: event.timeOfDay ?? null };
      s.status = 'running';
      break;
    }
    case 'recall':
      if (s.start) s.falseStarts.push(s.start);
      s.start = null;
      s.status = 'armed';
      break;
    case 'capture_close':
      s.status = 'review';
      s.baseline = { marks: {}, statuses: structuredClone(s.statuses) };
      break;
    case 'proposals': {
      if (!Array.isArray(event.items)) throw new HeatError('proposals needs items[]', 'invalid');
      const model = event.model ?? null;
      const setIndex = s.proposalSets.length;
      const lanesInSet = new Set();
      const items = event.items.map((/** @type {any} */ it, /** @type {number} */ i) => {
        if (!Number.isInteger(it?.lane) || !isNonNegInt(it.col) || (it.decision !== 'auto' && it.decision !== 'review')) {
          throw new HeatError(`proposals.items[${i}] needs integer lane, integer col >= 0, decision auto|review`, 'invalid');
        }
        const item = { ...it };
        if (!s.entries.some((e) => e.lane === it.lane)) item.ignored = 'unknown_lane';
        else if (lanesInSet.has(it.lane)) item.ignored = 'duplicate_lane';
        lanesInSet.add(it.lane);
        return item;
      });
      s.proposalSets.push({ seq: s.seq, model, items: structuredClone(items) });
      let applied = 0;
      for (const item of items) {
        if (item.ignored) continue;
        const { ignored, ...clean } = item;
        /** @type {Proposal} */
        const proposal = { ...clean, model, set: setIndex };
        s.proposals[item.lane] = proposal;
        if (item.decision === 'auto' && !s.marks[item.lane] && !s.statuses[item.lane]) {
          /** @type {Mark} */
          const mark = { col: item.col, src: 'auto', proposal };
          s.marks[item.lane] = mark;
          if (s.saves.length === 0 && s.baseline) s.baseline.marks[item.lane] = structuredClone(mark);
          applied++;
        }
      }
      if (applied) reopenIfSaved(s);
      break;
    }
    case 'mark': {
      const lane = requireLane(s, event.lane);
      if (!isNonNegInt(event.col)) throw new HeatError('mark needs an integer col >= 0', 'invalid');
      const status = s.statuses[lane];
      if (status && status !== 'DQ') throw new HeatError(`lane ${lane} has status ${status}; clear it before marking`);
      const proposal = s.proposals[lane] ?? null;
      /** @type {MarkSrc} */
      const derived = !proposal ? 'manual' : proposal.col === event.col ? 'checked' : 'edited';
      if (event.src !== undefined && event.src !== derived) {
        throw new HeatError(`mark src ${event.src} does not match: lane ${lane} at col ${event.col} is ${derived}`, 'invalid');
      }
      const prev = s.marks[lane];
      if (prev && prev.col === event.col && prev.src === derived) break; // no change
      s.marks[lane] = { col: event.col, src: derived, proposal };
      reopenIfSaved(s);
      break;
    }
    case 'clear_mark': {
      const lane = requireLane(s, event.lane);
      if (s.marks[lane]) {
        delete s.marks[lane];
        reopenIfSaved(s);
      }
      break;
    }
    case 'clear_all_marks':
      if (Object.keys(s.marks).length) {
        s.marks = {};
        reopenIfSaved(s);
      }
      break;
    case 'status': {
      const lane = requireLane(s, event.lane);
      const code = event.code === null || event.code === undefined ? null : String(event.code).toUpperCase();
      if (code !== null && !STATUS_CODES.includes(code)) throw new HeatError(`unknown status ${code}`, 'invalid');
      if ((s.statuses[lane] ?? null) === code) break; // no change
      if (code === null) delete s.statuses[lane];
      else s.statuses[lane] = /** @type {StatusCode} */ (code);
      if (code !== null && code !== 'DQ') delete s.marks[lane];
      reopenIfSaved(s);
      break;
    }
    case 'revert': {
      const last = s.saves.length ? s.saves[s.saves.length - 1] : null;
      const target = last ? last.snapshot : s.baseline;
      if (target) {
        s.marks = structuredClone(target.marks);
        s.statuses = structuredClone(target.statuses);
      }
      break;
    }
    case 'save': {
      if (typeof event.fileName !== 'string' || !event.fileName) throw new HeatError('save needs a fileName', 'invalid');
      const missing = missingResults(s);
      if (missing.length) {
        throw new HeatError(`cannot save: lane${missing.length > 1 ? 's' : ''} ${missing.join(', ')} need a time or a status`, 'incomplete');
      }
      s.saves.push({
        seq: s.seq, fileName: event.fileName,
        snapshot: { marks: structuredClone(s.marks), statuses: structuredClone(s.statuses) },
      });
      s.status = 'saved';
      break;
    }
    default:
      break;
  }
  return s;
}

/**
 * Fold a whole event log into a state.
 * @param {any[]} events
 * @returns {HeatState}
 */
export function reduce(events) {
  if (!Array.isArray(events) || events.length === 0) throw new HeatError('reduce needs at least a load event', 'invalid');
  return /** @type {HeatState} */ (events.reduce((s, e) => apply(s, e), undefined));
}

/**
 * Rank marked, status-free athletes by column; equal columns share a place
 * (1, 1, 3). With `colTime`, each row also gets its race time.
 * @param {HeatState} state
 * @param {(col: number) => number} [colTime]
 * @returns {{lane: number, place: number, col: number, time?: number}[]}
 */
export function places(state, colTime) {
  const rows = state.entries
    .filter((e) => state.marks[e.lane] && !state.statuses[e.lane])
    .map((e) => ({ lane: e.lane, col: state.marks[e.lane].col }))
    .sort((a, b) => a.col - b.col || a.lane - b.lane);
  return rows.map((r, i) => {
    let place = i + 1;
    for (let j = i; j > 0 && rows[j - 1].col === r.col; j--) place = j;
    return colTime ? { ...r, place, time: colTime(r.col) } : { ...r, place };
  });
}

/**
 * Inputs for buildLif(heat, results) from a heat state. DQ keeps its time
 * when it has a mark.
 * @param {HeatState} state
 * @param {(col: number) => number} colTime  Race time of a column (e.g. store.raceTimeOf).
 */
export function lifInput(state, colTime) {
  const heat = { ...state.heat, startTimeOfDay: state.start?.timeOfDay ?? null };
  const results = state.entries.map((e) => {
    const mark = state.marks[e.lane];
    const status = state.statuses[e.lane] ?? null;
    return { ...e, status, time: mark ? colTime(mark.col) : null };
  });
  return { heat, results };
}
