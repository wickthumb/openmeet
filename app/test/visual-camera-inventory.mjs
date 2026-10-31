// Generated, local-only Electron/CDP regression. No demo data or model services.
// Usage: node app/test/visual-camera-inventory.mjs [absolute-app-dir] [output-parent]
// Each run retains its fixture, screenshots, test.log, electron.log and summary.json.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { encodePng } from '../../engine/sim/png-encode.js';
import { columnsOf } from '../../engine/sim/replay.js';
import { openCaptureStore } from '../../engine/capture/store.js';
import { sourceId } from '../simulation-sources.mjs';

const appDir = path.resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
const outputParent = path.resolve(process.argv[3] || os.tmpdir());
await mkdir(outputParent, { recursive: true });
const root = await mkdtemp(path.join(outputParent, 'openmeet-camera-inventory-'));
const logFile = path.join(root, 'test.log'), electronLog = path.join(root, 'electron.log');
const log = (...args) => {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  appendFileSync(logFile, line + '\n'); console.log(line);
};
log('ARTIFACTS', root);
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async file => hash(await readFile(file));
const replayDir = path.join(root, 'generated-replay'), meetDir = path.join(replayDir, 'meet');
const heatDir = path.join(replayDir, 'heat-1'), profile = path.join(root, 'profile');
await mkdir(meetDir, { recursive: true }); await mkdir(heatDir); await mkdir(profile);
await writeFile(path.join(meetDir, 'lynx.evt'), '5,1,1,Generated camera inventory 100m\n,101,2,Example,Ada,Generated Club\n,102,3,Sample,Sam,Generated Club\n');
await writeFile(path.join(replayDir, 'openmeet-replay.json'), JSON.stringify({ version: 1,
  type: 'real-replay', name: 'Generated camera inventory', heats: [{ folder: 'heat-1', event: '5', round: 1, heat: 1 }] }));
const cameras = [];
for (const [i, id] of ['primary', 'backup', 'scan-far'].entries()) {
  const width = 320, height = [96, 144, 216][i], period = [.00125, .0025, .005][i];
  const color = [[210, 35, 55], [25, 200, 65], [35, 65, 220]][i];
  const image = { width, height, channels: 3, data: Buffer.alloc(width * height * 3) };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const n = (y * width + x) * 3;
    // Broad solid stripes allow an exact on-screen RGB check after scaling.
    for (let c = 0; c < 3; c++) image.data[n + c] = color[c] + (Math.floor(x / 40) % 2 ? 8 : 0);
  }
  const meta = { rows: height, columns: width, column_period_s: period,
    first_column_race_time_s: 16 * period, camera_name: `Generated camera ${i + 1}`, truth: [],
    lane_rows: [{ lane: 2, top_row: 0, bottom_row: height / 2 }, { lane: 3, top_row: height / 2, bottom_row: height }] };
  const png = path.join(heatDir, id + '.png'), sidecar = path.join(heatDir, id + '.json');
  const pngBytes = encodePng(image), sidecarBytes = Buffer.from(JSON.stringify(meta));
  await writeFile(png, pngBytes); await writeFile(sidecar, sidecarBytes);
  cameras.push({ id, image, meta, png, sidecar, pngBytes, sidecarBytes, color });
}
await writeFile(path.join(profile, 'openmeet-settings.json'), JSON.stringify({
  simulationSources: [{ id: sourceId(replayDir), type: 'real', name: 'Generated camera inventory', path: replayDir }],
  simulationSourceId: sourceId(replayDir),
}));

// Never inherit a private service/worker configuration. This fresh profile has none.
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('OPENMEET_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
const child = spawn(path.join(appDir, 'node_modules/electron/dist/electron'), [appDir,
  '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
  '--ozone-platform=headless', '--user-data-dir=' + profile],
{ env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let processLog = '', spawnError, ws, serial = 0, phase = 'launch', port;
const pending = new Map(), runtimeErrors = [], failures = [], passed = [];
const saveProcessLog = data => { processLog = (processLog + data).slice(-12000); appendFileSync(electronLog, data); };
child.stdout.on('data', saveProcessLog); child.stderr.on('data', saveProcessLog);
child.on('error', error => { spawnError = error; });
const stopProcess = signal => { if (child.pid) try { process.kill(-child.pid, signal); } catch {} };
const watchdog = setTimeout(() => stopProcess('SIGTERM'), 120000);
async function poll(fn, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`Electron exited (${child.exitCode ?? child.signalCode}): ${processLog.slice(-2500)}`);
    const result = await fn(); if (result) return result;
    await delay(75);
  }
  throw Error('Timed out: ' + label);
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 10000);
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
});
async function ev(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const rpc = (method, params = {}) => ev(`window.openmeet.call(${JSON.stringify(method)},${JSON.stringify(params)})`);
const waitUI = (expression, label) => poll(() => ev(expression), label);
async function click(selector) {
  await waitUI(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&e.getClientRects().length>0;})()`, 'enabled ' + selector);
  await ev(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',inline:'nearest'})`);
  await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const point = await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function button(text, scope = 'document') {
  await poll(()=>ev(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.getClientRects().length);if(!b)return false;b.click();return true;})()`),'button '+text);
}
const tab = name => button(name, `document.querySelector('#tabs')`);
async function set(selector, value) {
  await waitUI(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled;})()`, 'editable ' + selector);
  const tag = await ev(`document.querySelector(${JSON.stringify(selector)}).tagName`);
  if (tag === 'SELECT') {
    await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(![...e.options].some(o=>o.value===${JSON.stringify(value)}))throw Error('Missing option: '+${JSON.stringify(value)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  } else {
    await click(selector);
    await ev(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await send('Input.insertText', { text: value });
  }
  assert.equal(await ev(`document.querySelector(${JSON.stringify(selector)}).value`), value, selector + ' value');
}
const shot = async name => {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(root, name + '.png'), Buffer.from(result.data, 'base64'));
};
const config = () => rpc('camera.config.get', { meetDir });
const recorders = captureId => rpc('camera.recorders', captureId ? { captureId } : {});
const starts = () => rpc('starts.list', { dir: meetDir });
const captureDirs = async () => {
  try { return (await readdir(path.join(meetDir, 'openmeet/captures'))).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const journalBytes = async () => {
  try { return await readFile(path.join(meetDir, 'openmeet/starts.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
async function check(label, fn) {
  try { await fn(); passed.push(label); log('PASS', label); }
  catch (error) { failures.push({ phase, label, error: error.stack }); log('FAIL', label, error.message); }
}
async function openInventory() {
  await tab('Camera setup');
  await waitUI(`document.querySelector('#setupDialog')?.open&&document.querySelectorAll('#cameraInventory [data-camera-id]').length===3&&!document.querySelector('#cameraName').disabled`, 'three-camera inventory');
}
const closeDialog = async () => { await click('#drawerClose'); await waitUI(`!document.querySelector('#setupDialog').open`, 'dialog closed'); };
async function selectCamera(id) {
  await click(`#cameraInventory [data-camera-id="${id}"]`);
  await waitUI(`document.querySelector('#cameraInventory [data-camera-id="${id}"]').getAttribute('aria-pressed')==='true'`, 'selected ' + id);
}
async function saveSetup(id, values) {
  await selectCamera(id);
  for (const [field, value] of Object.entries(values)) await set('#' + field, value);
  const before = (await config()).setups[id].revision;
  await click('#cameraSave');
  await poll(async () => { const c = await config(); return c.setups[id].revision > before && c; }, 'saved setup ' + id);
  await waitUI(`document.querySelector('#cameraSave').disabled&&document.querySelector('.camera-revision').textContent.includes('Revision ${before + 1}')`, 'saved revision in UI');
}
async function assign(locationId, timingCameraId) {
  await set('#heatFinishLocation', locationId); await set('#heatTimingCamera', timingCameraId);
  await click('#heatCameraAssign');
  await poll(async () => { const c = await config(); return c.heats['5-1-1']?.timingCameraId === timingCameraId && c; }, 'saved heat assignment');
  await waitUI(`document.querySelector('#heatCameraAssign').disabled`, 'assignment saved in UI');
}
async function evidenceHashes(status) {
  const files = status.cameras.flatMap(camera => ['source.json', 'columns.bin', 'times.f64', 'events.jsonl', 'meta.json'].map(name => path.join(camera.dir, name)));
  for (const camera of cameras) for (const ext of ['png', 'json']) files.push(path.join(status.dir, 'views', camera.id + '.' + ext));
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await fileHash(file)])));
}
async function verifySnapshots(status) {
  for (const camera of cameras) {
    assert.deepEqual(await readFile(path.join(status.dir, 'views', camera.id + '.png')), camera.pngBytes, camera.id + ' PNG snapshot');
    assert.deepEqual(await readFile(path.join(status.dir, 'views', camera.id + '.json')), camera.sidecarBytes, camera.id + ' sidecar snapshot');
    const image = await ev(`window.openmeet.call('camera.image',${JSON.stringify({captureId:status.captureId,cameraId:camera.id})}).then(image=>({...image,data:Array.from(image.data)}))`);
    assert.equal(image.width, camera.image.width); assert.equal(image.height, camera.image.height);
    assert.deepEqual(Buffer.from(image.data), camera.image.data, camera.id + ' historical pixels');
  }
}

try {
  port = Number(await poll(async () => {
    try { return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, 'disposable DevTools port', 30000));
  assert.ok(port > 0 && port !== 9506, 'Never connect to the user app on CDP 9506');
  log('CDP', { port, profile });
  const page = await poll(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(p => p.type === 'page' && p.url.endsWith('/renderer/index.html')); }
    catch { return null; }
  }, 'disposable renderer');
  assert.equal(new URL(page.url).href, new URL('renderer/index.html', 'file://' + appDir + '/').href);
  assert.equal(Number(new URL(page.webSocketDebuggerUrl).port), port);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id);
    if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || JSON.stringify(message.params));
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') runtimeErrors.push(message.params.args.map(a => a.value || a.description).join(' '));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('openmeet.autoMark','false');localStorage.setItem('openmeet.autoStop','"manual"');` });
  await send('Page.reload');
  await poll(async () => {
    if (runtimeErrors.length) throw Error('Renderer startup failed: ' + runtimeErrors[0]);
    return ev(`!!window.openmeet&&document.querySelector('#ctl .go')?.textContent.includes('Start')&&document.querySelector('#list').textContent.includes('Ada')`);
  }, 'generated replay ready');
  await ev(`(()=>{window.__cameraEvents=[];for(const name of ['capture.hello','capture.pulse','capture.end','capture.error','preview.hello','preview.columns','preview.end','preview.error','camera.setup.changed','camera.recorder.error'])window.openmeet.on(name,d=>window.__cameraEvents.push({name,id:d.id||d.captureId,rows:d.rows,count:d.count,message:d.message}));})()`);

  phase = 'inventory and finish setup';
  await openInventory();
  await check('inventory lists three registered cameras with independent native geometry/rate', async () => {
    assert.deepEqual(await ev(`[...document.querySelectorAll('#cameraInventory [data-camera-id]')].map(e=>e.dataset.cameraId)`), cameras.map(c => c.id));
    assert.deepEqual(await recorders(), { captureId: null, cameras: [] });
    for (const camera of cameras) {
      await selectCamera(camera.id);
      const details = await ev(`Object.fromEntries([...document.querySelectorAll('.camera-details dt')].map(e=>[e.textContent,e.nextElementSibling.textContent]))`);
      assert.equal(details['Camera ID'], camera.id);
      assert.equal(details['Native resolution'], `${camera.image.width} × ${camera.image.height}`);
      assert.equal(details['Scan rate'], `${1 / camera.meta.column_period_s} columns/s`);
    }
  });
  await set('#finishLocationName', 'Far finish'); await click('#finishLocationAdd');
  const farLocation = await poll(async () => (await config()).locations.find(l => l.name === 'Far finish'), 'UI-created finish location');
  await saveSetup('scan-far', { cameraName: 'Far camera at start', cameraLocation: farLocation.id, cameraSide: 'outside', cameraDirection: 'reverse' });
  const startConfig = await config(), frozenFar = startConfig.setups['scan-far'];
  await check('setup save retains location/side/direction/revision and excludes other finishes from timing choices', async () => {
    assert.equal(frozenFar.locationId, farLocation.id); assert.equal(frozenFar.side, 'outside'); assert.equal(frozenFar.direction, 'reverse');
    assert.equal(frozenFar.revision, 2);
    assert.deepEqual(startConfig.history.filter(s => s.cameraId === 'scan-far').map(s => s.revision), [1, 2]);
    assert.deepEqual(await ev(`[...document.querySelector('#heatTimingCamera').options].map(o=>o.value).filter(Boolean)`), ['primary', 'backup']);
    await set('#heatFinishLocation', farLocation.id);
    assert.deepEqual(await ev(`[...document.querySelector('#heatTimingCamera').options].map(o=>o.value).filter(Boolean)`), ['scan-far']);
    assert.equal(await ev(`document.querySelector('#heatCameraAssign').disabled`), true, 'location change requires an explicit eligible camera');
  });
  await assign('home', 'backup'); await closeDialog();

  phase = 'view selection and alignment';
  const heatAssignments = (await config()).heats;
  await tab('Network'); await set('select[aria-label="Main view"]', 'scan-far'); await closeDialog();
  await waitUI(`document.querySelector('#scanCameraLabel').textContent.includes('Far camera at start')`, 'far main view');
  await check('Main view selection leaves the official timing assignment unchanged', async () => {
    assert.deepEqual((await config()).heats, heatAssignments);
    assert.equal(heatAssignments['5-1-1'].timingCameraId, 'backup');
    assert.equal(await ev(`JSON.parse(localStorage.getItem(${JSON.stringify('openmeet.camera-roles:' + meetDir)})).main`), 'scan-far');
  });
  const beforePreview = { starts: await starts(), dirs: await captureDirs(), journal: await journalBytes() };
  await openInventory(); await selectCamera('scan-far'); await click('#cameraAlign');
  await waitUI(`!document.querySelector('#setupDialog').open&&document.querySelector('#race').textContent.includes('Preview streaming')`, 'camera alignment streaming');
  await waitUI(`window.__cameraEvents.filter(e=>e.name==='preview.columns').length>=3`, 'alignment receives actual columns');
  await check('SIM alignment uses a two-column slit with every sensor row, shared zoom controls and no invented area view',async()=>{
    await waitUI(`document.querySelector('#sim-camera-alignment').dataset.nativeHeight==='216'`, 'full-height slit');
    assert.equal(await ev(`document.querySelector('#sim-camera-alignment').dataset.nativeWidth`),'2');
    assert.equal(await ev(`document.querySelector('#sim-camera-alignment [data-alignment-action="area"]').disabled`),true);
    await click('#sim-camera-alignment [data-alignment-action="in"]');assert.match(await ev(`document.querySelector('#sim-camera-alignment .alignment-caption').textContent`),/200%/);
    await click('#sim-camera-alignment [data-alignment-action="width"]');assert.match(await ev(`document.querySelector('#sim-camera-alignment .alignment-caption').textContent`),/2× width/);await click('#sim-camera-alignment [data-alignment-action="narrow"]');assert.equal(await ev(`document.querySelector('#sim-camera-alignment [data-alignment-action="narrow"]').disabled`),true);await click('#sim-camera-alignment [data-alignment-action="fit"]');assert.match(await ev(`document.querySelector('#sim-camera-alignment .alignment-caption').textContent`),/100%/);
    assert.equal(await ev(`getComputedStyle(document.querySelector('#tools')).display`),'none');
  });
  await shot('01-alignment'); await button('Stop preview');
  await waitUI(`document.querySelector('#race').textContent.includes('Preview paused')`, 'alignment paused');
  await button('Return to race'); await waitUI(`!!document.querySelector('#ctl .go')`, 'race restored');
  await check('alignment preview writes no capture, official pulse or start journal', async () => {
    assert.deepEqual(await starts(), beforePreview.starts); assert.deepEqual(await captureDirs(), beforePreview.dirs);
    assert.equal(await journalBytes(), beforePreview.journal); assert.deepEqual(await recorders(), { captureId: null, cameras: [] });
    const events = await ev('window.__cameraEvents');
    assert.equal(events.filter(e => e.name === 'preview.hello').length, 1);
    assert.equal(events.filter(e => e.name === 'preview.hello')[0].rows, 216);
    assert.equal(events.filter(e => e.name === 'preview.end').length, 1);
    assert.equal(events.filter(e => e.name.startsWith('capture.')).length, 0);
  });

  phase = 'official capture';
  await click('#ctl .go');
  const recording = await poll(async () => {
    const status = await recorders();
    return status.cameras.length === 3 && status.cameras.every(c => c.state === 'recording' && c.columns >= 64) && status;
  }, 'three live native recorders');
  await check('start records all three cameras, including another finish, using the assigned timing camera', async () => {
    assert.equal(recording.primaryCameraId, 'backup');
    assert.deepEqual(recording.heatAssignment, { locationId: 'home', timingCameraId: 'backup' });
    assert.deepEqual(recording.cameraSetups, startConfig.setups);
    assert.deepEqual(recording.cameras.map(c => c.rows), [96, 144, 216]);
    assert.deepEqual(recording.cameras.map(c => c.columnPeriod), [.00125, .0025, .005]);
    assert.equal(recording.cameras.find(c => c.id === 'backup').dir, recording.dir);
    assert.equal(recording.cameras.find(c => c.id === 'scan-far').setup.locationId, farLocation.id);
    assert.equal((await starts()).triggers.length, 1);
  });
  const farRecorder = recording.cameras.find(c => c.id === 'scan-far');
  const sourceBefore = await readFile(path.join(farRecorder.dir, 'source.json'), 'utf8');
  await openInventory();
  await waitUI(`document.querySelectorAll('#cameraInventory .camera-item-status[data-state="recording"]').length===3`, 'three recording UI statuses');
  await check('live inventory disables alignment and labels assignment changes for the next capture', async () => {
    assert.equal(await ev(`document.querySelector('#cameraAlign').disabled`), true);
    assert.equal(await ev(`document.querySelector('#heatCameraAssign').textContent`), 'Use for next capture');
    assert.match(await ev(`document.querySelector('.camera-current-assignment').textContent`), /Generated camera 2/);
  });
  await shot('02-all-cameras-recording');
  await saveSetup('scan-far', { cameraName: 'Moved far camera', cameraLocation: 'home', cameraSide: 'inside', cameraDirection: 'normal' });
  await assign('home', 'scan-far');
  const movedConfig = await config();
  await check('mid-race save changes next assignment but freezes every recorder setup', async () => {
    const status = await recorders(recording.captureId);
    assert.equal(status.primaryCameraId, 'backup'); assert.deepEqual(status.heatAssignment, recording.heatAssignment);
    assert.deepEqual(status.nextAssignment, { locationId: 'home', timingCameraId: 'scan-far' });
    assert.deepEqual(status.cameraSetups, recording.cameraSetups);
    assert.deepEqual(status.cameras.find(c => c.id === 'scan-far').setup, frozenFar);
    assert.equal(movedConfig.setups['scan-far'].revision, frozenFar.revision + 1);
    assert.ok(status.cameras.every(c => c.state === 'recording'));
    assert.equal(await readFile(path.join(farRecorder.dir, 'source.json'), 'utf8'), sourceBefore);
    const changes = (await readFile(path.join(recording.dir, 'review-events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(changes.length, 1); assert.equal(changes[0].type, 'setup-change');
    assert.deepEqual(changes[0].captureSetup, frozenFar); assert.deepEqual(changes[0].setup, movedConfig.setups['scan-far']);
    assert.match(await ev(`document.querySelector('.camera-current-assignment').textContent`), /Generated camera 2/);
    assert.match(await ev(`document.querySelector('.camera-heat').textContent`), /Next capture: Home finish · Moved far camera/);
  });
  // Replace only this run's generated input. History must use the snapshots.
  await writeFile(cameras[2].png, cameras[0].pngBytes);
  await writeFile(cameras[2].sidecar, JSON.stringify({ ...cameras[0].meta, column_period_s: .25, camera_name: 'Replacement source' }));
  await poll(async () => {
    const status = await recorders(recording.captureId);
    return status.cameras.every((c, i) => c.columns > recording.cameras[i].columns && c.columns >= 16 + cameras[i].image.width);
  }, 'all streams grow past their complete image after the move');
  await check('live historical snapshots keep original pixels after source replacement', () => verifySnapshots(recording));
  await closeDialog(); await click('#ctl .go');
  await waitUI(`document.querySelector('#ev .state')?.textContent==='REVIEW'`, 'UI manual stop');
  const stopped = await poll(async () => { const status = await recorders(recording.captureId); return status.cameras.every(c => c.state === 'stopped') && status; }, 'every recorder stopped');
  await check('manual stop closes every native store with exact pixels, timestamps and one start/end each', async () => {
    assert.deepEqual((await json(path.join(stopped.dir, 'cameras.json'))).cameras, stopped.cameras);
    for (const camera of cameras) {
      const status = stopped.cameras.find(c => c.id === camera.id), store = openCaptureStore(status.dir, { readOnly: true });
      try {
        assert.equal(store.meta().rows, camera.image.height); assert.equal(store.meta().columnPeriod, camera.meta.column_period_s);
        assert.equal(store.columnCount(), status.columns);
        assert.deepEqual(store.readColumns(16, 16 + camera.image.width), columnsOf(camera.image, 0, camera.image.width), camera.id + ' native column bytes');
        for (const x of [0, 63, camera.image.width - 1]) assert.ok(Math.abs(store.raceTimeOf(16 + x) - camera.meta.first_column_race_time_s - x * camera.meta.column_period_s) < 1e-9, camera.id + ' native clock');
        assert.equal(store.events().filter(e => e.type === 'start_pulse').length, 1);
        assert.equal(store.events().filter(e => e.type === 'end').length, 1);
      } finally { store.close(); }
    }
    assert.ok(stopped.cameras[0].columns > stopped.cameras[1].columns && stopped.cameras[1].columns > stopped.cameras[2].columns, 'native rates must produce different column counts');
    const events = await ev('window.__cameraEvents');
    for (const name of ['capture.hello', 'capture.pulse', 'capture.end']) assert.equal(events.filter(e => e.name === name).length, 1, name);
    assert.equal(events.find(e => e.name === 'capture.hello').rows, 144);
    const journal = await starts(); assert.equal(journal.triggers.length, 1); assert.equal(journal.history.length, 1);
    assert.equal(journal.triggers[0].captureId, recording.captureId);
  });

  phase = 'historical review';
  const frozenEvidence = await evidenceHashes(stopped), stoppedStarts = await starts(), stoppedJournal = await journalBytes();
  await openInventory(); await selectCamera('scan-far'); await click('#cameraView'); await closeDialog();
  await waitUI(`document.querySelector('#scanCameraLabel').textContent.includes('Far camera at start')`, 'historical far-camera view');
  await check('historical view retains the original finish label and actual generated image pixels', async () => {
    const label = await ev(`document.querySelector('#scanCameraLabel').textContent`);
    assert.match(label, /Far camera at start/); assert.match(label, /Far finish/); assert.match(label, /outside/);
    assert.doesNotMatch(label, /Moved far camera|Home finish/);
    assert.equal(await ev(`document.querySelector('[aria-label="Link comparison view"]').disabled`),true);
    assert.equal(await ev(`document.querySelector('[aria-label="Link comparison view"]').textContent`),'Different finish');
    await waitUI(`(()=>{const c=document.querySelector('#scan'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<p.length;i+=4)if(p[i]===35&&p[i+1]===65&&p[i+2]===220)n++;return n>100;})()`, 'original blue pixels on the actual review canvas');
    await verifySnapshots(stopped);
    assert.deepEqual(await evidenceHashes(stopped), frozenEvidence);
  });
  await shot('03-historical-far-finish');
  await openInventory();
  await waitUI(`document.querySelectorAll('#cameraInventory .camera-item-status[data-state="stopped"]').length===3`, 'three stopped UI statuses');
  await selectCamera('scan-far'); await click('#cameraAlign');
  await waitUI(`document.querySelector('#race').textContent.includes('Preview streaming')`, 'post-race alignment');
  await button('Stop preview'); await button('Return to race');
  await waitUI(`document.querySelector('#ev .state')?.textContent==='REVIEW'`, 'historical race restored');
  await check('post-race alignment leaves stopped stores, snapshots, capture count and journal unchanged', async () => {
    assert.deepEqual(await evidenceHashes(stopped), frozenEvidence);
    assert.deepEqual(await starts(), stoppedStarts); assert.equal(await journalBytes(), stoppedJournal);
    assert.deepEqual(await captureDirs(), [recording.captureId]);
    assert.deepEqual((await recorders(recording.captureId)).cameras, stopped.cameras);
    assert.deepEqual((await config()).heats['5-1-1'], { locationId: 'home', timingCameraId: 'scan-far' });
  });
  await check('renderer and camera lifecycle report no errors', async () => {
    assert.deepEqual(runtimeErrors, []);
    assert.deepEqual(await ev(`window.__cameraEvents.filter(e=>['capture.error','preview.error','camera.recorder.error'].includes(e.name))`), []);
  });
  await shot('04-final-review');
  await writeFile(path.join(root, 'camera-events.json'), JSON.stringify(await ev('window.__cameraEvents'), null, 2));
  if (failures.length) throw Error(`${failures.length} camera inventory checks failed`);
  log('PASS generated camera inventory Electron integration:', passed.length, 'checks');
} catch (error) {
  if (!failures.some(f => f.error === error.stack)) failures.push({ phase, error: error.stack });
  log('FAILED', phase, error.stack);
  if (ws?.readyState === WebSocket.OPEN) {
    try { await shot('failure'); await writeFile(path.join(root, 'failure-dom.txt'), await ev('document.body.innerText')); } catch (artifactError) { log('Failure artifact:', artifactError.message); }
  }
  log('ELECTRON_LOG', electronLog); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  ws?.close();
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Test ended')); }
  pending.clear();
  stopProcess('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1000)]);
  stopProcess('SIGKILL');
  await writeFile(path.join(root, 'summary.json'), JSON.stringify({ appDir, profile, port, passed, failures, runtimeErrors }, null, 2));
  log('TEST_LOG', logFile);
}
