import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openCaptureStore } from '../capture/store.js';
import { columnsOf } from '../sim/replay.js';
import { replayFixture } from '../cameras/testing/fixtures.js';

async function host(t, root) {
  const adapter = path.join(root, 'adapter.mjs');
  await writeFile(adapter, `process.parentPort = { on(event, cb) { if (event === 'message') process.on('message', data => cb({data})); }, postMessage(message) { process.send(message); } };\nawait import(${JSON.stringify(new URL('../../app/engine-host.mjs', import.meta.url).href)});`);
  const child = fork(adapter, [path.join(root, 'user-data')], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
  child.stdout.resume(); child.stderr.resume();
  const events = [], pending = new Map(); let id = 0;
  child.on('message', msg => {
    if (msg.event) events.push(msg);
    const request = pending.get(msg.id);
    if (request) { pending.delete(msg.id); clearTimeout(request.timer); msg.error ? request.reject(Error(msg.error)) : request.resolve(msg.result); }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`RPC timeout: ${method}`)); }, 5000);
    pending.set(requestId, { resolve, reject, timer }); child.send({ id: requestId, method, params });
  });
  assert.equal((await call('ping')).core, true);
  return { call, events };
}
async function eventually(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(20); }
  assert.fail('Condition did not become true');
}
async function fixtureHost(t, type) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openmeet-multicamera-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await replayFixture(root, type), engine = await host(t, root);
  const replay = await engine.call('assets.open', { dir: fixture.dir });
  return { ...fixture, engine, root, replay };
}
const json = async file => JSON.parse(await readFile(file, 'utf8'));

test('host records three native streams at independent rates/heights, all finishes, one trigger, and immutable setups', { timeout: 15000 }, async t => {
  const { engine, cameras, meetDir, replay, dir } = await fixtureHost(t);
  const config = await engine.call('camera.config.get', { meetDir });
  assert.deepEqual(config.locations, [{ id: 'home', name: 'Home finish' }]);
  assert.equal(Object.keys(config.setups).length, 3);
  await engine.call('camera.location.save', { meetDir, id: 'away', name: 'Unrelated finish' });
  await engine.call('camera.setup.save', { meetDir, cameraId: 'scan-far', label: 'Far camera', locationId: 'away', side: 'outside', direction: 'reverse' });
  await assert.rejects(engine.call('camera.heat.assign', { meetDir, heatKey: '5|1|1', locationId: 'home', timingCameraId: 'scan-far' }), /selected finish/);
  await engine.call('camera.heat.assign', { meetDir, heatKey: '5|1|1', locationId: 'home', timingCameraId: 'backup' });
  const primary = cameras[1], cap = await engine.call('capture.start', { key: '5|1|1', png: primary.png, meetDir,
    cameraId: primary.id, cameraSources: replay.heats[0].lineScans.map(({ id, png, label }) => ({ id, png, label })),
    front: { path: path.join(dir, 'heat-1/front.mp4'), meta: { fps: 30 } } });
  assert.equal(cap.cameras.length, 3);
  assert.deepEqual(cap.cameras.map(camera => camera.rows), [5, 8, 11]);
  assert.deepEqual(cap.cameraSetups.backup, config.setups.backup);
  assert.deepEqual(cap.heatAssignment, { locationId: 'home', timingCameraId: 'backup' });
  for (const camera of cameras) {
    assert.deepEqual(await readFile(path.join(cap.dir, 'views', camera.id + '.png')), await readFile(camera.png));
    assert.deepEqual(await readFile(path.join(cap.dir, 'views', camera.id + '.json')), await readFile(camera.sidecar));
  }
  assert.equal(await readFile(cap.front.path, 'utf8'), 'Generated front-video retention fixture');
  assert.equal((await json(path.join(cap.dir, 'front.json'))).fps, 30);
  const first = await eventually(async () => {
    const status = await engine.call('camera.recorders', { captureId: cap.id });
    return status.cameras.every(camera => camera.columns >= 128) && status;
  });
  assert.equal(first.primaryCameraId, 'backup');
  assert.equal(first.cameras.find(camera => camera.id === 'backup').dir, cap.dir);
  assert.equal(first.cameras.find(camera => camera.id === 'primary').dir, path.join(cap.dir, 'cameras/primary'));
  const originalSource = await readFile(path.join(cap.dir, 'cameras/scan-far/source.json'), 'utf8');
  const originalSetup = first.cameras.find(camera => camera.id === 'scan-far').setup;
  const edited = await engine.call('camera.setup.save', { meetDir, cameraId: 'scan-far', label: 'Moved camera', locationId: 'home', side: 'inside', direction: 'normal' });
  assert.equal(edited.setups['scan-far'].revision, originalSetup.revision + 1);
  await engine.call('camera.heat.assign', { meetDir, heatKey: '5|1|1', locationId: 'home', timingCameraId: 'scan-far' });
  const prepared = await engine.call('camera.recorders', { captureId: cap.id });
  assert.deepEqual(prepared.heatAssignment, cap.heatAssignment);
  assert.deepEqual(prepared.nextAssignment, { locationId: 'home', timingCameraId: 'scan-far' });
  assert.equal(prepared.primaryCameraId, 'backup');
  // Only generated fixtures are changed: recording and historical camera reads
  // must keep the evidence captured at start, even if source files are moved/replaced.
  await writeFile(cameras[2].png, await readFile(cameras[0].png));
  await writeFile(cameras[2].sidecar, JSON.stringify({ column_period_s: .25, first_column_race_time_s: 7 }));
  const grown = await eventually(async () => {
    const status = await engine.call('camera.recorders');
    return status.cameras.every((camera, i) => camera.columns > first.cameras[i].columns) && status;
  });
  assert.ok(grown.cameras.every(camera => camera.state === 'recording'));
  assert.deepEqual(grown.cameras.find(camera => camera.id === 'scan-far').setup, originalSetup);
  assert.equal(await readFile(path.join(cap.dir, 'cameras/scan-far/source.json'), 'utf8'), originalSource);
  const changes = (await readFile(path.join(cap.dir, 'review-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(changes.length, 1); assert.equal(changes[0].type, 'setup-change');
  assert.deepEqual(changes[0].captureSetup, originalSetup);
  for (const [method, params] of [['assets.open', { dir }], ['meet.open', { dir: meetDir }], ['demo.load', { id: 'builtin' }], ['settings.set', { patch: { meetDir } }]]) {
    await assert.rejects(engine.call(method, params), /Stop capture/);
  }
  assert.equal(engine.events.filter(event => event.event === 'capture.end').length, 0);
  await engine.call('capture.stop');
  const stopped = await engine.call('camera.recorders', { captureId: cap.id });
  assert.ok(stopped.cameras.every(camera => camera.state === 'stopped'));
  assert.deepEqual((await json(path.join(cap.dir, 'cameras.json'))).cameras, stopped.cameras);
  for (const source of cameras) {
    const status = stopped.cameras.find(camera => camera.id === source.id), store = openCaptureStore(status.dir, { readOnly: true });
    try {
      assert.equal(store.meta().rows, source.image.height);
      assert.equal(store.meta().columnPeriod, source.meta.column_period_s);
      assert.equal(status.columns, store.columnCount());
      const pre = Math.round(source.meta.first_column_race_time_s / source.meta.column_period_s);
      assert.deepEqual(store.readColumns(pre, pre + source.image.width), columnsOf(source.image, 0, source.image.width));
      for (const x of [0, 63, 95]) assert.ok(Math.abs(store.raceTimeOf(pre + x) - source.meta.first_column_race_time_s - x * source.meta.column_period_s) < 1e-9);
      assert.equal(store.events().filter(event => event.type === 'end').length, 1);
      assert.equal(store.events().filter(event => event.type === 'start_pulse').length, 1);
    } finally { store.close(); }
  }
  assert.deepEqual(engine.events.filter(event => event.event === 'capture.hello').map(event => event.data.rows), [8]);
  assert.equal(engine.events.filter(event => event.event === 'capture.pulse').length, 1);
  assert.equal(engine.events.filter(event => event.event === 'capture.end').length, 1);
  const starts = await engine.call('starts.list', { dir: meetDir });
  assert.equal(starts.triggers.length, 1); assert.equal(starts.history.length, 1);
  assert.equal(starts.triggers[0].captureId, cap.id);
  const historical = await engine.call('camera.image', { captureId: cap.id, png: cameras[2].png });
  assert.equal(historical.height, cameras[2].image.height);
  assert.deepEqual(Buffer.from(historical.data), cameras[2].image.data);
  assert.deepEqual((await json(path.join(cap.dir, 'views/scan-far.json'))), cameras[2].meta);
  await engine.call('camera.image', { captureId: cap.id, png: cameras[2].png, includePixels: false });
  assert.equal(await readFile(path.join(cap.dir, 'cameras/scan-far/source.json'), 'utf8'), originalSource);
  await assert.rejects(engine.call('capture.start', { key: '5|1|1', png: cameras[1].png, meetDir }), /heat timing camera assignment/);
  await delay(100);
  assert.deepEqual((await engine.call('camera.recorders')).cameras, stopped.cameras);
});

test('legacy callers infer all same-heat cameras; secondary failure leaves primary running and stop closes every store', { timeout: 15000 }, async t => {
  const { engine, cameras, meetDir } = await fixtureHost(t, 'ttp-simulator');
  await writeFile(cameras[2].png, 'generated broken PNG');
  const cap = await engine.call('capture.start', { key: 'legacy', png: cameras[0].png, meetDir });
  const status = await eventually(async () => {
    const value = await engine.call('camera.recorders');
    return value.cameras[2].state === 'error' && value.cameras[0].columns >= 128 && value;
  });
  assert.equal(status.cameras.length, 3);
  assert.equal(status.cameras[0].state, 'recording');
  assert.equal(status.cameras[1].state, 'recording');
  assert.equal(engine.events.filter(event => event.event === 'capture.end').length, 0);
  assert.equal(engine.events.filter(event => event.event === 'capture.error').length, 0);
  assert.ok(engine.events.some(event => event.event === 'camera.recorder.error'));
  await engine.call('capture.stop');
  const final = await engine.call('camera.recorders', { captureId: cap.id });
  assert.deepEqual(final.cameras.map(camera => camera.state), ['stopped', 'stopped', 'error']);
  const primary = openCaptureStore(cap.dir, { readOnly: true });
  try { assert.equal(primary.meta().model, 'sim-render'); } finally { primary.close(); }
  for (const camera of final.cameras) {
    const store = openCaptureStore(camera.dir, { readOnly: true });
    try { assert.equal(store.events().at(-1).type, 'end'); } finally { store.close(); }
  }
  assert.equal(engine.events.filter(event => event.event === 'capture.end').length, 1);
  const starting = engine.call('capture.start', { key: 'early-stop', png: cameras[0].png, meetDir });
  await engine.call('capture.stop');
  const early = await starting;
  await eventually(() => engine.events.some(event => event.event === 'capture.end' && event.data.id === early.id));
  assert.ok((await engine.call('camera.recorders', { captureId: early.id })).cameras.every(camera => camera.state !== 'recording'));
});

test('registered PNG validation, timeout finalization and bounded preview leave official records alone', { timeout: 15000 }, async t => {
  const { engine, cameras, meetDir, dir, replay, root } = await fixtureHost(t);
  assert.deepEqual(await engine.call('camera.recorders'), { captureId: null, cameras: [] });
  for (const patch of [
    { png: path.join(root, 'unregistered.png') },
    { cameraId: 'backup' },
    { cameraSources: [{ id: 'backup', png: cameras[0].png }] },
    { cameraSources: [{ id: 'primary', png: replay.heats[1].primary }] },
  ]) await assert.rejects(engine.call('capture.start', { png: cameras[0].png, meetDir, ...patch }), /registered|match/);
  assert.deepEqual(await engine.call('starts.list', { dir: meetDir }), { triggers: [], assignments: {}, history: [] });
  const before = await readdir(path.join(meetDir, 'openmeet'));
  const preview = await engine.call('preview.start', { png: cameras[0].png, meetDir });
  assert.equal(preview.dir, null);
  await eventually(() => engine.events.filter(event => event.event === 'preview.columns').length >= 3);
  assert.deepEqual(await engine.call('camera.recorders'), { captureId: null, cameras: [] });
  await assert.rejects(engine.call('assets.open', { dir }), /Stop capture or preview/);
  await engine.call('preview.stop');
  assert.deepEqual(await readdir(path.join(meetDir, 'openmeet')), before);
  assert.equal(engine.events.filter(event => event.event === 'preview.end').length, 1);
  assert.equal(engine.events.filter(event => event.event === 'capture.pulse').length, 0);
  const cap = await engine.call('capture.start', { png: cameras[0].png, meetDir, timeoutSeconds: .2 });
  await eventually(() => engine.events.some(event => event.event === 'capture.end' && event.data.id === cap.id));
  assert.ok((await engine.call('camera.recorders')).cameras.every(camera => camera.state === 'stopped'));
  assert.equal((await engine.call('starts.list', { dir: meetDir })).triggers.length, 1);
  await engine.call('assets.open', { dir });
});


test('next attempt uses saved heat assignment, validates finish, and old camera evidence survives registry replacement', { timeout: 15000 }, async t => {
  const { engine, cameras, meetDir, root } = await fixtureHost(t);
  await engine.call('camera.config.get', { meetDir });
  await engine.call('camera.heat.assign', { meetDir, heatKey: '5|1|1', locationId: 'home', timingCameraId: 'primary' });
  const first = await engine.call('capture.start', { key: '5-1-1', png: cameras[0].png, meetDir });
  await engine.call('camera.heat.assign', { meetDir, heatKey: '5|1|1', locationId: 'home', timingCameraId: 'backup' });
  await engine.call('capture.stop');
  const second = await engine.call('capture.start', { key: '5-1-1', png: cameras[1].png, meetDir });
  assert.equal(second.primaryCameraId, 'backup');
  assert.equal((await engine.call('camera.recorders', { captureId: first.id })).primaryCameraId, 'primary');
  await engine.call('capture.stop');
  await engine.call('camera.location.save', { meetDir, id: 'away', name: 'Away' });
  await engine.call('camera.setup.save', { meetDir, cameraId: 'backup', label: 'Moved B', locationId: 'away', side: 'outside', direction: 'normal' });
  await assert.rejects(engine.call('capture.start', { key: '5|1|1', png: cameras[1].png, meetDir }), /selected finish location/);
  const moved = await replayFixture(path.join(root, 'moved'));
  await writeFile(moved.cameras[0].png, await readFile(moved.cameras[2].png));
  await engine.call('assets.open', { dir: moved.dir });
  const original = await engine.call('camera.image', { captureId: first.id, png: moved.cameras[0].png });
  assert.equal(original.height, cameras[0].image.height);
  assert.deepEqual(Buffer.from(original.data), cameras[0].image.data);
  const byId = await engine.call('camera.image', { captureId: first.id, cameraId: 'backup' });
  assert.deepEqual(Buffer.from(byId.data), cameras[1].image.data);
  assert.equal((await engine.call('starts.list', { dir: meetDir })).triggers.length, 2);
});
