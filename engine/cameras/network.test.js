import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createNetworkCameraService } from './network.js';
import { openStartJournal } from '../timing/starts.js';
import { networkFixture, cameraFrame, cameraReply } from './testing/network-fixture.js';
import { runCameraCli, cameraProfileTemplate } from './cli.js';

function setup(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmeet-network-'));
  const f = networkFixture();
  const service = createNetworkCameraService({ ...f.options, ...extra });
  t.after(async () => { await service.closeAll().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); });
  const config = { ...f.config, recordingDir: path.join(root, 'recording'), meetDir: root };
  return { root, f, service, config };
}
const operation = (service, id, name, params) => service.command({ id, operation: name, params });

test('construction and binding are inert; explicit prepare/start/stop/end retain raw evidence', async t => {
  const { f, service, config } = setup(t);
  assert.equal(f.transports.length, 0);
  const { id } = service.open(config);
  assert.equal(f.sent.length, 0); assert.equal(f.streams.length, 0);
  await operation(service, id, 'prepare'); await operation(service, id, 'start');
  const { frame, body } = cameraFrame();
  f.streams[0].onData(frame.subarray(0, 9)); f.streams[0].onData(frame.subarray(9));
  await operation(service, id, 'stop'); await operation(service, id, 'end');
  const result = await service.close({ id });
  assert.equal(result.recording.blocks, 1); assert.equal(result.session.captureComplete, false);
  assert.equal(result.recording.streamBytes, frame.length);
  assert.deepEqual(fs.readFileSync(path.join(config.recordingDir, 'stream.dat')), frame);
  const bytes = fs.readFileSync(path.join(config.recordingDir, 'blocks.dat'));
  assert.equal(bytes.readUInt32LE(), body.length); assert.deepEqual(bytes.subarray(4), body);
  const index = JSON.parse(fs.readFileSync(path.join(config.recordingDir, 'blocks.jsonl'), 'utf8'));
  assert.equal(index.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(index.actualIndex, 1); assert.ok(index.unknownRanges.length > 0);
  const events = fs.readFileSync(path.join(config.recordingDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.type === 'control-reply'));
  assert.equal(events.at(-1).captureComplete, false);
  assert.deepEqual(f.sent.map(p => p.readUInt16LE(8)), [14, 5, 6, 7, 8, 24]);
  assert.equal(f.jobs.size, 0); assert.ok(f.transports.every(t => t.closed));
});

test('duplicate local owners, invalid configuration and overwrite are refused before packets', async t => {
  const { f, service, config } = setup(t);
  assert.throws(() => service.open({ ...config, profile: { ...config.profile, marker: null } }), TypeError);
  assert.equal(f.sent.length, 0); assert.equal(fs.existsSync(config.recordingDir), false);
  const first = service.open(config);
  assert.throws(() => service.open({ ...config, recordingDir: config.recordingDir + '-other' }), { code: 'ERR_CAMERA_OWNED' });
  await assert.rejects(service.probe({ address: '127.0.0.1', marker: 1 }), { code: 'ERR_CAMERA_OWNED' });
  await service.close({ id: first.id });
  assert.throws(() => service.open(config), { code: 'EEXIST' });
  assert.equal(f.sent.length, 0);
});

test('probe sends only one clock read, validates correlation and closes its transport', async t => {
  const { f, service } = setup(t);
  const result = await service.probe({ address: '127.0.0.1', marker: 0x11223344, sequence: 19 });
  assert.equal(result.clock128k, '1280'); assert.equal(result.clockOrigin, 7);
  assert.equal(result.deviceValidated, false);
  assert.deepEqual(f.sent.map(p => p.readUInt16LE(8)), [14]);
  assert.ok(f.transports[0].closed);
  f.exchangeHook = packet => cameraReply(packet, [7, 0x1000000, 0]);
  await assert.rejects(service.probe({ address: '127.0.0.1', marker: 1 }), { code: 'ERR_CAMERA_PROBE_REPLY' });
  assert.ok(f.transports.at(-1).closed);
});

test('fresh starts persist into the existing meet journal with exact offset sign and isolated clocks', async t => {
  const { root, f, service, config } = setup(t);
  const { id, clockId } = service.open(config);
  await operation(service, id, 'prepare');
  await operation(service, id, 'armRace', { raceId: '5-1-1', sourceKey: 'wired' });
  f.current = 250; f.event = 225; f.descriptor = 1;
  const result = await operation(service, id, 'pollStatus');
  const triggers = openStartJournal(root).list().triggers;
  assert.equal(triggers.length, 1); assert.equal(triggers[0].timeS, 0.0195);
  assert.equal(triggers[0].clockId, clockId); assert.equal(triggers[0].captureId, id);
  assert.equal(result.session.journal.races[0].start.primary.ticks, '1800');
  assert.equal(f.published.filter(e => e.event === 'camera.network.start').length, 1);
  await operation(service, id, 'retryStatus');
  assert.equal(openStartJournal(root).list().triggers.length, 1);
  await service.close({ id });
  const next = service.open({ ...config, recordingDir: config.recordingDir + '-next' });
  assert.notEqual(next.clockId, clockId);
});

for (const reason of ['untrusted', 'ambiguous']) test(reason + ' start evidence cannot become a timed meet trigger', async t => {
  const { root, f, service, config } = setup(t);
  if (reason === 'untrusted') config.profile.queueEpochTrusted = false;
  const { id } = service.open(config); await operation(service, id, 'prepare');
  f.event = reason === 'ambiguous' ? 300 : 150; f.descriptor = 1;
  await operation(service, id, 'pollStatus');
  assert.equal(openStartJournal(root).list().triggers.length, 0);
  const log = fs.readFileSync(path.join(config.recordingDir, 'events.jsonl'), 'utf8');
  assert.match(log, /eventTimestampRaw/);
});

test('malformed TCP bytes survive validation failure and local cleanup', async t => {
  const { f, service, config } = setup(t);
  const { id } = service.open(config); await operation(service, id, 'prepare');
  const invalid = Buffer.from('0000000001020304', 'hex');
  f.streams[0].onData(invalid);
  assert.equal(service.snapshot({ id }).session.invalid, true);
  const closing = service.close({ id });
  assert.strictEqual(service.close({ id }), closing);
  await closing;
  assert.deepEqual(fs.readFileSync(path.join(config.recordingDir, 'stream.dat')), invalid);
  assert.equal(f.jobs.size, 0);
});

test('unknown mutation timeout sends once and leaves reviewable diagnostics', async t => {
  const { f, service, config } = setup(t);
  const { id } = service.open(config); await operation(service, id, 'prepare');
  f.exchangeHook = () => { throw Object.assign(Error('timeout'), { code: 'ERR_TRANSPORT_TIMEOUT' }); };
  await assert.rejects(operation(service, id, 'start'), { code: 'ERR_TRANSPORT_TIMEOUT' });
  assert.equal(service.snapshot({ id }).session.frozen, true);
  assert.equal(f.sent.filter(p => p.readUInt16LE(8) === 7).length, 1);
  await assert.rejects(operation(service, id, 'start'));
  assert.equal(f.sent.filter(p => p.readUInt16LE(8) === 7).length, 1);
  await service.close({ id });
  assert.match(fs.readFileSync(path.join(config.recordingDir, 'events.jsonl'), 'utf8'), /unknownAfterPossibleSend|command-error/);
});

test('terminal shutdown releases transports, timers and sessions and prevents rebind', async t => {
  const { f, service, config } = setup(t);
  const { id } = service.open(config); await operation(service, id, 'prepare');
  await service.closeAll(); await service.closeAll();
  assert.deepEqual(service.snapshot(), []); assert.equal(f.jobs.size, 0);
  assert.ok(f.transports.every(t => t.closed));
  assert.throws(() => service.open({ ...config, recordingDir: config.recordingDir + '-next' }), { code: 'ERR_CAMERA_SERVICE_CLOSED' });
});

test('raw write failure revokes the session, closes resources and is reported', async t => {
  const { f, service, config } = setup(t, { storeFactory() {
    return { append() {}, event() {}, stream() { throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); },
      snapshot: () => ({}), close() {} };
  } });
  const { id } = service.open(config); await operation(service, id, 'prepare');
  f.streams[0].onData(cameraFrame().frame);
  await assert.rejects(service.close({ id }), AggregateError);
  assert.equal(f.jobs.size, 0); assert.ok(f.transports.every(t => t.closed));
  assert.ok(f.published.some(e => e.event === 'camera.network.error' && e.data.code === 'ENOSPC'));
});

test('CLI template requires explicit device facts; probe reaches the backend API', async t => {
  const { root } = setup(t), outputs = [], calls = [];
  await runCameraCli(['template'], { output: v => outputs.push(v) });
  assert.equal(outputs[0].profile.marker, null); assert.equal(outputs[0].profile.parameters, null);
  const file = path.join(root, 'profile.json'); fs.writeFileSync(file, JSON.stringify(cameraProfileTemplate()));
  await runCameraCli(['probe', file], { output: v => outputs.push(v), serviceFactory: () => ({
    async probe(params) { calls.push(params); return { received: true }; }, async closeAll() { calls.push('closed'); },
  }) });
  assert.equal(calls[0].port, 41925); assert.equal(calls[1], 'closed');
  assert.equal(outputs.at(-1).received, true);
});

test('interrupting a CLI probe closes its pending transport immediately', async t => {
  const { root } = setup(t), controller = new AbortController();
  const file = path.join(root, 'profile.json'); fs.writeFileSync(file, JSON.stringify(cameraProfileTemplate()));
  let rejectProbe, begun;
  const started = new Promise(resolve => { begun = resolve; });
  let closes = 0;
  const pending = runCameraCli(['probe', file], { signal: controller.signal, serviceFactory: () => ({
    probe() { begun(); return new Promise((_resolve, reject) => { rejectProbe = reject; }); },
    async closeAll() { closes++; rejectProbe?.(Error('locally closed')); },
  }) });
  await started; controller.abort(); await pending;
  assert.ok(closes >= 1);
});
