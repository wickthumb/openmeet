import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic, appendReviewEvent } from './files.js';

// One logical start, independent native capture stores. Only primary messages use
// the legacy capture events; a failed secondary never aborts another recorder.
export class ReplayRecorderGroup {
  constructor({ id, dir, sources, primaryId, core, speed, emit, trigger = null, heatKey, heatAssignment }) {
    Object.assign(this, { id, dir, primaryId, core, speed, emit, trigger, heatKey, heatAssignment });
    this.controller = new AbortController();
    this.setupChanges = [];
    this.cameras = sources.map(source => ({ ...source, setup: structuredClone(source.setup),
      dir: source.id === primaryId ? dir : path.join(dir, 'cameras', source.id),
      state: 'recording', store: null, error: null, facts: {} }));
    for (const camera of this.cameras) camera.ready = new Promise(resolve => { camera.markReady = resolve; });
    this.ready = Promise.all(this.cameras.map(camera => camera.ready));
  }

  snapshot() {
    return { captureId: this.id, dir: this.dir, primaryCameraId: this.primaryId, trigger: this.trigger,
      heatKey: this.heatKey, heatAssignment: structuredClone(this.heatAssignment),
      setupChanges: structuredClone(this.setupChanges),
      cameraSetups: Object.fromEntries(this.cameras.map(camera => [camera.id, structuredClone(camera.setup)])),
      cameras: this.cameras.map(camera => {
        const meta = camera.store?.meta() || camera.facts;
        return { id: camera.id, label: camera.setup.label, state: camera.state,
          columns: camera.store?.columnCount() ?? camera.facts.columns ?? 0, rows: meta?.rows ?? null,
          columnPeriod: meta?.columnPeriod ?? null, channels: meta?.channels ?? null,
          dir: camera.dir, setup: structuredClone(camera.setup), ...(camera.error ? { error: camera.error } : {}) };
      }) };
  }

  publish() {
    const snapshot = this.snapshot();
    // Status is replaceable; source.json and capture bytes are immutable/appended.
    try {
      writeJsonAtomic(path.join(this.dir, 'cameras.json'), { version: 1, ...snapshot });
      for (const camera of snapshot.cameras) writeJsonAtomic(path.join(camera.dir, 'status.json'), camera);
    } catch (err) {
      // A status write failure must not interrupt native capture appends.
      snapshot.statusError = err.message;
    }
    this.emit('camera.recorders', snapshot);
    return snapshot;
  }

  noteSetupChange({ cameraId, previousSetup, setup }) {
    const camera = this.cameras.find(item => item.id === cameraId);
    if (!camera) return;
    const event = { type: 'setup-change',
      captureId: this.id, cameraId, at: new Date().toISOString(), columns: camera.store?.columnCount() ?? camera.facts.columns ?? 0,
      captureSetup: camera.setup, previousSetup, setup };
    appendReviewEvent(path.join(this.dir, 'review-events.jsonl'), event);
    this.setupChanges.push(structuredClone(event));
    this.publish();
  }

  async run(camera) {
    let ended = false;
    try {
      fs.mkdirSync(camera.dir, { recursive: true });
      const views = path.join(this.dir, 'views');
      fs.mkdirSync(views, { recursive: true });
      const snapshotImage = path.join(views, `${camera.id}.png`), snapshotSidecar = path.join(views, `${camera.id}.json`);
      fs.copyFileSync(camera.png, snapshotImage, fs.constants.COPYFILE_EXCL);
      if (camera.sidecarFile) fs.copyFileSync(camera.sidecarFile, snapshotSidecar, fs.constants.COPYFILE_EXCL);
      else fs.writeFileSync(snapshotSidecar, JSON.stringify(camera.sidecar), { flag: 'wx' });
      fs.writeFileSync(path.join(camera.dir, 'source.json'), JSON.stringify({ cameraId: camera.id,
        label: camera.setup.label, source: camera.sourceType === 'real' ? 'real-recorded' : 'sim-replay',
        image: camera.png, snapshotImage, snapshotSidecar, setup: camera.setup }, null, 2) + '\n', { flag: 'wx' });
      camera.store = this.core.openCaptureStore(camera.dir);
      const gen = this.core.simReplay({ png: snapshotImage, sidecar: snapshotSidecar,
        realtime: true, speed: this.speed, model: camera.sourceType === 'real' ? 'real-recorded-replay' : 'sim-render',
        preRollFrom: 0, holdOpen: true, signal: this.controller.signal });
      for await (const msg of gen) {
        if (this.controller.signal.aborted) break;
        camera.store.append(msg);
        if (msg.type === 'hello') camera.markReady();
        if (msg.type === 'end') ended = true;
        if (camera.id !== this.primaryId) continue;
        if (msg.type === 'hello') this.emit('capture.hello', { id: this.id, rows: msg.rows, channels: msg.channels, columnPeriod: msg.columnPeriod, model: msg.model });
        else if (msg.type === 'start_pulse') this.emit('capture.pulse', { id: this.id, hwTime: msg.hwTime });
        else if (msg.type === 'columns') this.emit('capture.columns', { id: this.id,
          first: camera.store.columnCount() - msg.count, count: msg.count, period: msg.period, data: msg.data });
      }
    } catch (err) {
      if (err.name !== 'AbortError' || !this.controller.signal.aborted) this.fail(camera, err);
    } finally {
      if (camera.store) {
        try { if (!ended) camera.store.append({ type: 'end' }); }
        catch (err) { this.fail(camera, err); }
        camera.facts = { ...camera.store.meta(), columns: camera.store.columnCount() };
        try { await camera.store.close(); }
        catch (err) { this.fail(camera, err); }
        camera.store = null;
      }
      camera.markReady();
      if (camera.state !== 'error') camera.state = 'stopped';
      this.publish();
    }
  }

  fail(camera, err) {
    camera.state = 'error';
    camera.error = err.message || String(err);
    this.emit(camera.id === this.primaryId ? 'capture.error' : 'camera.recorder.error',
      { id: this.id, cameraId: camera.id, message: camera.error });
  }

  start() {
    this.done = Promise.all(this.cameras.map(camera => this.run(camera))).then(() => {
      clearInterval(this.timer);
      return this.publish();
    });
    this.timer = setInterval(() => this.publish(), 250);
    this.publish();
    return this.done;
  }
}
