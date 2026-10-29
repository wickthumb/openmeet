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

const here = path.dirname(fileURLToPath(import.meta.url));
const userData = process.argv[2] || here;
const port = process.parentPort;
const emit = (event, data) => port.postMessage({ event, data });

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

// One camera capture at a time: the simulated camera streams protocol messages into an append-only store,
// and every chunk is forwarded to the console as it lands. The store, not the console, is the record.
let active = null;
let captureStarting = false, captureStartStop = false, sourceChanging = false;
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
const scanSources = new Map();

// Auto-timing: the configured TTP finish service, or the labelled stand-in (simulator truth echo) on loopback.
const locate = rel => [path.join(here, '..', rel), path.join(here, rel)].find(p => fs.existsSync(p));
let finish = null;
async function finishService() {
  if (finish) return finish;
  const at = (await loadSettings()).autotiming || {};
  const clientPath = locate('engine/autotiming/client.js');
  if (!clientPath) throw new Error('auto-timing client missing from this build');
  const { createFinishClient } = await import(pathToFileURL(clientPath).href);
  const timeoutMs = at.timeoutMs || 300000;  // the real model's full stack has taken ~200 s per heat on CPU; the console stays usable meanwhile
  if (at.baseUrl) return (finish = { client: createFinishClient({ baseUrl: at.baseUrl, apiKey: at.apiKey, timeoutMs }), stub: false, model: null });
  const stubPath = locate('services/finish-api-stub/server.js');
  if (!stubPath) throw new Error('no auto-timing service configured');
  const { createStubServer } = await import(pathToFileURL(stubPath).href);
  const server = createStubServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return (finish = { client: createFinishClient({ baseUrl, timeoutMs }), stub: true, baseUrl });
}

// The captured strip as a native-orientation PNG, read back from the capture store (the record, not the console's copy).
// Columns [from, to] of the captured strip (to defaults to the latest), so a capture still being recorded can be read too.
async function stripPng(dir, from = 0, to = null, laneGuides = null) {
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
      rows, columns: n, channels: ch, from: a, firstRaceTime: store.raceTimeOf(a), period: meta.columnPeriod,
    };
  } finally { await store.close(); }
}

const settingsPath = path.join(userData, 'openmeet-settings.json');
async function loadSettings() { try { return JSON.parse(await fsp.readFile(settingsPath, 'utf8')); } catch { return {}; } }
let settingsWrite = Promise.resolve();
function saveSettings(patch) {
  const write = settingsWrite.then(async () => {
    const s = { ...(await loadSettings()), ...patch };
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
  for (const heat of replay.heats) for (const source of heat.lineScans) scanSources.set(source.png, source);
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

async function cropperRequest(payload) {
  const settings=await loadSettings(),url=settings.cropServiceUrl||process.env.OPENMEET_CROP_URL;
  if(url){const health=payload.operation==='health',response=await fetch(new URL(health?'/health':'/v1/column-ranges',url),{method:health?'GET':'POST',...(!health?{headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}:{}),signal:AbortSignal.timeout(health?3000:120000)});const result=await response.json();if(!response.ok)throw Error(result.error||'Auto-cropper request failed');return result;}
  const command=JSON.parse(process.env.OPENMEET_CROP_COMMAND||'null');
  if(!Array.isArray(command)||!command.length||command.some(a=>typeof a!=='string'))throw Error('Configure a private auto-cropper worker first');
  return new Promise((resolve,reject)=>{
    const child=execFile(command[0],command.slice(1),{timeout:120000,maxBuffer:64*1024*1024,windowsHide:true},(error,stdout)=>{
      try{const result=JSON.parse(stdout);if(error||result.error)reject(Error(result.error||'Private cropper worker failed'));else resolve(result);}catch{reject(Error(error?.message||'Invalid private cropper response'));}
    });child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(payload));
  });
}

const methods = {
  async ping() { return { ok: true, pid: process.pid, core: !!core, node: process.versions.node }; },
  async 'settings.get'() { return loadSettings(); },
  async 'settings.set'({ patch }) {
    if ((active || captureStarting || sourceChanging) && ['simulationSources', 'simulationSourceId', 'demoDir', 'meetDir'].some(k => k in patch)) throw Error('Stop capture or preview before changing simulation sources');
    return saveSettings(patch);
  },
  async 'demo.catalog'() { return simulationCatalog(await loadSettings()); },
  async 'demo.import'({ dir, type = 'ttp', name }) {
    return changeSource(async () => {
      if (!dir || !SOURCE_TYPES.has(type)) throw Error('Choose a TTP simulator or real meet replay folder');
      const replay = await readReplayFolder(dir, readMeet, type);
      const catalog = simulationCatalog(await loadSettings());
      const source = { id: catalog.sources.find(s => s.path === replay.dir)?.id || sourceId(replay.dir), type:replay.type, name: String(name || replay.name), path: replay.dir };
      const sources=catalog.sources.filter(s=>s.type!=='builtin'),index=sources.findIndex(s=>s.id===source.id);
      if(index<0)sources.push(source);else sources[index]=source;
      await saveSettings({ simulationSources: sources });
      return source;
    });
  },
  async 'demo.load'({ id = null, dir = null, type = 'ttp' } = {}) {
    return changeSource(async () => {
      const settings = await loadSettings(), catalog = simulationCatalog(settings);
      const source = id ? catalog.sources.find(s => s.id === id) : dir ? catalog.sources.find(s=>s.path===path.resolve(dir)) || { id: sourceId(dir), type, name: path.basename(dir), path: path.resolve(dir) } : catalog.sources.find(s => s.id === catalog.selectedId);
      if (!source || (source.type !== 'builtin' && !SOURCE_TYPES.has(source.type))) throw Error('Unknown simulation source');
      // Fully validate before replacing the meet watcher or the saved selection.
      const replay = source.type === 'builtin' ? null : await readReplayFolder(source.path, readMeet, source.type);
      if(replay){if(!id||source.type!==replay.type)source.name=replay.name;source.type=replay.type;}
      if (typeof watcher === 'function') await watcher(); else if (watcher) await watcher.close();
      watcher = null;
      if (replay) watcher = core?.watchMeetFolder
        ? core.watchMeetFolder(replay.meet.dir, async change => emit('meet.changed', { dir: replay.meet.dir, ...change, files: (await readMeet(replay.meet.dir)).files }))
        : watchPlain(replay.meet.dir);
      const sources=catalog.sources.filter(s=>s.type!=='builtin'),index=sources.findIndex(s=>s.id===source.id);
      if(replay){if(index<0)sources.push(source);else sources[index]=source;}
      await saveSettings({ simulationSources: sources, simulationSourceId: source.id, demoDir: source.path, meetDir: replay?.meet.dir || null });
      return { source, ...(replay ? registerReplay(replay) : { heats: [], meet: null }) };
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
    if (typeof watcher==='function')await watcher();else if(watcher)await watcher.close();
    watcher = core?.watchMeetFolder
      ? core.watchMeetFolder(dir, async change => emit('meet.changed', { dir, ...change, files: (await readMeet(dir)).files }))
      : watchPlain(dir);
    return meet;
  },
  // Build and write one heat's results with the engine core: {dir, heat: LifHeat, results: LifResult[]}.
  async 'lif.save'({ dir, heat, results, captureId, review }) {
    if (!core) throw new Error('engine core missing from this build');
    if (!dir) throw new Error('no meet folder open');
    const name = core.lifName(heat.event, heat.round, heat.heat);
    const text = core.buildLif(heat, results);
    if(captureId && captures.has(captureId)) await core.writeLifAtomic(captures.get(captureId).dir,name,text);
    if(captureId&&review&&captures.has(captureId))await fsp.writeFile(path.join(captures.get(captureId).dir,'review.json'),JSON.stringify(review,null,2));
    const p = await core.writeLifAtomic(dir, name, text);
    return { path: p, name, text };
  },
  // Start the simulated camera on a rendered line-scan: {key, png, sidecar, speed, meetDir}.
  // Captures live in <meet folder>/openmeet/captures/, beside the meet manager's files and never mixed into them.
  async 'capture.start'({ key, png, sidecar, speed = 1, meetDir, front, timeoutSeconds = null, preview = false, cameraId, cameraLabel }) {
    if (!core) throw new Error('engine core missing from this build');
    if (active || captureStarting || sourceChanging) throw new Error('a capture or source change is already running');
    captureStarting = true;captureStartStop=false;
    try {
    const source = scanSources.get(png);
    sidecar = source?.sidecar ? JSON.parse(await fsp.readFile(source.sidecar,'utf8')) : sidecar;
    const replaySidecar=preview?{...(typeof sidecar==='string'?JSON.parse(await fsp.readFile(sidecar,'utf8')):sidecar),first_column_race_time_s:0}:sidecar;
    const id = `${String(key || 'heat').replace(/[^\w-]/g, '_')}-${Date.now()}`;
    const dir = preview ? null : path.join(meetDir ? path.join(meetDir, 'openmeet', 'captures') : path.join(userData, 'captures'), id);
    if(dir) await fsp.mkdir(dir, { recursive: true });
    if(dir)await fsp.writeFile(path.join(dir,'source.json'),JSON.stringify({cameraId:cameraId||'sim-camera',label:cameraLabel||'Simulated line-scan',source:source?.sourceType==='real'?'real-recorded':'sim-replay',image:png},null,2));
    if (!meetDir && dir) emit('roots.add', [dir]);
    // The front camera's recording belongs to the heat, beside its line-scan: <capture>/front.mp4 + front.json (frame timing).
    let frontRec = null;
    if (front && front.path && !preview) {
      const vp = path.join(dir, 'front' + path.extname(front.path));
      await fsp.copyFile(front.path, vp);
      await fsp.writeFile(path.join(dir, 'front.json'), JSON.stringify({ ...(front.meta || {}), heat: key }, null, 2));
      frontRec = { path: vp, meta: front.meta || null, frames: front.frames || null };
    }
    let previewColumns=0;
    const store = preview ? { append(msg){if(msg.type==='columns')previewColumns+=msg.count;},columnCount(){return previewColumns;},async close(){} } : core.openCaptureStore(dir);
    const pulseMs = Date.now();
    const trigger = meetDir && !preview ? (await startJournal(meetDir)).record({ clockId: 'simulated-meet-clock', timeS: pulseMs / 1000, wallTimeMs: pulseMs, source: 'Simulated camera start', captureId: id }) : null;
    if (trigger) (await startJournal(meetDir)).assign({ heatKey: key, triggerId: trigger.id, referenceTriggerId: trigger.id });
    if(!preview) captures.set(id, { dir, sidecar, trigger, cameraId, sourceType:source?.sourceType,sourceColumns:source?.size.width,sourceRef:source?{kind:'recorded-results',label:'Recorded results',path:source.sidecar}:null });
    const controller = new AbortController();
    active = { id, stop: captureStartStop, controller, preview };
    if(captureStartStop)controller.abort();
    if(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) active.timer=setTimeout(()=>{ if(active?.id===id) controller.abort(); },timeoutSeconds/speed*1000);
    // The camera runs from the gun (race time 0), like a real line-scan, not just around the finish.
    active.done=runCapture(id, store, core.simReplay({ png, sidecar:replaySidecar, realtime:true, speed, model:source?.sourceType==='real'?'real-recorded-replay':preview?'sim-preview':'sim-render', preRollFrom:preview?undefined:0, holdOpen:true, signal:controller.signal }),preview);
    return { id, dir, front: frontRec, trigger };
    } finally { captureStarting = false; }
  },
  async 'preview.start'(params) {return methods['capture.start']({...params,key:'camera-setup',preview:true,timeoutSeconds:null});},
  async 'preview.stop'() {
    const current=active;if(current?.preview){current.stop=true;current.controller.abort();await current.done;}
    return {ok:true};
  },
  async 'capture.stop'() { if(captureStarting)captureStartStop=true;if (active) { active.stop = true; active.controller.abort(); } return { ok: true }; },
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
      timebase: { first_column_race_time_s: strip.firstRaceTime, column_period_s: strip.period },
      start_list: startList,
      // lane_rows may only name lanes on the start list (contract v1)
      ...(laneRows && laneRows.length ? { lane_rows: laneRows.filter(b => startList.some(s => s.lane === b.lane)) } : {}),
    });
    return { ...res, stub: svc.stub, fromCol: strip.from, inputDerived };
  },
  async 'lif.write'({ dir, name, text }) {
    if (!dir || !/^[\w-]+\.lif$/i.test(name)) throw new Error('bad results file name');
    const p = await writeAtomic(dir, name, text);
    return { path: p, bytes: Buffer.byteLength(text, 'latin1') };
  },
  async 'autocrop.info'() {
    const settings=await loadSettings(),configured=!!(settings.cropServiceUrl||process.env.OPENMEET_CROP_URL||process.env.OPENMEET_CROP_COMMAND);
    if(!configured)return {configured:false};
    try{const info=await cropperRequest({operation:'health'});return {configured:true,ready:info.ready===true,contract:info.contract};}catch{return {configured:true,ready:false};}
  },
  async 'occlusion.info'() { return occlusionInfo(); },
  async 'occlusion.predict'({captureId,viewPng=null}) {
    const cap=captures.get(captureId);if(!cap)throw Error('No captured image is available');
    if(active?.id===captureId)throw Error('Stop capture before requesting the model mask');
    let png,width,height,camera=cap.cameraId||'primary';
    const checkSize=()=>{if(width>32768||height>32768||width*height>16*1024*1024)throw Error('This capture exceeds the model preview size limit; Simple remains available');};
    if(viewPng){const source=scanSources.get(viewPng);if(!source)throw Error('Open this camera source first');width=source.size.width;height=source.size.height;checkSize();png=await fsp.readFile(source.png);camera=source.id;}
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
    const strip=await stripPng(cap.dir),digest=createHash('sha256').update(strip.png).digest('hex'),requestId=randomUUID();
    const output=await cropperRequest({request_id:requestId,image_sha256:digest,image:{encoding:'png',data_base64:strip.png.toString('base64')},mode:'both'});
    if(output.image_sha256!==digest||output.request_id!==requestId)throw Error('Cropper returned a different image');
    validateCropResult(output.result,strip.columns,'storage-display');validateCropResult(output.result,strip.columns,'inference-safe');
    const record={...output,first_column_race_time_s:strip.firstRaceTime,column_period_s:strip.period,at:new Date().toISOString()};
    await fsp.writeFile(path.join(cap.dir,'autocrop.json'),JSON.stringify(record));return record;
  },
  async 'camera.image'({png,captureId,includePixels=true}) {
    const source=scanSources.get(png);if(!source)throw new Error('Open this camera source first');
    const cap=captures.get(captureId);
    if(cap){const dir=path.join(cap.dir,'views');await fsp.mkdir(dir,{recursive:true});await fsp.copyFile(png,path.join(dir,source.id+'.png'));await fsp.writeFile(path.join(dir,source.id+'.json'),JSON.stringify({id:source.id,label:source.label,column_period_s:source.meta.column_period_s,first_column_race_time_s:source.meta.first_column_race_time_s,lane_rows:source.meta.lane_rows},null,2));}
    return includePixels?core.decodePng(await fsp.readFile(png)):{ok:true};
  },
  async 'assets.open'({ dir, type = 'ttp' }) {
    return registerReplay(await readReplayFolder(dir, readMeet, type));
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
  if (!fn) return port.postMessage({ id, error: `unknown method ${method}` });
  try { port.postMessage({ id, result: await fn(params || {}) }); }
  catch (err) { port.postMessage({ id, error: err.message || String(err) }); }
});
emit('engine.ready', { core: !!core });

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
  async 'scoreboard.publish'({ state }) { return (await startScoreboard()).publish(state); },
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
port.on('close', () => { closeScoreboards().catch(() => {}); });
process.once('disconnect', () => { closeScoreboards().catch(() => {}); });
process.once('exit', () => { for (const controller of scoreboardAgents) controller.abort(); });
// ========================== END SCOREBOARD V1 ================================
