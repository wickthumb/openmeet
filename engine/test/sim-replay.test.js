import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simReplay, loadSimTruth, columnsOf, SIM_START_HW_TIME } from '../sim/replay.js';
import { openCaptureStore } from '../capture/store.js';
import { validateMessage } from '../capture/protocol.js';
import { encodePng, testImage } from '../testing/png-encode.js';

const sidecar = {
  column_period_s: 0.001,
  first_column_race_time_s: 10.25,
  truth: [{ lane: 4, time_s: 10.3141 }, { lane: 2, time_s: 10.3377 }],
};

async function collect(gen) {
  const out = [];
  for await (const m of gen) out.push(m);
  return out;
}

test('stream: hello, start_pulse at 1000.0, 64-column chunks with hardware times, end', async () => {
  const img = testImage(150, 6, 3, 5);
  const msgs = await collect(simReplay({ png: encodePng(img), sidecar, realtime: false }));
  assert.deepEqual(msgs.map((m) => m.type), ['hello', 'start_pulse', 'columns', 'columns', 'columns', 'end']);
  assert.deepEqual(msgs[0], { type: 'hello', model: 'sim-replay', rows: 6, channels: 3, columnPeriod: 0.001 });
  assert.deepEqual(msgs[1], { type: 'start_pulse', hwTime: 1000.0 });
  const chunks = msgs.slice(2, 5);
  assert.deepEqual(chunks.map((c) => c.count), [64, 64, 22]);
  chunks.forEach((c, k) => {
    validateMessage(c, msgs[0]);
    assert.equal(c.period, 0.001);
    const i = k * 64;
    assert.ok(Math.abs(c.firstHwTime - (SIM_START_HW_TIME + 10.25 + i * 0.001)) < 1e-9, `chunk ${k} firstHwTime`);
  });
});

test('row-major image becomes column-major chunks', async () => {
  const img = testImage(70, 5, 4, 9);
  const msgs = await collect(simReplay({ png: encodePng(img), sidecar }));
  const cols = msgs.filter((m) => m.type === 'columns');
  const all = Buffer.concat(cols.map((c) => c.data));
  for (let x = 0; x < 70; x++) {
    for (let y = 0; y < 5; y++) {
      for (let k = 0; k < 4; k++) {
        assert.equal(all[(x * 5 + y) * 4 + k], img.data[(y * 70 + x) * 4 + k]);
      }
    }
  }
  assert.ok(columnsOf(img, 3, 2).equals(all.subarray(3 * 20, 5 * 20)));
});

test('ground truth never enters the stream; loadSimTruth hands it over separately', async () => {
  const img = testImage(10, 2, 1);
  const msgs = await collect(simReplay({ png: encodePng(img), sidecar }));
  const allowed = {
    hello: ['type', 'model', 'rows', 'channels', 'columnPeriod'],
    start_pulse: ['type', 'hwTime'],
    columns: ['type', 'firstHwTime', 'period', 'count', 'data'],
    end: ['type'],
  };
  for (const m of msgs) {
    assert.deepEqual(Object.keys(m).sort(), [...allowed[m.type]].sort());
    const text = JSON.stringify({ ...m, data: undefined });
    assert.ok(!text.includes('truth') && !text.includes('10.3141') && !text.includes('10.3377'), text);
  }
  assert.deepEqual(loadSimTruth(sidecar), [{ lane: 4, time_s: 10.3141 }, { lane: 2, time_s: 10.3377 }]);
  assert.deepEqual(loadSimTruth({ column_period_s: 1, first_column_race_time_s: 0 }), []);
  assert.throws(() => loadSimTruth({ ...sidecar, truth: [{ lane: 'x', time_s: 1 }] }), /truth\[0\]/);
});

test('png and sidecar from file paths; sidecar validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openmeet-sim-'));
  try {
    const img = testImage(5, 3, 1);
    writeFileSync(join(dir, 'race.png'), encodePng(img));
    writeFileSync(join(dir, 'race.json'), JSON.stringify(sidecar));
    const msgs = await collect(simReplay({ png: join(dir, 'race.png'), sidecar: join(dir, 'race.json') }));
    assert.equal(msgs[2].count, 5);
    assert.equal(loadSimTruth(join(dir, 'race.json')).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const png = encodePng(testImage(2, 2, 1));
  await assert.rejects(collect(simReplay({ png, sidecar: { first_column_race_time_s: 0 } })), /column_period_s/);
  await assert.rejects(collect(simReplay({ png, sidecar: { column_period_s: 0.001 } })), /first_column_race_time_s/);
});

test('realtime: chunks are paced to when their last column would exist', async () => {
  const img = testImage(100, 2, 1);
  const sc = { column_period_s: 0.002, first_column_race_time_s: 0.1 };
  const arrivals = [];
  let t0 = 0;
  for await (const m of simReplay({ png: encodePng(img), sidecar: sc, realtime: true, chunkColumns: 25 })) {
    if (m.type === 'start_pulse') t0 = performance.now();
    if (m.type === 'columns') arrivals.push(performance.now() - t0);
  }
  const due = [150, 200, 250, 300];
  assert.equal(arrivals.length, 4);
  arrivals.forEach((a, i) => assert.ok(a >= due[i] - 5 && a < due[i] + 120, `chunk ${i} at ${a.toFixed(1)} ms, due ${due[i]}`));

  // speed=4 runs four times faster.
  const fast = [];
  for await (const m of simReplay({ png: encodePng(img), sidecar: sc, realtime: true, chunkColumns: 50, speed: 4 })) {
    if (m.type === 'start_pulse') t0 = performance.now();
    if (m.type === 'columns') fast.push(performance.now() - t0);
  }
  [50, 75].forEach((d, i) => assert.ok(fast[i] >= d - 5 && fast[i] < d + 60, `speed 4 chunk ${i} at ${fast[i].toFixed(1)} ms, due ${d}`));
});

test('replay into the capture store: race time of column i = first_column_race_time_s + i * period', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'openmeet-sim-store-'));
  try {
    const img = testImage(200, 8, 3, 3);
    const store = openCaptureStore(dir);
    for await (const m of simReplay({ png: encodePng(img), sidecar })) store.append(m);
    assert.equal(store.columnCount(), 200);
    for (const i of [0, 63, 64, 199]) {
      assert.ok(Math.abs(store.raceTimeOf(i) - (10.25 + i * 0.001)) < 1e-9, `col ${i}`);
    }
    const col = store.readColumns(77, 78);
    for (let y = 0; y < 8; y++) for (let k = 0; k < 3; k++) assert.equal(col[y * 3 + k], img.data[(y * 200 + 77) * 3 + k]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
