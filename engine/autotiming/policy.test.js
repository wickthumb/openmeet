import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceClosePolicy } from './client.js';

const prediction = (lane, race_time_s) => ({ lane, column: lane, race_time_s,
  decision: 'auto', reason: 'detected', confidence: 0.99 });

test('close policy handles no finishes and one finish', () => {
  assert.deepEqual(enforceClosePolicy([]), []);
  const original = [prediction(1, 10)];
  const result = enforceClosePolicy(original);
  assert.deepEqual(result, original);
  assert.notEqual(result, original);
  assert.notEqual(result[0], original[0]);
});

test('close policy marks both members of an unsorted close pair without mutation', () => {
  const original = Object.freeze([Object.freeze(prediction(3, 11)),
    Object.freeze(prediction(2, 10.019)), Object.freeze(prediction(1, 10))]);
  const result = enforceClosePolicy(original);
  assert.deepEqual(result.map(p => p.lane), [3, 2, 1]);
  assert.deepEqual(result.map(p => p.decision), ['auto', 'review', 'review']);
  assert.deepEqual(result.slice(1).map(p => p.reason), ['close_finish', 'close_finish']);
  assert.equal(original[1].decision, 'auto');
  assert.equal(result[1].confidence, 0.99);
});

test('three chained finishers all require review even when endpoints are 0.03 s apart', () => {
  const result = enforceClosePolicy([prediction(3, 10.03), prediction(1, 10), prediction(2, 10.015)]);
  assert.ok(result.every(p => p.decision === 'review' && p.reason === 'close_finish'));
});

test('exactly 0.02 s is excluded despite floating-point subtraction', () => {
  for (const start of [0, 1, 10, 100]) {
    assert.ok(enforceClosePolicy([prediction(1, start), prediction(2, start + 0.02)])
      .every(p => p.decision === 'auto'));
  }
});

test('ties, negative pre-start times, custom thresholds and zero threshold', () => {
  assert.ok(enforceClosePolicy([prediction(1, -0.1), prediction(2, -0.1)])
    .every(p => p.reason === 'close_finish'));
  assert.ok(enforceClosePolicy([prediction(1, 10), prediction(2, 10.03)], 0.05)
    .every(p => p.decision === 'review'));
  assert.ok(enforceClosePolicy([prediction(1, 10), prediction(2, 10)], 0)
    .every(p => p.decision === 'auto'));
});

test('distant reviews keep their original reason', () => {
  const original = [{ ...prediction(1, 10), decision: 'review', reason: 'low_confidence' }, prediction(2, 11)];
  assert.deepEqual(enforceClosePolicy(original), original);
});

test('close policy rejects unusable times and thresholds', () => {
  for (const invalid of [NaN, Infinity, -0.01, '0.02']) {
    assert.throws(() => enforceClosePolicy([], invalid), TypeError);
  }
  for (const invalid of [null, [null], [prediction(1, NaN)], [prediction(1, '10')]]) {
    assert.throws(() => enforceClosePolicy(invalid), TypeError);
  }
});
