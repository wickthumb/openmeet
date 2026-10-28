// OpenMeet engine host: runs in an Electron utility process (plain Node, no window).
// It owns every file the meet depends on: the meet manager's shared folder and the results written back.
// Messages: {id, method, params} in; {id, result} | {id, error} out; {event, data} for pushes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

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

// PNG width/height from the IHDR chunk, without decoding the image.
async function pngSize(p) {
  const fh = await fsp.open(p, 'r');
  try { const b = Buffer.alloc(24); await fh.read(b, 0, 24, 0); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; } finally { await fh.close(); }
}

// One camera capture at a time: the simulated camera streams protocol messages into an append-only store,
// and every chunk is forwarded to the console as it lands. The store, not the console, is the record.
let active = null;
async function runCapture(id, store, gen) {
  try {
    for await (const msg of gen) {
      if (!active || active.id !== id || active.stop) break;
      store.append(msg);
      if (msg.type === 'hello') emit('capture.hello', { id, rows: msg.rows, channels: msg.channels, columnPeriod: msg.columnPeriod, model: msg.model });
      else if (msg.type === 'start_pulse') emit('capture.pulse', { id, hwTime: msg.hwTime });
      else if (msg.type === 'columns') emit('capture.columns', { id, first: store.columnCount() - msg.count, count: msg.count, period: msg.period, data: msg.data });
      else if (msg.type === 'end') emit('capture.end', { id, columns: store.columnCount() });
    }
  } catch (err) {
    emit('capture.error', { id, message: err.message || String(err) });
  } finally {
    try { await store.close(); } catch { /* already closed */ }
    if (active && active.id === id) active = null;
  }
}

// Capture id -> {dir, sidecar}. The simulator's truth stays here in the engine: the console never receives it.
const captures = new Map();

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
async function stripPng(dir, from = 0, to = null) {
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
      png: core.encodePng({ width: n, height: rows, channels: ch, data: rm }, { filter: () => 1 }),
      rows, columns: n, channels: ch, from: a, firstRaceTime: store.raceTimeOf(a), period: meta.columnPeriod,
    };
  } finally { await store.close(); }
}

const settingsPath = path.join(userData, 'openmeet-settings.json');
async function loadSettings() { try { return JSON.parse(await fsp.readFile(settingsPath, 'utf8')); } catch { return {}; } }

const methods = {
  async ping() { return { ok: true, pid: process.pid, core: !!core, node: process.versions.node }; },
  async 'settings.get'() { return loadSettings(); },
  async 'settings.set'({ patch }) {
    const s = { ...(await loadSettings()), ...patch };
    await fsp.mkdir(userData, { recursive: true });
    await fsp.writeFile(settingsPath, JSON.stringify(s, null, 2));
    return s;
  },
  async 'meet.open'({ dir }) {
    if (!dir) throw new Error('no folder given');
    emit('roots.add', [dir]);
    const meet = await readMeet(dir);
    if (watcher) watcher.close();
    watcher = core?.watchMeetFolder
      ? core.watchMeetFolder(dir, async change => emit('meet.changed', { dir, ...change, files: (await readMeet(dir)).files }))
      : watchPlain(dir);
    return meet;
  },
  // Build and write one heat's results with the engine core: {dir, heat: LifHeat, results: LifResult[]}.
  async 'lif.save'({ dir, heat, results }) {
    if (!core) throw new Error('engine core missing from this build');
    if (!dir) throw new Error('no meet folder open');
    const name = core.lifName(heat.event, heat.round, heat.heat);
    const text = core.buildLif(heat, results);
    const p = await core.writeLifAtomic(dir, name, text);
    return { path: p, name, text };
  },
  // Start the simulated camera on a rendered line-scan: {key, png, sidecar, speed, meetDir}.
  // Captures live in <meet folder>/openmeet/captures/, beside the meet manager's files and never mixed into them.
  async 'capture.start'({ key, png, sidecar, speed = 1, meetDir, front }) {
    if (!core) throw new Error('engine core missing from this build');
    if (active) throw new Error('a capture is already running');
    const id = `${String(key || 'heat').replace(/[^\w-]/g, '_')}-${Date.now()}`;
    const dir = path.join(meetDir ? path.join(meetDir, 'openmeet', 'captures') : path.join(userData, 'captures'), id);
    await fsp.mkdir(dir, { recursive: true });
    if (!meetDir) emit('roots.add', [dir]);
    // The front camera's recording belongs to the heat, beside its line-scan: <capture>/front.mp4 + front.json (frame timing).
    let frontRec = null;
    if (front && front.path) {
      const vp = path.join(dir, 'front' + path.extname(front.path));
      await fsp.copyFile(front.path, vp);
      await fsp.writeFile(path.join(dir, 'front.json'), JSON.stringify({ ...(front.meta || {}), heat: key }, null, 2));
      frontRec = { path: vp, meta: front.meta || null };
    }
    const store = core.openCaptureStore(dir);
    captures.set(id, { dir, sidecar });
    active = { id, stop: false };
    // The camera runs from the gun (race time 0), like a real line-scan, not just around the finish.
    runCapture(id, store, core.simReplay({ png, sidecar, realtime: true, speed, model: 'sim-render', preRollFrom: 0 }));
    return { id, dir, front: frontRec };
  },
  async 'capture.stop'() { if (active) active.stop = true; return { ok: true }; },
  // Ask the finish model about a finished capture: {captureId, heat: {event, round, heat}, startList: [{lane, id}], laneRows?}.
  // Live mode for services fast enough to call during the race (the stand-in, or a service configured with live: true).
  async 'autotiming.info'() {
    const at = (await loadSettings()).autotiming || {};
    return { stub: !at.baseUrl && !at.cli, live: (!at.baseUrl && !at.cli) || !!at.live };
  },
  // {captureId, heat, startList, laneRows?, fromCol?, toCol?}: columns in the reply are relative to `fromCol` (returned).
  async 'autotiming.predict'({ captureId, heat, startList, laneRows, fromCol = 0, toCol = null }) {
    const cap = captures.get(captureId);
    if (!cap) throw new Error('unknown capture');
    const strip = await stripPng(cap.dir, fromCol, toCol);
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
    const res = await svc.client.predict({
      request_id: randomUUID(),
      heat: { event: String(heat.event), round: heat.round, heat: heat.heat, race_type: 'laned_sprint' },
      strip: { encoding: 'png', data_base64: strip.png.toString('base64'), rows: strip.rows, columns: strip.columns, channels: strip.channels, orientation: 'native' },
      timebase: { first_column_race_time_s: strip.firstRaceTime, column_period_s: strip.period },
      start_list: startList,
      // lane_rows may only name lanes on the start list (contract v1)
      ...(laneRows && laneRows.length ? { lane_rows: laneRows.filter(b => startList.some(s => s.lane === b.lane)) } : {}),
    });
    return { ...res, stub: svc.stub, fromCol: strip.from };
  },
  async 'lif.write'({ dir, name, text }) {
    if (!dir || !/^[\w-]+\.lif$/i.test(name)) throw new Error('bad results file name');
    const p = await writeAtomic(dir, name, text);
    return { path: p, bytes: Buffer.byteLength(text, 'latin1') };
  },
  async 'assets.open'({ dir }) {
    // A rendered demo meet: meet/ (lynx.*) plus heat-<n>/ (primary.png/json, backup.png/json, front.mp4/json).
    emit('roots.add', [dir]);
    const heats = [];
    for (const name of (await fsp.readdir(dir)).filter(n => /^heat-\d+$/.test(n)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)))) {
      const hd = path.join(dir, name), files = await fsp.readdir(hd);
      const json = async f => (files.includes(f) ? JSON.parse(await fsp.readFile(path.join(hd, f), 'utf8')) : null);
      const primary = files.includes('primary.png') ? path.join(hd, 'primary.png') : null;
      heats.push({
        name, dir: hd,
        primary, primarySize: primary ? await pngSize(primary) : null, primaryMeta: await json('primary.json'),
        backup: files.includes('backup.png') ? path.join(hd, 'backup.png') : null, backupMeta: await json('backup.json'),
        front: files.includes('front.mp4') ? path.join(hd, 'front.mp4') : null, frontMeta: await json('front.json'),
      });
    }
    const meetDir = path.join(dir, 'meet');
    return { dir, heats, meet: fs.existsSync(meetDir) ? await readMeet(meetDir) : null };
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
