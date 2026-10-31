// Local replay catalog. Paths stay in user settings; recordings are never bundled.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SOURCE_TYPES = new Set(['ttp', 'real']);

export function simulationCatalog(settings = {}) {
  const sources = [];
  for (const s of Array.isArray(settings.simulationSources) ? settings.simulationSources : []) {
    if (!s || !SOURCE_TYPES.has(s.type) || typeof s.path !== 'string' || !path.isAbsolute(s.path)) continue;
    const dir = path.resolve(s.path);
    if (sources.some(x => x.path === dir)) continue;
    const id = typeof s.id === 'string' && s.id && s.id !== 'builtin' ? s.id : sourceId(dir);
    if (sources.some(x => x.id === id)) continue;
    sources.push({ id, type: s.type, name: s.type==='ttp'?'OpenMeet demo':String(s.name || path.basename(dir)), path: dir });
  }
  // Keep existing demoDir setups working, including their next app launch.
  if (typeof settings.demoDir === 'string' && settings.demoDir && !sources.some(s => s.path === path.resolve(settings.demoDir))) {
    const dir = path.resolve(settings.demoDir);
    sources.push({ id: sourceId(dir), type: 'ttp', name: 'OpenMeet demo', path: dir });
  }
  const selected = sources.find(s => s.id === settings.simulationSourceId)
    || (!settings.simulationSourceId && typeof settings.demoDir==='string' && sources.find(s => s.path === path.resolve(settings.demoDir))) || sources.find(s=>s.type==='ttp') || sources[0];
  return { sources, selectedId: selected?.id || null };
}

export const sourceId = dir => 'folder-' + createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16);

// Optional manifest paths are relative to the imported folder, never another disk location.
function inside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw Error('Replay paths must be relative to the imported folder');
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(root + path.sep)) throw Error('Replay path leaves the imported folder');
  return file;
}

async function optionalJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function timingMeta(meta, file) {
  if (!meta || !Number.isFinite(meta.column_period_s) || meta.column_period_s <= 0 || !Number.isFinite(meta.first_column_race_time_s)) {
    throw Error(`${file} needs column_period_s > 0 and a finite first_column_race_time_s`);
  }
  // Simulator evaluation answers never cross into the operator UI.
  const { truth, ...publicMeta } = meta;
  return publicMeta;
}

async function pngSize(file) {
  const handle = await fs.open(file, 'r');
  try {
    const b = Buffer.alloc(24), { bytesRead } = await handle.read(b, 0, 24, 0);
    if (bytesRead !== 24 || b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || b.toString('ascii', 12, 16) !== 'IHDR') throw Error(`Invalid PNG: ${file}`);
    const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
    if (!width || !height) throw Error(`Empty PNG: ${file}`);
    return { width, height };
  } finally { await handle.close(); }
}

// Same meet/ + heat-N/ layout as assets.open; a manifest can bind images to exact EVT keys.
export async function readReplayFolder(dir, readMeet, type = 'ttp') {
  dir = path.resolve(dir);
  const manifest = await optionalJson(path.join(dir, 'openmeet-replay.json'));
  if (manifest && manifest.version !== 1) throw Error('Unsupported openmeet-replay.json version');
  if (manifest?.type === 'real-replay') type = 'real';
  else if (manifest?.type === 'ttp-simulator') type = 'ttp';
  const meet = await readMeet(inside(dir, manifest?.meet || 'meet'));
  const events = meet.parsed?.events.filter(e => e.entries.some(x => x.lane)) || [];
  if (!events.length) throw Error('Replay folder needs meet/lynx.evt with laned start lists');
  const folders = manifest?.heats || (await fs.readdir(dir)).filter(n => /^heat-\d+$/.test(n))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map(folder => ({ folder }));
  if (!Array.isArray(folders) || !folders.length) throw Error('Replay folder needs heat-N folders with line-scan PNGs and JSON sidecars');
  const heats = [], keys = new Set();
  for (const entry of folders) {
    const hd = inside(dir, entry.folder), files = await fs.readdir(hd), lineScans = [];
    for (const f of files.filter(f => /^(primary|backup|scan-[\w-]+)\.png$/.test(f)).sort((a, b) =>
      (a === 'primary.png' ? -1 : b === 'primary.png' ? 1 : a === 'backup.png' ? -1 : b === 'backup.png' ? 1 : a.localeCompare(b)))) {
      const id = f.slice(0, -4), sidecar = path.join(hd, id + '.json');
      const rawMeta=await optionalJson(sidecar),meta = timingMeta(rawMeta, sidecar), png = path.join(hd, f);
      lineScans.push({ id, label: meta.camera_name || (id === 'primary' ? (type === 'real' ? 'Recorded line-scan' : 'Line-scan A') : id === 'backup' ? 'Line-scan B' : id.replace(/^scan-/, 'Line-scan ')), png, meta, size: await pngSize(png), sidecar, sourceType: type, referenceTiming: Array.isArray(rawMeta.truth)&&rawMeta.truth.length>0 });
    }
    if (!lineScans.length) throw Error(`${entry.folder} has no line-scan PNG / JSON pair`);
    // Positional legacy folders follow EVT file order, not a separately reordered schedule.
    const explicit = ['event', 'round', 'heat'].some(k => entry[k] != null);
    const event = explicit ? events.find(e => ['event', 'round', 'heat'].every(k => String(e[k]) === String(entry[k]))) : events[heats.length];
    if (!event) throw Error(`${entry.folder} does not match a laned EVT heat`);
    const key = `${event.event}|${event.round}|${event.heat}`;
    if (keys.has(key)) throw Error(`Duplicate replay heat ${key}`);
    keys.add(key);
    const primary = lineScans[0], backup = lineScans.find(s => s.id !== primary.id);
    const front = files.includes('front.mp4') ? path.join(hd, 'front.mp4') : null;
    let frontFrames = null;
    if (front && files.includes('front')) {
      const names = (await fs.readdir(path.join(hd, 'front'))).filter(n => /^\d{4,}\.png$/.test(n)).sort();
      if (names.length && names.every((n, i) => Number.parseInt(n, 10) === i)) frontFrames = names.map(n => path.join(hd, 'front', n));
    }
    heats.push({ name: entry.folder, dir: hd, event: event.event, round: event.round, heat: event.heat, sourceType: type,
      lineScans, primary: primary.png, primaryMeta: primary.meta, primarySize: primary.size,
      backup: backup?.png || null, backupMeta: backup?.meta || null,
      front, frontMeta: front ? await optionalJson(path.join(hd, 'front.json')) : null, frontFrames });
  }
  return { dir, type, name: manifest?.name || path.basename(dir), heats, meet };
}

export function publicReplay(replay) {
  return { ...replay, heats: replay.heats.map(h => ({ ...h, lineScans: h.lineScans.map(({ sidecar, ...s }) => s) })) };
}

// Recorded references are an exact practice answer source, separate from the QA
// HTTP stub. image_column is zero-based in primary.png, before replay pre-roll;
// source_column is optional full-stitch provenance, never a collapsed time axis.
export function recordedResults({ sidecar, firstRaceTime, period, columns, startList, sourceColumns }) {
  const lanes=new Set(startList.map(s=>s.lane)),seen=new Set(),predictions=[];
  for(const point of sidecar.truth || []) {
    if(!Number.isSafeInteger(point?.lane)||point.lane<=0||seen.has(point.lane)||!Number.isFinite(point.time_s))throw Error('Invalid recorded reference points');
    seen.add(point.lane);
    if(point.image_column!=null&&(!Number.isSafeInteger(point.image_column)||point.image_column<0||point.image_column>=sourceColumns))throw Error('Recorded reference column is outside its source image');
    if(!lanes.has(point.lane))continue;
    const time=point.image_column==null?point.time_s:sidecar.first_column_race_time_s+(point.image_column+.5)*sidecar.column_period_s;
    const column=Math.round((time-firstRaceTime)/period-.5);
    if(column<0||column>=columns)continue; // live replay reveals only columns already captured
    predictions.push({lane:point.lane,column,race_time_s:firstRaceTime+(column+.5)*period,
      decision:'auto',reason:'recorded_result',reference_time_s:point.time_s,
      ...(point.image_column==null?{}:{image_column:point.image_column}),
      ...(point.source_column==null?{}:{source_column:point.source_column}),
      ...(Number.isFinite(point.official_seconds)?{official_seconds:point.official_seconds}:{})});
  }
  return predictions;
}
