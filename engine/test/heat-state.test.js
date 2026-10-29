import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, reduce, places, missingResults, lifInput, HeatError } from '../heat/state.js';
import { parseEvt } from '../meetlink/parse.js';
import { buildLif } from '../meetlink/lif.js';
import { parseFields } from '../meetlink/text.js';

const [HEAT] = parseEvt([
  '3,1,2,Women 100m',
  ',101,1,Ace,Amy,East',
  ',102,2,Bee,Bea,West',
  ',103,3,Cee,Cat,North',
  '\\DNS,104,4,Dee,Dot,South',
].join('\n'));

const load = { type: 'load', heat: HEAT };
const toReview = [load, { type: 'arm' }, { type: 'start', hwTime: 1000, timeOfDay: 54000.5 }, { type: 'capture_close' }];

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Fold events one by one, asserting apply never mutates its input. */
function run(events) {
  let s;
  for (const e of events) s = apply(deepFreeze(s), e);
  return s;
}

const illegal = (fn, re) => assert.throws(fn, (err) => err instanceof HeatError && re.test(err.message));

test('load: entries by lane, pre-set status from lynx.evt, header kept', () => {
  const s = reduce([load]);
  assert.equal(s.status, 'loaded');
  assert.deepEqual(s.entries.map((e) => e.lane), [1, 2, 3, 4]);
  assert.deepEqual(s.statuses, { 4: 'DNS' });
  assert.deepEqual(s.heat, { event: '3', round: 1, heat: 2, name: 'Women 100m', distance: null, wind: null, windUnit: null });
  assert.equal(s.seq, 1);
  illegal(() => reduce([{ type: 'load', heat: { ...HEAT, entries: [{ id: '9', lane: null }] } }]), /has no lane/);
  illegal(() => reduce([{ type: 'load', heat: { ...HEAT, entries: [{ lane: 1 }, { lane: 1 }] } }]), /two entries in lane 1/);
  illegal(() => reduce([]), /at least a load/);
  illegal(() => reduce([{ type: 'arm' }]), /arm is illegal before load/);
});

test('legal path loaded -> armed -> running -> review -> saved, and every illegal move throws', () => {
  let s = run([load]);
  for (const bad of ['disarm', 'start', 'recall', 'capture_close', 'proposals', 'mark', 'clear_mark', 'clear_all_marks', 'revert', 'save']) {
    illegal(() => apply(s, { type: bad, hwTime: 1, lane: 1, col: 1, items: [], fileName: 'x' }), new RegExp(`${bad} is illegal in state loaded`));
  }
  s = apply(s, { type: 'arm' });
  assert.equal(s.status, 'armed');
  assert.equal(apply(s, { type: 'disarm' }).status, 'loaded');
  illegal(() => apply(s, { type: 'arm' }), /arm is illegal in state armed/);
  illegal(() => apply(s, { type: 'capture_close' }), /illegal in state armed/);
  illegal(() => apply(s, { type: 'start' }), /finite hwTime/);

  s = apply(s, { type: 'start', hwTime: 1000, timeOfDay: 54000.5 });
  assert.equal(s.status, 'running');
  assert.deepEqual(s.start, { hwTime: 1000, timeOfDay: 54000.5 });
  for (const bad of ['load', 'arm', 'disarm', 'start', 'mark', 'save', 'proposals']) {
    illegal(() => apply(s, { type: bad, heat: HEAT, hwTime: 1, lane: 1, col: 1, items: [], fileName: 'x' }), /illegal in state running/);
  }
  s = apply(s, { type: 'capture_close' });
  assert.equal(s.status, 'review');
  illegal(() => apply(s, { type: 'recall' }), /recall is illegal in state review/);
  illegal(() => apply(s, { type: 'arm' }), /illegal in state review/);
  illegal(() => apply(s, { type: 'bogus' }), /unknown heat event "bogus"/);
});

test('recall (false start) goes back to armed and keeps the false start on record', () => {
  const s = run([load, { type: 'arm' }, { type: 'start', hwTime: 1000 }, { type: 'recall' }, { type: 'start', hwTime: 1030, timeOfDay: '15:00:30.0000' }]);
  assert.equal(s.status, 'running');
  assert.deepEqual(s.falseStarts, [{ hwTime: 1000, timeOfDay: null }]);
  assert.deepEqual(s.start, { hwTime: 1030, timeOfDay: '15:00:30.0000' });
});

test('statuses can be set before the start (clerk scratches); re-seed while armed', () => {
  let s = run([load, { type: 'status', lane: 3, code: 'sc' }, { type: 'arm' }]);
  assert.deepEqual(s.statuses, { 3: 'SC', 4: 'DNS' });
  const [reseeded] = parseEvt('3,1,2,Women 100m\n,101,1,Ace,Amy,East\n,105,2,New,Nia,West\n');
  s = apply(s, { type: 'load', heat: reseeded });
  assert.equal(s.status, 'armed', 're-seed keeps the heat armed');
  assert.deepEqual(s.entries.map((e) => e.id), ['101', '105']);
  assert.deepEqual(s.statuses, {}, 'statuses follow the new start list');
  illegal(() => apply(s, { type: 'status', lane: 1, code: 'XX' }), /unknown status XX/);
  illegal(() => apply(s, { type: 'status', lane: 9, code: 'DNS' }), /no entry in lane 9/);
});

test('proposals: auto applied only to lanes with no mark and no status; review waits; everything recorded', () => {
  let s = run([...toReview, { type: 'mark', lane: 3, col: 900 }]);
  s = apply(s, {
    type: 'proposals', model: 'ttp-finish-v1',
    items: [
      { lane: 1, col: 500, decision: 'auto', reason: 'clear', conf: 0.99 },
      { lane: 2, col: 510, decision: 'review', reason: 'close_finish', conf: 0.7 },
      { lane: 3, col: 520, decision: 'auto', conf: 0.98 }, // already marked by the operator
      { lane: 4, col: 530, decision: 'auto', conf: 0.97 }, // DNS
      { lane: 9, col: 540, decision: 'auto', conf: 0.9 },  // no such lane
      { lane: 1, col: 999, decision: 'auto', conf: 0.5 },  // duplicate
    ],
  });
  assert.deepEqual(s.marks[1], { col: 500, src: 'auto', proposal: { lane: 1, col: 500, decision: 'auto', reason: 'clear', conf: 0.99, model: 'ttp-finish-v1', set: 0 } });
  assert.equal(s.marks[2], undefined, 'review proposals are not applied');
  assert.equal(s.marks[3].col, 900, 'operator mark wins');
  assert.equal(s.marks[4], undefined);
  assert.equal(s.statuses[4], 'DNS');
  assert.deepEqual(s.proposalSets[0].items.map((i) => i.ignored ?? null), [null, null, null, null, 'unknown_lane', 'duplicate_lane']);
  assert.equal(s.proposals[1].col, 500, 'duplicate did not replace the first');
  illegal(() => apply(s, { type: 'proposals', items: [{ lane: 1, col: -1, decision: 'auto' }] }), /items\[0\]/);
  illegal(() => apply(s, { type: 'proposals', items: [{ lane: 1, col: 1, decision: 'maybe' }] }), /items\[0\]/);
});

test('mark src: manual, checked, edited; given src must match; auto only via proposals', () => {
  let s = run([...toReview, { type: 'proposals', model: 'm', items: [{ lane: 1, col: 500, decision: 'review' }, { lane: 2, col: 510, decision: 'auto' }] }]);
  s = apply(s, { type: 'mark', lane: 1, col: 500, src: 'checked' });
  assert.equal(s.marks[1].src, 'checked');
  s = apply(s, { type: 'mark', lane: 1, col: 503 });
  assert.equal(s.marks[1].src, 'edited');
  assert.equal(s.marks[1].proposal.col, 500, 'the overridden proposal stays next to the mark');
  s = apply(s, { type: 'mark', lane: 3, col: 520 });
  assert.equal(s.marks[3].src, 'manual');
  assert.equal(s.marks[3].proposal, null);
  s = apply(s, { type: 'mark', lane: 2, col: 510 });
  assert.equal(s.marks[2].src, 'checked', 'operator confirming an auto mark');
  illegal(() => apply(s, { type: 'mark', lane: 3, col: 530, src: 'checked' }), /does not match: lane 3 at col 530 is manual/);
  illegal(() => apply(s, { type: 'mark', lane: 2, col: 510, src: 'auto' }), /does not match/);
  illegal(() => apply(s, { type: 'mark', lane: 3, col: 1.5 }), /integer col/);
  illegal(() => apply(s, { type: 'mark', lane: 7, col: 1 }), /no entry in lane 7/);
  // Proposals are never lost.
  assert.deepEqual(s.proposalSets[0].items, [{ lane: 1, col: 500, decision: 'review' }, { lane: 2, col: 510, decision: 'auto' }]);
});

test('status: non-DQ removes the mark, DQ keeps it; marking a DNF lane is refused', () => {
  let s = run([...toReview, { type: 'mark', lane: 1, col: 500 }, { type: 'mark', lane: 2, col: 510 }]);
  s = apply(s, { type: 'status', lane: 1, code: 'DQ' });
  assert.equal(s.marks[1].col, 500);
  s = apply(s, { type: 'status', lane: 2, code: 'DNF' });
  assert.equal(s.marks[2], undefined);
  illegal(() => apply(s, { type: 'mark', lane: 2, col: 600 }), /lane 2 has status DNF; clear it/);
  s = apply(s, { type: 'status', lane: 2, code: null });
  s = apply(s, { type: 'mark', lane: 2, col: 600 });
  assert.equal(s.marks[2].col, 600);
  s = apply(s, { type: 'mark', lane: 1, col: 505 });
  assert.equal(s.marks[1].col, 505, 'a DQ lane can still be marked');
});

test('save requires a mark or status for every entry; saved -> change -> review (reopened)', () => {
  let s = run([...toReview, { type: 'mark', lane: 1, col: 500 }]);
  assert.deepEqual(missingResults(s), [2, 3]);
  assert.throws(() => apply(s, { type: 'save', fileName: '003-1-02.lif' }), (e) => e.code === 'incomplete' && /lanes 2, 3 need a time or a status/.test(e.message));
  s = run([...toReview, { type: 'mark', lane: 1, col: 500 }, { type: 'mark', lane: 2, col: 510 }, { type: 'status', lane: 3, code: 'DNF' }]);
  illegal(() => apply(s, { type: 'save' }), /needs a fileName/);
  s = apply(s, { type: 'save', fileName: '003-1-02.lif' });
  assert.equal(s.status, 'saved');
  assert.equal(s.saves.length, 1);

  assert.equal(apply(s, { type: 'status', lane: 3, code: 'DNF' }).status, 'saved', 'no-op status does not reopen');
  assert.equal(apply(s, { type: 'clear_mark', lane: 3 }).status, 'saved', 'clearing nothing does not reopen');
  assert.equal(apply(s, { type: 'proposals', items: [{ lane: 1, col: 1, decision: 'auto' }] }).status, 'saved', 'nothing applied');
  for (const e of [{ type: 'mark', lane: 1, col: 501 }, { type: 'clear_mark', lane: 1 }, { type: 'clear_all_marks' }, { type: 'status', lane: 1, code: 'DQ' }]) {
    const r = apply(s, e);
    assert.equal(r.status, 'review', e.type);
    assert.equal(r.reopens, 1);
  }
  const again = apply(apply(s, { type: 'mark', lane: 1, col: 501 }), { type: 'save', fileName: '003-1-02.lif' });
  assert.equal(again.status, 'saved');
  assert.deepEqual(again.saves.map((x) => x.fileName), ['003-1-02.lif', '003-1-02.lif'], 'history kept');
  assert.equal(apply(again, { type: 'save', fileName: '003-1-02.lif' }).saves.length, 3, 're-save allowed');
});

test('revert: never saved -> capture close + applied auto proposals; after a save -> last save', () => {
  let s = run([
    ...toReview,
    { type: 'proposals', model: 'm', items: [{ lane: 1, col: 500, decision: 'auto' }, { lane: 2, col: 510, decision: 'review' }] },
    { type: 'mark', lane: 1, col: 505 },
    { type: 'mark', lane: 2, col: 510 },
    { type: 'status', lane: 4, code: null },
    { type: 'status', lane: 3, code: 'DNF' },
  ]);
  s = apply(s, { type: 'revert' });
  assert.deepEqual(Object.keys(s.marks), ['1']);
  assert.deepEqual({ col: s.marks[1].col, src: s.marks[1].src }, { col: 500, src: 'auto' });
  assert.deepEqual(s.statuses, { 4: 'DNS' });
  assert.equal(s.proposalSets.length, 1, 'proposals survive a revert');
  assert.equal(s.proposals[2].col, 510);

  s = run([...toReview, { type: 'mark', lane: 1, col: 500 }, { type: 'mark', lane: 2, col: 510 }, { type: 'mark', lane: 3, col: 520 }, { type: 'save', fileName: 'a.lif' },
    { type: 'mark', lane: 1, col: 600 }, { type: 'status', lane: 2, code: 'FS' }]);
  assert.equal(s.status, 'review');
  s = apply(s, { type: 'revert' });
  assert.deepEqual(Object.fromEntries(Object.entries(s.marks).map(([k, m]) => [k, m.col])), { 1: 500, 2: 510, 3: 520 });
  assert.deepEqual(s.statuses, { 4: 'DNS' });
});

test('places: by column, ties share a place, any status excluded (DQ too)', () => {
  const s = run([
    ...toReview,
    { type: 'mark', lane: 1, col: 520 },
    { type: 'mark', lane: 2, col: 500 },
    { type: 'mark', lane: 3, col: 500 },
    { type: 'status', lane: 4, code: null },
    { type: 'mark', lane: 4, col: 510 },
    { type: 'status', lane: 4, code: 'DQ' },
  ]);
  assert.deepEqual(places(s), [
    { lane: 2, col: 500, place: 1 },
    { lane: 3, col: 500, place: 1 },
    { lane: 1, col: 520, place: 3 },
  ]);
  assert.deepEqual(places(s, (c) => (c - 400) / 10).map((p) => p.time), [10, 10, 12]);
});

test('reduce(log) equals step-by-step apply, state is plain JSON, input never mutated', () => {
  const log = [...toReview, { type: 'proposals', model: 'm', items: [{ lane: 1, col: 500, decision: 'auto' }] }, { type: 'mark', lane: 2, col: 510 }, { type: 'status', lane: 3, code: 'DNF' }, { type: 'save', fileName: 'x.lif' }];
  const a = reduce(log);
  const b = run(log); // run() deep-freezes each state before applying the next event
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
  assert.equal(a.seq, log.length);
});

test('lifInput feeds buildLif: places, DQ with time, statuses after finishers, start time of day', () => {
  const colTime = (c) => (c - 400) * 0.001 + 11; // 1 ms per column
  const s = run([
    ...toReview,
    { type: 'mark', lane: 1, col: 520 },
    { type: 'mark', lane: 2, col: 500 },
    { type: 'mark', lane: 3, col: 505 },
    { type: 'status', lane: 3, code: 'DQ' },
    { type: 'save', fileName: '003-1-02.lif' },
  ]);
  const { heat, results } = lifInput(s, colTime);
  const lines = buildLif(heat, results).split('\r\n');
  assert.equal(lines[0], '3,1,2,Women 100m,,,,,,,15:00:00.5000');
  assert.deepEqual(lines.slice(1, -1).map(parseFields).map((f) => [f[0], f[2], f[6], f[8]]), [
    ['1', '2', '11.100', '11.100'],
    ['2', '1', '11.120', '0.020'],
    ['DQ', '3', '11.105', ''],
    ['DNS', '4', '', ''],
  ]);
});
