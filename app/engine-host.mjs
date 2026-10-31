// OpenMeet engine host: runs in an Electron utility process (plain Node, no window).
// It owns every file the meet depends on: the meet manager's shared folder and the results written back.
// Messages: {id, method, params} in; {id, result} | {id, error} out; {event, data} for pushes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { validateCropResult } from './renderer/column-map.mjs';
import { occlusionInfo, requestOcclusion } from './private-occlusion.mjs';
import { SOURCE_TYPES, simulationCatalog, sourceId, readReplayFolder, publicReplay, recordedResults } from './simulation-sources.mjs';
import { createMeetBackup } from './meet-backup.mjs';
import {nativeCrop,nativeCropInfo} from './autocrop/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const userData = process.argv[2] || here;
const port = process.parentPort;
let portClosed = false;
const emit = (event, data) => { if (!portClosed) port.postMessage({ event, data }); };

// The engine core library (engine/) lives beside the app; load it if this build includes it.
let core = null;
for (const p of [path.join(here, '..', 'engine', 'index.js'), path.join(here, 'engine', 'index.js')]) {
  if (fs.existsSync(p)) { core = await import(pathToFileURL(p).href); break; }
}

const decode = buf => new TextDecoder('windows-1252').decode(buf).replace(/^﻿/, '');
const MEET_FILES = ['lynx.evt', 'lynx.ppl', 'lynx.sch'];
let watcher = null;

async function readMeet(dir) {
  const out = { dir, files: {}, parsed: null };
  for (const f of MEET_FILES) {
    try {
      const p = path.join(dir, f), st = await fsp.stat(p);
      out.files[f] = { text: decode(await fsp.readFile(p)), mtimeMs: st.mtimeMs, size: st.size };
    } catch { /* optional file absent */ }
  }
  if (core && out.files['lynx.evt']) {
    out.parsed = {
      events: core.parseEvt(out.files['lynx.evt'].text),
      people: out.files['lynx.ppl'] ? core.parsePpl(out.files['lynx.ppl'].text) : [],
      schedule: out.files['lynx.sch'] ? core.parseSch(out.files['lynx.sch'].text) : [],
    };
  }
  return out;
}

async function writeAtomic(dir, name, text) {
  if (core?.writeLifAtomic) return core.writeLifAtomic(dir, name, text);
  const final = path.join(dir, name), tmp = final + '.tmp';
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'latin1')); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, final);
  return final;
}

const meetBackup = createMeetBackup({ writeAtomic, onStatus: status => emit('backup.status', status) });

// One logical capture (or one bounded preview) at a time. Each registered replay
// camera has its own append-only native store; primary events keep their legacy shape.
let active = null;
let captureStarting = false, captureStartStop = false, captureStartingPreview = false, sourceChanging = false;
async function changeSource(fn) {
  if (active || captureStarting || sourceChanging) throw Error('Stop capture or preview before changing simulation sources');
  sourceChanging = true;
  try { return await fn(); } finally { sourceChanging = false; }
}
async function runCapture(id, store, gen, preview=false) {
  const prefix=preview?'preview':'capture';
  try {
    for await (const msg of gen) {
      if (!active || active.id !== id || active.stop) break;
      store.append(msg);
      if (msg.type === 'hello') emit(`${prefix}.hello`, { id, rows: msg.rows, channels: msg.channels, columnPeriod: msg.columnPeriod, model: msg.model });
      else if (msg.type === 'start_pulse' && !preview) emit('capture.pulse', { id, hwTime: msg.hwTime });
      else if (msg.type === 'columns') emit(`${prefix}.columns`, { id, first: store.columnCount() - msg.count, count: msg.count, period: msg.period, data: msg.data });
      // Completion is reported only after the capture store has been closed below.
    }
  } catch (err) {
    if (err.name !== 'AbortError') emit(`${prefix}.error`, { id, message: err.message || String(err) });
  } finally {
    const columns = store.columnCount();
    if (active?.id === id && active.timer) clearTimeout(active.timer);
    try { await store.close(); } catch { /* already closed */ }
    if (active && active.id === id) active = null;
    emit(`${prefix}.end`, { id, columns });
  }
}

// Capture id -> {dir, sidecar}. The simulator's truth stays here in the engine: the console never receives it.
const captures = new Map();
const backendIntegration = core?.createBackendIntegrationService({ root:userData,
  captureResolver:id=>captures.get(id), emit });
const scanSources = new Map();
const recorderGroups = new Map();
let latestCaptureId = null;
const cameraEnginePath = [path.join(here, '..', 'engine', 'cameras', 'index.js'), path.join(here, 'engine', 'cameras', 'index.js')].find(p => fs.existsSync(p));
const cameraEngine = cameraEnginePath ? await import(pathToFileURL(cameraEnginePath).href) : null;
const wireScoreboards = core?.createWireScoreboardService({ onEvent:emit });
const remoteServers = core?.createRemoteServerService({onEvent:emit,
  binaryProvider(context){
    const capture=captures.get(context.captureId);if(!capture)throw Error('Unknown remote capture');
    return core.createCaptureRemoteProvider({...context,dir:capture.dir,invalidColumns:capture.invalidColumns});
  },
  async textDispatch(request,context){
    const field=(name,component=-1)=>core.remoteLookup(request,name,component);
    const command=field('Command').value?.toLowerCase();
    try{
      if(command==='imagegetinfo'){
        const capture=captures.get(context.captureId);if(!capture)throw Error('Unknown capture');
        const store=core.openCaptureStore(capture.dir,{readOnly:true});
        try{return [['Reply','Ok'],['ImageSize',`${store.columnCount()},${store.meta().rows}`],['Rate',String(1/store.meta().columnPeriod)]];}finally{store.close();}
      }
      if(command==='startcreate'){
        const result=await core.dispatchRemoteStart(request,{
          sourceTag:()=>context.clockOrigin??0,
          async append(record){
            if(!context.meetDir||typeof context.clockId!=='string')throw Error('Remote start needs a bound meet and capture clock');
            const timeS=Number(BigInt(record.primary.ticks)-BigInt(record.secondary.ticks))/80000;
            const trigger=(await startJournal(context.meetDir)).record({clockId:context.clockId,timeS,source:'remote-control',captureId:context.captureId});
            await fsp.appendFile(path.join(context.meetDir,'remote-start-audit.jsonl'),JSON.stringify({record,trigger,physicalPulseConfirmed:false})+'\n');
            emit('remote.start',{record,trigger,physicalPulseConfirmed:false});
          },
          trigger(request){emit('remote.start-request',{...request,captureId:context.captureId,physicalPulseConfirmed:false});return false;},
        });return [['Reply',result.reply]];
      }
      if(command==='eventopen'){
        const file=field('File',0);if(!file.present||!file.value)throw Error('Event file required');
        const handle=await fsp.open(file.value,'r');let bytes;
        try{const limit=64*1024*1024,size=(await handle.stat()).size;if(size>limit)throw Error('Event metadata exceeds its input budget');
          const input=Buffer.alloc(size+1);let at=0;
          while(at<input.length){const read=await handle.read(input,at,input.length-at,at);if(!read.bytesRead)break;at+=read.bytesRead;}
          if(at>size)throw Error('Event metadata changed during read');bytes=input.subarray(0,at);
        }finally{await handle.close();}
        const archive=core.readEventArchive(bytes);
        emit('remote.event-open',{path:file.value,archive});return [['Reply','Ok']];
      }
      // Unsupported actions are explicit. Print/OS providers are never inferred.
      return [['Reply','Unknown']];
    }catch(error){emit('remote.action-error',{message:error.message});return [['Reply','Error']];}
  },
});
const networkCameras = cameraEngine?.createNetworkCameraService({ onEvent(name,data) {
  if(name==='camera.network.columns'){
    const capture=captures.get(data.id);
    if(capture?.network)for(let i=0;i<data.times.length;i++)if(!data.times[i].valid)capture.invalidColumns.add(data.first+i);
  }
  if(name==='camera.network.start'&&data.evidence?.candidate){
    const candidate=data.evidence.candidate;
    wireScoreboards?.notifyGun({time:{ticks:String(BigInt(candidate.primary.ticks)-BigInt(candidate.secondary.ticks)),
      quantum:candidate.primary.quantum,origin:candidate.primary.origin},kind:candidate.kind});
  }
  emit(name,data);
} });
const hardware = core?.createHardwareService({root:userData,cameras:networkCameras,boards:wireScoreboards,
  openCamera:options=>methods['camera.network.open'](options),captureBusy:()=>!!active||captureStarting||sourceChanging,onEvent:emit});
const cameraConfig = cameraEngine?.createCameraConfig({
  sampleDir: path.join(userData, 'sample'),
  cameras: () => [...new Map([...scanSources.values()].map(source => [source.id, source])).values()],
  onSetupChange(change) {
    if (active?.group && active.configFile === change.file) active.group.noteSetupChange(change);
  },
});

// Auto-timing: the configured TTP finish service, or the labelled stand-in (simulator truth echo) on loopback.
const locate = rel => [path.join(here, '..', rel), path.join(here, rel)].find(p => fs.existsSync(p));
let finish = null, finishStarting = null;
async function finishService() {
  if (finish) return finish;
  if (!finishStarting) finishStarting = (async () => {
    const at = (await loadSettings()).autotiming || {};
    const clientPath = locate('engine/autotiming/client.js');
    if (!clientPath) throw new Error('auto-timing client missing from this build');
    const { createFinishClient } = await import(pathToFileURL(clientPath).href);
    const timeoutMs = at.timeoutMs || 300000;
    if (at.baseUrl) return (finish = { client: createFinishClient({ baseUrl: at.baseUrl, apiKey: at.apiKey, timeoutMs }), stub: false, model: null });
    const stubPath = locate('services/finish-api-stub/server.js');
    if (!stubPath) throw new Error('no auto-timing service configured');
    const { createStubServer } = await import(pathToFileURL(stubPath).href);
    const server = createStubServer();
    try {
      await new Promise((resolve, reject) => {
        const failed = error => reject(error);
        server.once('error', failed);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', failed); resolve(); });
      });
    } catch (error) { server.close(); throw error; }
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return (finish = { client: createFinishClient({ baseUrl, timeoutMs }), stub: true, baseUrl, server });
  })().catch(error => { finishStarting = null; throw error; });
  return finishStarting;
}
async function closeFinishService() {
  try { await finishStarting; } catch { /* startup already reported its error */ }
  if (finish?.server) {
    const server = finish.server;
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
  }
}

// The captured strip as a native-orientation PNG, read back from the capture store (the record, not the console's copy).
// Columns [from, to] of the captured strip (to defaults to the latest), so a capture still being recorded can be read too.
async function stripPng(dir, from = 0, to = null, laneGuides = null, includeImage = false) {
  const store = core.openCaptureStore(dir, { readOnly: true });
  try {
    const meta = store.meta(), total = store.columnCount(), rows = meta.rows, ch = meta.channels;
    const a = Math.max(0, Math.min(from, total)), b = Math.min(total, to == null ? total : to + 1), n = b - a;
    if (n <= 0) throw new Error('no captured columns in that range yet');
    const cm = store.readColumns(a, b), rm = Buffer.alloc(n * rows * ch);
    for (let c = 0; c < n; c++) for (let r = 0; r < rows; r++) {
      const s = (c * rows + r) * ch, d = (r * n + c) * ch;
      for (let k = 0; k < ch; k++) rm[d + k] = cm[s + k];
    }
    return {
      png: core.encodePng(core.renderLaneGuides({ width: n, height: rows, channels: ch, data: rm },laneGuides), { filter: () => 1 }),
      ...(includeImage?{image:{width:n,height:rows,channels:ch,data:rm}}:{}),
      rows, columns: n, channels: ch, from: a, firstRaceTime: store.raceTimeOf(a), period: meta.columnPeriod,
    };
  } finally { await store.close(); }
}

const settingsPath = path.join(userData, 'openmeet-settings.json');
async function loadSettings() { try { return JSON.parse(await fsp.readFile(settingsPath, 'utf8')); } catch { return {}; } }
let settingsWrite = Promise.resolve();
function saveSettings(patch) {
  const write = settingsWrite.then(async () => {
    const current = await loadSettings();
    const s = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
    await fsp.mkdir(userData, { recursive: true });
    const tmp = settingsPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(s, null, 2));
    await fsp.rename(tmp, settingsPath);
    return s;
  });
  settingsWrite = write.catch(() => {});
  return write;
}

function registerReplay(replay) {
  scanSources.clear();
  for (const heat of replay.heats) {
    const group = heat.lineScans.map(source => ({ ...source, heatKey: `${heat.event}|${heat.round}|${heat.heat}` }));
    for (const source of group) { source.group = group; scanSources.set(source.png, source); }
  }
  emit('roots.add', [replay.dir]);
  return publicReplay(replay);
}

const startJournals = new Map();
async function startJournal(dir) {
  if (!dir) throw new Error('Open a meet folder first');
  const key = path.resolve(dir);
  if (!startJournals.has(key)) {
    const { openStartJournal } = await import(pathToFileURL(locate('engine/timing/starts.js')).href);
    startJournals.set(key, openStartJournal(key));
  }
  return startJournals.get(key);
}

const cropRequests = new Set(), cropProcesses = new Set();
const MAX_CROP_RESPONSE_BYTES = 64 * 1024 * 1024;
async function cropperRequest(payload) {
  const settings=await loadSettings(),url=settings.cropServiceUrl||process.env.OPENMEET_CROP_URL;
  if(url) {
    const health=payload.operation==='health',controller=new AbortController(),limit=health?64*1024:MAX_CROP_RESPONSE_BYTES;
    const timer=setTimeout(()=>controller.abort(),health?3000:120000);cropRequests.add(controller);
    try {
      const response=await fetch(new URL(health?'/health':'/v1/column-ranges',url),{method:health?'GET':'POST',...(!health?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{}),signal:controller.signal});
      if(Number(response.headers.get('content-length'))>limit) {
        await response.body?.cancel().catch(()=>{});controller.abort();throw Error('Auto-cropper response exceeds its byte limit');
      }
      const chunks=[];let length=0;
      if(response.body) {
        const reader=response.body.getReader();
        try {
          for(;;) {
            const {done,value}=await reader.read();if(done)break;
            length+=value.byteLength;
            if(length>limit){await reader.cancel().catch(()=>{});controller.abort();throw Error('Auto-cropper response exceeds its byte limit');}
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      const result=JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
      if(!response.ok)throw Error(result.error||'Auto-cropper request failed');return result;
    } finally { clearTimeout(timer);cropRequests.delete(controller); }
  }
  const command=JSON.parse(process.env.OPENMEET_CROP_COMMAND||'null');
  if(!Array.isArray(command)||!command.length||command.some(a=>typeof a!=='string'))throw Error('Configure a private auto-cropper worker first');
  return new Promise((resolve,reject)=>{
    const child=execFile(command[0],command.slice(1),{timeout:120000,maxBuffer:MAX_CROP_RESPONSE_BYTES,windowsHide:true},(error,stdout)=>{
      cropProcesses.delete(child);
      try{const result=JSON.parse(stdout);if(error||result.error)reject(Error(result.error||'Private cropper worker failed'));else resolve(result);}catch{reject(Error(error?.message||'Invalid private cropper response'));}
    });cropProcesses.add(child);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
  });
}
const cropJobs = new Map();
let nativeCropPreparing = false;

const methods = {
  async ping() { return { ok: true, pid: process.pid, core: !!core, node: process.versions.node }; },
  async 'settings.get'() { return loadSettings(); },
  async 'settings.set'({ patch }) {
    if ((active || captureStarting || sourceChanging) && ['simulationSources', 'simulationSourceId', 'demoDir', 'meetDir'].some(k => k in patch)) throw Error('Stop capture or preview before changing simulation sources');
    return saveSettings(patch);
  },
  async 'meet.folders.set'({ dir, kind, folder }) {
    return changeSource(async () => {
      if (!dir || !['output', 'backup'].includes(kind)) throw Error('Open an input folder first');
      if (folder != null && (typeof folder !== 'string' || !path.isAbsolute(folder))) throw Error('Choose an absolute folder path');
      const destination = folder ? await fsp.realpath(folder) : null;
      if (destination) {
        await fsp.access(destination, fs.constants.W_OK);
        const settings = await loadSettings(), input = await fsp.realpath(dir);
        const output = settings.resultsFor?.[dir] ? await fsp.realpath(settings.resultsFor[dir]) : input;
        const backup = settings.backupFor?.[dir] ? await fsp.realpath(settings.backupFor[dir]).catch(() => path.resolve(settings.backupFor[dir])) : null;
        if (kind === 'backup' && [input, output].includes(destination) || kind === 'output' && destination === backup) throw Error('Choose a separate folder for the backup');
      }
      const field = kind === 'output' ? 'resultsFor' : 'backupFor';
      const settings = await saveSettings(current => ({ [field]: { ...current[field], [dir]: destination } }));
      return { resultsDir: settings.resultsFor?.[dir] || null, backupDir: settings.backupFor?.[dir] || null };
    });
  },
  async 'demo.catalog'() { return simulationCatalog(await loadSettings()); },
  async 'demo.import'({ dir, type = 'ttp', name }) {
    return changeSource(async () => {
      if (!dir || !SOURCE_TYPES.has(type)) throw Error('Choose a TTP simulator or real meet replay folder');
      const replay = await readReplayFolder(dir, readMeet, type);
      const catalog = simulationCatalog(await loadSettings());
      const source = { id: catalog.sources.find(s => s.path === replay.dir)?.id || sourceId(replay.dir), type:replay.type, name: String(name || replay.name), path: replay.dir };
      const sources=catalog.sources.slice(),index=sources.findIndex(s=>s.id===source.id);
      if(index<0)sources.push(source);else sources[index]=source;
      await saveSettings({ simulationSources: sources });
      return source;
    });
  },
  async 'demo.load'({ id = null, dir = null, type = 'ttp' } = {}) {
    return changeSource(async () => {
      const settings = await loadSettings(), catalog = simulationCatalog(settings);
      const source = id ? catalog.sources.find(s => s.id === id) : dir ? catalog.sources.find(s=>s.path===path.resolve(dir)) || { id: sourceId(dir), type, name: path.basename(dir), path: path.resolve(dir) } : catalog.sources.find(s => s.id === catalog.selectedId);
      if (!source || !SOURCE_TYPES.has(source.type)) throw Error('Unknown simulation source');
      // Fully validate before replacing the meet watcher or the saved selection.
      const replay = await readReplayFolder(source.path, readMeet, source.type);
      if(!id||source.type!==replay.type)source.name=replay.name;source.type=replay.type;if(source.type==='ttp')source.name='OpenMeet demo';
      if (typeof watcher === 'function') await watcher(); else if (watcher) await watcher.close();
      watcher = null;
      watcher = core?.watchMeetFolder
        ? core.watchMeetFolder(replay.meet.dir, async change => emit('meet.changed', { dir: replay.meet.dir, ...change, files: (await readMeet(replay.meet.dir)).files }))
        : watchPlain(replay.meet.dir);
      const sources=catalog.sources.slice(),index=sources.findIndex(s=>s.id===source.id);
      if(index<0)sources.push(source);else sources[index]=source;
      await saveSettings({ simulationSources: sources, simulationSourceId: source.id, demoDir: source.path, meetDir: replay.meet.dir });
      return { source, ...registerReplay(replay) };
    });
  },
  async 'starts.list'({ dir }) { return (await startJournal(dir)).list(); },
  async 'starts.record'({ dir, clockId, timeS, source, captureId, wallTimeMs }) {
    return (await startJournal(dir)).record({ clockId, timeS, source, captureId, wallTimeMs });
  },
  async 'starts.assign'({ dir, heatKey, triggerId, referenceTriggerId }) {
    return (await startJournal(dir)).assign({ heatKey, triggerId, referenceTriggerId });
  },
  async 'meet.open'({ dir }) {
    if (active || captureStarting || sourceChanging) throw Error('Stop capture or preview before changing the meet folder');
    if (!dir) throw new Error('no folder given');
    emit('roots.add', [dir]);
    const meet = await readMeet(dir);
    if (!meet.parsed?.events.some(event => event.entries.some(entry => entry.lane))) throw Error('No start lists found in this input folder');
    if (typeof watcher==='function')await watcher();else if(watcher)await watcher.close();
    watcher = core?.watchMeetFolder
      ? core.watchMeetFolder(dir, async change => emit('meet.changed', { dir, ...change, files: (await readMeet(dir)).files }))
      : watchPlain(dir);
    return meet;
  },
  // Build and write one heat's results with the engine core: {dir, heat: LifHeat, results: LifResult[]}.
  async 'lif.save'({ dir, meetDir, heat, results, captureId, review }) {
    if (!core) throw new Error('engine core missing from this build');
    if (!dir) throw new Error('no meet folder open');
    const name = core.lifName(heat.event, heat.round, heat.heat);
    const text = core.buildLif(heat, results);
    if(captureId && captures.has(captureId)) await core.writeLifAtomic(captures.get(captureId).dir,name,text);
    if(captureId&&review&&captures.has(captureId))await fsp.writeFile(path.join(captures.get(captureId).dir,'review.json'),JSON.stringify(review,null,2));
    const p = await core.writeLifAtomic(dir, name, text);
    const capture = captures.get(captureId), input = capture?.meetDir || meetDir;
    const backupDir = input ? (await loadSettings()).backupFor?.[input] : null;
    if (input && backupDir) void meetBackup.run({ meetDir: input, backupDir, captureDir: capture?.dir, captureId, name, text, review });
    const backup = input && backupDir ? { state: 'copying' } : null;
    return { path: p, name, text, backup };
  },
  async 'hardware.list'(params) { return hardware.list(params); },
  async 'hardware.save'(params) { return hardware.save(params); },
  async 'hardware.remove'(params) { return hardware.remove(params); },
  async 'hardware.import'(params) { return hardware.importFile(params); },
  async 'hardware.inspect'(params) { return hardware.inspect(params); },
  async 'hardware.connect'(params) { return hardware.connect(params); },
  async 'hardware.status'(params) { return hardware.status(params); },
  async 'hardware.disconnect'(params) { return hardware.disconnect(params); },
  async 'hardware.image'(params) { return hardware.image(params); },
  async 'hardware.retryStatus'(params) { return hardware.retryStatus(params); },
  async 'hardware.scoreboardMode'(params) { return hardware.scoreboardMode(params); },
  async 'hardware.confirm'(params) { return hardware.confirm(params); },
  async 'hardware.scriptPreview'(params) { return hardware.scriptPreview(params); },
  async 'camera.config.get'(params) { return cameraConfig.get(params); },
  async 'camera.network.probe'(params) { return networkCameras.probe(params); },
  async 'camera.network.inspect'(params) { return networkCameras.inspect(params); },
  async 'camera.network.open'({ profile, meetDir = null, ...options }) {
    // The host owns recording paths; callers cannot replace an existing capture.
    const base = meetDir ? path.join(meetDir, 'openmeet', 'camera-sessions') : path.join(userData, 'camera-sessions');
    const opened=networkCameras.open({ ...options, profile, meetDir, recordingDir: path.join(base, randomUUID()) });
    if(opened.image){captures.set(opened.id,{id:opened.id,dir:opened.image.dir,meetDir,network:true,
      sourceType:'network',cameraId:profile.cameraKey,cameraSources:[],sidecar:null,invalidColumns:new Set()});if(!options.diagnostic)latestCaptureId=opened.id;}
    return opened;
  },
  async 'camera.network.command'(params) { return networkCameras.command(params); },
  async 'camera.network.status'(params) { return networkCameras.snapshot(params); },
  async 'camera.network.image'(params) { return networkCameras.image(params); },
  async 'camera.network.bindStart'({id,dir,triggerId}) {
    const trigger=(await startJournal(dir)).list().triggers.find(item=>item.id===triggerId);
    if(!trigger)throw Error('Unknown start trigger');return networkCameras.bindStart({id,clockId:trigger.clockId,timeS:trigger.timeS});
  },
  async 'camera.network.drain'(params) { return networkCameras.drain(params); },
  async 'camera.network.synchronize'(params) { return networkCameras.synchronize(params); },
  async 'camera.network.close'(params) { return networkCameras.close(params); },
  async 'backend.profiles'(params) { return backendIntegration.profiles(params); },
  async 'backend.settings'(params) { return backendIntegration.settings(params); },
  async 'backend.time'(params) { return backendIntegration.time(params); },
  async 'backend.participants'(params) { return backendIntegration.participants(params); },
  async 'backend.event.import'(params) { return backendIntegration.eventImport(params); },
  async 'backend.schedule'(params) { return backendIntegration.schedule(params); },
  async 'backend.results.assign'(params) { return backendIntegration.assignResult(params); },
  async 'remote.listen'(params) { return remoteServers.listen(params); },
  async 'remote.list'() { return remoteServers.list(); },
  async 'remote.close'(params) { return remoteServers.close(params); },
  async 'backend.archive'(params) { return backendIntegration.archive(params); },
  async 'backend.weather'(params) { return backendIntegration.weather(params); },
  async 'backend.results.extended'(params) { return backendIntegration.extendedResults(params); },
  async 'backend.media'(params) { return backendIntegration.media(params); },
  async 'backend.still.export'(params) { return backendIntegration.exportStill(params); },
  async 'camera.location.save'(params) { return cameraConfig.saveLocation(params); },
  async 'camera.setup.save'(params) { return cameraConfig.saveSetup(params); },
  async 'camera.heat.assign'(params) { return cameraConfig.assignHeat(params); },
  async 'camera.recorders'({ captureId } = {}) {
    const id = captureId || latestCaptureId;
    if (captureId && !recorderGroups.has(captureId)) throw Error('Unknown capture');
    const group = recorderGroups.get(id);
    if (!group) return { captureId: null, cameras: [] };
    const config = cameraConfig.get({ meetDir: group.meetDir });
    return { ...group.snapshot(), nextAssignment: config.heats[group.assignmentKey] || null };
  },
  // Record every registered replay camera in the primary source's heat. Selection
  // determines the compatible primary layout/events, never which cameras record.
  async 'capture.start'({ key, png, sidecar, speed = 1, meetDir, front, timeoutSeconds = null, preview = false, cameraId, cameraLabel, cameraSources }) {
    if (!core || !cameraEngine) throw new Error('engine core missing from this build');
    if (active || captureStarting || sourceChanging) throw new Error('a capture or source change is already running');
    captureStarting = true; captureStartStop = false; captureStartingPreview = preview;
    try {
      const source = scanSources.get(png);
      if (!source) throw Error('Open this registered camera source first');
      if (cameraId && cameraId !== source.id) throw Error('Camera id does not match its registered source PNG');
      if (!(Number.isFinite(speed) && speed > 0)) throw Error('Replay speed must be positive');
      if (cameraSources != null) {
        if (!Array.isArray(cameraSources)) throw Error('cameraSources must be an array of registered sources');
        const seen = new Set();
        for (const requested of cameraSources) {
          const registered = scanSources.get(requested?.png);
          if (!registered || registered.id !== requested.id || registered.group !== source.group || seen.has(requested.id)) throw Error('Camera source must be registered in this heat with its matching id and PNG');
          seen.add(requested.id);
        }
      }
      sidecar = JSON.parse(await fsp.readFile(source.sidecar, 'utf8'));
      const id = `${String(key || 'heat').replace(/[^\w-]/g, '_')}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      if (preview) {
        let columns = 0;
        const store = { append(msg) { if (msg.type === 'columns') columns += msg.count; }, columnCount() { return columns; }, async close() {} };
        const controller = new AbortController();
        active = { id, stop: captureStartStop, controller, preview: true };
        if (captureStartStop) controller.abort();
        active.done = runCapture(id, store, core.simReplay({ png,
          sidecar: { ...sidecar, first_column_race_time_s: 0 }, realtime: true, speed,
          model: source.sourceType === 'real' ? 'real-recorded-replay' : 'sim-preview',
          holdOpen: true, signal: controller.signal }), true);
        return { id, dir: null, front: null, trigger: null };
      }
      const config = cameraConfig.get({ meetDir });
      const assignmentKey = Object.hasOwn(config.heats, key) ? key : source.heatKey;
      const heatAssignment = config.heats[assignmentKey] || { locationId: config.setups[source.id].locationId, timingCameraId: source.id };
      if (!source.group.some(item => item.id === heatAssignment.timingCameraId)) throw Error('Heat timing camera is not registered in this heat');
      if (config.setups[heatAssignment.timingCameraId]?.locationId !== heatAssignment.locationId) throw Error('Heat timing camera must match the selected finish location');
      if (heatAssignment.timingCameraId !== source.id) throw Error('Primary camera must match the heat timing camera assignment');
      const dir = path.join(meetDir ? path.join(meetDir, 'openmeet', 'captures') : path.join(userData, 'captures'), id);
      await fsp.mkdir(dir, { recursive: true });
      if (!meetDir) emit('roots.add', [dir]);
      let frontRec = null;
      if (front?.path) {
        const vp = path.join(dir, 'front' + path.extname(front.path));
        await fsp.copyFile(front.path, vp);
        await fsp.writeFile(path.join(dir, 'front.json'), JSON.stringify({ ...(front.meta || {}), heat: key }, null, 2));
        frontRec = { path: vp, meta: front.meta || null, frames: front.frames || null };
      }
      const pulseMs = Date.now();
      const journal = meetDir ? await startJournal(meetDir) : null;
      const trigger = journal?.record({ clockId: 'simulated-meet-clock', timeS: pulseMs / 1000,
        wallTimeMs: pulseMs, source: 'Simulated camera start', captureId: id }) || null;
      if (trigger) journal.assign({ heatKey: key || source.heatKey, triggerId: trigger.id, referenceTriggerId: trigger.id });
      const backupDir = meetDir ? (await loadSettings()).backupFor?.[meetDir] : null;
      captures.set(id, { dir, meetDir, sidecar, trigger, cameraId: source.id, sourceType: source.sourceType,
        cameraSources: source.group.map(item => ({ id: item.id, png: item.png })),
        sourceColumns: source.size.width, sourceRef: { kind: 'recorded-results', label: 'Recorded results', path: source.sidecar } });
      const group = new cameraEngine.ReplayRecorderGroup({ id, dir, primaryId: source.id, core, speed, emit, trigger, heatKey: source.heatKey, heatAssignment,
        sources: source.group.map(item => ({ ...item, sidecar: item === source ? sidecar : item.sidecar, sidecarFile: item.sidecar, setup: config.setups[item.id] })) });
      group.meetDir = meetDir; group.assignmentKey = assignmentKey;
      recorderGroups.set(id, group); latestCaptureId = id;
      const current = active = { id, stop: captureStartStop, controller: group.controller, preview: false, group,
        configFile: cameraConfig.fileFor(meetDir) };
      if (captureStartStop) group.controller.abort();
      if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) current.timer = setTimeout(() => group.controller.abort(), timeoutSeconds / speed * 1000);
      current.done = group.start().then(snapshot => {
        clearTimeout(current.timer);
        if (active === current) active = null;
        const primary = snapshot.cameras.find(camera => camera.id === source.id);
        emit('capture.end', { id, columns: primary.columns });
        if (backupDir) void meetBackup.run({ meetDir, backupDir, captureDir: dir, captureId: id });
      });
      await group.ready;
      return { id, dir, front: frontRec, trigger, ...group.snapshot() };
    } finally { captureStarting = false; captureStartingPreview = false; }
  },
  async 'preview.start'(params) { return methods['capture.start']({ ...params, key: 'camera-setup', preview: true, timeoutSeconds: null }); },
  async 'preview.stop'() {
    if (captureStarting && captureStartingPreview) captureStartStop = true;
    const current = active;
    if (current?.preview) { current.stop = true; current.controller.abort(); await current.done; }
    return { ok: true };
  },
  async 'capture.stop'() {
    if (captureStarting) captureStartStop = true;
    const current = active;
    if (current) { current.stop = true; current.controller.abort(); await current.done; }
    return { ok: true };
  },
  // Ask the finish model about a finished capture: {captureId, heat: {event, round, heat}, startList: [{lane, id}], laneRows?}.
  // Live mode for services fast enough to call during the race (the stand-in, or a service configured with live: true).
  async 'autotiming.info'() {
    const at = (await loadSettings()).autotiming || {};
    return { stub: !at.baseUrl && !at.cli, live: (!at.baseUrl && !at.cli) || !!at.live };
  },
  // {captureId, heat, startList, laneRows?, fromCol?, toCol?}: columns in the reply are relative to `fromCol` (returned).
  async 'autotiming.predict'({ captureId, heat, startList, laneRows, fromCol = 0, toCol = null, laneGuides = null }) {
    const cap = captures.get(captureId);
    if (!cap) throw new Error('unknown capture');
    if(cap.network&&(await methods['autotiming.info']()).stub)throw Error('Configure a timing service for the network camera or mark finishes manually');
    if(cap.sourceType==='real'&&(await methods['autotiming.info']()).stub){
      if(!core.loadSimTruth(cap.sidecar).length)throw Error('This recorded replay has no reference timing points. Configure a timing service or mark finishes manually.');
      const store=core.openCaptureStore(cap.dir,{readOnly:true});
      try{
        const total=store.columnCount(),a=Math.max(0,Math.min(fromCol,total)),b=Math.min(total,toCol==null?total:toCol+1);
        if(b<=a)throw Error('No captured columns in that range yet');
        const {enforceClosePolicy}=await import(pathToFileURL(locate('engine/autotiming/client.js')).href);
        const predictions=recordedResults({sidecar:cap.sidecar,firstRaceTime:store.raceTimeOf(a),period:store.meta().columnPeriod,columns:b-a,startList,sourceColumns:cap.sourceColumns});
        const response={request_id:randomUUID(),model:'recorded-results',stub:true,reference:true,sourceRef:cap.sourceRef,
          predictions:enforceClosePolicy(predictions),warnings:[],fromCol:a,inputDerived:false};
        await fsp.appendFile(path.join(cap.dir,'reference-outputs.jsonl'),JSON.stringify(response)+'\n');
        return response;
      }finally{await store.close();}
    }
    const strip = await stripPng(cap.dir, fromCol, toCol,laneGuides);
    let exactTimes=null;
    if(cap.network){
      for(const column of cap.invalidColumns)if(column>=strip.from&&column<strip.from+strip.columns)throw Error('This image range contains columns without valid camera timestamps');
      const record=core.openCaptureStore(cap.dir,{readOnly:true});
      try{const start=record.startHwTime();if(start==null)throw Error('Bind a start reference before requesting finish times');exactTimes=Array.from(record.timesOf(strip.from,strip.from+strip.columns),time=>time-start);}
      finally{record.close();}
    }
    const svc = await finishService();
    if (svc.stub) {
      // The stand-in is not a model: it echoes the simulator truth registered for this exact strip (sha256 of the PNG).
      const sha = createHash('sha256').update(strip.png).digest('hex');
      const r = await fetch(`${svc.baseUrl}/v1/stub/truth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strip_sha256: sha, truth: core.loadSimTruth(cap.sidecar) }),
      });
      if (!r.ok) throw new Error(`stand-in truth registration failed (${r.status})`);
    }
    const requestId=randomUUID(),inputDerived=!!laneGuides?.enabled;
    await fsp.appendFile(path.join(cap.dir,'model-inputs.jsonl'),JSON.stringify({requestId,at:new Date().toISOString(),fromCol:strip.from,columns:strip.columns,inputDerived,laneGuides:inputDerived?laneGuides:null,sha256:createHash('sha256').update(strip.png).digest('hex')})+'\n');
    const res = await svc.client.predict({
      request_id: requestId,
      heat: { event: String(heat.event), round: heat.round, heat: heat.heat, race_type: 'laned_sprint' },
      strip: { encoding: 'png', data_base64: strip.png.toString('base64'), rows: strip.rows, columns: strip.columns, channels: strip.channels, orientation: 'native' },
      timebase: exactTimes?{column_race_times_s:exactTimes}:{ first_column_race_time_s: strip.firstRaceTime, column_period_s: strip.period },
      start_list: startList,
      // lane_rows may only name lanes on the start list (contract v1)
      ...(laneRows && laneRows.length ? { lane_rows: laneRows.filter(b => startList.some(s => s.lane === b.lane)) } : {}),
    });
    if(exactTimes){const {enforceClosePolicy}=await import(pathToFileURL(locate('engine/autotiming/client.js')).href);res.predictions=enforceClosePolicy(res.predictions.map(item=>({...item,race_time_s:exactTimes[item.column]})));}
    return { ...res, stub: svc.stub, fromCol: strip.from, inputDerived };
  },
  async 'lif.write'({ dir, name, text }) {
    if (!dir || !/^[\w-]+\.lif$/i.test(name)) throw new Error('bad results file name');
    const p = await writeAtomic(dir, name, text);
    return { path: p, bytes: Buffer.byteLength(text, 'latin1') };
  },
  async 'autocrop.info'() {
    const settings=await loadSettings(),configured=!!(settings.cropServiceUrl||process.env.OPENMEET_CROP_URL||process.env.OPENMEET_CROP_COMMAND);
    if(!configured)return nativeCropInfo();
    try{const info=await cropperRequest({operation:'health'});return {configured:true,ready:info.ready===true,contract:info.contract};}catch{return {configured:true,ready:false};}
  },
  async 'occlusion.info'() { return occlusionInfo(); },
  async 'occlusion.predict'({captureId,viewPng=null}) {
    const cap=captures.get(captureId);if(!cap)throw Error('No captured image is available');
    if(active?.id===captureId)throw Error('Stop capture before requesting the model mask');
    let png,width,height,camera=cap.cameraId||'primary';
    const checkSize=()=>{if(width>32768||height>32768||width*height>16*1024*1024)throw Error('This capture exceeds the model preview size limit; Simple remains available');};
    if(viewPng){const source=cap.cameraSources.find(item=>item.png===viewPng);if(!source)throw Error('Camera source does not belong to this capture');png=await fsp.readFile(path.join(cap.dir,'views',`${source.id}.png`));width=png.readUInt32BE(16);height=png.readUInt32BE(20);checkSize();camera=source.id;}
    else{const record=core.openCaptureStore(cap.dir,{readOnly:true});try{width=record.columnCount();height=record.meta().rows;checkSize();}finally{await record.close();}const strip=await stripPng(cap.dir);png=strip.png;}
    const result=await requestOcclusion({png,requestId:randomUUID()});
    if(result.width!==width||result.height!==height)throw Error('Occlusion mask does not match the camera image');
    await fsp.writeFile(path.join(cap.dir,`occlusion-${String(camera).replace(/[^\w-]/g,'_')}.png`),Buffer.from(result.mask_png_base64,'base64'));
    await fsp.writeFile(path.join(cap.dir,`occlusion-${String(camera).replace(/[^\w-]/g,'_')}.json`),JSON.stringify({request_id:result.request_id,image_sha256:result.image_sha256,width,height,model:result.model,at:new Date().toISOString(),displayOnly:true}));
    return result;
  },
  async 'autocrop.run'({captureId}) {
    const cap=captures.get(captureId);if(!cap)throw Error('No captured image is available');
    if(active?.id===captureId)throw Error('Stop capture before hiding empty spans');
    if(cropJobs.has(captureId))return cropJobs.get(captureId);
    const job=(async()=>{
      const settings=await loadSettings(),external=!!(settings.cropServiceUrl||process.env.OPENMEET_CROP_URL||process.env.OPENMEET_CROP_COMMAND);
      if(!external&&nativeCropPreparing)throw Error('Empty-span analysis is already running');
      if(!external)nativeCropPreparing=true;
      try {
        const strip=await stripPng(cap.dir,0,null,null,!external),digest=createHash('sha256').update(strip.png).digest('hex'),requestId=randomUUID();
        const output=external?await cropperRequest({request_id:requestId,image_sha256:digest,image:{encoding:'png',data_base64:strip.png.toString('base64')},mode:'both'}):{request_id:requestId,image_sha256:digest,...await nativeCrop(strip.image,{transfer:true})};
        if(output.image_sha256!==digest||output.request_id!==requestId)throw Error('Cropper returned a different image');
        validateCropResult(output.result,strip.columns,'storage-display');validateCropResult(output.result,strip.columns,'inference-safe');
        const record={...output,first_column_race_time_s:strip.firstRaceTime,column_period_s:strip.period,at:new Date().toISOString()};
        await fsp.writeFile(path.join(cap.dir,'autocrop.json'),JSON.stringify(record));return record;
      } finally {if(!external)nativeCropPreparing=false;}
    })();
    cropJobs.set(captureId,job);
    try {return await job;}finally{if(cropJobs.get(captureId)===job)cropJobs.delete(captureId);}
  },
  async 'camera.image'({ png, captureId, cameraId, includePixels = true }) {
    const cap = captures.get(captureId);
    if (captureId && !cap) throw Error('Unknown capture');
    if(cap?.network){if(!includePixels)return {ok:true};return core.decodePng((await stripPng(cap.dir)).png);}
    let image = png;
    if (cap) {
      const source = cap.cameraSources.find(item => cameraId ? item.id === cameraId : item.png === png || item.id === scanSources.get(png)?.id);
      if (!source) throw Error('Camera source does not belong to this capture');
      image = path.join(cap.dir, 'views', `${source.id}.png`);
    } else if (!scanSources.has(png)) throw Error('Open this camera source first');
    return includePixels ? core.decodePng(await fsp.readFile(image)) : { ok: true };
  },
  async 'assets.open'({ dir, type = 'ttp' }) {
    return changeSource(async () => registerReplay(await readReplayFolder(dir, readMeet, type)));
  },
};

// Fallback watcher when the engine core is absent: fs.watch plus a 1 s poll (mapped network drives drop watch events).
function watchPlain(dir) {
  const seen = {};
  let timer = null;
  const check = async () => {
    const changed = [];
    for (const f of MEET_FILES) {
      try { const st = await fsp.stat(path.join(dir, f)); const k = st.mtimeMs + ':' + st.size; if (seen[f] && seen[f] !== k) changed.push(f); seen[f] = k; } catch { /* absent */ }
    }
    if (changed.length) emit('meet.changed', { dir, changed, ...(await readMeet(dir)) });
  };
  check();
  const poll = setInterval(check, 1000);
  let w = null;
  try { w = fs.watch(dir, () => { clearTimeout(timer); timer = setTimeout(check, 250); }); } catch { /* polling only */ }
  return { close() { clearInterval(poll); clearTimeout(timer); w?.close(); } };
}

port.on('message', async e => {
  const { id, method, params } = e.data || {};
  const fn = methods[method];
  if(portClosed)return;
  if (!fn) return port.postMessage({ id, error: `unknown method ${method}` });
  try {const result=await fn(params || {});if(!portClosed)port.postMessage({id,result});}
  catch (err) {if(!portClosed)port.postMessage({ id, error: err.message || String(err) });}
});

// ==================== SCOREBOARD V1 (engine-owned service) ====================
const scoreboardRoot = path.join(userData, 'scoreboards');
let scoreboardServer = null;
let scoreboardStarting = null;
let scoreboardLibraryReady = null;
const scoreboardAgents = new Set();

async function ensureScoreboardLibrary() {
  if (!core?.createScoreboardServer) throw new Error('scoreboard engine missing from this build');
  if (!scoreboardLibraryReady) {
    scoreboardLibraryReady = (async () => {
      const templates = await core.listTemplates(scoreboardRoot);
      if (!templates.some(template => template.name === 'classic')) {
        await core.createTemplate(scoreboardRoot, 'classic', { from: 'builtin:classic' });
      }
      await core.refreshBuiltinTemplate(scoreboardRoot,'classic');
    })().catch(err => { scoreboardLibraryReady = null; throw err; });
  }
  return scoreboardLibraryReady;
}

async function startScoreboard(port = 0) {
  if (scoreboardStarting) return scoreboardStarting;
  scoreboardStarting = (async () => {
    await ensureScoreboardLibrary();
    const server = core.createScoreboardServer({ root: scoreboardRoot, host: '0.0.0.0', port });
    try { await server.listen(); }
    catch (err) { await server.close(); throw err; }
    scoreboardServer = server;
    return server;
  })().catch(err => { scoreboardStarting = null; throw err; });
  return scoreboardStarting;
}

Object.assign(methods, {
  async 'scoreboard.start'({ port = 0 }) {
    const server = await startScoreboard(port);
    // addresses a TV or an OBS browser source on the same network can load
    const lanUrls = Object.values(os.networkInterfaces()).flat()
      .filter(a => a && a.family === 'IPv4' && !a.internal && !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))   // skip CGNAT/VPN overlay addresses
      .map(a => `http://${a.address}:${server.port}/scoreboard/`);
    return { url: server.url('classic'), port: server.port, lanUrls };
  },
  async 'scoreboard.publish'({ state }) {
    const published=(await startScoreboard()).publish(state);
    void wireScoreboards?.publish(state).catch(error=>emit('scoreboard.wire.error',{message:error.message}));
    return published;
  },
  async 'scoreboard.wire.configure'(params) { return wireScoreboards.configure(params); },
  async 'scoreboard.wire.connect'(params) { return wireScoreboards.connect(params); },
  async 'scoreboard.wire.reconnect'(params) { return wireScoreboards.reconnect(params); },
  async 'scoreboard.wire.list'() { return wireScoreboards.list(); },
  async 'scoreboard.wire.publish'({state,force=false}) { return wireScoreboards.publish(state,{force}); },
  async 'scoreboard.wire.clock'(params) { return wireScoreboards.setClock(params); },
  async 'scoreboard.wire.gun'(params) { return wireScoreboards.notifyGun(params); },
  async 'scoreboard.wire.close'(params) { return wireScoreboards.close(params); },
  async 'scoreboard.list'() {
    await ensureScoreboardLibrary();
    return core.listTemplates(scoreboardRoot);
  },
  async 'scoreboard.create'({ name, from }) {
    await ensureScoreboardLibrary();
    return core.createTemplate(scoreboardRoot, name, { from });
  },
  async 'scoreboard.delete'({ name }) {
    await ensureScoreboardLibrary();
    await core.deleteTemplate(scoreboardRoot, name);
    return core.listTemplates(scoreboardRoot);
  },
  async 'scoreboard.addAsset'({ name, path: source }) {
    await ensureScoreboardLibrary();
    return core.addAsset(scoreboardRoot, name, source);
  },
  async 'scoreboard.agent'({ name, request, preset = 'muse' }) {
    await ensureScoreboardLibrary();
    if (!Object.hasOwn(core.AGENT_PRESETS, preset)) throw new Error(`Unknown scoreboard agent preset: ${preset}`);
    const agent = { ...core.AGENT_PRESETS[preset] };
    // Apps launched from a desktop menu may not have ~/.local/bin on PATH (where Muse Code installs): fall back to it.
    const onPath = (process.env.PATH || '').split(path.delimiter).some(d => d && fs.existsSync(path.join(d, agent.command)));
    const local = path.join(os.homedir(), '.local', 'bin', agent.command);
    if (!onPath && process.platform !== 'win32' && fs.existsSync(local)) agent.command = local;
    const controller = new AbortController();
    scoreboardAgents.add(controller);
    try {
      return await core.runScoreboardAgent({
        root: scoreboardRoot, name, request, agent, signal: controller.signal,
        onOutput: output => emit('scoreboard.agentOutput', { name, ...output }),
      });
    } finally { scoreboardAgents.delete(controller); }
  },
  async 'scoreboard.restore'({ name, snapshotId }) {
    await ensureScoreboardLibrary();
    return core.restore(scoreboardRoot, name, snapshotId);
  },
});

async function closeScoreboards() {
  for (const controller of scoreboardAgents) controller.abort();
  try { await scoreboardStarting; } catch { /* startup already reported its error */ }
  await scoreboardServer?.close();
}
function stopOwnedCapture() {
  portClosed = true;
  captureStartStop = true;
  if (active) { active.stop = true; active.controller.abort(); }
}
let closingServices = null;
function closeOwnedServices() {
  return closingServices ||= (async()=>{
    stopOwnedCapture();
    for(const controller of cropRequests)controller.abort();
    for(const child of cropProcesses)child.kill();
    const ownedWatcher=watcher;watcher=null;
    const closeWatcher=async()=>{if(typeof ownedWatcher==='function')await ownedWatcher();else await ownedWatcher?.close();};
    await Promise.allSettled([closeWatcher(),closeScoreboards(),closeFinishService(),hardware?.closeAll(),networkCameras?.closeAll(),wireScoreboards?.closeAll(),remoteServers?.closeAll()]);
  })();
}
port.on('close', () => {closeOwnedServices().catch(()=>{});});
process.once('disconnect', () => {closeOwnedServices().catch(()=>{});});
process.once('exit', () => {
  for (const controller of scoreboardAgents) controller.abort();
  for (const controller of cropRequests) controller.abort();
  for (const child of cropProcesses) child.kill();
});
// ========================== END SCOREBOARD V1 ================================

// ==================== BILLBOARD (separate display artwork library) ============
await (await import('./billboard-host.mjs')).registerBillboards({
  methods,userData,emit,port,enginePath:locate('engine/billboard/index.js'),
});
emit('engine.ready', { core: !!core });
