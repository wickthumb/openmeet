// OpenMeet engine host: runs in an Electron utility process (plain Node, no window).
// It owns every file the meet depends on: the meet manager's shared folder and the results written back.
// Messages: {id, method, params} in; {id, result} | {id, error} out; {event, data} for pushes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
      heats.push({
        name, dir: hd,
        primary: files.includes('primary.png') ? path.join(hd, 'primary.png') : null, primaryMeta: await json('primary.json'),
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
