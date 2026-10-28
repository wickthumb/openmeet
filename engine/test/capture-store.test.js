import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCaptureStore } from '../capture/store.js';
import { validateMessage, columnBytes, chunkColumnTime } from '../capture/protocol.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'openmeet-cap-'));
const ROWS = 5;
const CH = 3;
const hello = { type: 'hello', model: 'test-cam', rows: ROWS, channels: CH, columnPeriod: 0.001 };

/** Deterministic pixel bytes for columns [from, from+count). */
function pixels(from, count) {
  const b = Buffer.alloc(count * ROWS * CH);
  for (let c = 0; c < count; c++) {
    for (let r = 0; r < ROWS; r++) {
      for (let k = 0; k < CH; k++) b[(c * ROWS + r) * CH + k] = ((from + c) * 7 + r * 3 + k) & 0xff;
    }
  }
  return b;
}
const chunk = (from, count, t0 = 1000) => ({
  type: 'columns', firstHwTime: t0 + from * 0.001, period: 0.001, count, data: pixels(from, count),
});

test('protocol: validateMessage accepts the four messages and rejects bad ones', () => {
  assert.equal(validateMessage(hello), hello);
  validateMessage({ type: 'start_pulse', hwTime: 1000 });
  validateMessage(chunk(0, 2), hello);
  validateMessage({ type: 'end' });
  assert.equal(columnBytes(hello), 15);
  assert.equal(chunkColumnTime(chunk(10, 4), 2), 1000 + 0.010 + 0.002);
  assert.throws(() => validateMessage({ type: 'nope' }), /unknown camera message type "nope"/);
  assert.throws(() => validateMessage({ ...hello, rows: 0 }), /rows/);
  assert.throws(() => validateMessage({ ...hello, channels: 5 }), /channels/);
  assert.throws(() => validateMessage({ type: 'start_pulse', hwTime: NaN }), /hwTime/);
  assert.throws(() => validateMessage({ ...chunk(0, 2), data: pixels(0, 1) }, hello), /expected count\*rows\*channels = 30/);
  assert.throws(() => validateMessage({ ...chunk(0, 2), data: [1, 2] }, hello), /Buffer or Uint8Array/);
  assert.throws(() => validateMessage(null), /must be an object/);
});

test('3 chunks, close, reopen: byte-identical columns and exact timestamps', () => {
  const dir = tmp();
  try {
    const s = openCaptureStore(dir, { syncIntervalMs: 0 });
    s.append(hello);
    s.append({ type: 'start_pulse', hwTime: 999.5 });
    assert.deepEqual(s.append(chunk(0, 64)), { from: 0, to: 64 });
    assert.deepEqual(s.append(chunk(64, 64)), { from: 64, to: 128 });
    assert.deepEqual(s.append(chunk(128, 10)), { from: 128, to: 138 });
    s.append({ type: 'end' });
    assert.equal(s.columnCount(), 138);
    s.close();
    s.close(); // idempotent

    assert.equal(statSync(join(dir, 'columns.bin')).size, 138 * 15);
    assert.equal(statSync(join(dir, 'times.f64')).size, 138 * 8);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.deepEqual({ model: meta.model, rows: meta.rows, channels: meta.channels }, { model: 'test-cam', rows: 5, channels: 3 });

    const r = openCaptureStore(dir);
    assert.equal(r.columnCount(), 138);
    assert.ok(r.readColumns(0, 138).equals(pixels(0, 138)));
    assert.ok(r.readColumns(60, 70).equals(pixels(60, 10)), 'range spanning a chunk boundary');
    assert.equal(r.readColumns(5, 5).length, 0);
    for (const col of [0, 63, 64, 130, 137]) {
      const expected = chunk(Math.floor(col / 64) * 64, 1).firstHwTime + (col % 64) * 0.001;
      assert.equal(r.timeOf(col), expected, `timeOf(${col})`);
      assert.equal(r.raceTimeOf(col), expected - 999.5);
    }
    assert.equal(r.timesOf(0, 3).length, 3);
    assert.equal(r.startHwTime(), 999.5);
    assert.deepEqual(r.events().map((e) => e.type), ['hello', 'start_pulse', 'end']);
    assert.deepEqual(r.events().map((e) => e.col), [0, 0, 138]);
    assert.deepEqual(r.recovery, { columnsBytesCut: 0, timesBytesCut: 0, eventsBytesCut: 0 });
    assert.throws(() => r.timeOf(138), RangeError);
    assert.throws(() => r.readColumns(0, 139), RangeError);
    assert.throws(() => r.readColumns(5, 4), RangeError);

    // Further appends after reopen; earlier bytes untouched.
    const before = readFileSync(join(dir, 'columns.bin'));
    r.append(hello);
    r.append(chunk(138, 3));
    assert.equal(r.columnCount(), 141);
    assert.ok(r.readColumns(0, 141).equals(pixels(0, 141)));
    r.close();
    const after = readFileSync(join(dir, 'columns.bin'));
    assert.ok(after.subarray(0, before.length).equals(before), 'existing bytes never rewritten');
    assert.throws(() => r.readColumns(0, 1), /closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crash recovery: torn trailing column, missing timestamp, torn event line', () => {
  const dir = tmp();
  try {
    const s = openCaptureStore(dir);
    s.append(hello);
    s.append({ type: 'start_pulse', hwTime: 1000 });
    s.append(chunk(0, 4));
    s.close();
    // Simulate a crash mid-chunk: one whole column + 7 bytes of the next reached
    // columns.bin, only 1 timestamp + 3 bytes reached times.f64, and the event
    // log has half a line.
    appendFileSync(join(dir, 'columns.bin'), pixels(4, 2).subarray(0, 15 + 7));
    appendFileSync(join(dir, 'times.f64'), Buffer.alloc(8 + 3));
    appendFileSync(join(dir, 'events.jsonl'), '{"type":"end","co');

    const r = openCaptureStore(dir, { now: () => 42 });
    assert.equal(r.columnCount(), 5, '4 + the one column that has both pixels and a timestamp');
    assert.deepEqual(r.recovery, { columnsBytesCut: 7, timesBytesCut: 3, eventsBytesCut: 17 });
    assert.ok(r.readColumns(0, 5).equals(pixels(0, 5)));
    assert.equal(statSync(join(dir, 'columns.bin')).size, 5 * 15);
    assert.equal(statSync(join(dir, 'times.f64')).size, 5 * 8);
    const last = r.events().at(-1);
    assert.deepEqual(last, { type: 'recovered', columnsBytesCut: 7, timesBytesCut: 3, eventsBytesCut: 17, col: 5, at: 42 });
    r.append(chunk(5, 2));
    r.close();

    const again = openCaptureStore(dir);
    assert.equal(again.columnCount(), 7);
    assert.ok(again.readColumns(5, 7).equals(pixels(5, 2)));
    assert.deepEqual(again.recovery, { columnsBytesCut: 0, timesBytesCut: 0, eventsBytesCut: 0 });
    again.close();

    // Pixels for a column whose timestamp never landed are cut.
    appendFileSync(join(dir, 'columns.bin'), pixels(7, 1));
    const third = openCaptureStore(dir);
    assert.equal(third.columnCount(), 7);
    assert.equal(third.recovery.columnsBytesCut, 15);
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readOnly: never truncates or writes', () => {
  const dir = tmp();
  try {
    const s = openCaptureStore(dir);
    s.append(hello);
    s.append(chunk(0, 3));
    s.close();
    appendFileSync(join(dir, 'columns.bin'), Buffer.alloc(4));
    const ro = openCaptureStore(dir, { readOnly: true });
    assert.equal(ro.columnCount(), 3);
    assert.equal(ro.recovery.columnsBytesCut, 4);
    assert.throws(() => ro.append(chunk(3, 1)), /read-only/);
    ro.close();
    assert.equal(statSync(join(dir, 'columns.bin')).size, 3 * 15 + 4, 'torn bytes left for the writer to handle');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ordering and geometry rules; clock glitches are logged, never dropped', () => {
  const dir = tmp();
  try {
    const s = openCaptureStore(dir);
    assert.throws(() => s.append(chunk(0, 1)), /columns before hello/);
    assert.throws(() => s.raceTimeOf(0), RangeError);
    s.append(hello);
    assert.throws(() => s.append({ ...hello, rows: 6 }), /does not match/);
    s.append(chunk(0, 2));
    assert.throws(() => s.raceTimeOf(0), /no start pulse/);
    s.append({ ...chunk(2, 2), firstHwTime: 999 }); // clock went backwards
    assert.equal(s.columnCount(), 4);
    assert.equal(s.timeOf(2), 999);
    const warn = s.events().find((e) => e.type === 'warning');
    assert.equal(warn.kind, 'non_monotonic_time');
    assert.equal(warn.col, 2);
    // A false start then the real start: race time uses the latest pulse.
    s.append({ type: 'start_pulse', hwTime: 990 });
    s.append({ type: 'start_pulse', hwTime: 995 });
    assert.equal(s.raceTimeOf(0), 1000 - 995);
    s.close();
    writeFileSync(join(dir, 'meta.json.tmp'), 'junk'); // leftover tmp from a crash is ignored
    const r = openCaptureStore(dir);
    assert.equal(r.startHwTime(), 995);
    r.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('column data without meta.json is refused', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'columns.bin'), Buffer.alloc(30));
    assert.throws(() => openCaptureStore(dir), /column data without meta\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGKILL mid-capture: every column the writer reported is readable after reopen', async () => {
  const dir = tmp();
  try {
    const storeUrl = new URL('../capture/store.js', import.meta.url).href;
    const code = `
      import { openCaptureStore } from ${JSON.stringify(storeUrl)};
      const ROWS = ${ROWS}, CH = ${CH};
      const s = openCaptureStore(${JSON.stringify(dir)}, { syncIntervalMs: 1e9 });
      s.append({ type: 'hello', model: 'kill-test', rows: ROWS, channels: CH, columnPeriod: 0.001 });
      s.append({ type: 'start_pulse', hwTime: 1000 });
      let col = 0;
      // Write until killed (capped so a missed kill cannot fill the disk).
      while (col < 300000) {
        const n = 1 + (col % 13);
        const b = Buffer.alloc(n * ROWS * CH);
        for (let c = 0; c < n; c++) for (let r = 0; r < ROWS; r++) for (let k = 0; k < CH; k++)
          b[(c * ROWS + r) * CH + k] = ((col + c) * 7 + r * 3 + k) & 0xff;
        s.append({ type: 'columns', firstHwTime: 1000 + col * 0.001, period: 0.001, count: n, data: b });
        col += n;
        process.stdout.write(col + '\\n'); // only after append() returned
      }
    `;
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'], env });
    let reported = 0;
    let pending = '';
    const exit = await new Promise((resolve, reject) => {
      child.stdout.on('data', (d) => {
        pending += d;
        const lines = pending.split('\n');
        pending = lines.pop() ?? ''; // keep a partial line for the next chunk
        for (const l of lines) reported = Math.max(reported, Number(l));
        if (reported > 5000 && !child.killed) child.kill('SIGKILL');
      });
      child.on('exit', (code, signal) => resolve({ code, signal }));
      child.on('error', reject);
    });
    assert.equal(exit.signal, 'SIGKILL', `writer exited ${JSON.stringify(exit)}`);
    assert.ok(reported > 5000);
    const r = openCaptureStore(dir);
    const n = r.columnCount();
    assert.ok(n >= reported, `recovered ${n} columns, writer reported ${reported}`);
    assert.ok(r.readColumns(0, n).equals(pixels(0, n)), 'all recovered columns byte-exact');
    assert.ok(Math.abs(r.raceTimeOf(n - 1) - (n - 1) * 0.001) < 1e-9);
    r.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
