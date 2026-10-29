// End to end through the public API: meet folder -> heat -> sim camera ->
// capture store -> proposals -> marks/statuses -> LIF in the meet folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as engine from '../index.js';
import { encodePng, testImage } from '../sim/png-encode.js';

test('public API exports', () => {
  for (const name of ['parseEvt', 'parsePpl', 'parseSch', 'buildLif', 'writeLifAtomic', 'lifName', 'watchMeetFolder', 'diffHeat',
    'openCaptureStore', 'decodePng', 'simReplay', 'loadSimTruth', 'reduce', 'apply', 'places', 'encodeWindows1252']) {
    assert.equal(typeof engine[name], 'function', name);
  }
  assert.ok(engine.LIF_STATUS_CONVENTION);
});

test('meet folder to LIF, with a simulated camera and an evaluation harness using truth', async () => {
  const meet = mkdtempSync(join(tmpdir(), 'openmeet-e2e-'));
  try {
    writeFileSync(join(meet, 'lynx.evt'), Buffer.from(
      '18B,1,1,Girls 100m\r\n,201,1,Ren\xe9e,Ann,East\r\n,202,2,O\x92Neil,Bo,West\r\n,203,3,Cruz,Cy,North\r\n,204,4,Diaz,Di,South\r\n', 'latin1',
    ));
    writeFileSync(join(meet, 'lynx.sch'), '18B,1,1\r\n');

    // 1. Meet link.
    const snapshot = await new Promise((resolve) => {
      const close = engine.watchMeetFolder(meet, (s) => {
        if (s.events.length && s.schedule.length) {
          close();
          resolve(s);
        }
      }, { debounceMs: 20, settleMs: 30, pollMs: 30 });
    });
    const key = snapshot.schedule[0];
    const evtHeat = engine.findHeat(snapshot.events, key);
    assert.ok(evtHeat);

    // 2. Arm, then the camera streams into the store.
    let heat = engine.reduce([{ type: 'load', heat: evtHeat }, { type: 'arm' }]);
    const sidecar = {
      column_period_s: 0.001,
      first_column_race_time_s: 11.9,
      truth: [{ lane: 2, time_s: 11.9645 }, { lane: 1, time_s: 11.9713 }, { lane: 3, time_s: 12.0009 }],
    };
    const store = engine.openCaptureStore(join(meet, 'openmeet', '18B-1-01', 'capture'));
    for await (const msg of engine.simReplay({ png: encodePng(testImage(300, 16, 3)), sidecar })) {
      store.append(msg);
      if (msg.type === 'start_pulse') heat = engine.apply(heat, { type: 'start', hwTime: msg.hwTime, timeOfDay: 16 * 3600 });
      if (msg.type === 'end') heat = engine.apply(heat, { type: 'capture_close' });
    }
    assert.equal(heat.status, 'review');
    assert.equal(store.columnCount(), 300);

    // 3. The harness (not the console) knows truth; it fakes a model response.
    const truth = engine.loadSimTruth(sidecar);
    const colOf = (t) => Math.ceil((t - sidecar.first_column_race_time_s) / sidecar.column_period_s - 1e-9);
    heat = engine.apply(heat, {
      type: 'proposals', model: 'fake-v0',
      items: truth.map((t) => ({ lane: t.lane, col: colOf(t.time_s), decision: t.lane === 3 ? 'review' : 'auto', conf: 0.9 })),
    });
    assert.equal(heat.marks[2].src, 'auto');

    // 4. Operator: accept lane 3's review proposal, lane 4 did not start.
    heat = engine.apply(heat, { type: 'mark', lane: 3, col: heat.proposals[3].col, src: 'checked' });
    heat = engine.apply(heat, { type: 'status', lane: 4, code: 'DNS' });
    const fileName = engine.lifName(key.event, key.round, key.heat);
    heat = engine.apply(heat, { type: 'save', fileName });
    assert.equal(heat.status, 'saved');

    // 5. LIF out.
    const { heat: h, results } = engine.lifInput(heat, (c) => store.raceTimeOf(c));
    await engine.writeLifAtomic(meet, fileName, engine.buildLif(h, results));
    const lane3Time = store.raceTimeOf(heat.marks[3].col);
    store.close();
    const lif = readFileSync(join(meet, '18B-1-01.lif'));
    const lines = engine.decodeMeetText(lif).split('\r\n');
    assert.equal(lines[0], '18B,1,1,Girls 100m,,,,,,,16:00:00.0000');
    const rows = lines.slice(1, -1).map(engine.parseFields);
    assert.deepEqual(rows.map((r) => [r[0], r[1], r[2], r[3], r[6], r[8]]), [
      ['1', '202', '2', 'O’Neil', '11.965', '11.965'],
      ['2', '201', '1', 'Renée', '11.972', '0.007'],
      ['3', '203', '3', 'Cruz', '12.001', '0.029'],
      ['DNS', '204', '4', 'Diaz', '', ''],
    ]);
    // Delivered to the hundredth after RunMeet's round-up = official truth rounded up.
    for (const t of truth) {
      const row = rows.find((r) => r[2] === String(t.lane));
      assert.equal(Math.ceil(Number(row[6]) * 100 - 1e-9), Math.ceil(t.time_s * 100 - 1e-9), `lane ${t.lane}`);
    }
    assert.ok(lif.includes(Buffer.from([0x4f, 0x92, 0x4e])), 'windows-1252 on disk');

    // The capture survives a reopen, byte for byte.
    const again = engine.openCaptureStore(join(meet, 'openmeet', '18B-1-01', 'capture'));
    assert.equal(again.columnCount(), 300);
    assert.equal(again.raceTimeOf(heat.marks[3].col), lane3Time);
    assert.throws(() => store.timeOf(0), /closed/);
    again.close();
  } finally {
    rmSync(meet, { recursive: true, force: true });
  }
});
