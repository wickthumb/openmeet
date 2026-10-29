import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as core from '../index.js';
import { ReplayRecorderGroup } from './recorders.js';
import { replayFixture } from './testing/fixtures.js';

// Real PNG replay and native stores; inject only one append failure and delayed
// closure to exercise partial recording recovery and the group finalization fence.
test('a secondary append failure closes its store without ending peers; finalization waits for every close', { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openmeet-recorder-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = await replayFixture(root), dir = path.join(root, 'capture'), events = [], closes = [];
  const injectedCore = { ...core, openCaptureStore(storeDir) {
    const store = core.openCaptureStore(storeDir); let chunks = 0;
    return { ...store,
      append(msg) {
        if (storeDir.endsWith('backup') && msg.type === 'columns' && ++chunks === 2) throw Error('Generated recorder write failure');
        return store.append(msg);
      },
      async close() { await delay(storeDir.endsWith('scan-far') ? 100 : 0); store.close(); closes.push(storeDir); },
    };
  } };
  const group = new ReplayRecorderGroup({ id: 'fixture', dir, primaryId: 'primary', core: injectedCore, speed: 4,
    emit: (event, data) => events.push({ event, data }),
    sources: fixture.cameras.map(source => ({ ...source, sourceType: 'ttp', sidecarFile: source.sidecar,
      setup: { cameraId: source.id, label: source.id, revision: 1, locationId: 'home', side: 'unspecified', direction: 'normal', effectiveAt: new Date().toISOString() } })),
  });
  t.after(async () => { group.controller.abort(); await group.done; });
  const done = group.start(); await group.ready;
  for (let i = 0; i < 100 && group.snapshot().cameras[1].state !== 'error'; i++) await delay(10);
  const partial = group.snapshot();
  assert.equal(partial.cameras[1].state, 'error');
  assert.equal(partial.cameras[1].columns, 64);
  assert.ok(partial.cameras[1].error.includes('Generated recorder write failure'));
  assert.equal(partial.cameras[0].state, 'recording');
  assert.equal(partial.cameras[2].state, 'recording');
  const before = partial.cameras[0].columns;
  await delay(100);
  assert.ok(group.snapshot().cameras[0].columns > before);
  let finalized = false; done.then(() => { finalized = true; });
  group.controller.abort();
  await delay(10);
  assert.equal(finalized, false);
  const final = await done;
  assert.equal(closes.length, 3);
  assert.deepEqual(final.cameras.map(camera => camera.state), ['stopped', 'error', 'stopped']);
  assert.ok(group.cameras.every(camera => camera.store === null), 'finalized groups release native store buffers');
  assert.equal(events.filter(event => event.event === 'capture.error').length, 0);
  assert.equal(events.filter(event => event.event === 'camera.recorder.error').length, 1);
  for (const camera of final.cameras) {
    const store = core.openCaptureStore(camera.dir, { readOnly: true });
    try { assert.equal(store.events().at(-1).type, 'end'); assert.equal(store.columnCount(), camera.columns); }
    finally { store.close(); }
    await fs.rename(path.join(camera.dir, 'columns.bin'), path.join(camera.dir, 'closed-columns.bin'));
  }
});
