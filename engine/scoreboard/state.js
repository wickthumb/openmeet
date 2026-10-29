/** @typedef {{running: boolean, startedAtMs: number|null, speed: number, frozenS: number}} ScoreboardClock */
/** @typedef {{lane: number|null, id: string|null, first: string, last: string, affiliation: string, status: string|null, time: number|null, place: number|null, review: boolean}} ScoreboardLane */
/**
 * @typedef {object} ScoreboardState
 * @property {{name: string, logo: string|null}} meet
 * @property {{event: string, round: number, heat: number, of: number|null, name: string, state: string}} heat
 * @property {ScoreboardClock} clock
 * @property {ScoreboardLane[]} lanes
 * @property {ScoreboardLane[]} results
 * @property {number|null} wind Metres per second.
 * @property {number} updatedAt Unix milliseconds.
 */

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = value => typeof value === 'string' ? value : '';
const number = value => typeof value === 'number' && Number.isFinite(value);
const positiveInt = value => number(value) && Number.isInteger(value) && value > 0 ? value : null;
const seconds = value => number(value) && value >= 0 ? value : null;
const id = value => typeof value === 'string' || number(value) ? String(value) : null;

/** A logo must remain a relative path within the selected template. */
function logoPath(value) {
  if (typeof value !== 'string' || !value || /[\\:%?#\u0000-\u001f]/.test(value)) return null;
  return value.split('/').every(part => part && part !== '.' && part !== '..') ? value : null;
}

/** @param {unknown} input @returns {ScoreboardLane} */
function lane(input) {
  const v = object(input);
  const status = typeof v.status === 'string' ? v.status.toUpperCase() : null;
  const validStatus = ['DNS', 'DNF', 'DQ', 'FS'].includes(status) ? status : null;
  return {
    lane: positiveInt(v.lane), id: id(v.id), first: text(v.first), last: text(v.last),
    affiliation: text(v.affiliation), status: validStatus,
    time: validStatus ? null : seconds(v.time), place: validStatus ? null : positiveInt(v.place),
    review: !validStatus&&seconds(v.time)!==null&&v.review===true,
  };
}

/**
 * Sanitize a full state replacement. Unknown fields are dropped; absent or invalid
 * fields get defaults. Input is never mutated. Missing optional fields never throw.
 * Explicit results may describe a previous heat; otherwise they derive from lanes.
 * @param {unknown} [input]
 * @returns {ScoreboardState}
 */
export function normalizeState(input) {
  const v = object(input), meet = object(v.meet), heat = object(v.heat), clock = object(v.clock);
  const lanes = Array.isArray(v.lanes) ? v.lanes.map(lane) : [];
  const results = (Array.isArray(v.results) ? v.results.map(lane) : lanes.map(v => ({ ...v })))
    .filter(v => v.status === null && v.time !== null && v.place !== null&&!v.review)
    .sort((a, b) => a.place - b.place || a.time - b.time || (a.lane ?? 0) - (b.lane ?? 0));
  const startedAtMs = seconds(clock.startedAtMs);
  return {
    meet: { name: text(meet.name), logo: logoPath(meet.logo) },
    heat: {
      event: id(heat.event) ?? '', round: positiveInt(heat.round) ?? 1,
      heat: positiveInt(heat.heat) ?? 1, of: positiveInt(heat.of), name: text(heat.name),
      state: ['loaded', 'armed', 'running', 'review', 'saved'].includes(heat.state) ? heat.state : 'loaded',
    },
    clock: { running: clock.running === true && startedAtMs !== null, startedAtMs,
      speed: seconds(clock.speed) ?? 1, frozenS: seconds(clock.frozenS) ?? 0 },
    lanes, results, wind: number(v.wind) ? v.wind : null,
    updatedAt: seconds(v.updatedAt) ?? Date.now(),
  };
}

// Packaged Electron builds include engine JS only. This mirrors the data-contract
// section of docs/scoreboard-v1.md for agent prompts when that file is not bundled.
export const SCOREBOARD_DATA_CONTRACT = `OpenMeet scoreboard data contract v1:
meet: {name: string, logo: template-relative asset path or null}.
heat: {event: string, round: positive integer, heat: positive integer, of: positive integer or null,
name: string, state: loaded|armed|running|review|saved}.
clock: {running: boolean, startedAtMs: Unix milliseconds or null, speed: nonnegative number,
frozenS: nonnegative seconds}. Running time is max(0, (Date.now()-startedAtMs)/1000*speed);
when stopped it is frozenS. Use OpenMeetScoreboard.raceTime(state) in requestAnimationFrame.
lanes: [{lane: positive integer or null, id: string or null, first: string, last: string,
affiliation: string, status: null|DNS|DNF|DQ|FS, time: seconds or null, place: positive integer or null,
review: boolean (unaccepted suggested time; default false)}].
results: accepted finishers with a time and place, no status or pending review, sorted by place.
Classic displays all lanes by supplied place, then unplaced timed entries, then untimed lanes.
Show provisional times with an In review label; never turn a suggestion into an accepted result.
wind: metres per second or null. updatedAt: Unix milliseconds.
Updates are full normalized JSON replacements, not patches. Never invent results.`;
