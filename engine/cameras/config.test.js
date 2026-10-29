import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCameraConfig } from './config.js';

test('camera config persists defaults, independent revisions and assignments without changing history', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmeet-camera-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cameras = [{ id: 'primary', label: 'Camera A' }, { id: 'backup', label: 'Camera B' }], changes = [];
  const options = { sampleDir: path.join(root, 'sample'), cameras: () => cameras, onSetupChange: event => changes.push(event) };
  const store = createCameraConfig(options), meetDir = path.join(root, 'meet');
  const initial = store.get({ meetDir });
  assert.deepEqual(initial.locations, [{ id: 'home', name: 'Home finish' }]);
  assert.deepEqual(Object.keys(initial), ['version', 'locations', 'setups', 'history', 'heats']);
  assert.equal(initial.version, 1);
  assert.equal(initial.setups.primary.side, 'unspecified');
  assert.equal(initial.setups.primary.direction, 'normal');
  assert.equal(initial.history.length, 2);
  const away = store.saveLocation({ meetDir, name: 'Backstretch finish' }).locations[1];
  assert.equal(store.saveLocation({ meetDir, id: away.id, name: 'Away finish' }).locations[1].name, 'Away finish');
  const edited = store.saveSetup({ meetDir, cameraId: 'backup', label: 'Moved B', locationId: away.id, side: 'outside', direction: 'reverse' });
  const editedAgain = store.saveSetup({ meetDir, cameraId: 'backup', label: 'Moved B again', locationId: away.id, side: 'inside', direction: 'normal' });
  assert.deepEqual(editedAgain.history.slice(0, 2), initial.history);
  assert.deepEqual(editedAgain.history[2], edited.setups.backup);
  assert.equal(editedAgain.setups.backup.revision, 3);
  assert.ok(editedAgain.setups.backup.effectiveAt > edited.setups.backup.effectiveAt);
  assert.equal(editedAgain.setups.primary.revision, 1);
  assert.deepEqual(changes[0].previousSetup, initial.setups.backup);
  const assigned = store.assignHeat({ meetDir, heatKey: '5|1|1', locationId: away.id, timingCameraId: 'backup' });
  assert.deepEqual(assigned.heats['5|1|1'], { locationId: away.id, timingCameraId: 'backup' });
  assert.deepEqual(createCameraConfig(options).get({ meetDir }), assigned);
  const persisted = JSON.parse(fs.readFileSync(path.join(meetDir, 'openmeet/camera-setup.json'), 'utf8'));
  assert.deepEqual(persisted, assigned);
  assert.deepEqual(fs.readdirSync(path.dirname(store.fileFor(meetDir))), ['camera-setup.json']);
  assigned.history[0].label = 'Mutated response';
  assert.deepEqual(store.get({ meetDir }).history[0], initial.history[0]);
  assert.equal(store.get().setups.backup.revision, 1, 'sample config is scoped separately');
});

test('config rejects unknown finish/source, invalid edits and corrupt files without resetting saved data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openmeet-camera-validation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createCameraConfig({ sampleDir: root, cameras: () => [{ id: 'primary', label: 'A' }] });
  const before = store.get();
  const valid = { cameraId: 'primary', label: 'A', locationId: 'home', side: 'unspecified', direction: 'normal' };
  for (const patch of [{ cameraId: 'missing' }, { cameraId: '../escape' }, { side: 'up' }, { direction: 'left' }, { label: ' ' }, { locationId: 'missing' }]) {
    assert.throws(() => store.saveSetup({ ...valid, ...patch }));
  }
  store.saveLocation({ id: 'away', name: 'Away' });
  assert.throws(() => store.assignHeat({ heatKey: '5|1|1', locationId: 'away', timingCameraId: 'primary' }), /selected finish/);
  assert.throws(() => store.assignHeat({ heatKey: '5|1|1', locationId: 'home', timingCameraId: 'missing' }), /Unknown camera/);
  assert.throws(() => store.saveLocation({ id: '__proto__', name: 'bad' }), /Invalid/);
  assert.deepEqual(store.get().history, before.history);
  fs.writeFileSync(store.fileFor(), '{broken');
  assert.throws(() => store.get());
  assert.equal(fs.readFileSync(store.fileFor(), 'utf8'), '{broken');
});
