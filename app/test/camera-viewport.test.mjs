import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchCameraViewport } from '../renderer/camera-viewport.mjs';

const a = { id: 'a', rows: 1000, top: 100, bottom: 950, lanes: [
  { lane: 1, top_row: 380, bottom_row: 420, standing_head_row_1p80m: 300 },
  { lane: 2, top_row: 580, bottom_row: 620, standing_head_row_1p80m: 470 },
] };
const b = { id: 'b', rows: 640, top: 0, bottom: 640, lanes: [
  { lane: 1, top_row: 430, bottom_row: 460, standing_head_row_1p80m: 320 },
  { lane: 2, top_row: 180, bottom_row: 210, standing_head_row_1p80m: 80 },
] };
test('repeated A/B swaps preserve the chosen crop across reversed perspective and unequal sensor heights', () => {
  let view = { r0: 310, zy: 2.5, focusLane: null }, state;
  for (let i = 0; i < 100; i++) {
    const next = switchCameraViewport(state, view, 600, i % 2 ? b : a, i % 2 ? a : b);
    view = { ...view, r0: next.r0, zy: next.zy }; state = next.state;
    const target = i % 2 ? a : b;
    assert.ok(view.r0 >= target.top); assert.ok(view.r0 + 600 / view.zy <= target.bottom + 1e-8);
    if (i % 2) { assert.equal(view.r0, 310); assert.equal(view.zy, 2.5); }
  }
});
test('horizontal zoom keeps each camera framing filled rather than applying body calibration to a full-height view', () => {
  const first = switchCameraViewport(null, { r0: a.top, zy: 600 / (a.bottom - a.top), focusLane: 2 }, 600, a, b);
  assert.equal(first.r0, b.top); assert.equal(600 / first.zy, b.bottom - b.top);
  const back = switchCameraViewport(first.state, { r0: first.r0, zy: first.zy, focusLane: 2 }, 600, b, a);
  assert.equal(back.r0, a.top); assert.equal(600 / back.zy, a.bottom - a.top);
});
test('a new operator pan establishes a fresh reference and survives later camera switches', () => {
  const first = switchCameraViewport(null, { r0: 310, zy: 2.5, focusLane: 1 }, 600, a, b);
  const panned = { r0: 200, zy: 5, focusLane: null };
  const back = switchCameraViewport(first.state, panned, 600, b, a);
  const again = switchCameraViewport(back.state, { r0: back.r0, zy: back.zy, focusLane: null }, 600, a, b);
  assert.equal(again.r0, panned.r0); assert.equal(again.zy, panned.zy);
});
