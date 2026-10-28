import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from './state.js';

test('state fills defaults and handles absent or malformed optional fields', () => {
  for (const input of [undefined, null, {}, 1, [], { meet: null, heat: [], clock: null, lanes: 'bad' }]) {
    const state = normalizeState(input);
    assert.deepEqual(state.meet, { name: '', logo: null });
    assert.deepEqual(state.clock, { running: false, startedAtMs: null, speed: 1, frozenS: 0 });
    assert.deepEqual(state.lanes, []);
    assert.deepEqual(state.results, []);
    assert.equal(state.heat.state, 'loaded');
    assert.ok(Number.isFinite(state.updatedAt));
  }
});

test('state validates values, preserves ties, sorts finishers and never mutates input', () => {
  const input = {
    meet: { name: 'Meet', logo: 'assets/logo.png' }, heat: { event: 12, state: 'review', round: -1 },
    clock: { running: true, startedAtMs: 1000, speed: 4 }, wind: -1.2,
    lanes: [
      { lane: 2, id: 20, first: 'Bo', place: 2, time: 12.1 },
      { lane: 1, place: 1, time: 11.3 },
      { lane: 3, place: 1, time: 11.3 },
      { lane: 4, status: 'dq', place: 3, time: 12.5 },
      { lane: 5, time: Infinity }, null,
    ],
  };
  const copy = structuredClone(input), state = normalizeState(input);
  assert.deepEqual(input, copy);
  assert.equal(state.heat.event, '12');
  assert.equal(state.heat.round, 1);
  assert.deepEqual(state.results.map(v => v.lane), [1, 3, 2]);
  assert.equal(state.lanes[0].id, '20');
  assert.equal(state.lanes[3].status, 'DQ');
  assert.equal(state.lanes[3].time, null);
  assert.equal(state.lanes[3].place, null);
  assert.equal(state.lanes[4].time, null);
  assert.equal(state.wind, -1.2);
  assert.equal(state.clock.speed, 4);
  state.results[0].first = 'Changed';
  assert.equal(state.lanes[1].first, '');
  for (const logo of ['/etc/passwd', '../logo.png', 'https://foo/x.png', 'assets/%2e%2e/x', 'assets/../x', 'a\\b']) {
    assert.equal(normalizeState({ meet: { logo } }).meet.logo, null);
  }
  assert.equal(normalizeState({ clock: { running: true } }).clock.running, false);
  assert.equal(normalizeState({ clock: { speed: -1 } }).clock.speed, 1);
  assert.deepEqual(normalizeState({ ...input, results: [] }).results, []);
  assert.equal(normalizeState({ ...input, results: [{ place: 1, time: 2 }] }).results[0].time, 2);
});
