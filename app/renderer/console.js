import { scanBoundaries, movedBoundaryRow, scanBackground, writeForegroundMask, foregroundInRows } from './scan-overlays.mjs';
import { FrontFrameCache, linkedCameraRange, cameraAsset, cameraLaneBody, containedImageRect } from './front-preview.mjs';
import { SCAN_TOOLS, toolbarPreferences, moveToolbarTool } from './scan-toolbar.mjs';
import { validateCropResult, columnProjection, displayCoordinate, originalCoordinate, visibleColumnPieces } from './column-map.mjs';
import { FrontOverlayOcclusion } from './front-occlusion.mjs';
import { scanMaskPreferences, modelMaskStatus, OcclusionAvailability } from './occlusion-state.mjs';
import { LiveFollow } from './live-follow.mjs';
import { sourceLabel, sourceChoices, replayCameras, replayHeatKey, replayReferenceTiming, replayStartList } from './replay-sources.mjs';

(() => {
'use strict';

// ---------------------------------------------------------------- constants
const P = 0.00125;          // seconds per line-scan column (800 lines/s)
const IMG_H = 480;          // rows per column
const RULER = 22;           // px time ruler under the line-scan
const SPEED = Math.min(10, Math.max(0.25, +new URLSearchParams(location.search).get('speed') || 1));
const $ = s => document.querySelector(s);
const h_ = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const pad = (n, w) => String(n).padStart(w, '0');
const ceilTo = (t, d) => Math.ceil(t * 10 ** d - 1e-7) / 10 ** d;
const fmtT = (t, d = 3) => {
  const v = ceilTo(t, d);
  if (v < 60) return v.toFixed(d);
  const m = Math.floor(v / 60);
  return m + ':' + pad((v - m * 60).toFixed(d), d + 3);
};
const official = t => fmtT(t, 2);
const store = {
  get(k, d) { try { const v = localStorage.getItem('openmeet.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('openmeet.' + k, JSON.stringify(v)); } catch { /* storage unavailable: keep in memory */ } },
};
const svg = d => `<svg class="i" viewBox="0 0 12 12">${d}</svg>`;
const ICON = {
  prev: svg('<path d="M7.5 2.5 4 6l3.5 3.5"/>'),
  next: svg('<path d="M4.5 2.5 8 6 4.5 9.5"/>'),
  warn: '<svg class="i" viewBox="0 0 14 14"><path d="M7 1.8 12.6 12H1.4z"/><path d="M7 5.6v3.2M7 10.4v.2"/></svg>',
  ok: '<svg class="i" viewBox="0 0 14 14"><path d="M2.5 7.5 5.6 10.4 11.5 3.8"/></svg>',
  info: '<svg class="i" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.6"/><path d="M7 6.2v4M7 3.9v.2"/></svg>',
  close: svg('<path d="M3 3l6 6M9 3 3 9"/>'),
  zoom: svg('<path d="M3 1v8h8M1 3h8v8"/>'),
  fit: svg('<path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8"/>'),
  flip: svg('<path d="M6 1v10M4 3.5 1.5 6 4 8.5M8 3.5 10.5 6 8 8.5"/>'),
  lanes: svg('<path d="M1 3h10M1 6h10M1 9h10"/>'),
  auto: svg('<circle cx="6" cy="6" r="2.2"/><path d="M6 1v2M6 9v2M1 6h2M9 6h2"/>'),
  clear: svg('<path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/>'),
  revert: svg('<path d="M2.8 5A3.8 3.8 0 1 1 2.6 7.6"/><path d="M2 1.8V5h3.2"/>'),
  trash: svg('<path d="M2 3.2h8M4.8 3.2V2h2.4v1.2M3 3.2l.6 7h4.8l.6-7"/>'),
};

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- pixel wordmark (TTP logo geometry: 7x8 glyphs, 1px gap)
const GLYPH = {
  O: ['.#####.', '#######', '##...##', '##...##', '##...##', '##...##', '#######', '.#####.'],
  P: ['######.', '#######', '##...##', '#######', '######.', '##.....', '##.....', '##.....'],
  E: ['#######', '#######', '##.....', '######.', '######.', '##.....', '#######', '#######'],
  N: ['##...##', '###..##', '####.##', '#######', '##.####', '##..###', '##...##', '##...##'],
  M: ['##...##', '###.###', '#######', '##.#.##', '##...##', '##...##', '##...##', '##...##'],
  T: ['#######', '#######', '..###..', '..###..', '..###..', '..###..', '..###..', '..###..'],
};
function wordmark() {
  const el = $('#wordmark'), word = 'OPENMEET', u = 2;
  el.setAttribute('width', (word.length * 8 - 1) * u);
  el.setAttribute('height', 8 * u);
  el.setAttribute('viewBox', `0 0 ${word.length * 8 - 1} 8`);
  el.setAttribute('shape-rendering', 'crispEdges');
  let out = '';
  [...word].forEach((ch, i) => {
    const fill = i < 4 ? 'var(--logo)' : 'var(--mint)';
    GLYPH[ch].forEach((row, y) => [...row].forEach((px, x) => {
      if (px === '#') out += `<rect x="${i * 8 + x}" y="${y}" width="1" height="1" fill="${fill}"/>`;
    }));
  });
  el.innerHTML = out;
}

// ---------------------------------------------------------------- meet data (the meet manager's lynx.evt / .ppl / .sch)
const TEAMS = [
  { name: 'North Valley', c: '#1f4fa3' }, { name: 'Riverside', c: '#b3262e' },
  { name: 'Lakeview', c: '#1d7a4a' }, { name: 'Cedar Ridge', c: '#6b3fa0' },
  { name: "St. Mary's", c: '#c77d12' }, { name: 'Westfield', c: '#0f6f7a' },
  { name: 'Pine Bluff', c: '#3a3f47' }, { name: 'Eastside', c: '#a8326e' },
];
const FIRST = {
  G: ['Ava', 'Maya', 'Nora', 'Leah', 'Ruby', 'Zoe', 'Ella', 'Iris', 'Jade', 'Lena', 'Mia', 'Tess', 'Cora', 'Quinn', 'Sage', 'Elise'],
  B: ['Owen', 'Eli', 'Jonah', 'Theo', 'Caleb', 'Miles', 'Ezra', 'Luca', 'Isaac', 'Ben', 'Noah', 'Silas', 'Reid', 'Cole', 'Finn', 'Jude'],
};
const LAST = ['Lopez', 'Hart', 'Okafor', 'Lindqvist', 'Brennan', 'Castillo', 'Nguyen', 'Moreau', 'Adeyemi', 'Kowalski', 'Reyes', 'Sato',
  'Fischer', 'Mendez', 'Novak', 'Baptiste', 'Holm', 'Duarte', 'Price', 'Ibarra', 'Walsh', 'Kaur', 'Ortega', 'Lund', 'Abbott', 'Varga',
  'Quill', 'Rocha', 'Sorensen', 'Mbeki', 'Tran', 'Ellis'];
const SKIN = ['#8d5524', '#c68642', '#e0ac69', '#f1c27d', '#f6d0a8', '#5c3a21', '#a86b3c'];
const ALL8 = [1, 2, 3, 4, 5, 6, 7, 8];
const SPECS = [
  { ev: 3, rd: 1, ht: 1, of: 2, name: 'Girls 100 Meter Dash', g: 'G', base: 12.18, spread: 1.25, lanes: ALL8, close: [4, 5], wind: 1.1, seed: 11 },
  { ev: 3, rd: 1, ht: 2, of: 2, name: 'Girls 100 Meter Dash', g: 'G', base: 12.4, spread: 1.1, lanes: [1, 2, 3, 4, 5, 6, 7], dns: [2], lowconf: [6], wind: 0.4, seed: 12 },
  { ev: 4, rd: 1, ht: 1, of: 2, name: 'Boys 100 Meter Dash', g: 'B', base: 10.98, spread: 1.05, lanes: ALL8, dnf: [7], wind: -0.6, seed: 21 },
  { ev: 4, rd: 1, ht: 2, of: 2, name: 'Boys 100 Meter Dash', g: 'B', base: 11.1, spread: 0.95, lanes: ALL8, wind: 1.8, seed: 22 },
];

const bibs = new Set();
const hashStr = s => { let x = 2166136261; for (const c of String(s)) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return x >>> 0; };
const teamFor = name => ({ name: name || '', c: TEAMS[hashStr(name) % TEAMS.length].c });
// Simulated finish times for a heat the meet manager seeded: a plausible race for its distance and sex.
function paceFor(name) {
  const d = +((/(\d{2,5})\s*(m\b|meter|metre)/i.exec(name) || [])[1] || 100);
  const boys = /\b(boys?|men|male)\b/i.test(name) && !/women/i.test(name);
  const hurdles = /hurdle/i.test(name);
  const table = { 55: [6.6, 7.4], 60: [7.1, 8.0], 100: [11.0, 12.3], 110: [15.0, 15.0], 200: [22.4, 25.4], 300: [38, 45], 400: [50, 58], 800: [118, 140] };
  const [b, g] = table[d] || [d / 9, d / 8];
  const base = (boys ? b : g) + (hurdles ? (d === 110 ? 0 : 3.5) : 0);
  return { base, spread: base * 0.1 };
}
function specFromEvent(e, all) {
  const entries = e.entries.filter(x => x.lane).map(x => ({ lane: +x.lane, id: x.id, first: x.first, last: x.last, affiliation: x.affiliation, status: x.status }));
  const heatNumbers=all.filter(x=>x.event===e.event&&x.round===e.round).map(x=>x.heat).sort((a,b)=>a-b);
  return {
    ev: e.event, rd: e.round, ht: e.heat, name: e.name || `Event ${e.event}`,
    of: heatNumbers.every((number,i)=>number===i+1)?heatNumbers.length:null,
    entries, lanes: entries.map(x => x.lane), wind: null, seed: hashStr(`${e.event}-${e.round}-${e.heat}`) % 100000, ...paceFor(e.name || ''),
  };
}
function buildHeat(s) {
  const r = rng(s.seed);
  const pick = a => a[Math.floor(r() * a.length)];
  const teams = [...TEAMS];
  for (let i = teams.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [teams[i], teams[j]] = [teams[j], teams[i]]; }
  const athletes = s.entries
    ? s.entries.map(x => ({ ...x, lane: x.lane, id: x.id, first: x.first, last: x.last, team: teamFor(x.affiliation), skin: pick(SKIN), truth: null, pre: x.status || null }))
    : s.lanes.map((lane, li) => {
      let id;
      do { id = 100 + Math.floor(r() * 600); } while (bibs.has(id));
      bibs.add(id);
      return { lane, id, first: pick(FIRST[s.g]), last: pick(LAST), team: teams[li % teams.length], skin: pick(SKIN), truth: null, pre: null };
    });
  s = { ...s, dns: [...(s.dns || []), ...athletes.filter(a => a.pre).map(a => a.lane)] };
  // simulated truth: finish times, hidden from the console (used only to draw the strip and to fake model proposals)
  const runners = athletes.filter(a => !(s.dns || []).includes(a.lane));
  const step = s.spread / Math.max(1, runners.length - 1);
  const times = runners.map((_, i) => s.base + i * step + (r() - 0.5) * 0.5 * step);
  for (let i = runners.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [times[i], times[j]] = [times[j], times[i]]; }
  runners.forEach((a, i) => { a.truth = times[i]; });
  if (s.close) {
    const [a, b] = s.close.map(l => athletes.find(x => x.lane === l));
    b.truth = a.truth + 0.009;
  }
  (s.dns || []).forEach(l => { const a = athletes.find(x => x.lane === l); if (a && !a.pre) a.pre = 'DNS'; });
  (s.dnf || []).forEach(l => { const a = athletes.find(x => x.lane === l); a.dnfAt = 57; a.truth = null; });
  const fin = athletes.filter(a => a.truth != null).map(a => a.truth);
  if (!fin.length) fin.push(s.base || 12);
  const tOpen = 0, tClose = Math.max(...fin) + 0.8;          // the camera captures the whole race, from the gun
  const heat = {
    ...s, athletes, tOpen, tClose, nCols: Math.ceil((tClose - tOpen) / P),
    state: 'loaded', marks: {}, status: {}, proposals: null, req: 'idle', img: null, imgSrc: null,
    liveCol: -1, tNow: 0, startPerf: 0, startTOD: null, saves: 0, lif: null, base: null,
    lifName: `${pad(s.ev, 3)}-${s.rd}-${pad(s.ht, 2)}.lif`,
  };
  athletes.forEach(a => { if (a.pre) heat.status[a.lane] = a.pre; });
  return heat;
}
let HEATS = SPECS.map(buildHeat);
const attemptsByHeat = new Map();
const attemptKey = h => JSON.stringify([S.meet?.dir || 'sample', h.ev, h.rd, h.ht]);

const S = {
  idx: 0, tab: 'run', selLane: null, selCol: null, entryNumber: '', source: 'replay', apiOnline: true,
  rosterOrder: store.get('rosterOrder','lane'),
  autoStop: store.get('autoStop','manual'), stopAfter: store.get('stopAfter',60),
  autoArm: store.get('autoArm', true), autoMark: store.get('autoMark', true),
  flip: store.get('flip', false), lanes: store.get('lanes', false), zoomTool: false,
  files: [], view: { c0: 0, zx: 1, r0: 0, zy: 1, user: false, zoomed: false }, drag: null,
  layout: null, max: null, rects: {},
  meet: null,   // {dir, files} when a real meet folder is open (Electron); null = built-in sample meet
  bview: { linked: true, t0: 0, spp: 0.00125, r0: 0, rv: 1 }, bdrag: null,   // backup line-scan view (race time)
  fview: { s: 1, x: 0, y: 0 },                                               // front camera zoom/pan
  simulationCatalog: null, simulationSource: null, sourceChanging: false,
};
const OM = window.openmeet || null;   // the Electron bridge; absent when this page runs as the static replica
const occlusionAvailability=OM?new OcclusionAvailability(()=>OM.call('occlusion.info'),()=>{S.occlusionInfo=occlusionAvailability.info;updateModelMaskStatus();invalidate();}):null;
const windStr = h => (h.wind == null ? '—' : (h.wind >= 0 ? '+' : '') + h.wind.toFixed(1) + ' m/s');
const cur = () => HEATS[S.idx];
const runningHeat = () => HEATS.find(h=>h.state==='running')||null;
const scanSourceViews=new Map();
const viewHeat = () => S.cameraSetup?.heat || scanPresentation(cur());
function scanPresentation(h) {
  if(!h.asset)return h;
  const main=h.viewCameraId||h.asset.mainCameraId,comparison=h.viewCompareId||h.asset.comparisonCameraId;
  if(main===h.asset.mainCameraId&&comparison===h.asset.comparisonCameraId)return h;
  const selected=cameraAsset(h.asset,{main,comparison}),source=scanSourceViews.get(selected.primary);
  if(main!==h.asset.mainCameraId&&!source)return h;
  const p=h.presentation||(h.presentation=Object.create(h));
  p.recordingHeat=h;p.displaySource=main===h.asset.mainCameraId?null:source;p.displayMeta=p.displaySource?.meta||h.asset.primaryMeta;
  p.rows=p.displaySource?.rows||h.rows;p.laneRows=p.displaySource?p.displayMeta.lane_rows?.map(b=>({lane:b.lane,top:b.top_row,bottom:b.bottom_row})):h.laneRows;
  p.asset={...h.asset,mainCameraId:selected.mainCameraId,mainCameraLabel:selected.mainCameraLabel,comparisonCameraId:selected.comparisonCameraId,comparisonCameraLabel:selected.comparisonCameraLabel,backup:selected.backup,backupMeta:selected.backupMeta};
  return p;
}
async function loadScanSource(h,descriptor) {
  let source=scanSourceViews.get(descriptor.png);
  if(source){if(h.captureId&&!source.saved.has(h.captureId)){await OM.call('camera.image',{png:descriptor.png,captureId:h.captureId,includePixels:false});source.saved.add(h.captureId);}return source;}
  const image=await OM.call('camera.image',{png:descriptor.png,captureId:h.captureId}),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
  const g=canvas.getContext('2d'),rgba=g.createImageData(image.width,image.height),channels=image.channels;
  for(let i=0;i<image.width*image.height;i++){rgba.data[i*4]=image.data[i*channels];rgba.data[i*4+1]=image.data[i*channels+(channels>2?1:0)];rgba.data[i*4+2]=image.data[i*channels+(channels>2?2:0)];rgba.data[i*4+3]=255;}g.putImageData(rgba,0,0);
  const pixels={...image,layout:'rows'},mask=new Uint8Array(Math.ceil(image.width*image.height/8));writeForegroundMask(mask,0,pixels,scanBackground(pixels));
  source={img:canvas,mask,rows:image.height,w:image.width,t:descriptor.meta.first_column_race_time_s,p:descriptor.meta.column_period_s,meta:descriptor.meta,id:descriptor.id,label:descriptor.label,saved:new Set(h.captureId?[h.captureId]:[])};
  scanSourceViews.set(descriptor.png,source);return source;
}
async function chooseScanView(role,id) {
  const h=cur(),scans=h.asset?.lineScans;if(!scans?.some(s=>s.id===id)||h.viewLoading)return;
  finishHeightFrame();
  const previous=viewHeat(),main=role==='main'?id:previous.asset.mainCameraId,comparison=role==='comparison'?id:previous.asset.comparisonCameraId;
  const selected=cameraAsset(h.asset,{main,comparison:main===comparison?previous.asset.mainCameraId:comparison});
  overlayMenu?.overlaySettingsCleanup?.();overlayMenu?.remove();overlayMenu=null;
  if(S.cameraSetup){await stopCameraSetup(true);if(S.cameraSetup)return;await chooseScanView(role,id);await startCameraSetup();return;}
  if(['loaded','armed'].includes(h.state)){store.set(cameraRoleKey(),{main:selected.mainCameraId,comparison:selected.comparisonCameraId});for(const heat of HEATS)if(heat.asset&&['loaded','armed'].includes(heat.state)){heat.viewCameraId=null;heat.viewCompareId=null;attachAsset(heat,heat.asset);}ensureStrip(h);fitView();renderUI();return;}
  h.viewLoading=true;renderTools();
  try {
    for(const cameraId of [selected.mainCameraId,selected.comparisonCameraId])if(cameraId&&cameraId!==h.asset.mainCameraId)await loadScanSource(h,scans.find(s=>s.id===cameraId));
    const linked=linkedCameraRange(S.view,{rows:rowsOf(previous),height:scanH(),width:scanW(),period:periodOf(previous),timeOrigin:previous.tOpen,otherWidth:scanW(),otherRows:selected.primarySize.height,mainLanes:(previous.displayMeta||previous.asset.primaryMeta).lane_rows,otherLanes:selected.primaryMeta.lane_rows});
    h.viewCameraId=selected.mainCameraId;h.viewCompareId=selected.comparisonCameraId;S.bview.linked=true;
    if(role==='main'){if(!S.view.zoomed)fitScanHeight(viewHeat());else{S.view.r0=linked.r0*selected.primarySize.height;S.view.zy=scanH()/(linked.rv*selected.primarySize.height);}}
    store.set(cameraRoleKey(),{main:selected.mainCameraId,comparison:selected.comparisonCameraId});
    renderUI();
  }catch(err){toast('Camera view could not load: '+err.message,true);}finally{h.viewLoading=false;renderTools();}
}
let sourceMenu=null;
function showSourceMenu(role,anchor) {
  sourceMenu?.close(false);
  const h=viewHeat(),scans=cur().asset?.lineScans;if(!scans?.length)return;
  const menu=h_('div','camera-source-menu');menu.setAttribute('role','menu');menu.setAttribute('aria-label',role==='main'?'Main scan camera':'Comparison camera');sourceMenu=menu;
  const close=(restore=true)=>{menu.remove();window.removeEventListener('pointerdown',outside);anchor.setAttribute('aria-expanded','false');if(sourceMenu===menu)sourceMenu=null;if(restore&&anchor.isConnected)anchor.focus();};
  const outside=e=>{if(!menu.contains(e.target)&&!anchor.contains(e.target))close(false);};menu.close=close;
  anchor.setAttribute('aria-expanded','true');
  for(const source of scans){
    if(role==='comparison'&&source.id===h.asset.mainCameraId)continue;
    const b=h_('button','',source.label);b.setAttribute('role','menuitemradio');
    b.setAttribute('aria-checked',String(source.id===(role==='main'?h.asset.mainCameraId:h.asset.comparisonCameraId)));
    b.onclick=()=>{close();chooseScanView(role,source.id);};menu.append(b);
  }
  const rect=anchor.getBoundingClientRect();document.body.append(menu);
  menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,rect.left))+'px';menu.style.top=Math.max(8,Math.min(innerHeight-menu.offsetHeight-8,rect.bottom+4))+'px';
  (menu.querySelector('[aria-checked="true"]')||menu.querySelector('button'))?.focus();window.addEventListener('pointerdown',outside);
  menu.onkeydown=e=>{
    e.stopPropagation();const items=[...menu.querySelectorAll('button')],index=items.indexOf(document.activeElement);
    if(e.key==='Escape'){e.preventDefault();close();}
    else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
    else if(e.key==='Tab')close(false);
  };
}

// ---------------------------------------------------------------- shared-folder files (what RunMeet's AthleticLOCAL writes, and what OpenMeet writes back)
const q = v => (/[",]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
function evtText() {
  const out = ['; lynx.evt written by the meet manager (read-only for OpenMeet)'];
  HEATS.forEach(h => {
    out.push([h.ev, h.rd, h.ht, h.name].map(q).join(','));
    h.athletes.forEach(a => out.push((a.pre ? '\\' + a.pre : '') + ',' + [a.id, a.lane, a.last, a.first, a.team.name].map(q).join(',')));
  });
  return out.join('\n');
}
function todStr(d) {
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}0`;
}
function places(h) {
  const fin = h.athletes.filter(a => h.marks[a.lane] && !h.status[a.lane]).sort((a, b) => h.marks[a.lane].col - h.marks[b.lane].col);
  const pl = {};
  fin.forEach((a, i) => {
    const prev = fin[i - 1];
    pl[a.lane] = prev && h.marks[prev.lane].col === h.marks[a.lane].col ? pl[prev.lane] : i + 1;
  });
  return { fin, pl };
}
const projectionOf=h=>{const owner=h.recordingHeat||h;return owner.hideEmpty?owner.cropProjection:null;};
const displayCount=h=>projectionOf(h)?.length??h.nCols;
const toDisplay=(h,c)=>projectionOf(h)?displayCoordinate(projectionOf(h),c):c;
const toOriginal=(h,c)=>projectionOf(h)?originalCoordinate(projectionOf(h),c):c;
const displayPieces=(h,a,b)=>visibleColumnPieces(projectionOf(h),a,b,h.nCols);
const periodOf = h => h.asset?.primaryMeta?.column_period_s || P;
const colTime = (h, col) => h.tOpen + (col + 0.5) * periodOf(h);
const raceTime = (h, col) => colTime(h, col) - (h.startCorrection || 0);
function lifText(h) {
  const tod = h.startTOD ? todStr(h.startTOD) : '';
  const wind = h.wind == null ? '' : (h.wind >= 0 ? '+' : '') + h.wind.toFixed(1);
  const lines = [[h.ev, h.rd, h.ht, q(h.name), wind, h.wind == null ? '' : 'm/s', '', '', '', '', tod].join(',')];
  const { fin, pl } = places(h);
  let prevT = null;
  fin.forEach(a => {
    const t = ceilTo(raceTime(h, h.marks[a.lane].col), 3);
    const delta = prevT == null ? t : t - prevT;
    prevT = t;
    lines.push([pl[a.lane], a.id, a.lane, q(a.last), q(a.first), q(a.team.name), fmtT(t), '', fmtT(delta), '', '', tod, '', '', ''].join(','));
  });
  h.athletes.filter(a => h.status[a.lane]).forEach(a => {
    const st = h.status[a.lane];
    const t = st === 'DQ' && h.marks[a.lane] ? fmtT(raceTime(h, h.marks[a.lane].col)) : '';
    lines.push([st, a.id, a.lane, q(a.last), q(a.first), q(a.team.name), t, '', '', '', '', tod, '', '', ''].join(','));
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------- simulated camera: render the heat's line-scan strip
const laneTop = j => 168 + 302 * Math.pow(j / 8, 0.92);            // lane boundary rows (perspective: far lanes thinner)
const laneFeet = k => (laneTop(k - 1) + laneTop(k)) / 2;
const laneHt = k => 95 + (k - 1) * 7.5;                             // runner height in rows
const rowsOf = h => h.rows || h.asset?.primarySize?.height || h.asset?.primaryMeta?.rows || (h.asset && store.get(scanGeometryKey(h.asset.mainCameraId), {}).rows) || IMG_H;
function scanGeometryKey(camera='primary') { return `camera-geometry:${S.meet?.dir || 'sample'}:${camera}`; }
function scanFrameKey(h=viewHeat(),camera=h.asset?.mainCameraId||'simulated') { return `scan-framing:${S.meet?.dir||'sample'}:${camera}`; }
function cameraFrame(h,camera) {
  const value=store.get(scanFrameKey(h,camera),null),top=Number(value?.top),bottom=Number(value?.bottom);
  return value&&Number.isFinite(top)&&Number.isFinite(bottom)&&top>=0&&bottom<=1&&bottom-top>=0.049999?{top,bottom}:{top:0,bottom:1};
}
function visibleRows(h=viewHeat()) {
  const frame=S.frameEditor?{top:0,bottom:1}:cameraFrame(h),rows=rowsOf(h);
  return {top:frame.top*rows,bottom:frame.bottom*rows};
}
function fitScanHeight(h=viewHeat()) {
  const rows=visibleRows(h);S.view.r0=rows.top;S.view.zy=scanH()/(rows.bottom-rows.top);
}
function finishHeightFrame() {
  if(!S.frameEditor)return;
  S.frameEditor=null;fitScanHeight();renderTools();invalidate();
}
function toggleHeightFrame() {
  if(S.frameEditor){finishHeightFrame();return;}
  S.frameEditor={key:scanFrameKey()};S.view.focusLane=null;S.zoomTool=false;S.hoverCol=null;
  fitScanHeight();syncCursor();renderTools();invalidate();
  requestAnimationFrame(()=>document.querySelector('#scanHeightEditor [data-edge="top"]')?.focus({preventScroll:true}));
}
function rememberScanGeometry(h, observed={}, persist=true) {
  const camera=h.asset?.mainCameraId || 'simulated',key=scanGeometryKey(camera),previous=store.get(key,{});
  const rows=Number.isInteger(observed.rows)&&observed.rows>0?observed.rows:rowsOf(h);
  let bands=h.laneRows;
  if(bands&&h.rows&&h.rows!==rows)bands=bands.map(b=>({...b,top:b.top*rows/h.rows,bottom:b.bottom*rows/h.rows}));
  if(!bands&&previous.laneRows?.length)bands=previous.laneRows.map(b=>({...b,top:b.top*rows/previous.rows,bottom:b.bottom*rows/previous.rows}));
  // Give legacy absolute-row overlays a known resolution before a camera mode changes.
  const overlay=store.get(cameraOverlayKey('scan',camera),camera==='primary'?store.get(overlayKey('scan'),{}):{});
  if(persist&&Object.keys(overlay).length&&!overlay.resolutionRows)store.set(cameraOverlayKey('scan',camera),{...overlay,resolutionRows:previous.rows||h.rows||rows});
  h.rows=rows;if(bands)h.laneRows=bands;
  if(persist)store.set(key,{rows,laneRows:bands||[],...(observed.channels?{channels:observed.channels}:previous.channels?{channels:previous.channels}:{})});
}
function rowsForCamera(camera) {
  const displayed=viewHeat(),recorded=cur();
  if(camera===displayed.asset?.mainCameraId)return rowsOf(displayed);
  if(camera===recorded.asset?.mainCameraId)return rowsOf(recorded);
  const source=recorded.asset?.lineScans?.find(s=>s.id===camera);
  return source?.size?.height||source?.meta?.rows||store.get(scanGeometryKey(camera),{}).rows||IMG_H;
}
// Lane geometry at the finish plane, in image rows: from the camera calibration when the source has it.
const laneBands = h => h.laneRows || ALL8.map(k => ({ lane: k, top: laneTop(k - 1), bottom: laneTop(k) }));
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = f < 0 ? 0 : 255, k = Math.abs(f);
  r = Math.round(r + (m - r) * k); g = Math.round(g + (m - g) * k); b = Math.round(b + (m - b) * k);
  return `rgb(${r},${g},${b})`;
}
function rowColor(y, r, clean) {
  const n = clean ? 0 : (r() - 0.5);
  let c;
  if (y < 56) c = [38 + n * 28, 44 + n * 28, 58 + n * 28];                               // far stands
  else if (y < 166) { const k = (y - 56) / 110; c = [44 + 18 * k + n * 10, 78 + 22 * k + n * 12, 52 + 10 * k + n * 8]; } // infield grass
  else if (y < 170) c = [196, 198, 192];                                                // curb
  else if (y < 472) {                                                                   // the white finish line itself
    const v = 224 - (y - 170) * 0.05 + n * 7;
    const edge = ALL8.some(j => Math.abs(y - laneTop(j)) < 0.8) && !clean ? -9 : 0;
    c = [v + edge, v + 1 + edge, v - 5 + edge];
  } else c = [92 + n * 10, 94 + n * 10, 98 + n * 10];
  return `rgb(${c.map(v => Math.max(0, Math.min(255, Math.round(v)))).join(',')})`;
}
function drawRunner(g, h, a) {
  const cf = Math.round((a.truth - h.tOpen) / P);
  const m = 1 / ((100 / a.truth) * 1.06 * P);                      // columns per metre at finishing speed
  const yF = laneFeet(a.lane), hh = laneHt(a.lane);
  const X = d => cf + d * m, Y = f => yF - f * hh;
  const lw = hh * 0.055, skinBack = shade(a.skin, -0.18), shorts = shade(a.team.c, -0.5);
  g.lineCap = 'round'; g.lineJoin = 'round';
  const limb = (pts, w, col) => {
    g.strokeStyle = col; g.lineWidth = w; g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    g.stroke();
  };
  const poly = (pts, col) => {
    g.fillStyle = col; g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    g.closePath(); g.fill();
  };
  limb([[0.2, 0.8], [0.4, 0.66], [0.58, 0.6]], lw * 0.9, skinBack);              // trailing arm
  limb([[0.24, 0.5], [0.46, 0.27], [0.74, 0.13]], lw * 1.15, skinBack);          // trailing leg
  limb([[0.74, 0.13], [0.86, 0.1]], lw, '#1d1d1f');
  poly([[0, 0.8], [0.24, 0.83], [0.3, 0.5], [0.07, 0.49], [0, 0.62]], a.team.c); // torso: chest front edge is x = 0 (the timing point)
  poly([[0.07, 0.52], [0.3, 0.53], [0.31, 0.41], [0.05, 0.41]], shorts);
  g.fillStyle = '#f1f1ec';
  g.fillRect(X(0.03), Y(0.73), 0.12 * m, 0.1 * hh);                              // bib
  g.fillStyle = a.skin; g.beginPath();
  g.ellipse(X(-0.01), Y(0.905), 0.1 * m, hh * 0.064, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = shade(a.skin, -0.6); g.beginPath();
  g.ellipse(X(0.02), Y(0.94), 0.09 * m, hh * 0.04, 0, Math.PI, Math.PI * 2); g.fill();
  limb([[0.12, 0.48], [-0.16, 0.3], [-0.06, 0.04]], lw * 1.15, a.skin);          // lead leg
  limb([[-0.06, 0.04], [-0.18, 0.02]], lw, '#1d1d1f');
  limb([[0.04, 0.79], [-0.1, 0.66], [-0.28, 0.7]], lw * 0.9, a.skin);            // lead arm
}
function renderStrip(h) {
  const c = document.createElement('canvas');
  c.width = h.nCols; c.height = IMG_H;
  const g = c.getContext('2d'), r = rng(h.seed * 977), clean = S.source === 'render';
  for (let y = 0; y < IMG_H; y++) { g.fillStyle = rowColor(y, r, clean); g.fillRect(0, y, h.nCols, 1); }
  if (!clean) for (let i = 0; i < h.nCols / 7; i++) { g.fillStyle = `rgba(0,0,0,${0.015 + r() * 0.03})`; g.fillRect(Math.floor(r() * h.nCols), 0, 1, IMG_H); }
  const orderColumn=a=>h.status[a.lane]?Infinity:(h.marks[a.lane]?.col??h.proposals?.find(p=>p.lane===a.lane)?.col??Infinity);
  [...h.athletes].sort((a,b)=>{
    if(S.rosterOrder==='finish'){const ac=orderColumn(a),bc=orderColumn(b);if(ac!==bc)return ac<bc?-1:1;}
    return a.lane-b.lane;
  }).forEach(a => { if (a.truth != null) drawRunner(g, h, a); });
  h.img = c; h.imgSrc = S.source;
}
function ensureStrip(h) {
  if(h.replaySourceType&&!h.asset){if(!h.img)blankStrip(h);return;}
  if (h.asset) { if (!h.img) blankStrip(h); return; }
  if (!h.img || (h.imgSrc !== S.source && (h.state === 'loaded' || h.state === 'armed'))) renderStrip(h);
}
// A heat whose camera is the engine's: the strip starts black and fills as the engine's columns arrive.
const STRIP_TILE = 2048;
function blankStrip(h) {
  h.liveFollow=new LiveFollow();h.presentedCols=0;
  h.stripTiles = [];
  h.foregroundTiles = []; h.overlayBackground = null; h.sampleForeground = null;
  h.guideRenderCache=null;
  h.img = document.createElement('canvas'); h.img.width=1; h.img.height=rowsOf(h);
  h.imgSrc = 'engine'; h.recvCols = 0;
}
function drawStrip(g,h,sx,sy,sw,sh,dx,dy,dw,dh) {
  if(!h.stripTiles) { g.drawImage(h.img,sx,sy,sw,sh,dx,dy,dw,dh); return; }
  if(sw<=0)return;
  const lo=Math.floor(sx/STRIP_TILE),hi=Math.floor((sx+sw-1e-7)/STRIP_TILE);
  for(let i=lo;i<=hi;i++) {
    const tile=h.stripTiles[i]; if(!tile)continue;
    const a=Math.max(sx,i*STRIP_TILE),b=Math.min(sx+sw,(i+1)*STRIP_TILE);
    if(b>a)g.drawImage(tile,a-i*STRIP_TILE,sy,b-a,sh,dx+(a-sx)/sw*dw,dy,(b-a)/sw*dw,dh);
  }
}
// Keep long captures in small canvas tiles; the engine retains every original column on disk.
function ingestColumns(h, first, count, data, channels) {
  const rows=rowsOf(h);
  if(!h.overlayBackground)h.overlayBackground=scanBackground({data,width:count,height:rows,channels});
  h.foregroundTiles ||= [];
  for(let c=0;c<count;) {
    const index=Math.floor((first+c)/STRIP_TILE),local=(first+c)%STRIP_TILE,n=Math.min(count-c,STRIP_TILE-local);
    if(!h.stripTiles[index]) {const tile=document.createElement('canvas');tile.width=STRIP_TILE;tile.height=rows;h.stripTiles[index]=tile;}
    const g=h.stripTiles[index].getContext('2d'),im=g.createImageData(n,rows),px=im.data;
    for(let x=0;x<n;x++)for(let r=0;r<rows;r++) {
      const src=((c+x)*rows+r)*channels,dst=(r*n+x)*4;
      px[dst]=data[src];px[dst+1]=data[src+(channels>1?1:0)];px[dst+2]=data[src+(channels>1?2:0)];px[dst+3]=255;
    }
    g.putImageData(im,local,0);c+=n;
    const mask=h.foregroundTiles[index] ||= new Uint8Array(Math.ceil(STRIP_TILE*rows/8));
    writeForegroundMask(mask,local,{data:data.subarray((c-n)*rows*channels,c*rows*channels),width:n,height:rows,channels},h.overlayBackground);
  }
  h.recvCols=Math.max(h.recvCols||0,first+count);
  (h.liveFollow ||= new LiveFollow()).observe(h.recvCols,performance.now(),SPEED/periodOf(h));
  if(h.preview){h.minCol=Math.max(0,h.recvCols-STRIP_TILE*8);const firstTile=Math.floor(h.minCol/STRIP_TILE);for(let i=h.firstTile||0;i<firstTile;i++){delete h.stripTiles[i];delete h.foregroundTiles[i];}h.firstTile=firstTile;}
  h.nCols=Math.max(h.nCols,h.recvCols);h.tClose=h.tOpen+h.recvCols*periodOf(h);
}

// ---------------------------------------------------------------- simulated auto-timing service
function makeProposals(h) {
  const r = rng(h.seed * 31 + 7);
  const props = h.athletes.filter(a => a.truth != null).map(a => {
    const c = Math.round((a.truth - h.tOpen) / P);
    const low = (h.lowconf || []).includes(a.lane);
    return { lane: a.lane, col: low ? c + 5 : c + [0, 0, 0, 1, -1][Math.floor(r() * 5)], decision: low ? 'review' : 'auto', reason: low ? 'low confidence' : '', conf: low ? 0.62 + r() * 0.1 : 0.97 + r() * 0.025 };
  }).sort((a, b) => a.col - b.col);
  // policy: finishes within 0.02 s of a neighbour always go to a human
  for (let i = 1; i < props.length; i++) {
    const gap = (props[i].col - props[i - 1].col) * P;
    if (gap < 0.02) [props[i - 1], props[i]].forEach(p => { p.decision = 'review'; p.reason = `close finish (${gap.toFixed(3)} s)`; });
  }
  (h.close || []).forEach((l, i) => { const p = props.find(x => x.lane === l); if (p) p.col += i ? 2 : -2; });
  return props;
}
const snap = h => JSON.stringify({ marks: h.marks, status: h.status });
// Final suggestions for the whole capture. Live marks the operator has not touched follow the final answer.
function applyProposals(h, props, meta = {}) {
  const untouched = h.base === snap(h);
  h.proposals = props.filter(p=>!h.dismissed?.[p.lane]); h.model = meta.model || 'sim-0'; h.stub = !!meta.stub;h.reference=!!meta.reference;h.sourceRef=meta.sourceRef||null;
  h.inputDerived=!!meta.inputDerived;
  h.req = 'done'; h.reqMs = Math.round(performance.now() - h.reqStart);
  h.proposals.forEach(p => {
    const mk = h.marks[p.lane];
    if (h.status[p.lane] || h.dismissed?.[p.lane]) return;
    if (p.decision === 'auto' && (!mk || mk.src === 'auto')) h.marks[p.lane] = { col: p.col, src: 'auto',...(h.sourceRef?{sourceRef:h.sourceRef}:{}) };
    else if (p.decision === 'review' && mk && mk.src === 'auto') delete h.marks[p.lane];   // a live auto-accept the final pass flags goes back to review
  });
  if(h.hideEmpty&&[...Object.values(h.marks),...h.proposals.filter(p=>!h.status[p.lane]&&!h.dismissed?.[p.lane])].some(m=>displayCoordinate(h.cropProjection,m.col+0.5)==null)){
    h.hideEmpty=false;if(cur()===h){fitView();toast('New finish outside hidden spans. Full view shown.');}
  }
  if (untouched && !h.saves) h.base = snap(h);                 // machine output on a fresh capture is part of "as captured"
  renderUI();
}
const predictParams = (h, extra = {}) => ({
  captureId: h.captureId,
  heat: { event: h.ev, round: h.rd, heat: h.ht },
  startList: replayStartList(h.athletes.filter(a => !['DNS', 'SC'].includes(h.status[a.lane]))),
  laneRows: h.laneRows ? h.laneRows.map(b => ({ lane: b.lane, top_row: Math.round(b.top), bottom_row: Math.round(b.bottom) })) : null,
  laneGuides: modelLaneGuides(h),
  ...extra,
});
const toProps = res => res.predictions.map(p => ({ lane: p.lane, col: (res.fromCol || 0) + p.column, t: p.race_time_s, decision: p.decision, model: p.decision, reason: p.reason || '', conf: p.confidence ?? 0 }));

// ---- live suggestions: as each athlete crosses, not after the race
// A suggestion is shown once its torso is fully past the line (LIVE_LAG), and auto-accepted only once no
// neighbour could still be within 0.02 s of it. The final pass at capture close then confirms or corrects.
const LIVE_LAG = 0.15, LIVE_EVERY = 0.35;
function mergeLive(h, props, seenToT) {
  const by = new Map((h.proposals || []).map(p => [p.lane, p]));
  props.filter(p=>!h.dismissed?.[p.lane]).forEach(p => by.set(p.lane, { ...p, model: p.model || p.decision }));
  const all = [...by.values()].sort((a, b) => a.col - b.col);
  all.forEach(p => { p.decision = p.model; if (p.model === 'auto') p.reason = p.reason === 'close_finish' ? '' : p.reason; });
  for (let i = 1; i < all.length; i++) {
    const gap = (all[i].col - all[i - 1].col) * periodOf(h);
    if (gap < 0.02) [all[i - 1], all[i]].forEach(p => { p.decision = 'review'; p.reason = `close finish (${gap.toFixed(3)} s)`; });
  }
  h.proposals = all;
  const settledT = seenToT - LIVE_LAG;
  all.forEach(p => {
    if (h.status[p.lane] || h.marks[p.lane] || h.dismissed?.[p.lane]) return;
    if (p.decision === 'auto' && colTime(h, p.col) + 0.02 <= settledT) h.marks[p.lane] = { col: p.col, src: 'auto',...(h.sourceRef?{sourceRef:h.sourceRef}:{}) };
  });
}
function liveSuggest(h) {
  if (!S.autoMark || !S.apiOnline || h.liveCol < 0) return;
  if(h.replaySourceType==='real'&&(!S.atInfo||(S.atInfo.stub&&!replayReferenceTiming(h))))return;
  if (h.asset && OM) {
    if (!h.captureId || h.liveBusy || (S.atInfo && !S.atInfo.live)) return;
    if (h.liveTo != null && colTime(h, h.liveCol) - colTime(h, h.liveTo) < LIVE_EVERY) return;
    const fromCol = Math.max(0, (h.liveTo == null ? 0 : h.liveTo) - Math.round(0.6 / periodOf(h))), toCol = h.liveCol;
    const runVersion = h.runVersion;
    h.liveBusy = true; h.req = 'live';
    OM.call('autotiming.predict', predictParams(h, { fromCol, toCol })).then(res => {
      if (h.runVersion !== runVersion || h.state !== 'running') return;
      h.reference=!!res.reference;h.sourceRef=res.sourceRef||null;
      const seenT = colTime(h, toCol);
      mergeLive(h, toProps(res).filter(p => p.t <= seenT - LIVE_LAG), seenT);
      h.liveTo = toCol; h.model = res.model; h.stub = !!res.stub; h.inputDerived=!!res.inputDerived;
      if (cur() === h) { renderProps(); renderSide(); invalidate(); }
    }).catch(() => {}).finally(() => { if(h.runVersion === runVersion) h.liveBusy = false; });
  } else {
    if (!h.allProps) h.allProps = makeProposals(h);   // the simulated model, revealed as athletes cross
    const seenT = h.tNow;
    h.req = 'live'; h.model = 'sim-0'; h.stub = true;
    mergeLive(h, h.allProps.filter(p => colTime(h, p.col) <= seenT - LIVE_LAG).map(p => ({ ...p, model: p.decision })), seenT);
  }
}
function requestProposals(h) {
  if(h.replaySourceType==='real'&&S.atInfo?.stub&&!replayReferenceTiming(h)){h.req='error';h.reqErr='No reference timing points are available. Configure a timing service, or mark finishes manually';renderUI();return;}
  if (!S.apiOnline) { h.req = 'offline'; renderUI(); return; }
  h.req = 'pending'; h.reqStart = performance.now(); renderUI();
  if (h.asset && OM && h.captureId) {
    // Engine-fed heat: the engine reads the strip from the capture store and calls the finish service.
    OM.call('autotiming.predict', predictParams(h)).then(res => applyProposals(h, toProps(res).sort((a, b) => a.col - b.col), res))
      .catch(err => { h.req = 'error'; h.reqErr = err.message; renderUI(); });
    return;
  }
  setTimeout(() => {
    if (!S.apiOnline) { h.req = 'offline'; renderUI(); return; }
    applyProposals(h, makeProposals(h), { model: 'sim-0', stub: true });
  }, Math.max(250, 900 / SPEED));
}

// Camera setup preview is independent of the official heat and its start journal.
async function startCameraSetup() {
  if(runningHeat()||S.sourceChanging||S.cameraSetup?.starting||!replayCameras(cur()).primary)return;
  const source={...cur()};if(source.asset)attachAsset(source,source.asset);ensureStrip(source);
  if(!S.cameraSetup) S.cameraSetup={previousView:{...S.view},previousSelection:{lane:S.selLane,col:S.selCol},mode:'alignment'};
  const setup=S.cameraSetup;
  S.tab='alignment';
  setup.heat={...source,preview:true,state:'running',marks:{},status:{},proposals:[],img:null,stripTiles:[],recvCols:0,liveCol:-1,nCols:1,
    tOpen:source.asset?.primaryMeta.first_column_race_time_s||0,tClose:0,tNow:0,startPerf:performance.now(),startTOD:null,startCorrection:0,frontRec:null};
  setup.sample=source.sampleStrip||source.img;setup.starting=true;setup.live=false;setup.id=null;setup.failed=false;
  setup.heat.sampleStrip=setup.sample;
  S.selLane=null;S.selCol=null;S.hoverCol=null;S.view.user=false;S.view.followZoom=null;blankStrip(setup.heat);fitView();renderUI();
  try {
    if(OM&&source.asset){
      const result=await OM.call('preview.start',{png:source.asset.primary,sidecar:source.asset.primaryMeta,speed:SPEED,cameraId:source.asset.mainCameraId,cameraLabel:source.asset.mainCameraLabel});
      setup.id=result.id;
    }
    if(S.cameraSetup!==setup)return;
    setup.heat.startPerf=performance.now();setup.live=!setup.failed;
  } catch(err){setup.heat.state='review';toast('Preview could not start: '+err.message,true);}
  finally {setup.starting=false;renderUI();}
}
async function stopCameraSetup(exit=false) {
  const setup=S.cameraSetup;if(!setup||setup.stopping)return;
  setup.stopping=true;renderUI();
  try {
    if(OM&&setup.id)await OM.call('preview.stop');
    setup.live=false;setup.heat.state='review';setup.heat.nCols=Math.max(1,setup.heat.recvCols||1);setup.heat.liveCol=(setup.heat.recvCols||0)-1;
    S.selCol=setup.heat.liveCol>=0?setup.heat.liveCol:null;S.hoverCol=null;
    if(exit){S.cameraSetup=null;if(S.tab==='alignment')S.tab='run';S.view={...setup.previousView};S.selLane=setup.previousSelection.lane;S.selCol=setup.previousSelection.col;}
  }catch(err){toast('Could not stop preview: '+err.message,true);}
  finally {setup.stopping=false;renderUI();}
}
function renderSetupSidebar() {
  const setup=S.cameraSetup;
  $('#ev').innerHTML=`<div class="ev-top"><span class="kicker">CAMERA ALIGNMENT</span><span class="tag sim">${setup.heat.replaySourceType==='real'?'RECORDED REPLAY':'SIMULATOR'}</span></div><div class="ev-name">Align cameras & overlays</div><div class="ev-sub">Preview only · no race start or results</div>`;
  const ctl=$('#ctl');ctl.innerHTML='';
  renderCameraRoles(ctl);
  const stop=h_('button','btn primary wide',setup.starting?'Starting preview…':setup.live?'Stop preview':'Start preview');stop.disabled=setup.starting||setup.stopping;stop.onclick=()=>setup.live?stopCameraSetup():startCameraSetup();ctl.append(stop);
  const modes=h_('div','setup-modes wide');
  ['alignment','overlays'].forEach(mode=>{const b=h_('button','btn sm'+(setup.mode===mode?' primary':''),mode==='alignment'?'Alignment':'Overlays');b.onclick=()=>{setup.mode=mode;renderUI();};modes.append(b);});ctl.append(modes);
  const done=h_('button','btn wide','Return to race');done.disabled=setup.starting||setup.stopping;done.onclick=()=>stopCameraSetup(true);ctl.append(done);
  $('#warn').innerHTML='';
  $('#list').innerHTML=`<div class="setup-help"><p>${setup.mode==='alignment'?'Use the preview image to align the finish-line view. Pan and zoom as needed.':'Open Lanes ▾ on an available camera to place and style your lane guides.'}</p><p>You can stop the preview and keep the image visible while adjusting overlays.</p><p class="dimtext">${setup.heat.replaySourceType==='real'?'This is recorded camera input. Live camera drivers are planned.':'This build uses simulated camera input. Real camera drivers are planned.'}</p></div>`;
}

// ---------------------------------------------------------------- heat flow: Loaded -> Armed -> Running -> Review -> Saved
function go(i) {
  if (S.cameraSetup || i < 0 || i >= HEATS.length) return;
  finishHeightFrame();
  overlayMenu?.overlaySettingsCleanup?.();overlayMenu?.remove();overlayMenu=null;toolbarPopover?.close(false);sourceMenu?.close(false);
  S.idx = i; S.selLane = null; S.selCol = null; S.entryNumber = ''; S.hoverCol = null;
  S.bview.linked = true; Object.assign(S.fview, { s: 1, x: 0, y: 0 }); applyFrontView();
  const h = cur();
  rememberScanGeometry(h);ensureStrip(h);
  if (S.autoArm && h.state === 'loaded') h.state = 'armed';
  fitView();
  renderUI();
}
function arm() { if(S.cameraSetup)return; const h = cur(); if (h.state !== 'loaded') return; ensureStrip(h); h.state = 'armed'; renderUI(); }
function disarm() { const h = cur(); if (h.state === 'armed') { h.state = 'loaded'; renderUI(); } }
function fire() {
  if(S.cameraSetup||S.sourceChanging||!replayCameras(cur()).primary)return;
  const h = cur();
  if (h.state !== 'armed'||runningHeat()) return;
  S.lastLiveHeat=h;h.runVersion = (h.runVersion || 0) + 1;h.hideEmpty=false;h.cropResult=null;h.cropProjection=null;
  h.stopMode=S.autoStop; h.stopAfter=S.stopAfter; h.stopping=false;
  h.state = 'running'; h.startPerf = performance.now(); h.startTOD = new Date(); h.liveCol = -1; h.tNow = 0;
  h.startCorrection = 0; h.startReference = null; h.startTriggerId = null; h.dismissed = {}; h.inputDerived=false;
  if(!h.asset) { h.sampleStrip=h.sampleStrip||h.img; blankStrip(h); }
  h.proposals = null; h.allProps = null; h.liveTo = null; h.liveBusy = false; h.req = 'idle';h.reference=false;h.sourceRef=null;h.learnedForeground=null;h.occlusionAttempt=null;
  S.view.user = false; S.view.followZoom=null; S.view.followTransition=null; S.selCol = null;
  if (h.asset && OM) {
    blankStrip(h); h.captureId = null; S.pendingCapture = h;
    OM.call('capture.start', {
      timeoutSeconds:h.stopMode==='timeout'?h.stopAfter:null,
      key: `${h.ev}-${h.rd}-${h.ht}`, png: h.asset.primary, sidecar: h.asset.primaryMeta, speed: SPEED, meetDir: S.meet && S.meet.dir,cameraId:h.asset.mainCameraId,cameraLabel:h.asset.mainCameraLabel,
      front: h.asset.front ? { path: h.asset.front, meta: h.asset.frontMeta, frames:h.asset.frontFrames } : null,
    })
      .then(r => { h.captureId = r.id; h.captureDir = r.dir; if (r.trigger) { h.startReference = r.trigger; h.startCorrection = 0; h.startTOD = new Date(r.trigger.wallTimeMs); } if (r.front) h.frontRec = r.front; })
      .catch(err => { S.pendingCapture = null; h.state = 'armed'; toast('The camera did not start: ' + err.message, true); renderUI(); });
  }
  if (!h.asset && OM && S.meet) {
    OM.call('starts.record', { dir:S.meet.dir, clockId:'simulated-meet-clock', timeS:h.startTOD.getTime()/1000, wallTimeMs:h.startTOD.getTime(), source:'Simulated start' }).then(async trigger => {
      h.startReference = trigger;
      await OM.call('starts.assign', { dir:S.meet.dir, heatKey:`${h.ev}-${h.rd}-${h.ht}`, triggerId:trigger.id, referenceTriggerId:trigger.id });
    }).catch(err => toast('Start could not be recorded: '+err.message,true));
  }
  renderUI();
}
function recall() {
  const h = cur();
  if (h.state !== 'running') return;
  h.runVersion = (h.runVersion || 0) + 1;
  h.state = 'armed'; h.liveCol = -1; h.startTOD = null; h.tNow = 0; h.marks = {}; h.proposals = null; h.allProps = null; h.liveTo = null; h.req = 'idle';
  if (h.asset && OM) { OM.call('capture.stop').catch(() => {}); h.captureId = null; S.pendingCapture = null; blankStrip(h); }
  toast('Recall: false start. Heat re-armed. Set FS on the athlete from their row.');
  renderUI();
}
function prepareRestart(h) {
  const heatIndex=HEATS.indexOf(h),selected=h===cur();if(heatIndex<0)return;
  const key=attemptKey(h),attempts=attemptsByHeat.get(key)||[h];
  if(!attempts.includes(h))attempts.push(h);
  h.attemptNumber ||= attempts.indexOf(h)+1;
  const next={...h,attemptNumber:attempts.length+1,state:'armed',marks:{},status:{},proposals:null,req:'idle',img:null,
    stripTiles:null,recvCols:0,liveCol:-1,tNow:0,startPerf:0,startTOD:null,startReference:null,startTriggerId:null,startCorrection:0,
    captureId:null,captureDir:null,frontRec:null,saves:0,lif:null,base:null,allProps:null,liveTo:null,liveBusy:false,dismissed:{},
    stopping:false,restartAfterStop:false,hideEmpty:false,cropResult:null,cropProjection:null,cropBusy:false,runVersion:(h.runVersion||0)+1};
  next.athletes.forEach(a=>{if(a.pre)next.status[a.lane]=a.pre;});
  if(next.asset)attachAsset(next,next.asset);
  else {next.img=h.sampleStrip||h.img;next.nCols=next.img?.width||h.nCols;next.tClose=next.tOpen+next.nCols*periodOf(next);}
  attempts.push(next);attemptsByHeat.set(key,attempts);HEATS[heatIndex]=next;if(selected)rememberScanGeometry(next);
  if(selected){S.selLane=null;S.selCol=null;S.hoverCol=null;S.entryNumber='';S.view.user=false;S.view.followZoom=null;}
  ensureStrip(next);if(selected)fitView();renderUI();
  toast(`Attempt ${next.attemptNumber} is armed. The previous capture and its start triggers are retained.`);
}
function restartRace() {
  const h=cur();if(h.stopping||h.saving)return;
  if(h.state==='running'){h.restartAfterStop=true;stopCapture();return;}
  prepareRestart(h);
}
function confirmRaceReset() {
  const h=cur();if(S.cameraSetup||h.stopping||h.saving||document.querySelector('.race-reset-dialog'))return;
  const running=h.state==='running';
  const dialog=h_('dialog','race-reset-dialog');
  dialog.setAttribute('aria-labelledby','race-reset-title');
  dialog.setAttribute('aria-describedby','race-reset-detail');
  const title=h_('h2','',running?'Stop or restart this race?':'Restart this race?');title.id='race-reset-title';
  const detail=h_('p','',`Event ${h.ev} · Round ${h.rd} · Heat ${h.ht}. Restarting retains the current attempt and its capture, start triggers and saved results, then arms a new attempt.`);detail.id='race-reset-detail';
  const actions=h_('div','race-reset-actions');
  const cancel=h_('button','btn',running?'Keep capturing':'Cancel');cancel.autofocus=true;cancel.onclick=()=>dialog.close();actions.append(cancel);
  const act=(text,fn)=>{const b=h_('button','btn warn',text);b.onclick=()=>{dialog.close();if(cur()===h&&!S.cameraSetup&&!h.stopping&&!h.saving)fn();};actions.append(b);};
  if(running)act('Stop capture',stopCapture);
  act(running?'Stop & restart':'Restart race',restartRace);
  dialog.append(title,detail,actions);dialog.addEventListener('close',()=>{dialog.remove();document.querySelector('#raceReset')?.focus();},{once:true});
  document.body.append(dialog);dialog.showModal();
}
function selectAttempt(index) {
  const h=cur();if(h.state==='running'||h.stopping)return;
  const attempts=attemptsByHeat.get(attemptKey(h));if(!attempts?.[index])return;
  HEATS[S.idx]=attempts[index];S.selLane=null;S.selCol=null;S.hoverCol=null;S.entryNumber='';fitView();renderUI();
}
function stopCapture(target) {
  const h=target?.state?target:cur(); if(h.state!=='running'||h.stopping)return;
  h.stopping=true;renderUI();
  if(h.asset&&OM) OM.call('capture.stop').catch(err=>{h.stopping=false;h.restartAfterStop=false;toast(err.message,true);renderUI();});
  else {endCapture(h);renderUI();}
}
function endCapture(h) {
  if(h.state!=='running')return;
  if(h.asset) h.nCols=h.recvCols||0;
  else h.nCols=Math.min(h.nCols,Math.max(1,h.liveCol+1));
  h.tClose=h.tOpen+h.nCols*periodOf(h);
  h.state='review';h.stopping=false;h.liveCol=h.nCols-1;h.tNow=h.tClose;
  h.base=snap(h);if(h===cur())fitView();
  occlusionAvailability?.refresh();
  if(h.restartAfterStop){h.restartAfterStop=false;prepareRestart(h);return;}
  if(S.autoMark&&h.nCols>0)requestProposals(h);else h.req='idle';
}
function editHeat(h) { if (h.state === 'saved') h.state = 'review'; }
function setMark(lane, col) {
  if(S.cameraSetup)return;
  const h = cur();
  if(!h.athletes.some(a=>a.lane===lane))return;
  if (col == null || !(['review', 'saved'].includes(h.state) || (h.state === 'running' && col <= h.liveCol))) return;   // marking works while capturing too
  const p = h.proposals && h.proposals.find(x => x.lane === lane);
  const src = p ? (p.col === col ? 'checked' : 'edited') : 'manual';
  if (h.dismissed) delete h.dismissed[lane];
  const display=p?.col===col?null:viewHeat().displaySource,time=colTime(h,col),nativeColumn=display?(time-display.t)/display.p-0.5:null;
  if(display&&(nativeColumn<-.5||nativeColumn>=display.w-.5)){toast('This camera has no captured image at that time.',true);return;}
  h.marks[lane] = { col, src, ...(display?{cameraId:display.id,cameraColumn:nativeColumn}:{cameraId:h.asset?.mainCameraId}) };
  if (h.status[lane] && h.status[lane] !== 'DQ') delete h.status[lane];
  editHeat(h); renderUI();
}
function setStatus(lane, code) {
  const h = cur();
  if (!code || h.status[lane] === code) delete h.status[lane];
  else { h.status[lane] = code; if (code !== 'DQ') delete h.marks[lane]; }
  editHeat(h); renderUI();
}
function clearMarks() {
  const h = cur(), n = Object.keys(h.marks).length;
  if (!n) return;
  h.marks = {}; editHeat(h);
  toast(`Cleared ${n} mark${n > 1 ? 's' : ''}. Revert brings them back.`);
  renderUI();
}
function revert() {
  const h = cur();
  if (!h.base || h.base === snap(h)) return;
  const b = JSON.parse(h.base);
  h.marks = b.marks; h.status = b.status;
  h.state = h.saves ? 'saved' : 'review';
  toast(h.saves ? 'Reverted to the last saved results.' : 'Reverted to the capture as it closed.');
  renderUI();
}
const resolved = (h, a) => !!(h.marks[a.lane] || h.status[a.lane]);
// Results for the engine's LIF writer (engine/meetlink/lif.js buildLif).
function lifRequest(h) {
  const d = h.startTOD, tod = d ? d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000 : null;
  return {
    dir: S.meet.resultsDir || S.meet.dir, captureId:h.captureId || null,review:{at:new Date().toISOString(),cameraId:h.asset?.mainCameraId,timeOrigin:h.tOpen,columnPeriod:periodOf(h),marks:h.marks,status:h.status,startCorrection:h.startCorrection||0,...(h.sourceRef?{sourceRef:h.sourceRef}:{})},
    heat: { event: h.ev, round: h.rd, heat: h.ht, name: h.name, wind: h.wind == null ? '' : (h.wind >= 0 ? '+' : '') + h.wind.toFixed(1), windUnit: h.wind == null ? '' : 'm/s', startTimeOfDay: tod },
    results: h.athletes.map(a => {
      const st = h.status[a.lane], mk = h.marks[a.lane];
      return { id: a.id, lane: a.lane, last: a.last, first: a.first, affiliation: a.team.name, startTimeOfDay: tod, ...(st ? { status: st } : {}), ...(mk && (!st || st === 'DQ') ? { time: raceTime(h, mk.col) } : {}) };
    }),
  };
}
async function save() {
  const h = cur();
  if (h.saving || h.state !== 'review' || !h.athletes.every(a => resolved(h, a))) return;
  let where = '';
  if (OM && S.meet) {
    h.saving = true;
    try {
      const r = await OM.call('lif.save', lifRequest(h));
      h.lif = r.text; h.lifName = r.name; where = r.path;
    } catch (err) {
      toast(`Could not write ${h.lifName}: ${err.message}. The heat is not saved.`, true);
      return;
    } finally { h.saving = false; }
  } else h.lif = lifText(h);
  h.saves++; h.state = 'saved'; h.base = snap(h);
  const f = S.files.find(x => x.name === h.lifName);
  const entry = { name: h.lifName, at: new Date(), bytes: h.lif.length, v: h.saves, text: h.lif, path: where };
  if (f) Object.assign(f, entry); else S.files.push(entry);
  const nextI = S.idx + 1, nxt = HEATS[nextI], again = h.saves > 1 ? ` (rewrite ${h.saves})` : '';
  if (nxt && nxt.state === 'loaded') {
    toast(`Wrote ${h.lifName}${again}. Next heat loaded${S.autoArm ? ' and armed' : ''}.`);
    setTimeout(() => { if (cur() === h && h.state === 'saved') go(nextI); }, 900);
  } else toast(`Wrote ${h.lifName}${again}.${nxt ? '' : ' Schedule complete.'}`);
  renderUI();
}

// ---------------------------------------------------------------- warnings: the one most important problem
const andList = a => (a.length < 2 ? String(a[0]) : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
function warnings(h) {
  const w = [];
  if (h.state === 'running') return [{ k: 'info', t: S.autoMark ? 'Capturing. Suggested times appear as athletes finish; you can mark as they come in.' : 'Capturing. You can mark finishes as they come in.' }];
  if (h.state === 'loaded') return [{ k: 'info', t: 'Heat loaded from lynx.evt. Arm when the starter is ready.' }];
  if (h.state === 'armed') return [{ k: 'info', t: 'Armed. Waiting for the start signal.' }];
  if (h.req === 'offline') w.push({ k: 'warn', t: 'Auto-timing is offline. Mark finishes by hand; capture is unaffected.' });
  if (h.req === 'error') w.push({ k: 'warn', t: `Auto-timing failed (${h.reqErr}). Mark finishes by hand, or press Auto-mark to retry.` });
  if (h.req === 'pending') w.push({ k: 'info', t: h.replaySourceType==='real'&&S.atInfo?.stub?'Loading recorded results. You can mark by hand meanwhile.':'Timing: AI suggestions are on the way. You can mark by hand meanwhile.' });
  if (h.req === 'idle' && !h.proposals && h.state === 'review') w.push({ k: 'info', t: 'Capture closed. Mark finishes, or press Auto-mark.' });
  const rev = (h.proposals || []).filter(p => p.decision === 'review' && !h.marks[p.lane] && !h.status[p.lane]);
  if (rev.length) {
    const close = rev.filter(p => p.reason.startsWith('close'));
    if (close.length) w.push({ k: 'warn', t: `Lanes ${andList(close.map(p => p.lane))}: close finish. Check ${close.length === 2 ? 'both' : 'each'} before saving.` });
    const low = rev.filter(p => !p.reason.startsWith('close'));
    if (low.length) w.push({ k: 'warn', t: `Lane ${andList(low.map(p => p.lane))}: low-confidence proposal. Check it before saving.` });
  }
  if (h.req === 'done') {
    h.athletes.filter(a => !resolved(h, a) && !(h.proposals || []).some(p => p.lane === a.lane))
      .forEach(a => w.push({ k: 'warn', t: `Lane ${a.lane}: no finish detected. Mark it, or set DNF.` }));
  }
  const open = h.athletes.filter(a => !resolved(h, a)).length;
  if (open && !w.length) w.push({ k: 'warn', t: `${open} athlete${open > 1 ? 's' : ''} still need a time or a status.` });
  if (!open && h.state === 'review') w.push({ k: 'ok', t: 'Every athlete has a time or a status. Ready to save.' });
  if (h.state === 'saved') w.push({ k: 'ok', t: `Saved ${h.lifName} to the meet folder.` });
  return w;
}

// ---------------------------------------------------------------- header + sidebar
const TABS = [['run', 'Run'], ['events', 'Meet'], ['alignment', 'Camera alignment'], ['board', 'Scoreboard'], ['network', 'Network'], ['meet', 'Meet Link'], ['api', 'Auto-Timing'], ['starts', 'Starts'], ['settings', 'Settings']];
function renderTabs() {
  const n = $('#tabs'); n.innerHTML = '';
  TABS.forEach(([k, label]) => {
    const b = h_('button', 'tab' + (S.tab === k ? ' on' : ''), label);
    b.disabled=!!(S.cameraSetup?.starting||S.cameraSetup?.stopping)||(k==='alignment'&&!!runningHeat());
    if(k==='alignment'&&!!runningHeat())b.title='Stop race capture before entering camera alignment';
    b.onclick = async () => {
      if(k==='alignment'){if(!S.cameraSetup)await startCameraSetup();else {S.tab=k;renderUI();}return;}
      if(S.cameraSetup){await stopCameraSetup(true);if(S.cameraSetup)return;}
      S.tab=k;renderUI();
    };
    n.append(b);
  });
}
function renderStatus() {
  // quiet by default: a dot and a word; detail on hover; only a problem gets colour and words
  const chips = [
    ['Cameras', true, replayCameras(cur()).folder ? 'Local recorded inputs; see Accessories for available cameras' : 'Built-in simulated cameras'],
    [S.meet || !OM ? 'Meet folder' : 'Sample meet', true, S.meet ? 'Watching ' + S.meet.dir : OM ? 'No meet folder open (Meet Link)' : 'Watching C:\\Meets\\2026-10-28-sim\\'],
    ['Internet', true, 'Online'],
    ['Auto-timing', S.apiOnline, S.apiOnline ? 'Reachable' : 'unreachable'],
  ];
  $('#status').innerHTML = chips.map(([k, ok, detail]) =>
    `<span class="chip${ok ? '' : ' alert'}" title="${detail}"><span class="dot ${ok ? 'ok' : 'warn'}"></span>${k}${ok ? '' : ' ' + detail}</span>`).join('') +
    '<span class="tod" id="tod"></span>';
  tickTod();
}
function tickTod() { const t = $('#tod'); if (t) t.textContent = new Date().toTimeString().slice(0, 8); }

function renderSide() {
  if(S.cameraSetup){renderSetupSidebar();return;}
  const h = cur();
  const stLabel = { loaded: 'LOADED', armed: 'ARMED', running: 'RUNNING', review: 'REVIEW', saved: 'SAVED' }[h.state];
  $('#ev').innerHTML = `
    <div class="ev-top"><span class="kicker">Event ${h.ev} · Round ${h.rd} · Heat ${h.ht}${h.of?` of ${h.of}`:''}</span><span class="state ${h.state}">${stLabel}</span></div>
    <div class="ev-name">${h.name}</div>
    <div class="ev-sub">${S.idx + 1} of ${HEATS.length} in schedule · ${h.athletes.length} athletes${h.replaySourceType==='real'?' · Real-recorded replay':''}</div>`;
  const active=runningHeat();
  if(active&&active!==h){const back=h_('button','background-capture',`Recording E${active.ev} · H${active.ht} — return to live`);back.onclick=()=>{S.tab='run';go(HEATS.indexOf(active));};$('#ev').append(back);}
  const ctl = $('#ctl'); ctl.innerHTML = '';
  const running = h.state === 'running';
  const actions=h_('div','race-actions wide');
  const btn = (html, cls, on, dis) => { const b = h_('button', 'btn ' + cls); b.innerHTML = html; b.onclick = on; b.disabled = !!dis; actions.append(b); return b; };
  const nav=h_('div','heat-nav wide');
  const prev=h_('button','btn sm'),next=h_('button','btn sm');prev.innerHTML=ICON.prev;next.innerHTML=ICON.next;
  prev.title='Previous heat';prev.setAttribute('aria-label','Previous heat');prev.disabled=S.idx===0;prev.onclick=()=>go(S.idx-1);
  next.title='Next heat';next.setAttribute('aria-label','Next heat');next.disabled=S.idx===HEATS.length-1;next.onclick=()=>go(S.idx+1);
  nav.append(prev,h_('span','dimtext',`Heat ${h.ht}${h.of?` of ${h.of}`:''}`),next);ctl.append(nav);
  const ready=h.state==='review'&&h.athletes.every(a=>resolved(h,a));
  if(running)btn(h.stopping?'Stopping…':'Stop capture','go wide',stopCapture,h.stopping);
  else if(h.state==='loaded')btn('Arm heat','primary wide',arm);
  else if(h.state==='armed')btn(`Start <span class="tag sim">${h.replaySourceType==='real'?'REPLAY':'SIM'}</span>`,'go wide',fire,!!runningHeat()||S.sourceChanging||!replayCameras(h).primary);
  else if(h.state==='review'&&ready)btn(h.saves?'Save corrected results':'Save results','go wide',save);
  else if(h.state==='review')btn('Review next finish','primary wide',()=>{const a=h.athletes.find(a=>!resolved(h,a));if(a)selectLane(a.lane);});
  else btn('Next heat','primary wide',()=>go(S.idx+1),S.idx===HEATS.length-1);
  const reset=btn(ICON.revert+(running?'Stop/reset':'Restart'),'warn race-reset',confirmRaceReset,h.stopping||h.saving);
  reset.id='raceReset';reset.title=running?'Stop or restart this race':'Restart this race';reset.setAttribute('aria-haspopup','dialog');
  ctl.append(actions);
  const opts=h_('details','capture-options wide');opts.open=!!S.captureOptionsOpen;
  opts.innerHTML=`<summary>Capture options <span>${S.autoStop==='manual'?'Manual stop':S.autoStop==='timeout'?`Stop after ${S.stopAfter}s`:'Stop when complete'}</span></summary>
    <div class="capture-option-fields"><label><span>Auto-arm next heat</span><input id="autoArm" type="checkbox" ${S.autoArm?'checked':''}></label>
    <label><span>Auto-stop</span><select id="stopMode" ${running?'disabled':''}><option value="manual">Off · manual</option><option value="timeout">After timeout</option><option value="complete">All runners marked</option></select></label>
    ${S.autoStop==='timeout'?`<label><span>Timeout (seconds)</span><input id="stopAfter" type="number" min="1" max="86400" value="${S.stopAfter}" ${running?'disabled':''}></label>`:''}
    <div class="capture-secondary"></div></div>`;
  opts.ontoggle=()=>{S.captureOptionsOpen=opts.open;};ctl.append(opts);
  opts.querySelector('#autoArm').onchange=e=>{S.autoArm=e.target.checked;store.set('autoArm',S.autoArm);if(S.autoArm&&h.state==='loaded')h.state='armed';renderUI();};
  opts.querySelector('#stopMode').value=S.autoStop;
  opts.querySelector('#stopMode').onchange=e=>{S.autoStop=e.target.value;store.set('autoStop',S.autoStop);renderUI();};
  const timeoutInput=opts.querySelector('#stopAfter');if(timeoutInput)timeoutInput.onchange=e=>{S.stopAfter=Math.max(1,Math.min(86400,Number(e.target.value)||60));store.set('stopAfter',S.stopAfter);};
  if(h.state==='armed'||running){const secondary=h_('button','btn sm',running?'Recall false start':'Disarm');secondary.onclick=running?recall:disarm;opts.querySelector('.capture-secondary').append(secondary);}
  const problems=warnings(h).filter(w=>w.k==='warn'),top=problems[0];
  $('#warn').innerHTML=top?`<div class="sidebar-problem">${ICON.warn}<span>${esc(top.t)}</span></div>`:'';
  if(h.replaySourceType&&!h.asset)$('#warn').prepend(h_('p','dimtext','No recorded line-scan for this heat. Choose a heat with a recording.'));
  const progress=h_('div','roster-progress');progress.innerHTML=`<div class="roster-order" role="group" aria-label="Athlete list order"><button data-order="lane" aria-pressed="${S.rosterOrder==='lane'}">Lane</button><button data-order="finish" aria-pressed="${S.rosterOrder==='finish'}">Finish</button></div><span>${h.athletes.filter(a=>resolved(h,a)).length} / ${h.athletes.length} resolved</span>`;
  progress.querySelectorAll('[data-order]').forEach(b=>{b.onclick=()=>{S.rosterOrder=b.dataset.order;store.set('rosterOrder',S.rosterOrder);renderSide();};});$('#warn').append(progress);

  const { pl } = places(h);
  const list = $('#list'); list.innerHTML = '';
  const orderColumn=a=>h.status[a.lane]?Infinity:(h.marks[a.lane]?.col??h.proposals?.find(p=>p.lane===a.lane)?.col??Infinity);
  [...h.athletes].sort((a,b)=>{
    if(S.rosterOrder==='finish'){const ac=orderColumn(a),bc=orderColumn(b);if(ac!==bc)return ac<bc?-1:1;}
    return a.lane-b.lane;
  }).forEach(a => {
    const row = h_('div', 'row' + (S.selLane === a.lane ? ' sel' : ''));
    const mk = h.marks[a.lane], st = h.status[a.lane], p = h.proposals && h.proposals.find(x => x.lane === a.lane);
    let res;
    if (st) {
      res = `<span class="tag ${st === 'DQ' ? 'bad' : 'review'}">${st}</span>${st === 'DQ' && mk ? `<span class="sub num">${official(raceTime(h, mk.col))}</span>` : ''}`;
    } else if (mk) {
      const src = { auto: ['AUTO', 'auto'], checked: ['CHECKED', 'info'], edited: ['EDITED', 'info'], manual: ['MANUAL', 'info'] }[mk.src];
      res = `<span class="t" title="${fmtT(raceTime(h,mk.col))} s">${official(raceTime(h,mk.col))}</span><span class="sub"><span class="num">P${pl[a.lane]}</span><span class="result-source" title="${h.reference&&mk.src==='auto'?'Recorded results':h.stub&&mk.src==='auto'?'STAND-IN':src[0]}">${mk.src==='auto'?(h.reference?'Recorded':h.stub?'Stand-in':'AI'):mk.src==='manual'?'Manual':'Checked'}</span></span>`;
    } else if (p) {
      res = `<span class="t prop">${official(raceTime(h, p.col))}</span><span class="sub"><span class="tag review">REVIEW</span></span>`;
    } else {
      res = `<span class="t prop">${running ? 'racing' : '—'}</span><span class="sub">${h.state === 'review' || h.state === 'saved' ? 'no time' : 'pending'}</span>`;
    }
    row.innerHTML = `
      <div class="lane">${a.lane}</div>
      <div class="who"><div class="nm">${a.last}, ${a.first}</div><div class="sc">${a.team.name}${a.id==null||a.id===''?'':` <span class="athlete-id">· #${esc(a.id)}</span>`}</div></div>
      <div class="res">${res}</div>`;
    row.onclick = e => { if (e.target.closest('button,select,input')) return; selectLane(a.lane); };
    if (S.selLane === a.lane) {
      const rc = h_('div', 'rowctl');
      if (p && !mk && !st) {
        const accept = h_('button', 'btn sm primary', 'Accept time');
        accept.title = `Accept ${official(raceTime(h,p.col))} for lane ${a.lane}`;
        accept.onclick = e => { e.stopPropagation(); setMark(a.lane,p.col); };
        rc.append(accept);
      }
      const status=h_('select','athlete-status');status.setAttribute('aria-label',`Race status for ${a.first} ${a.last}`);
      status.innerHTML='<option value="">Race status…</option>'+['DNS','DNF','DQ','FS'].map(c=>`<option value="${c}">${c}</option>`).join('');status.value=st||'';
      status.onchange=e=>setStatus(a.lane,e.target.value);rc.append(status);
      if(mk){const exact=h_('span','num dimtext',fmtT(raceTime(h,mk.col))+' s');rc.append(exact);const clear=h_('button','btn sm clear-athlete');clear.innerHTML=ICON.trash;clear.title='Clear finish mark';clear.setAttribute('aria-label','Clear finish mark');clear.onclick=deleteSelectedFinish;rc.append(clear);}
      row.append(rc);
    }
    list.append(row);
  });
}
function selectLane(lane) {
  S.entryNumber = '';
  S.selLane = lane;
  const h = cur();
  if (lane != null) {
    const mk = h.marks[lane], p = h.proposals && h.proposals.find(x => x.lane === lane);
    const col = mk ? mk.col : p ? p.col : null;
    if (col != null) { S.selCol = col; S.hoverCol = null; focusFinish(col); }
  }
  renderUI();
}

// ---------------------------------------------------------------- workspace panels
function renderRace() {
  if(S.cameraSetup){const p=S.cameraSetup,h=p.heat;$('#race').innerHTML=`<div class="setup-summary"><h3>${p.mode==='alignment'?'Camera alignment':'Overlay setup'}</h3><p>${p.live?'Preview streaming':p.starting?'Starting…':'Preview paused'}</p><dl class="kv"><dt>Image height</dt><dd>${rowsOf(h)} rows</dd><dt>Received</dt><dd>${h.recvCols||0} columns</dd></dl><p class="dimtext">Race capture and start triggers are unaffected.</p></div>`;return;}
  const h = cur();
  const done = ['review', 'saved'].includes(h.state);
  const marked = h.athletes.filter(a => resolved(h, a)).length;
  $('#race').innerHTML = `
    <div class="clock" id="clock">0.0</div>
    <div class="clocksub" id="clocksub"></div>
    <dl class="kv">
      <dt>Start (time of day)</dt><dd>${h.startTOD ? todStr(h.startTOD).slice(0, 12) : '—'}</dd>
      <dt>Wind</dt><dd>${done ? windStr(h) : '—'}</dd>
      <dt>Capture window</dt><dd>${h.state === 'loaded' || h.state === 'armed' ? '—' : fmtT(h.tOpen, 2) + ' – ' + fmtT(h.tClose, 2) + ' s'}</dd>
      <dt>Resolved</dt><dd>${marked} / ${h.athletes.length}</dd>
    </dl>`;
  const attempts=attemptsByHeat.get(attemptKey(h));
  if(attempts?.length>1){
    const wrap=h_('label','race-attempts');wrap.textContent='Attempt ';
    const select=h_('select');select.setAttribute('aria-label','Race attempt');select.disabled=h.state==='running';
    select.innerHTML=attempts.map((a,i)=>`<option value="${i}" ${a===h?'selected':''}>${i+1} · ${a.startTOD?todStr(a.startTOD).slice(0,12):'Not started'} · ${a.state}</option>`).join('');
    select.onchange=e=>selectAttempt(+e.target.value);wrap.append(select);$('#race').append(wrap);
  }
  tickClock();
}
function tickClock() {
  const h = cur(), c = $('#clock'), sub = $('#clocksub');
  if (!c) return;
  const done = ['review', 'saved'].includes(h.state), win = done ? places(h).fin[0] : null;
  const text=h.state==='running'?(Math.floor((h.tNow-(h.startCorrection||0))*10)/10).toFixed(1):win?official(raceTime(h,h.marks[win.lane].col)):done?'--.--':'0.0';
  if(c.textContent!==text)c.textContent=text;
  c.style.color = h.state === 'running' || win ? 'var(--paper)' : 'var(--dim)';
  const lead = h.state === 'running' ? places(h).fin[0] : null;
  if (sub) sub.textContent = win ? `Winner: lane ${win.lane}, ${win.first} ${win.last}`
    : lead ? `First: lane ${lead.lane} · ${official(raceTime(h, h.marks[lead.lane].col))}`
    : h.state === 'running' ? 'Running time' : h.state === 'armed' ? 'Waiting for the start' : done ? 'No finishes marked yet' : 'Not armed';
}
// The whole meet in run order: each event's heats, their state and, once saved, the winner and results file.
function renderSchedule() {
  const box = $('#schedule');
  if (!box) return;
  const label = { loaded: 'LOADED', armed: 'ARMED', running: 'RUNNING', review: 'REVIEW', saved: 'SAVED' };
  let html = '', lastKey = null;
  HEATS.forEach((h, i) => {
    const key = `${h.ev}|${h.rd}|${h.name}`;
    if (key !== lastKey) { html += `<div class="sch-ev"><span class="num">E${esc(h.ev)}</span> ${esc(h.name)} <span class="dimtext">· R${h.rd}</span></div>`; lastKey = key; }
    const win = h.state === 'saved' || h.state === 'review' ? places(h).fin[0] : null;
    const done = h.athletes.filter(a => resolved(h, a)).length;
    const detail = h.state === 'saved' ? `<span class="num">${win ? official(raceTime(h, h.marks[win.lane].col)) : '—'}</span> · <span class="num">${h.lifName}</span>`
      : h.state === 'review' ? `${done} / ${h.athletes.length} resolved` : `${h.athletes.length} athletes`;
    html += `<div class="sch-row${i === S.idx ? ' cur' : ''}" data-i="${i}"><span class="num">H${h.ht}</span><span class="sch-d">${detail}</span><span class="state ${h.state}">${label[h.state]}</span></div>`;
  });
  box.innerHTML = html;
  box.querySelectorAll('.sch-row').forEach(r => { r.onclick = () => go(+r.dataset.i); });
}
function renderAcc() {
  const h = cur();
  const cameras=replayCameras(h),recorded=h.replaySourceType==='real',source=recorded?'real-recorded replay':h.asset?'TTP simulator':'built-in sim';
  const start = { loaded: 'idle', armed: 'armed', running: 'fired', review: 'fired', saved: 'fired' }[h.state];
  const cap = h.state === 'running' ? (h.liveCol >= 0 ? 'capturing' : 'waiting') : 'idle';
  const rows = [
    [cameras.primary?'ok':'', h.asset?.mainCameraLabel||'Primary line-scan', '', cameras.primary?`${source} · ${cap}`:'absent'],
    [cameras.comparison?'ok':'', h.asset?.comparisonCameraLabel||'Backup line-scan', '', cameras.comparison?`${source} · ${cap}`:'absent'],
    [cameras.front?'ok':'', 'Front camera', '', cameras.front?(cameras.folder?'recording available':'sim · streaming'):'absent'],
    ['ok', 'Start system', '', `replay clock · ${start}`],
    h.wind == null ? ['', 'Wind gauge', '', 'not connected'] : ['ok', 'Wind gauge', '.41', ['review', 'saved'].includes(h.state) ? `sim · ${windStr(h)}` : 'sim · ready'],
    ['', 'Scoreboard', '', 'not configured'],
  ];
  $('#acc').innerHTML = `<div class="acc">${rows.map(([d, n, ip, s]) => `<span class="dot ${d}"></span><span class="nm" title="${ip ? '192.168.0' + ip : ''}">${esc(n)}</span><span class="st">${esc(s)}</span>`).join('')}</div>`;
}

function renderSimulationSources(body) {
  const card=h_('div','card');card.id='simulationSources';card.append(h_('h3','','Simulation source'));
  const label=h_('label'),select=h_('select');select.id='simulationSource';select.setAttribute('aria-label','Simulation source');
  for(const choice of sourceChoices(S.simulationCatalog)){const o=h_('option','',choice.label);o.value=choice.value;select.append(o);}
  select.value=S.simulationSource?.id||'builtin';select.disabled=!OM||!!runningHeat()||S.sourceChanging;
  select.title=sourceLabel(S.simulationSource);
  select.onchange=()=>select.value.startsWith('import:')?importSimulationSource(select.value.slice(7)):openDemo(null,{id:select.value});
  label.append(select);card.append(label);
  const buttons=h_('p');
  for(const [type,text]of[['ttp','Import TTP folder…'],['real','Import real meet replay…']]){
    const b=h_('button','btn sm',text);b.id=type==='real'?'importRealSource':'importTtpSource';b.disabled=select.disabled;b.onclick=()=>importSimulationSource(type);buttons.append(b,document.createTextNode(' '));
  }
  card.append(buttons);
  if(S.simulationSource?.path)card.append(h_('p','num',S.simulationSource.path));
  card.append(h_('p','dimtext',runningHeat()?'Stop capture before changing sources. The current recording stays active.':S.sourceChanging?'Opening source…':S.simulationSource?.type==='real'?'Real-recorded still timing source · original pixels and native column times. Saved reference suggestions are labelled RECORDED RESULTS.':'Simple built-in uses generated sample images. TTP and real meet sources load local folders with their own start lists.'));
  if(!OM)card.append(h_('p','dimtext','Folder sources are available in the desktop app.'));
  body.prepend(card);
}
function renderProps() {
  if(S.cameraSetup){$('#apiState').textContent='Setup';$('#props').innerHTML='<div class="empty">Timing suggestions are paused during camera setup.</div>';return;}
  const h = cur();
  const standIn=h.stub||(S.atInfo?.stub&&h.asset&&replayReferenceTiming(h));
  const reference=h.reference||(h.replaySourceType==='real'&&standIn),badge=standIn?`<span class="tag sim" title="${reference?'Recorded reference playback; no model predictions':'Echoes saved simulator answers; not a model'}">${reference?'RECORDED RESULTS':'STAND-IN'}</span>`:'';
  $('#apiState').innerHTML = !S.apiOnline ? '<span class="dot warn"></span>offline' :
    h.req === 'pending' ? `${badge}<span class="dot warn"></span>${reference?'loading…':'timing…'}` :
    h.req === 'error' ? '<span class="dot warn"></span>failed' :
    h.req === 'live' ? `${badge}<span class="dot ok"></span>live` :
    h.req === 'done' ? `${badge}<span class="dot ok"></span>${h.reqMs} ms` : `${badge}<span class="dot ok"></span>`;
  if(h.inputDerived) $('#apiState').append(h_('span','tag info','GUIDED INPUT'));
  if(viewHeat().asset?.mainCameraId!==h.asset?.mainCameraId){const source=h_('span','timing-source',h.asset.mainCameraLabel);source.title='Auto-timing uses this recorded camera';$('#apiState').prepend(source);}
  const box = $('#props');
  if (h.req === 'offline' || h.req === 'error') {
    box.innerHTML = `<div class="empty">${h.req === 'error' ? 'Auto-timing failed: ' + esc(h.reqErr || '') + '.' : 'The auto-timing service could not be reached.'} Every lane can still be marked by hand.</div>`;
    return;
  }
  if (!h.proposals) {
    if(reference){box.innerHTML='<div class="empty">Recorded results replay saved reference points. Untimed athletes stay unresolved. These are not model detections.</div>';return;}
    box.innerHTML = `<div class="empty">${h.req === 'pending' ? `Timing… ${Math.round((performance.now() - h.reqStart) / 1000)} s. Mark finishes by hand meanwhile; suggestions only fill lanes you have not marked.` : S.autoMark ? 'AI-suggested finish times appear as athletes cross the line, for your review. Finishes within 0.02 s of a neighbour always need a check.' : 'Auto-mark is off. Press Auto-mark on the line-scan bar to ask for suggested times.'}</div>`;
    return;
  }
  const tb = h_('table', 'props');
  h.proposals.forEach(p => {
    const a = h.athletes.find(x => x.lane === p.lane), mk = h.marks[p.lane], st = h.status[p.lane];
    let outcome = '<span class="tag mute">PENDING</span>';
    if (st) outcome = `<span class="tag mute">${st}</span>`;
    else if (mk && mk.src === 'auto') outcome = '<span class="tag auto">ACCEPTED</span>';
    else if (mk && mk.src === 'checked') outcome = '<span class="tag info">CHECKED</span>';
    else if (mk) outcome = '<span class="tag info">OVERRIDDEN</span>';
    const tr = h_('tr');
    tr.innerHTML = `<td class="num"><b>L${p.lane}</b></td><td>${a.last}</td><td class="num">${fmtT(raceTime(h, p.col))}</td><td class="num"><b>${official(raceTime(h, p.col))}</b></td>
      <td><span class="tag ${p.decision}">${p.decision.toUpperCase()}</span></td><td class="why">${p.reason || 'conf ' + p.conf.toFixed(3)}</td><td>${outcome}</td><td></td>`;
    if (p.decision === 'review' && !mk && !st) {
      const b = h_('button', 'btn sm', 'Accept');
      b.onclick = e => { e.stopPropagation(); setMark(p.lane, p.col); };
      tr.lastElementChild.append(b);
    }
    tr.onclick = () => selectLane(p.lane);
    tb.append(tr);
  });
  box.innerHTML = ''; box.append(tb);
}

// ---------------------------------------------------------------- tiling workspace (dwindle-style split tree)
// A leaf is a panel id; a split is {d: 'row' | 'col', r: ratio, a, b}. 'row' places a and b side by side.
const PANELS = { race: 'Race', front: 'Front camera', backup: 'Backup line-scan', schedule: 'Schedule', acc: 'Accessories', props: 'Auto-timing' };
const DEFAULT_LAYOUT = { d: 'col', r: 0.56, a: { d: 'row', r: 0.28, a: 'race', b: { d: 'row', r: 0.48, a: 'front', b: 'backup' } }, b: { d: 'row', r: 0.3, a: 'schedule', b: { d: 'row', r: 0.64, a: 'props', b: 'acc' } } };
const GAP = 8;
const leaves = n => (!n ? [] : typeof n === 'string' ? [n] : [...leaves(n.a), ...leaves(n.b)]);
const removeLeaf = (n, id) => {
  if (n === id) return null;
  if (!n || typeof n === 'string') return n;
  const a = removeLeaf(n.a, id), b = removeLeaf(n.b, id);
  return !a ? b : !b ? a : { ...n, a, b };
};
const replaceLeaf = (n, id, rep) => (n === id ? rep : !n || typeof n === 'string' ? n : { ...n, a: replaceLeaf(n.a, id, rep), b: replaceLeaf(n.b, id, rep) });
const swapLeaves = (n, x, y) => (typeof n === 'string' ? (n === x ? y : n === y ? x : n) : { ...n, a: swapLeaves(n.a, x, y), b: swapLeaves(n.b, x, y) });
function validLayout(n) {
  const ls = leaves(n);
  return ls.every(l => PANELS[l]) && new Set(ls).size === ls.length;
}
const panelEl = id => document.querySelector(`.pnl[data-p="${id}"]`);
function saveLayout() { store.set('layout2', S.layout); }
function renderTiles() {
  const host = $('#tiles'), W = host.clientWidth, H = host.clientHeight;
  host.querySelectorAll('.gut').forEach(g => g.remove());
  S.rects = {};
  const place = (n, x, y, w, h) => {
    if (typeof n === 'string') {
      const el = panelEl(n);
      if (el.parentNode !== host) host.append(el);
      Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
      S.rects[n] = { x, y, w, h };
      return;
    }
    const row = n.d === 'row', span = (row ? w : h) - GAP, sa = span * n.r;
    if (row) { place(n.a, x, y, sa, h); place(n.b, x + sa + GAP, y, span - sa, h); }
    else { place(n.a, x, y, w, sa); place(n.b, x, y + sa + GAP, w, span - sa); }
    const g = h_('div', 'gut ' + n.d);
    Object.assign(g.style, row ? { left: x + sa + 'px', top: y + 'px', width: GAP + 'px', height: h + 'px' } : { left: x + 'px', top: y + sa + 'px', width: w + 'px', height: GAP + 'px' });
    g.onmousedown = e => {
      e.preventDefault();
      const r0 = host.getBoundingClientRect();
      const move = ev => {
        const pos = row ? ev.clientX - r0.left - x : ev.clientY - r0.top - y;
        n.r = Math.max(0.12, Math.min(0.88, pos / span));
        renderTiles();
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); saveLayout(); };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    };
    host.append(g);
  };
  if (S.max && leaves(S.layout).includes(S.max)) place(S.max, 0, 0, W, H);
  else if (S.layout) place(S.layout, 0, 0, W, H);
  Object.keys(PANELS).forEach(id => { if (!S.rects[id]) $('#pool').append(panelEl(id)); });
  $('#emptyWs').style.display = S.layout ? 'none' : 'flex';
  $('.wsadd').classList.toggle('show', leaves(S.layout).length < Object.keys(PANELS).length);
  invalidate();
}
function closePanel(id) { S.layout = removeLeaf(S.layout, id); if (S.max === id) S.max = null; saveLayout(); renderTiles(); }
function addPanel(id) {
  if (!S.layout) S.layout = id;
  else {
    const [target] = Object.entries(S.rects).sort((a, b) => b[1].w * b[1].h - a[1].w * a[1].h)[0] || [];
    const r = S.rects[target];
    S.layout = replaceLeaf(S.layout, target, { d: r.w >= r.h ? 'row' : 'col', r: 0.5, a: target, b: id });
  }
  S.max = null; saveLayout(); renderTiles();
}
function renderAddMenu() {
  const m = $('#addMenu'); m.innerHTML = '';
  const hidden = Object.keys(PANELS).filter(id => !leaves(S.layout).includes(id));
  hidden.forEach(id => { const b = h_('button', '', 'Add ' + PANELS[id]); b.onclick = () => { addPanel(id); m.classList.remove('open'); }; m.append(b); });
  if (hidden.length) m.append(h_('div', 'sep'));
  const rb = h_('button', '', 'Reset layout');
  rb.onclick = () => { S.layout = JSON.parse(JSON.stringify(DEFAULT_LAYOUT)); S.max = null; saveLayout(); renderTiles(); m.classList.remove('open'); };
  m.append(rb);
}
function initTiles() {
  const saved = store.get('layout2', null);
  S.layout = saved !== null && validLayout(saved) ? saved : JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  document.querySelectorAll('.pnl[data-p]').forEach(el => {
    const id = el.dataset.p, ph = el.querySelector('.ph');
    let r = ph.querySelector('.r');
    if (!r) { r = h_('span', 'r'); ph.append(r); }
    const x = h_('button', 'x'); x.innerHTML = ICON.close; x.title = 'Close panel';
    x.onclick = e => { e.stopPropagation(); closePanel(id); };
    ph.append(x);
    ph.title = 'Drag to move · double-click to maximise';
    ph.ondblclick = e => { if (e.target.closest('button')) return; S.max = S.max === id ? null : id; renderTiles(); };
    ph.onmousedown = e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const t = { id, x0: e.clientX, y0: e.clientY, moved: false, target: null, zone: null };
      const drop = $('#drop'), host = $('#tiles');
      const move = ev => {
        if (!t.moved && Math.hypot(ev.clientX - t.x0, ev.clientY - t.y0) < 6) return;
        t.moved = true; document.body.classList.add('grabbing');
        const hr = host.getBoundingClientRect(), px = ev.clientX - hr.left, py = ev.clientY - hr.top;
        const hit = Object.entries(S.rects).find(([k, rc]) => k !== id && px >= rc.x && px <= rc.x + rc.w && py >= rc.y && py <= rc.y + rc.h);
        if (!hit) { drop.style.display = 'none'; t.target = null; return; }
        const [k, rc] = hit, fx = (px - rc.x) / rc.w, fy = (py - rc.y) / rc.h;
        const edges = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
        const [edge, dist] = Object.entries(edges).sort((a, b) => a[1] - b[1])[0];
        t.target = k; t.zone = dist > 0.3 ? 'swap' : edge;
        const z = { swap: [0, 0, 1, 1], left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5] }[t.zone];
        Object.assign(drop.style, { display: 'block', left: rc.x + z[0] * rc.w + 'px', top: rc.y + z[1] * rc.h + 'px', width: z[2] * rc.w + 'px', height: z[3] * rc.h + 'px' });
      };
      const up = () => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        document.body.classList.remove('grabbing'); drop.style.display = 'none';
        if (!t.moved || !t.target) return;
        if (t.zone === 'swap') S.layout = swapLeaves(S.layout, id, t.target);
        else {
          const split = { left: { d: 'row', a: id, b: t.target }, right: { d: 'row', a: t.target, b: id }, top: { d: 'col', a: id, b: t.target }, bottom: { d: 'col', a: t.target, b: id } }[t.zone];
          S.layout = replaceLeaf(removeLeaf(S.layout, id), t.target, { ...split, r: 0.5 });
        }
        S.max = null; saveLayout(); renderTiles();
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    };
  });
  $('#addBtn').onclick = e => { e.stopPropagation(); renderAddMenu(); $('#addMenu').classList.toggle('open'); };
  document.addEventListener('click', e => { if (!e.target.closest('.wsadd')) $('#addMenu').classList.remove('open'); });
  renderTiles();
}

// ---------------------------------------------------------------- header drawers
// Start pulses are retained for the entire meet; assigning one changes only elapsed time.
function renderStarts(body) {
  const h = cur(), key = `${h.ev}-${h.rd}-${h.ht}`;
  body.innerHTML = `<div class="card" style="grid-column:1/-1"><h3>Start triggers · ${esc(h.name)} · Heat ${h.ht}</h3>
    <p>Choose the official start for this heat. Finish marks stay in the same columns. Save the heat again to update exported results.</p>
    <button class="btn" id="recordStart" ${S.meet ? '' : 'disabled'}>Record trigger (SIM)</button>
    <button class="btn" id="refreshStarts">Refresh</button>
    <div id="startRows"><p>${S.meet ? 'Loading triggers…' : 'Open a meet folder to keep a start log.'}</p></div></div>`;
  if (!OM || !S.meet) return;
  const dir = S.meet.dir;
  body.querySelector('#refreshStarts').onclick = () => renderStarts(body);
  body.querySelector('#recordStart').onclick = async () => {
    try {
      const now = Date.now(), ref = h.startReference;
      await OM.call('starts.record', { dir, clockId: 'simulated-meet-clock',
        timeS: ref ? ref.timeS + (now - ref.wallTimeMs) / 1000 * SPEED : now / 1000,
        wallTimeMs: now, source: 'Simulated sensor trigger' });
      renderStarts(body);
    } catch (err) { toast(err.message, true); }
  };
  OM.call('starts.list', { dir }).then(log => {
    if (!body.querySelector('#startRows') || cur() !== h || S.meet?.dir !== dir) return;
    const assignment = log.assignments[key];
    const reference = h.startReference || log.triggers.find(t => t.id === assignment?.referenceTriggerId);
    const selected = h.startTriggerId || h.startReference?.id || assignment?.triggerId;
    body.querySelector('#startRows').innerHTML = log.triggers.length ? `<table class="tbl"><tr><th>Trigger</th><th>Timestamp</th><th>Source</th><th>Heat</th><th></th></tr>${log.triggers.map((t, i) => {
      const assigned = Object.entries(log.assignments).filter(([,a])=>a.triggerId === t.id).map(([k])=>k).join(', ');
      const compatible = reference && t.clockId === reference.clockId;
      return `<tr><td>${i+1}</td><td class="num">${esc(new Date(t.wallTimeMs).toLocaleTimeString([], {hour12:false}))}.${String(new Date(t.wallTimeMs).getMilliseconds()).padStart(3,'0')}</td><td>${esc(t.source)}</td><td>${esc(assigned || 'Unassigned')}</td><td><button class="btn sm" data-start="${t.id}" ${compatible ? '' : 'disabled'}>${selected === t.id ? 'Assigned · use again' : 'Assign to this heat'}</button></td></tr>`;
    }).join('')}</table><p class="dimtext">${log.history.length} start assignments retained. ${reference ? '' : 'Start a capture before assigning a trigger to this heat.'}</p>` : '<p>No triggers recorded yet.</p>';
    body.querySelectorAll('[data-start]').forEach(button => { button.onclick = async () => {
      try {
        const a = await OM.call('starts.assign', { dir, heatKey:key, triggerId:button.dataset.start, referenceTriggerId:reference.id });
        const trigger = log.triggers.find(t => t.id === a.triggerId);
        h.startReference = reference; h.startTriggerId = trigger.id; h.startCorrection = a.offsetS;
        h.startTOD = new Date(trigger.wallTimeMs);
        if (h.state === 'saved') h.state = 'review';
        toast(`Start updated for ${h.name}, heat ${h.ht}. Times changed by ${(-a.offsetS).toFixed(3)} s.`);
        renderUI();
      } catch (err) { toast(err.message, true); }
    }; });
  }).catch(err => { if(body.querySelector('#startRows')) body.querySelector('#startRows').textContent = err.message; });
}

function renderMeetNavigator(body) {
  if(!body.querySelector('#meetNavigator')){
    body.innerHTML='<div id="meetNavigator" class="meet-navigator"><div class="meet-nav-controls"><input type="search" id="meetSearch" placeholder="Find event or athlete" aria-label="Find event or athlete"><select id="meetFilter" aria-label="Filter heats"><option value="all">All heats</option><option value="recorded">Recorded</option><option value="upcoming">To run</option></select></div><div id="meetNavSummary"></div><div id="meetEventList"></div></div>';
    const search=body.querySelector('#meetSearch'),filter=body.querySelector('#meetFilter');search.value=S.meetQuery||'';filter.value=S.meetFilter||'all';
    search.oninput=()=>{S.meetQuery=search.value;renderMeetNavigator(body);};search.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();body.querySelector('[data-meet-heat]')?.click();}};
    filter.onchange=()=>{S.meetFilter=filter.value;renderMeetNavigator(body);};
  }
  const signature=JSON.stringify([S.idx,S.meetQuery,S.meetFilter,HEATS.map(h=>[h.ev,h.rd,h.ht,h.name,h.state,h.saves,h.offSchedule,h.athletes.filter(a=>resolved(h,a)).length])]);
  const list=body.querySelector('#meetEventList');if(list.dataset.signature===signature)return;list.dataset.signature=signature;
  const terms=(S.meetQuery||'').toLowerCase().trim().split(/\s+/).filter(Boolean),groups=new Map();let count=0;
  HEATS.forEach((h,i)=>{
    const recorded=['review','saved'].includes(h.state);
    if(S.meetFilter==='recorded'&&!recorded||S.meetFilter==='upcoming'&&recorded)return;
    const text=`${h.ev} ${h.name} round ${h.rd} heat ${h.ht} ${h.athletes.map(a=>a.first+' '+a.last+' '+a.team.name).join(' ')}`.toLowerCase();if(!terms.every(t=>text.includes(t)))return;
    const key=`${h.ev}:${h.rd}`;if(!groups.has(key))groups.set(key,{heat:h,items:[]});groups.get(key).items.push({h,i});count++;
  });
  list.replaceChildren();
  for(const {heat,items}of groups.values()){
    const section=h_('section','meet-event');section.append(h_('h3','',`E${heat.ev} · ${heat.name}`),h_('p','meet-round',`Round ${heat.rd}`));
    const heats=h_('div','meet-heat-grid');
    for(const {h,i}of items){const button=h_('button','meet-heat'+(i===S.idx?' selected':''));button.dataset.meetHeat=i;button.setAttribute('aria-current',i===S.idx?'true':'false');const done=h.athletes.filter(a=>resolved(h,a)).length,attempts=attemptsByHeat.get(attemptKey(h));
      button.innerHTML=`<span><b>Heat ${h.ht}</b><span class="state ${h.state}">${h.state==='running'?'RECORDING':h.state.toUpperCase()}</span></span><small>${['review','saved'].includes(h.state)?`${done} / ${h.athletes.length} resolved`:`${h.athletes.length} athletes`}${attempts?.length>1?` · ${attempts.length} attempts`:''}${h.offSchedule?' · Off schedule':''}</small>`;
      button.onclick=()=>{S.tab='run';go(i);};heats.append(button);
    }section.append(heats);list.append(section);
  }
  if(!count)list.append(h_('p','empty','No matching heats.'));
  const summary=body.querySelector('#meetNavSummary');summary.replaceChildren(h_('span','dimtext',`${count} of ${HEATS.length} heats`));const active=runningHeat();if(active){const live=h_('button','btn sm',`Return to live · E${active.ev} H${active.ht}`);live.onclick=()=>{S.tab='run';go(HEATS.indexOf(active));};summary.append(live);}
}

function renderDrawer() {
  const d = $('#drawer');
  d.classList.toggle('open', S.tab !== 'run' && S.tab !== 'alignment');
  if (S.tab === 'run' || S.tab === 'alignment') return;
  $('#drawerTitle').textContent = TABS.find(t => t[0] === S.tab)[1];
  const body = $('#drawerBody');
  body.classList.toggle('boardbody', S.tab === 'board');
  if (S.tab === 'board') { renderBoard(body); return; }
  body.dataset.tab = S.tab;
  if (S.tab === 'events') { renderMeetNavigator(body); return; }
  if (S.tab === 'starts') { renderStarts(body); return; }
  if (S.tab === 'network') {
    const h=cur(),cameras=replayCameras(h),period=periodOf(h),real=h.replaySourceType==='real';
    const row=(name,available,detail)=>`<tr><td>${esc(name)}</td><td>Local</td><td>${available?esc(detail):'absent'}</td></tr>`;
    body.innerHTML=`<div class="card"><h3>Camera inputs</h3>
      <p>${real?'Real-recorded still timing source':h.asset?'TTP simulator folder':'Simple built-in simulator'} · replay clock</p>
      <table class="tbl"><tr><th>Device</th><th>Connection</th><th>State</th></tr>
      ${row(h.asset?.mainCameraLabel||'Primary line-scan',cameras.primary,`${(1/period).toFixed(1)} columns/s`)}
      ${row(h.asset?.comparisonCameraLabel||'Backup line-scan',cameras.comparison,h.asset?.backupMeta?`${(1/h.asset.backupMeta.column_period_s).toFixed(1)} columns/s`:'simulated')}
      ${row('Front camera',cameras.front,h.asset?.front?'recorded video':'simulated')}
      ${row('Start system',true,'replay clock')}${row('Wind gauge',h.wind!=null,h.wind==null?'absent':windStr(h))}</table>
      <p class="dimtext">Recorded input is replayed locally. Live camera drivers are planned.</p></div>
      <div class="card"><h3>Auto-timing service</h3><p>${S.apiOnline?'Enabled':'Simulated offline'}</p></div>`;
    const camerasCard=h_('div','card');camerasCard.append(h_('h3','','Capture cameras'));renderCameraRoles(camerasCard);body.prepend(camerasCard);
    renderSimulationSources(body);
  } else if (S.tab === 'meet') {
    const last = S.files[S.files.length - 1], entries = HEATS.reduce((n, h) => n + h.athletes.length, 0);
    const kb = n => (n == null ? '' : n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' kB');
    const fileRow = f => { const m = S.meet.files[f]; return `<tr><td class="num">${f}</td><td>${m ? kb(m.size) : 'absent'}</td><td>${m ? new Date(m.mtimeMs).toTimeString().slice(0, 8) : '—'}</td><td><span class="dot ${m ? 'ok' : ''}"></span> ${m ? 'watching' : f === 'lynx.evt' ? 'required' : 'optional'}</td></tr>`; };
    const folderCard = !OM ? null : `
      <div class="card"><h3>Meet folder</h3>
        ${S.meet ? `<p class="num">${esc(S.meet.dir)}</p>` : '<p>No meet folder is open, so the built-in sample meet is loaded. Point this at the folder your meet manager (RunMeet through AthleticLOCAL, Hy-Tek, ...) writes lynx.evt to.</p>'}
        <p><button class="btn sm primary" id="openMeet">Open meet folder…</button> <button class="btn sm" id="openDemo">Open demo meet…</button> ${S.meet ? '<button class="btn sm" id="closeMeet">Use the sample meet</button>' : ''}</p>
        ${S.meet?.demo ? `<p class="dimtext">${esc(sourceLabel(S.simulationSource))} · local recording</p>` : ''}
        ${S.meet ? `<table class="tbl"><tr><th>Input (meet manager writes)</th><th>Size</th><th>Modified</th><th>State</th></tr>${['lynx.evt', 'lynx.ppl', 'lynx.sch'].map(fileRow).join('')}</table>
        <p>${HEATS.length} laned heats, ${entries} entries.</p>
        <p>Results folder: <span class="num">${esc(S.meet.resultsDir || S.meet.dir)}</span>${S.meet.resultsDir ? '' : ' <span class="dimtext">(same as the meet folder)</span>'}
          <button class="btn sm" id="pickResults">Change…</button>${S.meet.resultsDir ? ' <button class="btn sm" id="sameResults">Use the meet folder</button>' : ''}</p>
        <p class="dimtext">AthleticLOCAL: its Start Lists folder is the meet folder; its Results folder is the results folder.</p>
        <pre class="file">${esc((S.meet.files['lynx.evt'] || {}).text || '')}</pre>` : ''}
      </div>`;
    body.innerHTML = folderCard ? folderCard + resultsCard(last) : `
      <div class="card"><h3>Meet folder</h3>
        <p class="num">C:\\Meets\\2026-10-28-sim\\  <span class="dimtext">(mapped as X: on the meet-manager laptop)</span></p>
        <table class="tbl"><tr><th>Input (meet manager writes)</th><th>Contents</th><th>State</th></tr>
          <tr><td class="num">lynx.evt</td><td>${HEATS.length} heats, ${entries} entries</td><td><span class="dot ok"></span> watching</td></tr>
          <tr><td class="num">lynx.ppl</td><td>${entries} people</td><td><span class="dot ok"></span> watching</td></tr>
          <tr><td class="num">lynx.sch</td><td>${HEATS.length} entries in run order</td><td><span class="dot ok"></span> watching</td></tr>
        </table>
        <pre class="file">${esc(evtText())}</pre>
      </div>${resultsCard(last)}`;
    if (OM) {
      $('#openMeet').onclick = async () => { const dir = await OM.pickFolder('Open meet folder'); if (dir) openMeet(dir); };
      if ($('#closeMeet')) $('#closeMeet').onclick = closeMeet;
      const setResults = async dir => {
        S.meet.resultsDir = dir;
        const s = await OM.call('settings.get').catch(() => ({}));
        OM.call('settings.set', { patch: { resultsFor: { ...(s.resultsFor || {}), [S.meet.dir]: dir } } }).catch(() => {});
        renderUI();
      };
      if ($('#pickResults')) $('#pickResults').onclick = async () => { const dir = await OM.pickFolder('Results folder (the meet manager reads LIF files here)'); if (dir) setResults(dir); };
      if ($('#sameResults')) $('#sameResults').onclick = () => setResults(null);
      $('#openDemo').onclick = () => importSimulationSource('ttp');
      for(const id of ['openMeet','openDemo','closeMeet'])if($('#'+id))$('#'+id).disabled=!!runningHeat()||S.sourceChanging;
    }
    renderSimulationSources(body);
  } else if (S.tab === 'api') {
    const reference=cur().replaySourceType==='real'&&S.atInfo?.stub&&replayReferenceTiming(cur());
    body.innerHTML = `
      <div class="card"><h3>Auto-timing service</h3>
        <p>${reference?'Recorded result references for operator practice. The operator approves every result.':'AI-suggested finish times for operator review. The operator approves every result.'}</p>
        <table class="tbl">
          <tr><td>Service</td><td>${OM ? S.atInfo?.stub ? cur().replaySourceType==='real' ? replayReferenceTiming(cur())?'Recorded results · reference playback, not model detections':'No reference timing points · mark finishes manually' : 'Stand-in on this computer: echoes simulator truth, not a model' : 'Configured timing service' : 'TTP finish model (simulated in this replica)'}</td></tr>
          <tr><td>${reference?'Source':'Model'}</td><td class="num">${esc(reference?'Recorded results':cur().model || (OM ? 'stub-truth-0' : 'sim-0'))}</td></tr>
          <tr><td>Contract</td><td class="num">POST /v1/finish-predictions</td></tr>
          <tr><td>State</td><td><span class="dot ${S.apiOnline ? 'ok' : 'warn'}"></span> ${S.apiOnline ? 'reachable' : 'offline'}</td></tr>
        </table>
        <p><label class="chk"><input type="checkbox" id="apiOff" ${S.apiOnline ? '' : 'checked'}> Simulate the service being unreachable</label></p>
      </div>
      <div class="card"><h3>How suggestions are used</h3>
        <p>Each finisher gets a suggested time. REVIEW suggestions wait for the operator; nothing is delivered until the heat is saved.</p>
        <p>${cur().replaySourceType==='real'&&S.atInfo?.stub?'Recorded results use the supplied saved columns without QA jitter or dropped finishes. They are practice references, not a model accuracy test.':'AUTO is reserved for suggestions the model is confident in. Today almost everything comes back REVIEW: on unseen meets the auto rule is not yet reliable.'}</p>
        <p>Finishes within 0.02 s of a neighbour are always REVIEW.</p>
        <p>The operator can override anything; the original suggestion stays in the heat's log.</p>
        <p>Suggestions can take a while on a laptop; the heat stays fully usable and they fill in when ready. Capture never waits on the service, and without it heats are timed by hand.</p>
      </div>`;
    $('#apiOff').onchange = e => { S.apiOnline = !e.target.checked; renderUI(); };
  } else {
    body.innerHTML = `
      <div class="card"><h3>Display</h3>
        <p>Theme</p><div class="seg" id="themeSeg"><button data-t="dark">Dark</button><button data-t="outdoor">Outdoor (sunlight)</button></div>
      </div>
      `;
    renderSimulationSources(body);
    body.querySelectorAll('#themeSeg button').forEach(b => {
      b.classList.toggle('on', document.documentElement.dataset.theme === b.dataset.t);
      b.onclick = () => { document.documentElement.dataset.theme = b.dataset.t; store.set('theme', b.dataset.t); readTokens(); renderUI(); };
    });
  }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function resultsCard(last) {
  return `
      <div class="card"><h3>Results written (the meet manager imports these)</h3>
        ${S.files.length ? `<table class="tbl"><tr><th>File</th><th>Written</th><th>Bytes</th><th>Version</th></tr>${S.files.map(f => `<tr><td class="num" title="${esc(f.path || '')}">${f.name}</td><td class="num">${f.at.toTimeString().slice(0, 8)}</td><td class="num">${f.bytes}</td><td class="num">${f.v}</td></tr>`).join('')}</table>
        <p>Last written: <span class="num">${last.name}</span> (thousandths; the meet manager rounds up to hundredths)</p><pre class="file">${esc(last.text)}</pre>` : '<p>No results yet. Saving a heat writes <span class="num">EEE-R-HH.lif</span> atomically (temp file, then rename).</p>'}
      </div>`;
}

// ---------------------------------------------------------------- scoreboards (engine serves them; a coding agent builds them)
const B = { started: false, starting: false, port: null, lanUrls: [], list: [], sel: 'classic', running: false, snapshot: null, log: '' };
const boardUrl = name => `http://127.0.0.1:${B.port}/scoreboard/${name}/`;
// Live state for every scoreboard (docs/scoreboard-v1.md).
function boardState() {
  const h = runningHeat()||S.lastLiveHeat||cur(), done = ['review', 'saved'].includes(h.state), { fin, pl } = places(h), win = done ? fin[0] : null;
  const lanes = [...h.athletes].sort((a, b) => a.lane - b.lane).map(a => {
    const mark=h.marks[a.lane],proposal=!mark&&!h.status[a.lane]&&!h.dismissed?.[a.lane]?h.proposals?.find(p=>p.lane===a.lane):null;
    const point=mark||proposal;
    return {lane:h.unlaned?null:a.lane,id:a.id,first:a.first,last:a.last,affiliation:a.team.name,
      status:h.status[a.lane]||null,time:!h.status[a.lane]&&point&&Number.isFinite(point.col)?ceilTo(raceTime(h,point.col),2):null,
      place:mark?pl[a.lane]||null:null,review:!!proposal};
  });
  return {
    meet: { name: S.meet ? (S.meet.demo ? S.simulationSource?.name||'OpenMeet Demo Meet' : S.meet.dir.split(/[\\/]/).filter(Boolean).slice(-1)[0]) : 'OpenMeet Sample Meet', logo: null },
    heat: { event: h.ev, round: h.rd, heat: h.ht, of: h.of, name: h.name, state: h.state },
    clock: {
      running: h.state === 'running', speed: SPEED,
      startedAtMs: h.state === 'running' && h.startTOD ? h.startTOD.getTime() : null,
      frozenS: win ? ceilTo(raceTime(h, h.marks[win.lane].col), 2) : null,
    },
    lanes, results: lanes.filter(l => l.place&&!l.review).sort((a, b) => a.place - b.place),
    wind: h.wind == null || !done ? null : h.wind, updatedAt: Date.now(),
  };
}
let boardTimer = null;
function publishBoard() {
  if (!OM || !B.started || boardTimer) return;
  boardTimer = setTimeout(() => { boardTimer = null; OM.call('scoreboard.publish', { state: boardState() }).catch(() => {}); }, 200);
}
async function startBoards() {
  if (!OM || B.started || B.starting) return;
  B.starting = true;
  try {
    const r = await OM.call('scoreboard.start', {});
    B.port = r.port; B.lanUrls = r.lanUrls || []; B.started = true;
    B.list = await OM.call('scoreboard.list').catch(() => []);
    if (B.list.length && !B.list.some(t => (t.name || t) === B.sel)) B.sel = B.list[0].name || B.list[0];
    publishBoard();
  } catch (err) { toast('Scoreboards could not start: ' + err.message, true); } finally { B.starting = false; renderDrawer(); }
}
function renderBoard(body) {
  if (!OM) { body.innerHTML = '<div class="card"><h3>Scoreboards</h3><p>Scoreboards run in the OpenMeet app (they need the engine).</p></div>'; return; }
  if (!B.started) { body.innerHTML = '<div class="card"><p>Starting the scoreboard server…</p></div>'; startBoards(); return; }
  if (body.dataset.tab !== 'board') {
    body.dataset.tab = 'board';
    body.innerHTML = `
      <div class="card blist"><h3>Scoreboards</h3><div id="bList"></div>
        <p><button class="btn sm" id="bNew">New from classic</button> <button class="btn sm" id="bNewTicker">New lower-third</button></p>
        <p class="dimtext" id="bNet"></p></div>
      <div class="card bprev"><iframe id="bFrame" title="Scoreboard preview"></iframe></div>
      <div class="card bagent"><h3>Build with AI</h3>
        <textarea id="bPrompt" rows="5" placeholder="Describe the board, e.g. put our meet logo top-left, a school logo beside each name, make the clock huge, gold for the winner."></textarea>
        <p class="bctl"><select id="bAgent"><option value="muse">Muse Code (Meta)</option><option value="codex">Codex</option><option value="grok">Grok</option></select>
          <button class="btn sm" id="bAddLogo">Add logo…</button><button class="btn sm primary" id="bBuild">Build</button><button class="btn sm" id="bUndo">Undo last build</button></p>
        <pre class="file" id="bLog"></pre></div>`;
    $('#bNew').onclick = () => newBoard('classic');
    $('#bNewTicker').onclick = () => newBoard('results-ticker');
    $('#bBuild').onclick = buildBoard;
    $('#bUndo').onclick = async () => {
      if (!B.snapshot) return;
      try { await OM.call('scoreboard.restore', { name: B.sel, snapshotId: B.snapshot }); B.snapshot = null; toast('Restored the board from before the last build.'); reloadPreview(); } catch (err) { toast('Undo failed: ' + err.message, true); }
    };
    $('#bAddLogo').onclick = async () => {
      const p = await OM.pickFile('Add a logo or image to this scoreboard', 'image');
      if (!p) return;
      try { const r = await OM.call('scoreboard.addAsset', { name: B.sel, path: p }); toast(`Added ${r.path || r} to ${B.sel}. Mention it in the request to place it.`); } catch (err) { toast('Could not add the image: ' + err.message, true); }
    };
    $('#bAgent').value = store.get('boardAgent', 'muse');
    $('#bAgent').onchange = e => store.set('boardAgent', e.target.value);
    reloadPreview();
  }
  const list = $('#bList'); list.innerHTML = '';
  B.list.forEach(t => {
    const name = t.name || t, row = h_('div', 'brow' + (name === B.sel ? ' cur' : ''));
    row.innerHTML = `<span class="num">${esc(name)}</span>`;
    const open = h_('button', 'btn sm', 'Open window');
    open.onclick = e => { e.stopPropagation(); OM.openBoard(boardUrl(name), 'OpenMeet Scoreboard: ' + name); };
    // delete asks twice: it removes the board's folder, including its undo history
    const del = h_('button', 'btn sm ' + (B.confirmDel === name ? 'warn' : 'bdel'));
    del.innerHTML = B.confirmDel === name ? 'Delete?' : ICON.trash;
    del.title = 'Delete this board';
    del.onclick = async e => {
      e.stopPropagation();
      if (B.confirmDel !== name) { B.confirmDel = name; renderDrawer(); setTimeout(() => { if (B.confirmDel === name) { B.confirmDel = null; renderDrawer(); } }, 4000); return; }
      B.confirmDel = null;
      try {
        B.list = await OM.call('scoreboard.delete', { name });
        if (B.sel === name) { B.sel = (B.list[0] && (B.list[0].name || B.list[0])) || 'classic'; reloadPreview(); }
        toast(`Deleted the board "${name}".`);
      } catch (err) { toast('Could not delete the board: ' + err.message, true); }
      renderDrawer();
    };
    const btns = h_('span', 'bbtns'); btns.append(open, del);
    row.append(btns);
    row.onclick = () => { B.sel = name; reloadPreview(); renderDrawer(); };
    list.append(row);
  });
  $('#bNet').innerHTML = B.lanUrls.length ? 'On the network (TV, OBS browser source):<br>' + B.lanUrls.map(u => `<span class="num">${esc(u)}${esc(B.sel)}/</span>`).join('<br>') : `Local: <span class="num">${esc(boardUrl(B.sel))}</span>`;
  $('#bBuild').disabled = B.running; $('#bUndo').disabled = B.running || !B.snapshot;
  $('#bLog').textContent = B.log || 'The agent edits only this board\'s folder. Each build can be undone.';
}
function reloadPreview() { const f = $('#bFrame'); if (f) f.src = boardUrl(B.sel) + '?preview=' + Date.now(); }
async function newBoard(from) {
  const base = from === 'classic' ? 'board' : 'ticker';
  let n = 1; while (B.list.some(t => (t.name || t) === `${base}-${n}`)) n++;
  try {
    await OM.call('scoreboard.create', { name: `${base}-${n}`, from });
    B.list = await OM.call('scoreboard.list'); B.sel = `${base}-${n}`;
    const f = $('#bFrame'); if (f) f.removeAttribute('src');
    $('#drawerBody').dataset.tab = ''; renderDrawer();
  } catch (err) { toast('Could not create the board: ' + err.message, true); }
}
async function buildBoard() {
  const req = $('#bPrompt').value.trim();
  if (!req || B.running) return;
  B.running = true; B.log = `> ${$('#bAgent').value}: ${req}\n`; renderDrawer();
  try {
    const r = await OM.call('scoreboard.agent', { name: B.sel, request: req, preset: $('#bAgent').value });
    B.snapshot = r.snapshotId || null;
    B.log += `\n[done: exit ${r.code}${r.restored ? ', the board broke the contract and was restored' : ''}]`;
    reloadPreview();
  } catch (err) { B.log += `\n[failed: ${err.message}]`; } finally { B.running = false; renderDrawer(); }
}
if (OM) OM.on('scoreboard.agentOutput', d => {
  B.log = (B.log + (d.line != null ? d.line : d.text || '') + '\n').slice(-20000);
  const l = $('#bLog'); if (l) { l.textContent = B.log; l.scrollTop = l.scrollHeight; }
});

// Overlay appearance is stored per meet/camera and never changes timing or inference geometry.
const reviewHighlightDefaults = { pendingColor:'#ffd43b', pendingOpacity:0.32, pendingStyleVersion:2 };
const inactiveLaneDefaults = { shadeInactive:true, inactiveColor:'#98a0ab', inactiveOpacity:0.35 };
const overlayDefaults = { fontSize:16, weight:700, thickness:1, textColor:'#ffffff', lineColor:'#6ba5e7', opacity:0.65, edit:false, positions:{} };
function overlayKey(kind) { return `overlay:${S.meet?.dir || 'sample'}:${kind}`; }
function cameraOverlayKey(kind,camera=viewHeat().asset?.mainCameraId||'primary'){return kind==='scan'?`${overlayKey(kind)}:${camera}`:overlayKey(kind);}
function frontImageRect() {
  const h=viewHeat(),pb=$('#front').parentNode,meta=h.frontRec?.meta||h.asset?.frontMeta;
  return containedImageRect(pb.clientWidth,pb.clientHeight,meta?.width||vidEl?.videoWidth||pb.clientWidth,meta?.height||vidEl?.videoHeight||pb.clientHeight);
}
const frontFontScale=o=>frontImageRect().height/(o.sizeReferenceHeight||frontImageRect().height||1);
function overlayStyle(kind,camera=viewHeat().asset?.mainCameraId||'primary',nativeRows=null) {
  let saved=store.get(cameraOverlayKey(kind,camera),kind!=='scan'||camera==='primary'?store.get(overlayKey(kind),{}):{});
  if(kind==='scan'){const next=scanMaskPreferences(saved);if(next!==saved){saved=next;store.set(cameraOverlayKey(kind,camera),saved);}}
  if(kind==='front'&&!saved.imageSpace){
    const rect=frontImageRect(),pb=$('#front').parentNode,h=viewHeat(),meta=h.frontRec?.meta||h.asset?.frontMeta;
    // Wait for the image's actual aspect ratio before converting an older tile profile.
    if(rect.height>0&&(!S.meet||meta?.width&&meta?.height)){saved={...saved,imageSpace:1,sizeReferenceHeight:rect.height,positions:Object.fromEntries(Object.entries(saved.positions||{}).map(([lane,p])=>[lane,{x:Math.max(.02,Math.min(.98,(p.x*pb.clientWidth-rect.x)/rect.width)),y:Math.max(.02,Math.min(.98,(p.y*pb.clientHeight-rect.y)/rect.height))}]))};store.set(cameraOverlayKey(kind,camera),saved);}
  }
  const highlight=kind==='scan'?{...reviewHighlightDefaults,...(saved.pendingColor?{pendingColor:saved.pendingColor}:{}),...(saved.pendingOpacity!=null?{pendingOpacity:saved.pendingOpacity}:{} )}:{};
  if(kind==='scan'&&!saved.pendingStyleVersion){if(saved.pendingColor==='#ffb020')highlight.pendingColor=reviewHighlightDefaults.pendingColor;if(saved.pendingOpacity===0.12)highlight.pendingOpacity=reviewHighlightDefaults.pendingOpacity;}
  const rows=kind==='scan'?(nativeRows||rowsForCamera(camera)):null,scale=kind==='scan'&&saved.resolutionRows>0?rows/saved.resolutionRows:1;
  return {...overlayDefaults,...(kind==='front'?{fontSize:28,opacity:0.5,enabled:false,behindRunners:false,laneCount:8,placement:'anchors',firstScale:1,lastScale:0.55}:{enabled:S.lanes,behindRunners:true,occlusionMethod:'learned',needsFinish:false,...reviewHighlightDefaults,...inactiveLaneDefaults}),...saved,...highlight,
    positions:Object.fromEntries(Object.entries(saved.positions||{}).map(([lane,b])=>[lane,kind==='scan'?{...b,top:b.top*scale,bottom:b.bottom*scale}:{...b}])),
    boundaries:Object.fromEntries(Object.entries(saved.boundaries||{}).map(([key,row])=>[key,row*scale])),sizes:{...(saved.sizes||{})},...(kind==='scan'?{resolutionRows:rows}:{})};
}
function frontLanePoint(o,lane) {
  if(o.positions[lane])return o.positions[lane];
  const a=o.positions[1]||{x:0.1,y:0.8},b=o.positions[o.laneCount]||{x:0.9,y:0.8};
  const t=(lane-1)/Math.max(1,o.laneCount-1),near=o.firstScale||1,far=o.lastScale||0.55;
  const u=t*near/((1-t)*far+t*near);
  return {x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u};
}
function frontLaneSize(o,lane) {
  if(o.sizes?.[lane])return o.sizes[lane];
  const t=(lane-1)/Math.max(1,o.laneCount-1);
  return o.fontSize/((1-t)/(o.firstScale||1)+t/(o.lastScale||0.55));
}
function spreadFrontLanes(o) {
  const a=frontLanePoint(o,1),b=frontLanePoint(o,o.laneCount);
  o.positions={1:a,[o.laneCount]:b};
  const points={};for(let lane=1;lane<=o.laneCount;lane++)points[lane]=frontLanePoint(o,lane);
  o.positions=points;
}
function modelLaneGuides(h) {
  const o=overlayStyle('scan',h.asset?.mainCameraId||'primary',rowsOf(h));if(!o.modelInput)return null;
  const rows=[...new Set(scanBoundaries(laneBands(h),o,rowsOf(h)).map(b=>Math.round(b.row)))];
  return {enabled:true,rows,color:o.lineColor,thickness:Math.max(1,Math.round(o.thickness))};
}
function saveOverlay(kind,value) { if(kind==='scan')value={...value,resolutionRows:rowsOf(viewHeat())};store.set(cameraOverlayKey(kind),value); if(kind==='scan'){S.lanes=value.enabled;store.set('lanes',S.lanes);syncLaneGutter(value);} updateFrontOverlay(); invalidate(); }
let overlayMenu=null;
function showOverlaySettings(kind, anchor) {
  toolbarPopover?.close(false);
  // Clean up listeners as well as the previous popover when switching cameras.
  overlayMenu?.overlaySettingsCleanup?.();
  overlayMenu?.remove();

  const isFront = kind === 'front';
  if(!isFront)occlusionAvailability?.refresh();
  const id = `overlay-settings-${kind}`;
  const menu = h_('div', 'overlay-settings overlay-settings--grouped');
  let o = overlayStyle(kind);
  overlayMenu = menu;
  menu.id = id;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'false');
  menu.setAttribute('aria-labelledby', `${id}-title`);
  menu.setAttribute('aria-description', 'Settings save automatically for this camera.');
  menu.tabIndex = -1;
  menu.innerHTML = `
    <div class="overlay-title">
      <h2 id="${id}-title">${isFront ? 'Front camera' : 'Line-scan'} lanes</h2>
      <button type="button" class="btn sm overlay-close" data-close aria-label="Close lane settings">×</button>
    </div>
    <label class="overlay-master">
      <span>${isFront ? 'Show lane numbers' : 'Show lanes'}</span>
      <input data-key="enabled" type="checkbox" role="switch">
    </label>

    ${!isFront ? `
      <div class="overlay-quick">
        <label title="Highlight lanes without an accepted finish or race status.">
          <span>Highlight unfinished lanes</span>
          <input data-key="needsFinish" type="checkbox" role="switch">
        </label>
        <label><span>Overlays behind runners</span><input data-key="behindRunners" type="checkbox" role="switch"></label>
      </div>
    ` : `<div class="overlay-quick"><label title="Uses changes from a clear background. Keep this camera fixed."><span>Behind runners</span><input data-key="behindRunners" type="checkbox" role="switch"></label><button class="btn sm" data-front-background title="Use the current camera image while the track is clear.">Set empty background</button></div>`}

    <details class="overlay-group" data-settings-group="placement" ${isFront ? 'open' : ''}>
      <summary>Placement</summary>
      <div class="overlay-group-body">
        <label>
          <span>${isFront ? 'Drag to position' : 'Drag on image'}</span>
          <input data-key="edit" type="checkbox" role="switch" title="${isFront ? 'Drag lane numbers to position them.' : 'Left-column dividers are always draggable. This also enables dragging over the image.'}">
        </label>
        ${isFront ? `
          <label><span>Lane count</span><input data-lane-count type="number" min="2" max="24" step="1"></label>
          <label><span>Positioning</span><select data-placement>
            <option value="anchors">First + last lanes</option>
            <option value="individual">Each lane individually</option>
          </select></label>
          <fieldset class="overlay-subgroup">
            <legend>First and last lane sizes</legend>
            <label><span>First lane size (px)</span><input data-end-size="first" type="number" min="8" max="160" step="1"></label>
            <label><span>Last lane size (px)</span><input data-end-size="last" type="number" min="8" max="160" step="1"></label>
          </fieldset>
          <p class="overlay-hint" id="${id}-placement-help">Place first + last, then fine-tune.</p>
        ` : ''}
        <div class="overlay-actions"><button type="button" class="btn sm" data-reset>Reset positions</button></div>
      </div>
    </details>

    <details class="overlay-group" data-settings-group="appearance">
      <summary>Appearance</summary>
      <div class="overlay-group-body">
        ${isFront ? '<label><span>Font size</span><input data-key="fontSize" type="number" min="8" max="96" step="1"></label>' : ''}
        <label><span>Weight</span><select data-key="weight">${[400, 500, 600, 700, 800, 900].map(v => `<option value="${v}">${v}</option>`).join('')}</select></label>
        <label><span>Line width</span><input data-key="thickness" type="number" min="0" max="12" step="0.5"></label>
        <label><span>Text color</span><input data-key="textColor" type="color"></label>
        <label><span>Line color</span><input data-key="lineColor" type="color"></label>
        <label><span>Opacity</span><span class="overlay-range"><input data-key="opacity" type="range" min="0.1" max="1" step="0.05"><output data-value-for="opacity" aria-hidden="true"></output></span></label>
        ${!isFront ? `
          <fieldset class="overlay-subgroup">
            <legend>Review highlight</legend>
            <label><span>Color</span><input data-key="pendingColor" type="color"></label>
            <label><span>Opacity</span><span class="overlay-range"><input data-key="pendingOpacity" type="range" min="0.05" max="0.6" step="0.01"><output data-value-for="pendingOpacity" aria-hidden="true"></output></span></label>
          </fieldset>
          <fieldset class="overlay-subgroup">
            <legend>Inactive lanes</legend>
            <label title="Shade DNS, false-start and unentered lanes."><span>Show shading</span><input data-key="shadeInactive" type="checkbox" role="switch"></label>
            <label><span>Color</span><input data-key="inactiveColor" type="color"></label>
            <label><span>Opacity</span><span class="overlay-range"><input data-key="inactiveOpacity" type="range" min="0.05" max="0.8" step="0.01"><output data-value-for="inactiveOpacity" aria-hidden="true"></output></span></label>
          </fieldset>
        ` : ''}
        <div class="overlay-actions"><button type="button" class="btn sm" data-defaults>Reset appearance</button></div>
      </div>
    </details>

    ${!isFront ? `
      <details class="overlay-group" data-settings-group="advanced">
        <summary>Advanced</summary>
        <div class="overlay-group-body">
          <label title="Adds lane dividers to the image sent for auto-timing. Finish marks and text are excluded."><span>Use guides for auto-timing</span><input data-key="modelInput" type="checkbox" role="switch" aria-describedby="${id}-model-help ${id}-model-reason"></label>
          <p class="overlay-hint" id="${id}-model-help" data-model-input-help>Original recording stays unchanged.</p>
          <p class="overlay-hint overlay-model-reason" id="${id}-model-reason" data-model-input-reason role="status" hidden></p>
          <label><span>Runner mask</span><select data-occlusion><option value="learned">Learned preview</option><option value="simple">Simple</option></select></label>
          <p class="overlay-hint" data-occlusion-status role="status"></p>
        </div>
      </details>
    ` : ''}`;

  const uiDefaults = { needsFinish: false, ...reviewHighlightDefaults, ...inactiveLaneDefaults };
  const inputs = [...menu.querySelectorAll('[data-key]')];
  const endSizes = [...menu.querySelectorAll('[data-end-size]')];
  const syncRange = input => {
    const percent = `${Math.round(Number(input.value) * 100)}%`;
    menu.querySelector(`[data-value-for="${input.dataset.key}"]`).value = percent;
    input.setAttribute('aria-valuetext', percent);
  };
  const syncEndSizes = () => endSizes.forEach(input => {
    const scale = input.dataset.endSize === 'first' ? (o.firstScale || 1) : (o.lastScale || 0.55);
    input.value = Math.round(o.fontSize * scale * frontFontScale(o));
  });
  const syncControls = () => {
    inputs.forEach(input => {
      const value = o[input.dataset.key] ?? uiDefaults[input.dataset.key];
      if (input.type === 'checkbox') input.checked = !!value;
      else input.value = isFront&&input.dataset.key==='fontSize'?Math.round(value*frontFontScale(o)):value;
      if (input.type === 'range') syncRange(input);
    });
    if (isFront) {
      menu.querySelector('[data-lane-count]').value = o.laneCount;
      menu.querySelector('[data-placement]').value = o.placement || 'anchors';
      syncEndSizes();
    }
  };
  syncControls();
  if(!isFront){
    const method=menu.querySelector('[data-occlusion]');method.value=o.occlusionMethod;
    method.onchange=()=>{o=overlayStyle(kind);o.occlusionMethod=method.value;const target=maskTarget(viewHeat());target.occlusionAttempt=null;target.occlusionError=null;saveOverlay(kind,o);if(method.value==='learned')occlusionAvailability?.refresh();updateModelMaskStatus();};updateModelMaskStatus();
  }
  if (!isFront && viewHeat().asset?.mainCameraId !== cur().asset?.mainCameraId) {
    menu.querySelector('[data-key="modelInput"]').disabled = true;
    const reason = menu.querySelector('[data-model-input-reason]');
    reason.hidden = false;
    reason.textContent = `Switch to ${cur().asset.mainCameraLabel} to change this.`;
  }

  inputs.forEach(input => {
    input.oninput = () => {
      if (input.disabled || (input.type === 'number' && input.value === '')) return;
      const key = input.dataset.key;
      let value = input.type === 'checkbox' ? input.checked : input.type === 'color' ? input.value : Number(input.value);
      const limits = { fontSize: [8, 96], thickness: [0, 12], opacity: [0.1, 1], weight: [400, 900], pendingOpacity: [0.05, 0.6], inactiveOpacity:[0.05,0.8] };
      if (limits[key]) {
        if (!Number.isFinite(value)) return;
        value = Math.max(limits[key][0], Math.min(limits[key][1], value));
      }
      // Image dragging may have saved newer geometry while this menu stayed open.
      o = overlayStyle(kind);
      if(isFront&&key==='fontSize')value/=frontFontScale(o);
      o[key] = value;
      if (isFront && key === 'fontSize') syncEndSizes();
      if (input.type === 'range') syncRange(input);
      saveOverlay(kind, o);
    };
    if (input.type === 'number') input.onchange = () => {
      o = overlayStyle(kind);
      input.value = isFront&&input.dataset.key==='fontSize'?Math.round(o.fontSize*frontFontScale(o)):o[input.dataset.key];
    };
  });

  if (isFront) {
    menu.querySelector('[data-front-background]').onclick=()=>{
      const source=currentFrontPixels();
      if(!source){toast('Wait for a camera image first.');return;}
      frontOcclusion.configure(frontCacheKey||`sample:${S.meet?.dir||'sample'}:${$('#front').clientWidth}:${$('#front').clientHeight}`);
      frontOcclusion.generation++;frontOcclusion.loading=false;
      if(frontOcclusion.setReference(source.image))toast('Background set for this camera view.');
    };
    const count = menu.querySelector('[data-lane-count]');
    const placement = menu.querySelector('[data-placement]');
    count.onchange = () => {
      o = overlayStyle(kind);
      const first = frontLanePoint(o, 1), last = frontLanePoint(o, o.laneCount);
      o.laneCount = Math.max(2, Math.min(24, Math.round(Number(count.value) || 8)));
      count.value = o.laneCount;
      o.positions = { 1: first, [o.laneCount]: last };
      o.sizes = {};
      spreadFrontLanes(o);
      saveOverlay(kind, o);
    };
    placement.onchange = () => {
      o = overlayStyle(kind);
      o.placement = placement.value;
      saveOverlay(kind, o);
    };
    endSizes.forEach(input => {
      input.oninput = () => {
        if (input.value === '') return;
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        const size = Math.max(8, Math.min(160, value));
        o = overlayStyle(kind);
        o[input.dataset.endSize === 'first' ? 'firstScale' : 'lastScale'] = size / (o.fontSize*frontFontScale(o));
        o.sizes = {};
        if (o.placement === 'anchors') spreadFrontLanes(o);
        saveOverlay(kind, o);
      };
      input.onchange = () => { o = overlayStyle(kind); syncEndSizes(); };
    });
  }

  menu.querySelector('[data-reset]').onclick = () => {
    o = overlayStyle(kind);
    o.positions = {};
    o.boundaries = {};
    saveOverlay(kind, o);
  };
  menu.querySelector('[data-defaults]').onclick = () => {
    o = overlayStyle(kind);
    // Only appearance fields reset. Geometry, display effects and opt-ins survive.
    Object.assign(o, {
      fontSize: isFront ? 28/frontFontScale(o) : overlayDefaults.fontSize,
      weight: overlayDefaults.weight,
      thickness: overlayDefaults.thickness,
      textColor: overlayDefaults.textColor,
      lineColor: overlayDefaults.lineColor,
      opacity: isFront ? 0.5 : overlayDefaults.opacity,
      ...(!isFront ? { pendingColor: uiDefaults.pendingColor, pendingOpacity: uiDefaults.pendingOpacity, inactiveColor:uiDefaults.inactiveColor,inactiveOpacity:uiDefaults.inactiveOpacity } : {})
    });
    saveOverlay(kind, o);
    syncControls();
  };

  const previousExpanded = anchor.getAttribute('aria-expanded');
  const previousControls = anchor.getAttribute('aria-controls');
  const anchorRect = anchor.getBoundingClientRect();
  const currentAnchor = () => anchor.isConnected ? anchor : isFront ? frontLaneButton : toolbarAnchor('lanes');
  anchor.setAttribute('aria-expanded', 'true');
  anchor.setAttribute('aria-controls', id);
  let position = null;
  const placeMenu = () => {
    const viewport = window.visualViewport;
    const width = viewport ? viewport.width : window.innerWidth;
    const height = viewport ? viewport.height : window.innerHeight;
    const left = viewport ? viewport.offsetLeft : 0;
    const top = viewport ? viewport.offsetTop : 0;
    const margin = 8;
    menu.style.maxWidth = `${Math.max(0, width - 2 * margin)}px`;
    if (!position) {
      menu.style.maxHeight = `${Math.max(0, height - 2 * margin)}px`;
      const below = top + height - anchorRect.bottom - margin - 5;
      const y = menu.offsetHeight <= below ? anchorRect.bottom + 5 : anchorRect.top - menu.offsetHeight - 5;
      position = {x: anchorRect.left, y: Math.max(top + margin, y)};
    }
    position.x = Math.max(left + margin, Math.min(left + width - menu.offsetWidth - margin, position.x));
    position.y = Math.max(top + margin, Math.min(top + height - 96, position.y));
    menu.style.left = `${position.x}px`;
    menu.style.top = `${position.y}px`;
    menu.style.maxHeight = `${Math.max(0, top + height - position.y - margin)}px`;
  };
  const close = () => {
    menu.overlaySettingsCleanup();
    menu.remove();
    if (overlayMenu === menu) overlayMenu = null;
    currentAnchor()?.focus({ preventScroll: true });
  };
  const onEscape = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    close();
  };
  const observer = new ResizeObserver(placeMenu);
  menu.overlaySettingsCleanup = () => {
    observer.disconnect();
    window.removeEventListener('resize', placeMenu);
    window.visualViewport?.removeEventListener('resize', placeMenu);
    window.visualViewport?.removeEventListener('scroll', placeMenu);
    window.removeEventListener('keydown', onEscape, true);
    const target = currentAnchor();
    if (!target) return;
    if (previousExpanded === null) target.removeAttribute('aria-expanded');
    else target.setAttribute('aria-expanded', previousExpanded);
    if (previousControls === null) target.removeAttribute('aria-controls');
    else target.setAttribute('aria-controls', previousControls);
  };
  menu.querySelector('[data-close]').onclick = close;
  // Preserve native control keys while keeping race-entry shortcuts out of here.
  menu.addEventListener('keydown', event => event.stopPropagation());
  document.body.append(menu);
  placeMenu();
  observer.observe(menu);
  menu.querySelectorAll('details').forEach(group => group.addEventListener('toggle', () => {
    if (!group.open || !menu.isConnected) return;
    const panel = menu.getBoundingClientRect(), rect = group.getBoundingClientRect();
    const header = menu.querySelector('.overlay-title').offsetHeight;
    const bottom = Math.min(rect.bottom, rect.top + menu.clientHeight - header - 20);
    if (bottom > panel.bottom - 12) menu.scrollTop += bottom - panel.bottom + 12;
  }));
  window.addEventListener('resize', placeMenu);
  window.visualViewport?.addEventListener('resize', placeMenu);
  window.visualViewport?.addEventListener('scroll', placeMenu);
  window.addEventListener('keydown', onEscape, true);
  menu.querySelector('[data-key="enabled"]').focus({ preventScroll: true });
}
function updateFrontOverlay() {
  const layer=document.getElementById('frontLaneOverlay');if(!layer)return;
  if(!replayCameras(viewHeat()).front){layer.hidden=true;return;}
  const o=overlayStyle('front'),lanes=Array.from({length:o.laneCount},(_,i)=>i+1);
  if(!o.enabled||!o.behindRunners)layer.style.maskImage='none';
  layer.hidden=!o.enabled;if(!o.enabled)return;layer.style.opacity=o.opacity;
  const imageRect=frontImageRect(),scale=frontFontScale(o);
  layer.innerHTML='<div class="front-image-overlays"></div>';const content=layer.firstElementChild;
  Object.assign(content.style,{left:imageRect.x+'px',top:imageRect.y+'px',width:imageRect.width+'px',height:imageRect.height+'px'});
  content.innerHTML=lanes.map(lane=>{
    const pos=frontLanePoint(o,lane),movable=o.edit&&(o.placement==='individual'||lane===1||lane===o.laneCount);
    return `<span class="front-lane${o.edit&&o.placement==='anchors'&&(lane===1||lane===o.laneCount)?' lane-anchor':''}" data-lane="${lane}" style="left:${pos.x*100}%;top:${pos.y*100}%;font-size:${frontLaneSize(o,lane)*scale}px;font-weight:${o.weight};color:${o.textColor};-webkit-text-stroke:${o.thickness*scale}px ${o.lineColor};cursor:${movable?'grab':'default'};pointer-events:${movable?'auto':'none'}">${lane}</span>`;
  }).join('');
  layer.querySelectorAll('.front-lane').forEach(label=>{
    const lane=Number(label.dataset.lane);
    label.onwheel=e=>{if(!o.edit||!e.altKey)return;e.preventDefault();e.stopPropagation();o.sizes[lane]=Math.max(8/scale,Math.min(160/scale,frontLaneSize(o,lane)+(e.deltaY<0?1:-1)/scale));saveOverlay('front',o);};
    label.onpointerdown=e=>{
      if(!o.edit)return;e.preventDefault();e.stopPropagation();label.setPointerCapture(e.pointerId);
      const rect=frontPb.getBoundingClientRect(),f=S.fview;
      const move=ev=>{
        const x=Math.max(0.02,Math.min(0.98,((ev.clientX-rect.left-f.x)/f.s-imageRect.x)/imageRect.width)),y=Math.max(0.02,Math.min(0.98,((ev.clientY-rect.top-f.y)/f.s-imageRect.y)/imageRect.height));
        o.positions[lane]={x,y};if(o.placement==='anchors')spreadFrontLanes(o);
        layer.querySelectorAll('.front-lane').forEach(el=>{const p=frontLanePoint(o,Number(el.dataset.lane));el.style.left=p.x*100+'%';el.style.top=p.y*100+'%';});
      };
      const up=()=>{label.onpointermove=null;label.onpointerup=null;label.onpointercancel=null;saveOverlay('front',o);};
      label.onpointermove=move;label.onpointerup=up;label.onpointercancel=up;
    };
  });
}

// ---------------------------------------------------------------- line-scan toolbar
let toolbarPopover=null;
let toolbarOverflow=[];
async function toggleEmptyColumns() {
  const h=cur();if(h.cropBusy||!['review','saved'].includes(h.state))return;
  if(h.hideEmpty){h.hideEmpty=false;fitView();if(S.selCol!=null)focusFinish(S.selCol);renderUI();return;}
  h.cropBusy=true;renderTools();toast('Finding empty spans…');
  try{
    if(!h.cropResult)h.cropResult=await OM.call('autocrop.run',{captureId:h.captureId});
    const ranges=validateCropResult(h.cropResult.result,h.nCols),projection=columnProjection(ranges,h.nCols);
    const finishes=[...Object.values(h.marks).map(m=>m.col),...(h.proposals||[]).filter(p=>!h.status[p.lane]&&!h.dismissed?.[p.lane]).map(p=>p.col)];
    if(!projection.length||projection.length===h.nCols){toast('No empty spans to hide.');return;}
    if(finishes.some(c=>displayCoordinate(projection,c+0.5)==null)){toast('A marked finish is outside the cropper ranges. Full view kept.',true);return;}
    h.cropProjection=projection;h.hideEmpty=true;toast('Empty spans hidden. Original recording retained.');
    if(cur()===h){S.hoverCol=null;fitView();if(S.selCol!=null&&displayCoordinate(projection,S.selCol+0.5)!=null)focusFinish(S.selCol);else S.selCol=null;renderUI();}
  }catch(err){toast('Could not hide empty spans: '+err.message,true);}finally{h.cropBusy=false;renderTools();}
}
function scanToolStates() {
  const h=viewHeat(),captured=['review','saved'].includes(h.state)||(h.state==='running'&&h.liveCol>=0);
  const review=!S.cameraSetup&&['review','saved'].includes(h.state);
  const states={
    follow:{icon:ICON.next,when:h.state==='running',on:!S.view.user,disabled:false,action:()=>{S.view.followTransition={at:performance.now(),c0:S.view.c0,zx:S.view.zx};S.view.followZoom=S.view.zx;S.view.user=false;S.view.zoomed=false;S.zoomTool=false;S.hoverCol=null;follow(viewHeat());renderTools();invalidate();}},
    zoom:{icon:ICON.zoom,on:S.zoomTool,disabled:!captured,action:()=>{S.zoomTool=!S.zoomTool;renderTools();syncCursor();}},
    unzoom:{icon:ICON.fit,when:S.view.zoomed,disabled:!captured,action:()=>{fitView();renderUI();}},
    height:{icon:ICON.fit,on:!!S.frameEditor,disabled:false,action:toggleHeightFrame},
    mark:{icon:ICON.auto,disabled:!!S.cameraSetup||!!S.frameEditor||!captured||S.selLane==null||S.selCol==null,action:()=>setMark(S.selLane,S.selCol)},
    delete:{icon:ICON.clear,disabled:!!S.cameraSetup||!!S.frameEditor||!captured||S.selLane==null,action:deleteSelectedFinish},
    flip:{icon:ICON.flip,on:S.flip,disabled:false,action:()=>{S.flip=!S.flip;store.set('flip',S.flip);renderTools();}},
    lanes:{icon:ICON.lanes,on:overlayStyle('scan').enabled,disabled:false,action:anchor=>showOverlaySettings('scan',anchor)},
    auto:{icon:ICON.auto,on:S.autoMark,disabled:!!S.cameraSetup,action:anchor=>showToolbarPopover('auto',anchor)},
    hideEmpty:{icon:ICON.zoom,when:!!h.captureId&&review&&!!(S.cropInfo?.configured||h.cropResult),label:h.hideEmpty?'Show all columns':h.cropBusy?'Finding empty spans…':'Hide empty spans',on:!!h.hideEmpty,disabled:!!h.cropBusy,action:toggleEmptyColumns},
    autoRun:{icon:ICON.auto,disabled:!review||!S.apiOnline||h.req==='pending',action:()=>requestProposals(cur())},
    clear:{icon:ICON.clear,disabled:!review||!Object.keys(h.marks).length,action:clearMarks},
    revert:{icon:ICON.revert,disabled:!review||!h.base||h.base===snap(h),action:revert},
  };
  return SCAN_TOOLS.map(tool=>({...tool,when:true,...states[tool.id]}));
}
function toolbarAnchor(id) { return document.querySelector(`#tools [data-tool="${id}"]`)||document.querySelector('#tools [data-more]'); }
function runScanTool(id,anchor=toolbarAnchor(id)) {
  const tool=scanToolStates().find(t=>t.id===id);
  if(tool?.when&&!tool.disabled)tool.action(anchor);
}
function showToolbarPopover(kind,anchor) {
  overlayMenu?.overlaySettingsCleanup?.();overlayMenu?.remove();overlayMenu=null;sourceMenu?.close(false);
  toolbarPopover?.close(false);
  const menu=h_('div','scan-tool-menu'),rect=anchor.getBoundingClientRect(),heat=cur();
  menu.setAttribute('role',kind==='auto'?'dialog':'menu');menu.setAttribute('aria-label',kind==='auto'?'Auto timing':'More line-scan tools');
  let ids=[];
  const close=(focus=true)=>{menu.remove();window.removeEventListener('pointerdown',outside);window.removeEventListener('resize',closeOnResize);if(toolbarPopover?.menu===menu)toolbarPopover=null;const target=kind==='auto'?toolbarAnchor('auto'):document.querySelector('#tools [data-more]');target?.setAttribute('aria-expanded','false');if(focus)target?.focus();};
  const outside=e=>{if(!menu.contains(e.target)&&!e.target.closest('#tools'))close(false);};
  const closeOnResize=()=>close(false);
  const update=()=>{
    if(cur()!==heat){close(false);return;}
    const tools=scanToolStates();
    if(kind==='auto'){
      const toggle=menu.querySelector('[data-auto-toggle]'),run=menu.querySelector('[data-auto-run]');
      if(toggle){toggle.checked=S.autoMark;toggle.disabled=!!S.cameraSetup;run.disabled=!!S.cameraSetup||!['review','saved'].includes(cur().state)||!S.apiOnline||cur().req==='pending';menu.querySelector('[data-auto-status]').textContent=!S.apiOnline?'Offline':cur().req==='pending'?'Timing…':cur().reference?'Recorded results · reference playback':cur().stub?'Simulator stand-in':'Automatic suggestions as runners finish';}
      return;
    }
    const available=tools.filter(t=>toolbarOverflow.includes(t.id)&&t.when);
    const next=available.map(t=>t.id);
    if(!menu.children.length||JSON.stringify(next)!==JSON.stringify(ids)){
      ids=next;menu.replaceChildren();
      for(const group of ['View','Marking','Timing','Results']){
        const items=available.filter(t=>t.group===group);if(!items.length)continue;
        menu.append(h_('div','tool-menu-group',group));
        for(const tool of items){const button=h_('button','tool-menu-action'+(['clear','revert'].includes(tool.id)?' recovery':''));button.dataset.tool=tool.id;button.setAttribute('role','menuitem');button.innerHTML=`<span>${tool.icon}${tool.label}</span>${tool.shortcut?`<kbd>${tool.shortcut}</kbd>`:''}`;button.title=tool.help;button.onclick=()=>{close(false);runScanTool(tool.id,toolbarAnchor(tool.id));};menu.append(button);}
      }
      const footer=h_('div','tool-menu-footer');
      const customize=h_('button','tool-menu-action','Customize toolbar…');customize.setAttribute('role','menuitem');customize.onclick=()=>{close(false);showToolbarDialog('customize');};
      const help=h_('button','tool-menu-action','Controls & shortcuts…');help.setAttribute('role','menuitem');help.onclick=()=>{close(false);showToolbarDialog('help');};footer.append(customize,help);menu.append(footer);
    }
    for(const tool of available){const button=menu.querySelector(`[data-tool="${tool.id}"]`);button.disabled=tool.disabled;button.classList.toggle('on',!!tool.on);}
  };
  if(kind==='auto'){
    menu.classList.add('auto-timing-menu');
    menu.innerHTML='<h3>Auto timing</h3><label><span>Automatic suggestions</span><input data-auto-toggle type="checkbox" role="switch"></label><p data-auto-status></p><button class="btn wide" data-auto-run>Run now</button>';
    menu.querySelector('[data-auto-toggle]').onchange=e=>{S.autoMark=e.target.checked;store.set('autoMark',S.autoMark);renderUI();};
    menu.querySelector('[data-auto-run]').onclick=()=>{close(false);requestProposals(cur());};
  }
  toolbarPopover={menu,close,update};update();document.body.append(menu);
  menu.style.left=Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,rect.right-menu.offsetWidth))+'px';
  const below=innerHeight-rect.bottom-8;
  menu.style.top=(below>=Math.min(menu.offsetHeight,250)?rect.bottom+5:Math.max(8,rect.top-menu.offsetHeight-5))+'px';
  menu.style.maxHeight=Math.max(96,innerHeight-parseFloat(menu.style.top)-8)+'px';
  anchor.setAttribute('aria-expanded','true');
  window.addEventListener('pointerdown',outside);window.addEventListener('resize',closeOnResize);
  menu.onkeydown=e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();close();return;}if(kind==='more'&&['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();const buttons=[...menu.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);buttons[e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}};
  menu.querySelector('button:not(:disabled),input:not(:disabled)')?.focus({preventScroll:true});
}
function showToolbarDialog(kind) {
  toolbarPopover?.close(false);overlayMenu?.overlaySettingsCleanup?.();overlayMenu?.remove();overlayMenu=null;
  if(document.querySelector('.scan-toolbar-dialog[open]'))return;
  document.querySelector('.scan-toolbar-dialog')?.remove();
  const dialog=h_('dialog','scan-toolbar-dialog');dialog.setAttribute('aria-labelledby','scan-toolbar-dialog-title');
  const header=h_('div','toolbar-dialog-header');header.append(h_('h2','',kind==='customize'?'Customize toolbar':'Line-scan help'));
  header.querySelector('h2').id='scan-toolbar-dialog-title';const close=h_('button','btn sm','×');close.setAttribute('aria-label','Close');close.onclick=()=>dialog.close();header.append(close);dialog.append(header);
  const body=h_('div','toolbar-dialog-body');dialog.append(body);
  if(kind==='customize'){
    body.append(h_('p','toolbar-dialog-intro','Pin tools and put them in your preferred order.'));
    const list=h_('div','toolbar-customize-list');body.append(list);
    const draw=()=>{
      const preferences=toolbarPreferences(store.get('scanToolbar',null));list.replaceChildren();
      preferences.order.forEach((id,index)=>{
        const tool=SCAN_TOOLS.find(t=>t.id===id),row=h_('div','toolbar-customize-row'),label=h_('label'),pin=h_('input');pin.type='checkbox';pin.checked=preferences.pinned.includes(id);pin.setAttribute('aria-label',`Pin ${tool.label}`);
        pin.onchange=()=>{const next=toolbarPreferences(store.get('scanToolbar',null));next.pinned=pin.checked?[...next.pinned,id]:next.pinned.filter(t=>t!==id);store.set('scanToolbar',next);renderTools();};
        label.append(pin,h_('span','',tool.label));row.append(label);
        for(const [delta,text]of[[-1,'↑'],[1,'↓']]){const button=h_('button','btn sm',text);button.disabled=delta<0?index===0:index===preferences.order.length-1;button.setAttribute('aria-label',`Move ${tool.label} ${delta<0?'earlier':'later'}`);button.onclick=()=>{store.set('scanToolbar',moveToolbarTool(store.get('scanToolbar',null),id,delta));draw();renderTools();list.querySelector(`[data-order="${id}"] button${delta<0?':first-of-type':':last-of-type'}`)?.focus();};row.append(button);}
        row.dataset.order=id;list.append(row);
      });
    };draw();
    const footer=h_('div','toolbar-dialog-footer'),reset=h_('button','btn','Reset toolbar'),done=h_('button','btn primary','Done');reset.onclick=()=>{store.set('scanToolbar',toolbarPreferences(null));draw();renderTools();};done.onclick=()=>dialog.close();footer.append(reset,done);dialog.append(footer);
  }else{
    const intro=h_('p','toolbar-dialog-intro','Select a column, type a lane or hip number, then press Enter.');body.append(intro);
    for(const group of ['Marking','View','Timing','Results']){const section=h_('section','toolbar-help-section');section.append(h_('h3','',group));for(const tool of SCAN_TOOLS.filter(t=>t.group===group)){const row=h_('div','toolbar-help-row');row.innerHTML=`<div><b>${tool.label}</b>${tool.shortcut?`<kbd>${tool.shortcut}</kbd>`:''}</div><p>${tool.help}</p>`;section.append(row);}body.append(section);}
    const gestures=h_('p','toolbar-help-gestures');gestures.textContent='Wheel: scroll · Ctrl/Cmd + wheel: zoom · Drag: pan · Arrow keys: nudge the selected column · Shift + arrow: 10 columns';body.append(gestures);
    const footer=h_('div','toolbar-dialog-footer'),done=h_('button','btn primary','Got it');done.onclick=()=>dialog.close();footer.append(done);dialog.append(footer);
  }
  dialog.addEventListener('keydown',e=>e.stopPropagation());dialog.addEventListener('close',()=>{dialog.remove();document.querySelector('#tools [data-more]')?.focus();},{once:true});document.body.append(dialog);dialog.showModal();
}
let toolbarRenderKey='';
function renderTools() {
  invalidate();
  const h=viewHeat(),box=$('#tools');syncLaneGutter(overlayStyle('scan'));
  const tools=scanToolStates(),preferences=toolbarPreferences(store.get('scanToolbar',null));
  const key=JSON.stringify([box.clientWidth,h.replaySourceType,h.asset?.mainCameraId,h.asset?.mainCameraLabel,h.asset?.comparisonCameraLabel,cur().asset?.mainCameraId,cur().viewLoading,cur().asset?.lineScans?.length,!!overlayMenu?.isConnected,toolbarPopover?.menu.className,preferences,tools.map(t=>[t.id,t.when,t.on,t.disabled,t.label])]);
  if(toolbarRenderKey===key){toolbarPopover?.update();return;}toolbarRenderKey=key;box.innerHTML='';
  const camera=$('#scanCameraLabel');camera.textContent=(h.asset?.mainCameraLabel||'Main scan')+' ▾';camera.disabled=!!cur().viewLoading||!cur().asset?.lineScans?.length;camera.onclick=e=>showSourceMenu('main',e.currentTarget);
  camera.title=h.asset?.mainCameraId!==cur().asset?.mainCameraId?`Viewing ${h.asset.mainCameraLabel}; recording and auto-timing use ${cur().asset.mainCameraLabel}`:`${h.asset?.mainCameraLabel||'Main scan'} · Choose main line-scan view`;
  const backupTitle=backupCv?.parentNode?.parentNode?.querySelector('.kicker');if(backupTitle)backupTitle.textContent=h.asset?.comparisonCameraLabel?`${h.asset.comparisonCameraLabel} ▾`:'Backup line-scan';
  comparisonPicker.disabled=!replayCameras(h).comparison;
  backupLinkButton.disabled=!replayCameras(h).comparison;
  frontLaneButton.disabled=!replayCameras(h).front;
  const pinned=h_('div','pinned-scan-tools');box.append(pinned);
  for(const id of preferences.order){const tool=tools.find(t=>t.id===id);if(!preferences.pinned.includes(id)||!tool.when)continue;
    const button=h_('button','tool'+(tool.on?' on':'')+(id==='mark'?' primary-tool':''));button.dataset.tool=id;button.title=tool.help;button.disabled=tool.disabled;
    button.innerHTML=tool.icon+tool.label+(['lanes','auto'].includes(id)?' ▾':'');
    if(['lanes','auto'].includes(id)){button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded',String(id==='lanes'?!!overlayMenu?.isConnected:toolbarPopover?.menu?.classList.contains('auto-timing-menu')||false));}
    else if(['follow','zoom','flip','hideEmpty','height'].includes(id))button.setAttribute('aria-pressed',String(!!tool.on));
    button.onclick=()=>{if(id==='auto'&&toolbarPopover?.menu.classList.contains('auto-timing-menu')){toolbarPopover.close();return;}toolbarPopover?.close(false);runScanTool(id,button);};pinned.append(button);
  }
  const more=h_('button','tool more-scan-tools','⋯');more.dataset.more='';more.title='More tools, customize toolbar, and help';more.setAttribute('aria-label','More line-scan tools');more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded',String(!!toolbarPopover&&!toolbarPopover.menu.classList.contains('auto-timing-menu')));
  more.onclick=()=>{if(toolbarPopover?.menu.getAttribute('role')==='menu')toolbarPopover.close();else showToolbarPopover('more',more);};box.append(more);
  while(pinned.children.length&&pinned.scrollWidth>pinned.clientWidth+1)pinned.lastElementChild.remove();
  const visible=[...pinned.children].map(b=>b.dataset.tool);toolbarOverflow=tools.filter(t=>!visible.includes(t.id)).map(t=>t.id);
  toolbarPopover?.update();
}
function initScanToolbar() {
  let width=0;new ResizeObserver(entries=>{const next=Math.round(entries[0].contentRect.width);if(next!==width){width=next;renderTools();}}).observe($('#tools'));
}
function syncCursor() { scanCv.classList.toggle('zoom', S.zoomTool); }

function renderUI() {
  invalidate();
  renderTabs(); renderStatus(); renderSide(); renderRace(); renderAcc(); renderProps(); renderSchedule(); renderDrawer(); renderTools();
  if(!S.cameraSetup)publishBoard();
  updateFrontOverlay();
  updateTs();
}
// The timestamp follows the mouse over the line-scan, and falls back to the selected column.
function updateEntryNumber() {
  const el = document.getElementById('entryNumber');
  if (el) { el.hidden = !S.entryNumber; el.textContent = `${cur().unlaned ? 'Hip / bib' : 'Lane'} ${S.entryNumber} ↵`; }
}
function updateTs() {
  updateEntryNumber();
  const ts = $('#ts'), h = viewHeat(), col = S.hoverCol != null ? S.hoverCol : S.selCol;
  if (col != null && h.img) { ts.textContent = fmtT(raceTime(h, col)) + ' s'; ts.classList.remove('none'); }
  else { ts.textContent = '--.---'; ts.classList.add('none'); }
  ts.classList.toggle('hover', S.hoverCol != null && S.hoverCol !== S.selCol);
}
let toastTimer;
function toast(t, bad = false) {
  const e = $('#toast'); e.textContent = t; e.classList.add('show'); e.classList.toggle('bad', bad);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.remove('show'), bad ? 9000 : 4200);
}

// ---------------------------------------------------------------- the real meet folder (Electron only)
function orderEvents(parsed) {
  const evs = parsed.events.filter(e => e.entries.some(x => x.lane));
  if (!parsed.schedule || !parsed.schedule.length) return evs;
  const key = (e, r, h) => `${e}|${r}|${h}`;
  const byKey = new Map(evs.map(e => [key(e.event, e.round, e.heat), e]));
  const ordered = parsed.schedule.map(k => byKey.get(key(k.event, k.round, k.heat))).filter(Boolean);
  return [...ordered, ...evs.filter(e => !ordered.includes(e))];
}
function applyMeet(parsed, fresh) {
  const evs = orderEvents(parsed);
  if (fresh) {
    S.lastLiveHeat=null;HEATS = evs.map(e => bindReplayHeat(buildHeat(specFromEvent(e, evs))));
    S.idx = 0; S.files = []; S.selLane = null; S.selCol = null;
    const h = cur(); ensureStrip(h); if (S.autoArm) h.state = 'armed';
    fitView(); renderUI();
    return;
  }
  // Live re-seed from the meet manager: heats not yet started take the new start list; a heat that already ran only warns.
  const notes = [],selectedKey=JSON.stringify([cur().ev,cur().rd,cur().ht]);
  evs.forEach(e => {
    const spec = specFromEvent(e, evs), i = HEATS.findIndex(h => h.ev === e.event && h.rd === e.round && h.ht === e.heat);
    if (i < 0) { HEATS.push(bindReplayHeat(buildHeat(spec))); notes.push(`${spec.name} heat ${e.heat} added`); return; }
    const h = HEATS[i];
    if (JSON.stringify(h.entries) === JSON.stringify(spec.entries)) return;
    if (h.state === 'loaded' || h.state === 'armed') {
      const nh = bindReplayHeat(buildHeat(spec)); nh.state = h.state;
      if (h.asset) attachAsset(nh, h.asset);
      ensureStrip(nh); HEATS[i] = nh;
      notes.push(`${spec.name} heat ${e.heat} re-seeded`);
    } else notes.push(`${spec.name} heat ${e.heat} changed after it ran: check it against the meet manager`);
  });
  const runOrder=new Map(evs.map((e,i)=>[JSON.stringify([e.event,e.round,e.heat]),i]));
  HEATS.forEach(h=>{h.offSchedule=!runOrder.has(JSON.stringify([h.ev,h.rd,h.ht]));});
  HEATS.sort((a,b)=>(runOrder.get(JSON.stringify([a.ev,a.rd,a.ht]))??Infinity)-(runOrder.get(JSON.stringify([b.ev,b.rd,b.ht]))??Infinity));
  S.idx=Math.max(0,HEATS.findIndex(h=>JSON.stringify([h.ev,h.rd,h.ht])===selectedKey));
  if (notes.length) toast('Meet folder changed: ' + notes.join('; ') + '.', notes.some(n => n.includes('after it ran')));
  renderUI();
}
async function openMeet(dir) {
  if(runningHeat()||S.sourceChanging){toast('Stop capture before changing the meet folder.',true);return;}
  S.sourceChanging=true;renderUI();
  try {
    if(S.cameraSetup)await stopCameraSetup(true);
    if(S.cameraSetup)throw Error('Camera preview is still active');
    const r = await OM.call('meet.open', { dir });
    if (!r.parsed || !r.parsed.events.some(e => e.entries.some(x => x.lane))) { toast(`No laned heats found in ${dir} (lynx.evt missing or empty).`, true); return; }
    const s = await OM.call('settings.get').catch(() => ({}));
    S.meet = { dir, files: r.files, resultsDir: s.resultsFor && s.resultsFor[dir] ? s.resultsFor[dir] : null };
    S.simulationSource=null;scanSourceViews.clear();attemptsByHeat.clear();
    applyMeet(r.parsed, true);
    await OM.call('settings.set', { patch: { meetDir: dir, demoDir:null, simulationSourceId:null } });
    toast(`Opened ${dir}: ${HEATS.length} heats.`);
  } catch (err) { toast('Could not open the meet folder: ' + err.message, true); }
  finally {S.sourceChanging=false;renderUI();}
}
function bindReplayHeat(h) {
  if(!S.meet?.demo)return h;
  h.replaySourceType=S.simulationSource.type;
  h.athletes.forEach(a=>{a.truth=null;});
  const asset=S.meet.replayHeats.find(a=>replayHeatKey(a)===replayHeatKey(h));
  return asset?attachAsset(h,asset):h;
}
// TTP and real-recorded folders share the same native line-scan replay path.
function attachAsset(h, a) {
  if(a)a=cameraAsset(a,store.get(cameraRoleKey(),{}));
  if (!a || !a.primary || !a.primaryMeta || !a.primarySize) return h;
  const m = a.primaryMeta;
  // the engine's camera streams from the gun: pre-roll columns from race time 0, then the rendered finish window
  const nPre = Math.max(0, Math.round(m.first_column_race_time_s / m.column_period_s));
  h.asset = a; h.replaySourceType=a.sourceType||'ttp'; h.rows = a.primarySize.height || m.rows; h.nCols = nPre + a.primarySize.width;
  h.tOpen = m.first_column_race_time_s - nPre * m.column_period_s; h.tClose = h.tOpen + h.nCols * m.column_period_s;
  h.laneRows = Array.isArray(m.lane_rows) && m.lane_rows.length ? m.lane_rows.map(x => ({ lane: x.lane, top: x.top_row, bottom: x.bottom_row })) : null;
  rememberScanGeometry(h,{},h===cur());
  h.athletes.forEach(at => { at.truth = null; });            // truth stays in the engine
  h.wind = null; h.img = null; h.frontRec = null;
  h.backupImg=null;
  if (a.backup && a.backupMeta) { const im = new Image(); im.onload = invalidate; im.src = OM.fileUrl(a.backup); h.backupImg = im; }
  return h;
}
function cameraRoleKey(){return `camera-roles:${S.meet?.dir||'sample'}`;}
function renderCameraRoles(container) {
  const asset=cur().asset,scans=asset?.lineScans;if(!scans?.length)return;
  const roles=store.get(cameraRoleKey(),{}),selected=cameraAsset(asset,roles),box=h_('div','camera-role-fields wide');
  for(const [key,label,value]of[['main','Main line-scan',selected.mainCameraId],['comparison','Comparison',selected.comparisonCameraId]]) {
    const row=h_('label'),select=h_('select');select.setAttribute('aria-label',label);
    scans.filter(s=>key==='main'||s.id!==selected.mainCameraId).forEach(s=>{const option=h_('option','',s.label);option.value=s.id;select.append(option);});
    select.value=value||'';select.disabled=cur().state==='running'||S.cameraSetup?.starting||S.cameraSetup?.stopping||select.options.length<2;
    select.onchange=()=>chooseScanView(key,select.value);
    row.append(h_('span','',label),select);box.append(row);
  }
  container.append(box);
  if(['review','saved'].includes(cur().state))box.append(h_('p','dimtext','Changing the view keeps the original recording and finish times. The chosen roles also prepare the next capture.'));
}
async function importSimulationSource(type) {
  if(!OM||runningHeat()||S.sourceChanging)return;
  await openDemo(null,{importType:type});
}
async function openDemo(dir, selection = {}) {
  if(!OM||runningHeat()||S.sourceChanging){toast('Stop capture before changing simulation sources.',true);return false;}
  S.sourceChanging=true;renderUI();
  try {
    if(S.cameraSetup)await stopCameraSetup(true);
    if(S.cameraSetup)throw Error('Camera preview is still active');
    let id=selection.id;
    if(selection.importType){
      dir=await OM.pickFolder(selection.importType==='real'?'Import real meet replay folder':'Import TTP simulator folder');
      if(!dir)return false;
      const source=await OM.call('demo.import',{dir,type:selection.importType});id=source.id;
    }
    const r=await OM.call('demo.load',id?{id}:{dir,type:selection.type||'ttp'});
    const settings=await OM.call('settings.get');
    S.simulationCatalog=await OM.call('demo.catalog');S.simulationSource=r.source;
    scanSourceViews.clear();attemptsByHeat.clear();S.lastLiveHeat=null;
    if(r.source.type==='builtin'){
      S.meet=null;S.source='replay';HEATS=SPECS.map(buildHeat);S.idx=0;S.files=[];S.selLane=null;S.selCol=null;S.hoverCol=null;
      const h=cur();ensureStrip(h);if(S.autoArm)h.state='armed';fitView();
    }else{
      S.meet={dir:r.meet.dir,files:r.meet.files,demo:r.dir,replayHeats:r.heats,resultsDir:settings.resultsFor?.[r.meet.dir]||null};
      applyMeet(r.meet.parsed,true);
    }
    S.bview.linked=true;Object.assign(S.fview,{s:1,x:0,y:0});applyFrontView();
    toast(`${sourceLabel(r.source)}${r.meet?`: ${r.heats.length} recorded heats.`:'.'}`);
    return true;
  }catch(err){toast('Could not open simulation source: '+err.message,true);return false;}
  finally {S.sourceChanging=false;renderUI();}
}
function closeMeet() { return openDemo(null,{id:'builtin'}); }

// ---------------------------------------------------------------- canvases
let TK = {}, dirty = true;
const invalidate = () => { dirty = true; };
function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  ['scanbg', 'deep', 'paper', 'muted', 'dim', 'blue', 'mint', 'amber', 'finish', 'on-accent', 'rule2', 'mono', 'sans'].forEach(k => { TK[k] = cs.getPropertyValue('--' + k).trim(); });
}
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, hgt = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [g, w, hgt];
}
const scanCv = $('#scan');scanCv.tabIndex=0;scanCv.setAttribute('aria-label','Main line-scan image');
const laneGutter=$('#laneGutter');
const scanW = () => scanCv.clientWidth, scanH = () => scanCv.clientHeight - RULER;
const heightEditor=$('#scanHeightEditor');
function renderHeightFrame(h) {
  if(S.frameEditor&&S.frameEditor.key!==scanFrameKey(h))S.frameEditor=null;
  heightEditor.hidden=!S.frameEditor;if(!S.frameEditor)return;
  const frame=cameraFrame(h),rows=rowsOf(h),height=scanH();
  heightEditor.querySelector('.height-shade-top').style.height=frame.top*100+'%';
  heightEditor.querySelector('.height-shade-bottom').style.top=frame.bottom*100+'%';
  for(const edge of heightEditor.querySelectorAll('[data-edge]')){
    const name=edge.dataset.edge,y=frame[name]*height,top=Math.max(0,Math.min(height-24,y-12));
    edge.style.top=top+'px';edge.style.setProperty('--edge-y',(y-top)+'px');
    edge.setAttribute('aria-valuemin',name==='top'?0:Math.ceil((frame.top+.05)*rows));
    edge.setAttribute('aria-valuemax',name==='top'?Math.floor((frame.bottom-.05)*rows):rows);
    edge.setAttribute('aria-valuenow',Math.round(frame[name]*rows));
    edge.setAttribute('aria-valuetext',`Row ${Math.round(frame[name]*rows)} of ${rows}`);
    edge.title='Drag to frame the view. Arrow keys: one row; Shift: ten rows.';
  }
}
function changeFrameEdge(name,value) {
  if(!S.frameEditor||S.frameEditor.key!==scanFrameKey())return;
  const frame=cameraFrame(viewHeat());
  frame[name]=name==='top'?Math.max(0,Math.min(frame.bottom-.05,value)):Math.max(frame.top+.05,Math.min(1,value));
  store.set(S.frameEditor.key,frame);invalidate();
}
for(const edge of heightEditor.querySelectorAll('[data-edge]')){
  edge.onpointerdown=e=>{
    if(e.button!==0||!S.frameEditor)return;e.preventDefault();e.stopPropagation();edge.focus({preventScroll:true});edge.setPointerCapture(e.pointerId);
    const rect=heightEditor.getBoundingClientRect(),name=edge.dataset.edge,start=cameraFrame(viewHeat())[name],y=e.clientY;
    const move=ev=>changeFrameEdge(name,start+(ev.clientY-y)/rect.height);
    const done=()=>{edge.onpointermove=null;edge.onpointerup=null;edge.onpointercancel=null;edge.onlostpointercapture=null;};
    edge.onpointermove=move;edge.onpointerup=done;edge.onpointercancel=done;edge.onlostpointercapture=done;
  };
  edge.onkeydown=e=>{
    if(!['ArrowUp','ArrowDown','Home','End'].includes(e.key))return;e.preventDefault();e.stopPropagation();
    const name=edge.dataset.edge,frame=cameraFrame(viewHeat());
    changeFrameEdge(name,e.key==='Home'?0:e.key==='End'?1:frame[name]+(e.key==='ArrowUp'?-1:1)*(e.shiftKey?10:1)/rowsOf(viewHeat()));
  };
}
heightEditor.querySelector('[data-full-height]').onclick=()=>{if(S.frameEditor){store.set(S.frameEditor.key,{top:0,bottom:1});invalidate();}};
heightEditor.querySelector('[data-height-done]').onclick=()=>{finishHeightFrame();toolbarAnchor('height')?.focus({preventScroll:true});};
heightEditor.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finishHeightFrame();toolbarAnchor('height')?.focus({preventScroll:true});}};
function pendingLaneIds(h,o) {
  return new Set(o.needsFinish&&!S.cameraSetup&&['running','review','saved'].includes(h.state)?h.athletes.filter(a=>!resolved(h,a)).map(a=>a.lane):[]);
}
function syncLaneGutter(o) {
  const h=viewHeat(),hasStatus=!S.cameraSetup&&(Object.keys(h.status||{}).length>0||laneBands(h).some(b=>!h.athletes.some(a=>a.lane===b.lane)));
  const wrap=laneGutter.parentNode,width=hasStatus?72:Math.max(40,Math.min(64,20+12*String(Math.max(...laneBands(h).map(b=>b.lane))).length)),size=width+'px';
  if(laneGutter.hidden===!o.enabled&&wrap.style.getPropertyValue('--lane-gutter-width')===size)return;
  const oldWidth=scanW(),center=S.view.c0+oldWidth/(2*S.view.zx);
  laneGutter.hidden=!o.enabled;wrap.classList.toggle('with-lane-gutter',o.enabled);wrap.style.setProperty('--lane-gutter-width',size);
  if(oldWidth&&S.view.zx){S.view.c0=center-scanW()/(2*S.view.zx);clampView();}
  laneGutter.dataset.renderKey='';
}
function renderLaneGutter(h) {
  if(laneGutter.hidden)return;
  const o=overlayStyle('scan'),edges=scanBoundaries(laneBands(h),o,rowsOf(h)),pending=pendingLaneIds(h,o),v=S.view,Hi=scanH();
  const key=JSON.stringify([Hi,v.r0,v.zy,edges,o.fontSize,o.weight,o.textColor,o.lineColor,o.thickness,o.opacity,o.edit,[...pending],h.status,S.selLane]);
  if(laneGutter.dataset.renderKey===key)return;laneGutter.dataset.renderKey=key;laneGutter.replaceChildren();
  for(let i=0;i<edges.length-1;i++){
    const lane=edges[i].below,top=Math.max(0,(edges[i].row-v.r0)*v.zy),bottom=Math.min(Hi,(edges[i+1].row-v.r0)*v.zy);
    if(lane==null||bottom<=top)continue;
    const entered=h.athletes.some(a=>a.lane===lane),status=!S.cameraSetup?(h.status[lane]||(!entered?'Empty':null)):null;
    const row=h_('button','lane-row'+(S.selLane===lane?' selected':'')+(pending.has(lane)?' pending':'')+(status?' has-status':'')+(['DNS','FS','Empty'].includes(status)?' empty-lane':''));row.disabled=!S.cameraSetup&&!entered;row.dataset.lane=lane;row.style.top=top+'px';row.style.height=bottom-top+'px';row.style.fontSize=Math.max(6,Math.min(28,Math.floor((bottom-top)*0.7),(laneGutter.clientWidth-12)/(String(lane).length*0.65)))+'px';row.style.fontWeight=o.weight;row.style.color=o.textColor;
    if(bottom-top>=8){row.append(h_('span','lane-number',lane));if(status){const code=h_('small','lane-status',status);row.append(code);}}
    row.setAttribute('aria-label',`Lane ${lane}${status?', '+status:''}${pending.has(lane)?', awaiting a finish or status':''}`);row.setAttribute('aria-pressed',String(S.selLane===lane));
    row.onclick=()=>{if(S.cameraSetup){S.selLane=lane;renderUI();}else selectLane(lane);};laneGutter.append(row);
  }
  edges.forEach(b=>{
    const y=(b.row-v.r0)*v.zy;if(y<0||y>Hi)return;
    const divider=h_('button','lane-divider');divider.dataset.boundary=b.key;divider.style.top=(y-6)+'px';divider.style.setProperty('--divider-color',o.lineColor);divider.style.setProperty('--divider-width',Math.max(1,o.thickness)+'px');divider.style.setProperty('--divider-opacity',o.opacity);
    const name=b.above==null?`Top edge of lane ${b.below}`:b.below==null?`Bottom edge of lane ${b.above}`:`Boundary between lanes ${b.above} and ${b.below}`;
    divider.title=name+' · Drag to adjust';divider.setAttribute('aria-label',name);
    divider.onmousedown=e=>{if(e.button!==0)return;e.preventDefault();divider.focus();const r=laneGutter.getBoundingClientRect(),offset=(e.clientY-r.top)/S.view.zy+S.view.r0-b.row;S.drag={mode:'lane-boundary',key:b.key,offset,moved:false,x0:0,y0:e.clientY-r.top,x1:0,y1:e.clientY-r.top};};
    divider.onkeydown=e=>{if(!['ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();const value=overlayStyle('scan'),index=edges.findIndex(edge=>edge.key===b.key);value.boundaries=Object.fromEntries(edges.map(edge=>[edge.key,edge.row]));value.boundaries[b.key]=movedBoundaryRow(edges,index,b.row+(e.key==='ArrowUp'?-1:1)*(e.shiftKey?10:1),rowsOf(h));value.positions={};saveOverlay('scan',value);requestAnimationFrame(()=>{renderLaneGutter(viewHeat());laneGutter.querySelector(`[data-boundary="${CSS.escape(b.key)}"]`)?.focus();});};laneGutter.append(divider);
  });
}
function initWorkspaceSplit() {
  const main=$('.main'),bar=$('#workspaceSplit');let ratio=store.get('workspaceSplit',0.5);
  const apply=next=>{const old=scanH(),available=main.clientHeight-8,min=140,max=Math.max(min,available-220),height=Math.max(min,Math.min(max,next*available));ratio=height/available;main.style.gridTemplateRows=`${height}px 8px minmax(0,1fr)`;const now=scanH();if(old>0&&S.view.zy)S.view.zy*=now/old;bar.setAttribute('aria-valuemin',Math.round(min/available*100));bar.setAttribute('aria-valuemax',Math.round(max/available*100));bar.setAttribute('aria-valuenow',Math.round(ratio*100));bar.setAttribute('aria-valuetext',`${Math.round(ratio*100)} percent workspace`);renderTiles();invalidate();};
  bar.title='Drag to resize · Up/Down to adjust · Enter to reset';
  bar.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();bar.setPointerCapture(e.pointerId);const move=ev=>apply((ev.clientY-main.getBoundingClientRect().top)/(main.clientHeight-8)),up=()=>{bar.removeEventListener('pointermove',move);bar.removeEventListener('pointerup',up);bar.removeEventListener('pointercancel',up);store.set('workspaceSplit',ratio);};bar.addEventListener('pointermove',move);bar.addEventListener('pointerup',up,{once:true});bar.addEventListener('pointercancel',up,{once:true});};
  bar.onkeydown=e=>{let next=ratio;if(e.key==='ArrowUp')next-=(e.shiftKey?40:10)/(main.clientHeight-8);else if(e.key==='ArrowDown')next+=(e.shiftKey?40:10)/(main.clientHeight-8);else if(e.key==='Home')next=0;else if(e.key==='End')next=1;else if(e.key==='Enter')next=0.5;else return;e.preventDefault();e.stopPropagation();apply(next);store.set('workspaceSplit',ratio);};
  new ResizeObserver(()=>apply(ratio)).observe(main);apply(ratio);
}
// The line-scan never condenses past MIN_ZX px per column (about 3 s of race on a laptop screen):
// beyond that it scrolls instead. The default view ends at the capture's end, where the finishers are.
const MIN_ZX = 0.6;
function fitView() {
  const h = viewHeat(), v = S.view, W = scanW();
  S.bview.linked=true;
  v.focusLane=null;
  v.zx = Math.max(MIN_ZX, Math.min(1, W / displayCount(h)));
  v.c0 = Math.max(0, displayCount(h) - W / v.zx);
  fitScanHeight(h); v.zoomed = false;
}
function clampView() {
  const h = viewHeat(), v = S.view, vis = scanW() / v.zx;
  v.c0 = Math.max(h.preview?(h.minCol||0):-vis*0.05, Math.min(displayCount(h) - vis * 0.95, v.c0));
  const rows=visibleRows(h),span=scanH()/v.zy;
  v.r0 = Math.max(rows.top, Math.min(rows.bottom-span, v.r0));
}
function focusFinish(col) {
  const v = S.view,h=viewHeat();
  if(toDisplay(h,col+0.5)==null){cur().hideEmpty=false;}
  S.bview.linked=true;v.focusLane=S.selLane;
  v.zx = Math.max(v.zx, 1.5);
  v.c0 = toDisplay(h,col+0.5) - scanW() / (2 * v.zx);
  const body=cameraLaneBody((h.displayMeta||h.asset?.primaryMeta)?.lane_rows,S.selLane),span=scanH()/v.zy;
  if(body&&span<visibleRows(h).bottom-visibleRows(h).top-0.5)v.r0=body.center-span/2;
  v.zoomed = true; v.user = true;
  clampView();
}
function centerOn(col) {
  const v = S.view, vis = scanW() / v.zx;col=toDisplay(viewHeat(),col+0.5);
  if (col < v.c0 + vis * 0.1 || col > v.c0 + vis * 0.9) { v.c0 = col - vis / 2; clampView(); }
}
// While running: the scan streams in at 1:1, condenses down to MIN_ZX, then autoscrolls with the live edge at the right.
function follow(h,now=performance.now()) {
  const v = S.view, W = scanW(), n = Math.max(1,h.presentedCols??h.liveCol+1);
  fitScanHeight(h);
  v.focusLane=null;
  const zx=Math.max(MIN_ZX,v.followZoom??Math.min(1,W/n)),c0=Math.max(0,n-W/zx);
  if(h.liveFollow?.resumed&&!v.followTransition)v.followTransition={at:now,c0:v.c0,zx:v.zx};
  const transition=v.followTransition;
  if(transition){const t=Math.min(1,Math.max(0,(now-transition.at)/240)),ease=t*t*(3-2*t);v.zx=transition.zx+(zx-transition.zx)*ease;v.c0=transition.c0+(c0-transition.c0)*ease;if(t===1)v.followTransition=null;}
  else{v.zx=zx;v.c0=c0;}
}
// screen x <-> column, honouring Flip (mirrored: later times to the left)
const unflipX = x => (S.flip ? scanW() - x : x);
const xOf = col => {const value=toDisplay(viewHeat(),col+0.5);return value==null?NaN:unflipX((value-S.view.c0)*S.view.zx);};
const colOf = x => {const h=viewHeat(),column=toOriginal(h,S.view.c0+unflipX(x)/S.view.zx);if(!h.displaySource)return Math.floor(column);const s=h.displaySource,time=h.tOpen+column*periodOf(h),native=Math.floor((time-s.t)/s.p);return (s.t+(native+0.5)*s.p-h.tOpen)/periodOf(h)-0.5;};

function sampleForeground(h) {
  if(h.asset||h.preview||h.sampleForeground)return;
  const source=h.sampleStrip||h.img;if(!source?.width)return;
  const image={data:source.getContext('2d').getImageData(0,0,source.width,source.height).data,width:source.width,height:source.height,channels:4,layout:'rows'};
  h.overlayBackground=scanBackground(image);
  h.sampleForeground=new Uint8Array(Math.ceil(image.width*image.height/8));
  writeForegroundMask(h.sampleForeground,0,image,h.overlayBackground);
}
const maskTarget=h=>h.displaySource||h.recordingHeat||h;
const maskRequestKey=h=>`${h.captureId}:${h.asset?.mainCameraId||'primary'}`;
let occlusionJob=null;
function learnedMask(h) {
  const mask=maskTarget(h).learnedForeground;return mask?.key===maskRequestKey(h)?mask:null;
}
function updateModelMaskStatus() {
  const label=overlayMenu?.querySelector('[data-occlusion-status]');if(!label)return;
  const h=viewHeat(),target=maskTarget(h),o=overlayStyle('scan');
  label.textContent=modelMaskStatus({method:o.occlusionMethod,enabled:o.enabled,behind:o.behindRunners,ready:!!learnedMask(h),busy:target.occlusionBusy,error:target.occlusionError,state:h.state,captureId:h.captureId,service:S.occlusionInfo,checking:occlusionAvailability?.checking,queued:!!occlusionJob});
  label.title=target.occlusionError||S.occlusionInfo?.error||'Experimental line-scan mask. Real-data verification is still pending.';
}
async function maybeLearnedMask(h,o) {
  if(!OM||S.cameraSetup||occlusionAvailability?.checking||!o.enabled||!o.behindRunners||o.occlusionMethod!=='learned'||!['review','saved'].includes(h.state)||!h.captureId||!S.occlusionInfo?.ready)return;
  const target=maskTarget(h),key=maskRequestKey(h);if(occlusionJob||target.occlusionBusy||target.occlusionAttempt===key||learnedMask(h))return;
  occlusionJob=key;target.occlusionAttempt=key;target.occlusionBusy=true;target.occlusionError=null;updateModelMaskStatus();
  try{
    const descriptor=h.displaySource&&(h.recordingHeat||h).asset.lineScans.find(s=>s.id===h.asset.mainCameraId);
    const response=await OM.call('occlusion.predict',{captureId:h.captureId,viewPng:descriptor?.png||null});
    const width=h.displaySource?h.displaySource.w:h.nCols,rows=rowsOf(h);
    if(response.width!==width||response.height!==rows)throw Error('Mask geometry differs from this camera');
    const image=new Image();image.src='data:image/png;base64,'+response.mask_png_base64;await image.decode();
    if(image.naturalWidth!==width||image.naturalHeight!==rows)throw Error('Mask pixels differ from this camera');
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=rows;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const pixels=ctx.getImageData(0,0,width,rows).data,bits=new Uint8Array(Math.ceil(width*rows/8));
    for(let y=0;y<rows;y++)for(let x=0;x<width;x++)if(pixels[(y*width+x)*4]>127){const i=x*rows+y;bits[i>>3]|=1<<(i&7);}
    if(maskRequestKey(h)===key)target.learnedForeground={key,bits,width,rows,requestId:response.request_id,model:response.model};
  }catch(err){target.occlusionError=err.message;toast('Model mask unavailable; Simple kept.',true);}
  finally{occlusionJob=null;target.occlusionBusy=false;updateModelMaskStatus();invalidate();}
}
function guideOccluded(h, x0, x1, row0, row1) {
  const model=h.activeOcclusionMask;
  if(h.displaySource){const s=h.displaySource,a=Math.floor((colTime(h,colOf(x0))-s.t)/s.p)-1,b=Math.ceil((colTime(h,colOf(x1))-s.t)/s.p)+1;for(let x=Math.max(0,Math.min(a,b));x<=Math.min(s.w-1,Math.max(a,b));x++)if(foregroundInRows(model?.bits||s.mask,x,s.rows,Math.max(0,Math.floor(row0)-2),Math.ceil(row1)+2))return true;return false;}
  const first=Math.max(0,Math.min(colOf(x0),colOf(x1))-1),last=Math.min((h.state==='running'?h.liveCol:h.nCols-1),Math.max(colOf(x0),colOf(x1))+1);
  const rows=rowsOf(h),lo=Math.max(0,Math.floor(row0)-2),hi=Math.min(rows-1,Math.ceil(row1)+2);
  for(let c=first;c<=last;c++) {
    const mask=model?.bits||h.sampleForeground||h.foregroundTiles?.[Math.floor(c/STRIP_TILE)];
    const local=model||h.sampleForeground?c:c%STRIP_TILE;
    if(foregroundInRows(mask,local,rows,lo,hi))return true;
  }
  return false;
}
function hitScanBoundary(h,x,y,inGutter=false) {
  const o=overlayStyle('scan'),captured=h.state==='review'||h.state==='saved'||(h.state==='running'&&h.liveCol>=0);
  if(!captured||!o.enabled||!o.edit||(!inGutter&&S.zoomTool)||y<0||y>scanH())return null;
  return scanBoundaries(laneBands(h),o,rowsOf(h)).map(b=>{
    const lineY=(b.row-S.view.r0)*S.view.zy;
    const distance=Math.abs(lineY-y);
    return {...b,d:distance};
  }).filter(b=>b.d<=8).sort((a,b)=>a.d-b.d)[0]||null;
}
const OVERLAY_PAD=192;
const overlayOffset=cache=>-OVERLAY_PAD-(S.view.c0-cache.c0)*S.view.zx*(S.flip?-1:1);
function guideRenderData(h,o,W,Hi) {
  const v=S.view,key=JSON.stringify([W,Hi,v.zx,v.r0,v.zy,S.flip,h.recvCols,h.nCols,!!projectionOf(h),h.cropResult?.request_id,h.asset?.mainCameraId,o.behindRunners,o.occlusionMethod,h.activeOcclusionMask?.requestId,o.thickness,o.boundaries,o.positions]);
  if(h.guideRenderCache?.key===key&&Math.abs((v.c0-h.guideRenderCache.c0)*v.zx)<OVERLAY_PAD*.75)return h.guideRenderCache;
  const width=W+2*OVERLAY_PAD;
  const lines=scanBoundaries(laneBands(h),o,rowsOf(h)).map(b=>{
    const y=(b.row-v.r0)*v.zy,path=new Path2D();
    if(y>=0&&y<=Hi&&o.thickness>0) {
      if(!o.behindRunners){path.moveTo(0,y);path.lineTo(width,y);}
      else {const half=o.thickness/(2*v.zy);let start=null;for(let x=0;x<=width;x++){
        const hidden=x>=width||guideOccluded(h,x-OVERLAY_PAD,x+1-OVERLAY_PAD,b.row-half,b.row+half);
        if(!hidden&&start==null)start=x;
        if(hidden&&start!=null){path.moveTo(start,y);path.lineTo(x,y);start=null;}
      }}
    }
    return {boundary:b,path};
  });
  return h.guideRenderCache={key,lines,c0:v.c0};
}

function foregroundColumns(h,x0,x1) {
  const result=[],source=h.displaySource,model=h.activeOcclusionMask;
  let a,b,limit;
  if(source){a=(colTime(h,colOf(x0))-source.t)/source.p;b=(colTime(h,colOf(x1))-source.t)/source.p;limit=source.w-1;}
  else {a=colOf(x0);b=colOf(x1);limit=h.state==='running'?h.liveCol:h.nCols-1;}
  const first=Math.max(0,Math.floor(Math.min(a,b))-1),last=Math.min(limit,Math.ceil(Math.max(a,b))+1);
  for(let c=first;c<=last;c++){
    const mask=model?.bits||source?.mask||h.sampleForeground||h.foregroundTiles?.[Math.floor(c/STRIP_TILE)];
    if(mask)result.push({mask,column:model||source||h.sampleForeground?c:c%STRIP_TILE});
  }
  return result;
}
function reviewHighlightLayer(h,o,W,Hi,pending,edges,cache='reviewHighlightCache') {
  if(!pending.size||W<1||Hi<1)return null;
  const v=S.view,key=JSON.stringify([W,Hi,v.zx,v.r0,v.zy,S.flip,h.recvCols,h.nCols,!!projectionOf(h),h.cropResult?.request_id,h.asset?.mainCameraId,rowsOf(h),o.behindRunners,o.occlusionMethod,h.activeOcclusionMask?.requestId,o.pendingColor,[...pending],edges]);
  if(h[cache]?.key===key&&Math.abs((v.c0-h[cache].c0)*v.zx)<OVERLAY_PAD*.75)return h[cache];
  const canvas=document.createElement('canvas'),width=W+2*OVERLAY_PAD;canvas.width=width;canvas.height=Hi;
  const ctx=canvas.getContext('2d'),bands=[];ctx.fillStyle=o.pendingColor;
  for(let i=0;i<edges.length-1;i++){
    if(!pending.has(edges[i].below))continue;
    const top=Math.max(0,(edges[i].row-v.r0)*v.zy),bottom=Math.min(Hi,(edges[i+1].row-v.r0)*v.zy);
    if(bottom>top){ctx.fillRect(0,top,width,bottom-top);bands.push({top:Math.floor(top),bottom:Math.ceil(bottom),first:Math.max(0,Math.floor(v.r0+Math.floor(top)/v.zy)-2),last:Math.min(rowsOf(h)-1,Math.ceil(v.r0+Math.ceil(bottom)/v.zy)+2)});}
  }
  if(o.behindRunners&&bands.length){
    const image=ctx.getImageData(0,0,width,Hi),rows=rowsOf(h);
    for(let x=0;x<width;x++){
      const columns=foregroundColumns(h,x-OVERLAY_PAD,x+1-OVERLAY_PAD);if(!columns.length)continue;
      for(const band of bands){
        if(!columns.some(c=>foregroundInRows(c.mask,c.column,rows,band.first,band.last)))continue;
        for(let y=band.top;y<band.bottom;y++){
          const lo=Math.max(0,Math.floor(v.r0+y/v.zy)-2),hi=Math.min(rows-1,Math.ceil(v.r0+(y+1)/v.zy)+2);
          for(const c of columns)if(foregroundInRows(c.mask,c.column,rows,lo,hi)){image.data[(y*width+x)*4+3]=0;break;}
        }
      }
    }
    ctx.putImageData(image,0,0);
  }
  return h[cache]={key,canvas,c0:v.c0};
}

function drawLaneGuides(g,h,W,Hi) {
  const v=S.view;
  // Decorative lane guides can be adjusted without changing the model's lane geometry.
  const style=overlayStyle('scan'),hasPixels=(h.recvCols||0)>0||(!h.asset&&['review','saved'].includes(h.state));
  const o=hasPixels?style:{...style,behindRunners:false};
  h.activeOcclusionMask=style.occlusionMethod==='learned'?learnedMask(h):null;
  maybeLearnedMask(h,o);
  if(o.enabled) {
    const pending=pendingLaneIds(h,o),edges=scanBoundaries(laneBands(h),o,rowsOf(h));
    if(o.behindRunners)sampleForeground(h);
    const emptyLanes=new Set(o.shadeInactive&&!S.cameraSetup?laneBands(h).filter(b=>!h.athletes.some(a=>a.lane===b.lane)||['DNS','FS'].includes(h.status[b.lane])).map(b=>b.lane):[]);
    const emptyLayer=reviewHighlightLayer(h,{...o,pendingColor:o.inactiveColor},W,Hi,emptyLanes,edges,'statusHighlightCache');
    if(emptyLayer){g.save();g.globalAlpha=o.inactiveOpacity;g.drawImage(emptyLayer.canvas,overlayOffset(emptyLayer),0);g.restore();}
    const highlight=reviewHighlightLayer(h,o,W,Hi,pending,edges);
    if(highlight){g.save();g.globalAlpha=o.pendingOpacity;g.drawImage(highlight.canvas,overlayOffset(highlight),0);g.restore();}
    g.save();g.globalAlpha=o.opacity;g.strokeStyle=o.lineColor;g.lineWidth=o.thickness;g.font=`${o.weight} ${o.fontSize}px ${TK.mono}`;
    const guides=guideRenderData(h,o,W,Hi);g.translate(overlayOffset(guides),0);guides.lines.forEach(line=>{
      if(o.thickness>0)g.stroke(line.path);
    });g.restore();
  }
}

function drawFinishMarkers(g,h,W,height,project) {
  g.font='700 10px '+TK.mono;
  const tags = [];
  (h.proposals || []).forEach(p => {
    if (h.marks[p.lane] || h.status[p.lane] || h.dismissed?.[p.lane]) return;
    tags.push({ col: p.col, lane: p.lane, color: p.decision === 'auto' ? TK.blue : TK.amber, dashed: true });
  });
  Object.entries(h.marks).forEach(([lane, m]) => tags.push({ col: m.col, lane: +lane, color: h.status[lane] === 'DQ' ? TK.finish : TK.mint, dashed: false }));
  tags.sort((a, b) => a.col - b.col).forEach((t, i) => {
    const x = project(S.drag?.mode === 'mark' && S.drag.lane === t.lane && S.drag.moved ? S.selCol : t.col);
    if (x < -20 || x > W + 20) return;
    const sel = S.selLane === t.lane;
    g.strokeStyle = t.color; g.lineWidth = sel ? 2 : 1; g.setLineDash(t.dashed ? [5, 4] : []);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, height); g.stroke(); g.setLineDash([]);
    const ty = 3 + (i % 2) * 15;
    g.fillStyle = t.color; g.fillRect(x - 8, ty, 16, 13);
    if (sel) { g.strokeStyle = TK.paper; g.lineWidth = 1; g.strokeRect(x - 8.5, ty - 0.5, 17, 14); }
    g.fillStyle = TK['on-accent']; g.textAlign = 'center'; g.fillText(String(t.lane), x, ty + 10); g.textAlign = 'left';
  });
}

function drawScan() {
  const [g, W, Hc] = fitCanvas(scanCv), Hi = Hc - RULER, h = viewHeat(), v = S.view;
  g.fillStyle = TK.scanbg; g.fillRect(0, 0, W, Hc);
  const live = h.state === 'running', last = live ? h.liveCol : h.nCols - 1;
  const captured = h.state === 'review' || h.state === 'saved' || (live && h.liveCol >= 0);
  // Framing changes only the viewport. Sensor rows and lane coordinates remain native.
  if(!captured||S.frameEditor)fitScanHeight(h);
  renderHeightFrame(h);
  renderLaneGutter(h);
  if (!captured) {
    drawLaneGuides(g,h,W,Hi);
    g.fillStyle = TK.dim; g.font = '600 13px ' + TK.sans; g.textAlign = 'center';
    const msg = { loaded: 'Heat loaded. Arm to receive the start.', armed: 'Armed. The capture streams here after the start.', running: 'Running. Capture opens as the field reaches the line.' }[h.state];
    g.fillText(msg, W / 2, Hi / 2 - 8);
    g.font = '12px ' + TK.sans;
    g.fillText('Wheel: scroll · Ctrl+wheel: zoom · Drag: pan · Shift+drag: zoom · Click: select column · Arrows: nudge · Enter or double-click: mark', W / 2, Hi / 2 + 14);
    g.textAlign = 'left';
    drawRuler(g, W, Hc, h, false);
    return;
  }
  const vis=W/v.zx,sx=Math.max(0,v.c0),ex=Math.min(displayCount(h),v.c0+vis,live?last+1:Infinity);
  g.imageSmoothingEnabled=v.zx<3;
  g.save();if(S.flip){g.translate(W,0);g.scale(-1,1);}
  for(const piece of displayPieces(h,sx,ex)){
    const dx=(piece.displayStart-v.c0)*v.zx,dw=(piece.end-piece.start)*v.zx;
    if(h.displaySource){const s=h.displaySource,p=periodOf(h),start=h.tOpen+piece.start*p,end=h.tOpen+piece.end*p,x=t=>dx+(t-start)/p*v.zx,sh=Hi/v.zy;
      if(start<s.t){const stop=Math.min(end,s.t);g.drawImage(s.img,0,v.r0,1,sh,x(start),0,x(stop)-x(start),Hi);}
      const a=Math.max(0,(start-s.t)/s.p),b=Math.min(s.w,(end-s.t)/s.p);if(b>a)g.drawImage(s.img,a,v.r0,b-a,sh,x(s.t+a*s.p),0,(b-a)*s.p/p*v.zx,Hi);
      const tail=Math.max(start,s.t+s.w*s.p);if(end>tail)g.drawImage(s.img,0,v.r0,1,sh,x(tail),0,x(end)-x(tail),Hi);
    }else drawStrip(g,h,piece.start,v.r0,piece.end-piece.start,Hi/v.zy,dx,0,dw,Hi);
  }
  g.restore();
  drawTimeBreaks(g,h,W,Hi,c=>unflipX((c-v.c0)*v.zx));
  if (live) { g.fillStyle = TK.blue; g.fillRect(xOf(last) - 1, 0, 2, Hi); }

  drawLaneGuides(g,h,W,Hi);

  drawFinishMarkers(g,h,W,Hi,xOf);

  if (S.hoverCol != null && S.hoverCol !== S.selCol && !(S.drag && S.drag.moved)) {
    g.strokeStyle = 'rgba(247,248,250,0.45)'; g.lineWidth = 1; g.setLineDash([3, 3]);
    const x = Math.round(xOf(S.hoverCol)) + 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Hi); g.stroke(); g.setLineDash([]);
  }
  if (S.selCol != null) {
    const x = xOf(S.selCol);
    g.fillStyle = TK.finish; g.fillRect(Math.round(x), 0, 1, Hi);
    if (v.zx >= 3) { g.strokeStyle = TK.finish; g.lineWidth = 1; g.strokeRect(Math.round(x - v.zx / 2) + 0.5, 0.5, Math.max(1, Math.round(v.zx)), Hi - 1); }
  }
  if (S.drag && S.drag.mode === 'zoom' && S.drag.moved) {
    g.strokeStyle = TK.blue; g.setLineDash([4, 3]); g.lineWidth = 1;
    const { x0, y0, x1, y1 } = S.drag;
    g.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    g.setLineDash([]);
  }
  if(S.cameraSetup?.mode==='alignment'){
    g.save();g.strokeStyle='rgba(255,255,255,0.6)';g.lineWidth=1;g.setLineDash([5,5]);g.beginPath();g.moveTo(W/2,0);g.lineTo(W/2,Hi);g.moveTo(0,Hi/2);g.lineTo(W,Hi/2);g.stroke();g.restore();
  }
  drawRuler(g, W, Hc, h, true);
}
function drawTimeBreaks(g,h,W,height,project) {
  const map=projectionOf(h);if(!map)return;
  for(let i=1;i<map.spans.length;i++){
    const span=map.spans[i],x=project(span.displayStart);if(x<0||x>W)continue;
    const gap=(span.start-map.spans[i-1].end)*periodOf(h);
    g.save();g.fillStyle=TK.deep;g.globalAlpha=.8;g.fillRect(x-3,0,6,height);g.globalAlpha=1;g.strokeStyle=TK.muted;g.setLineDash([3,3]);g.beginPath();g.moveTo(x-2,0);g.lineTo(x-2,height);g.moveTo(x+2,0);g.lineTo(x+2,height);g.stroke();g.setLineDash([]);g.font='10px '+TK.mono;const label=`+${gap.toFixed(2)} s`,width=g.measureText(label).width+8,tx=Math.min(W-width-3,Math.max(4,x+6));g.fillStyle=TK.deep;g.fillRect(tx-3,height-20,width,16);g.fillStyle=TK.paper;g.fillText(label,tx+1,height-8);g.restore();
  }
}
function drawRuler(g, W, Hc, h, on) {
  const y0 = Hc - RULER;
  g.fillStyle = TK.deep; g.fillRect(0, y0, W, RULER);
  g.fillStyle = TK.rule2; g.fillRect(0, y0, W, 1);
  if (!on) return;
  const v = S.view, period=periodOf(h), pxPerS = v.zx / period;
  const steps = [0.00125, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  const step = steps.find(s => s * pxPerS >= 70) || 1;
  const dec = step < 0.01 ? 4 : step < 0.1 ? 2 : 1;
  g.font='10px '+TK.mono;
  for(const piece of displayPieces(h,Math.max(0,v.c0),Math.min(displayCount(h),v.c0+W/v.zx))){
    const t0=h.tOpen+piece.start*period,t1=h.tOpen+piece.end*period;
    for(let t=Math.ceil(t0/step)*step;t<t1;t+=step){
      const x=Math.round(xOf((t-h.tOpen)/period-0.5));
      g.fillStyle=TK.dim;g.fillRect(x,y0+1,1,6);g.fillStyle=TK.muted;g.textAlign=S.flip?'right':'left';g.fillText((t-(h.startCorrection||0)).toFixed(dec),x+(S.flip?-3:3),y0+16);
    }
  }
  g.textAlign = 'left';
}

// The backup line-scan has its own zoom and pan in race time. Until the operator moves it, it shows the
// primary's time window; double-click links it back. Hover and click are shared with the primary by time.
function backupSource(h) {
  const original=h.recordingHeat||h,id=h.viewCompareId||h.asset?.comparisonCameraId;
  if(original.asset&&id===original.asset.mainCameraId)return {img:original.img,t:original.tOpen,p:periodOf(original),w:original.nCols,rows:rowsOf(original),own:false,meta:original.asset.primaryMeta};
  const descriptor=original.asset?.lineScans?.find(s=>s.id===id),cached=descriptor&&scanSourceViews.get(descriptor.png);if(cached)return {...cached,own:true};
  if (h.backupImg && h.backupImg.complete && h.backupImg.naturalWidth) {
    const bm = h.asset.backupMeta;
    return { img: h.backupImg, t: bm.first_column_race_time_s, p: bm.column_period_s, w: h.backupImg.naturalWidth, rows: h.backupImg.naturalHeight, own: true,meta:bm };
  }
  return { img: h.img, t: h.tOpen, p: periodOf(h), w: h.nCols, rows: rowsOf(h), own: false };
}
function backupRange(h) {
  if (S.bview.linked) {
    const period=periodOf(h),pieces=displayPieces(h,Math.max(0,S.view.c0),Math.min(displayCount(h),S.view.c0+scanW()/S.view.zx)),src=backupSource(h);
    const finishes=[...Object.entries(h.marks).map(([lane,m])=>({lane:+lane,col:m.col})),...(h.proposals||[])];
    const finishLanes=[...new Set(finishes.filter(m=>pieces.some(p=>m.col>=p.start&&m.col<p.end)).map(m=>m.lane))];
    const range=linkedCameraRange(S.view,{rows:rowsOf(h),height:scanH(),width:scanW(),period,timeOrigin:h.tOpen,otherWidth:backupCv.clientWidth,otherRows:src.rows,mainLanes:(h.displayMeta||h.asset?.primaryMeta)?.lane_rows,otherLanes:src.meta?.lane_rows,finishLanes});
    if(!S.view.zoomed||S.frameEditor){const frame=cameraFrame(h,h.asset?.comparisonCameraId||'backup');range.r0=frame.top;range.rv=frame.bottom-frame.top;}
    return {...range,projection:projectionOf(h),origin:h.tOpen,period};
  }
  return S.bview;
}
const backupCv = document.getElementById('backup');backupCv.tabIndex=0;backupCv.setAttribute('aria-label','Comparison line-scan image');
const comparisonPicker=h_('button','kicker camera-source-picker');comparisonPicker.id='comparisonCameraPicker';comparisonPicker.setAttribute('aria-label','Choose comparison line-scan view');comparisonPicker.setAttribute('aria-haspopup','menu');
comparisonPicker.onpointerdown=e=>e.stopPropagation();comparisonPicker.onmousedown=e=>e.stopPropagation();comparisonPicker.onclick=e=>{e.stopPropagation();showSourceMenu('comparison',comparisonPicker);};backupCv.parentNode.parentNode.querySelector('.kicker').replaceWith(comparisonPicker);
const backupLinkButton=h_('button','btn sm','Linked');
backupLinkButton.setAttribute('aria-label','Link comparison view');backupLinkButton.style.marginLeft='auto';
backupLinkButton.onpointerdown=e=>e.stopPropagation();backupLinkButton.onmousedown=e=>e.stopPropagation();
backupLinkButton.onclick=e=>{e.stopPropagation();if(S.bview.linked)unlinkBackup(viewHeat());else S.bview.linked=true;invalidate();};
backupCv.parentNode.parentNode.querySelector('.ph').append(backupLinkButton);
const bAxisTime=(x,r,W)=>r.t0+(S.flip?W-x:x)*r.spp;
const bUnflippedX=(t,r)=>{const value=r.projection?displayCoordinate(r.projection,(t-r.origin)/r.period):null;return ((r.projection?(value==null?NaN:r.origin+value*r.period):t)-r.t0)/r.spp;};
const bX=(t,r,W)=>{const x=bUnflippedX(t,r);return S.flip?W-x:x;};
const bT=(x,r,W)=>{const t=bAxisTime(x,r,W);return r.projection?r.origin+originalCoordinate(r.projection,(t-r.origin)/r.period)*r.period:t;};
function drawBackup() {
  const cv = backupCv;
  backupLinkButton.textContent=S.bview.linked?'Linked':'Link views';backupLinkButton.setAttribute('aria-pressed',String(S.bview.linked));
  backupLinkButton.title=S.bview.linked?'Comparison follows the main view; click to move it independently':'Relink the comparison to the main view';
  if (!cv.isConnected || !cv.clientWidth) return;
  const [g, W, Hh] = fitCanvas(cv), h = viewHeat();
  g.fillStyle = TK.scanbg; g.fillRect(0, 0, W, Hh);
  if(!replayCameras(h).comparison){g.fillStyle=TK.dim;g.font='12px '+TK.sans;g.textAlign='center';g.fillText('No comparison camera recording',W/2,Hh/2);g.textAlign='left';return;}
  const live = h.state === 'running', last = live ? h.liveCol : h.nCols - 1;
  if (!h.img || last < 0 || h.state === 'loaded' || h.state === 'armed') {
    g.fillStyle = TK.dim; g.font = '12px ' + TK.sans; g.textAlign = 'center';
    g.fillText('Backup capture follows the primary.', W / 2, Hh / 2); g.textAlign = 'left';
    return;
  }
  const src=backupSource(h),r=backupRange(h),period=periodOf(h),origin=h.tOpen;
  const start=(r.t0-origin)/period,end=Math.min(displayCount(h),start+W*r.spp/period),sy=r.r0*src.rows,sh=r.rv*src.rows;
  const pieces=visibleColumnPieces(r.projection,start,end,h.nCols),x=t=>bUnflippedX(t,r);
  g.save();if(S.flip){g.translate(W,0);g.scale(-1,1);}
  if(!src.own)g.filter='grayscale(1) contrast(1.1)';g.imageSmoothingEnabled=src.p/r.spp<3;
  for(const piece of pieces){
    const a=origin+piece.start*period,b=origin+piece.end*period;
    if(src.own&&a<src.t){const stop=Math.min(b,src.t);if(stop>a)g.drawImage(src.img,0,sy,1,sh,x(a),0,x(stop)-x(a),Hh);}
    const i0=Math.max(0,(a-src.t)/src.p),i1=Math.min(src.w,(b-src.t)/src.p);
    if(i1>i0){const left=x(src.t+i0*src.p),right=x(src.t+i1*src.p);if(src.own)g.drawImage(src.img,i0,sy,i1-i0,sh,left,0,right-left,Hh);else drawStrip(g,h,i0,sy,i1-i0,sh,left,0,right-left,Hh);}
  }
  g.restore();
  drawTimeBreaks(g,h,W,Hh,c=>{const px=(origin+c*period-r.t0)/r.spp;return S.flip?W-px:px;});
  // marks, then the shared hover and selected hairlines
  drawFinishMarkers(g,h,W,Hh,col=>bX(colTime(h,col),r,W));
  if (S.hoverCol != null) { g.fillStyle = 'rgba(247,248,250,0.5)'; g.fillRect(Math.round(bX(colTime(h, S.hoverCol), r, W)), 0, 1, Hh); }
  if (S.selCol != null) { g.fillStyle = TK.finish; g.fillRect(Math.round(bX(colTime(h, S.selCol), r, W)), 0, 1, Hh); }
  const d = S.bdrag;
  if (d && d.mode === 'zoom' && d.moved) {
    g.strokeStyle = TK.blue; g.lineWidth = 1; g.setLineDash([4, 3]);
    g.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    g.setLineDash([]);
  }
  if (!S.bview.linked) {
    g.fillStyle = 'rgba(8,16,34,0.72)'; g.fillRect(W - 62, Hh - 19, 58, 15);
    g.fillStyle = '#d8dee9'; g.font = '10px ' + TK.mono; g.fillText('unlinked', W - 57, Hh - 8);
  }
}

// What moment the front camera shows: live while running; afterwards the hovered column, else the selected one.
function frontTime(h) {
  if(S.hoverCol!=null&&['running','review','saved'].includes(h.state))return colTime(h,S.hoverCol);
  if (h.state === 'running') return h.tNow;
  if (h.state !== 'review' && h.state !== 'saved') return null;
  const col = S.hoverCol != null ? S.hoverCol : S.selCol;
  return col == null ? null : colTime(h, col);
}
let vidEl = null, vidTag = null, frontCache=null, frontCacheKey=null, lastFrontFrame=null, wantedVideoTime=null, frontVideoFrame=0;
const frontOcclusion=new FrontOverlayOcclusion(()=>invalidate());
function currentFrontPixels() {
  if(vidEl?.style.display==='block')return vidEl.readyState>=2?{image:vidEl,stamp:`video:${vidEl.dataset.src}:${vidEl.requestVideoFrameCallback?frontVideoFrame:Math.floor(vidEl.currentTime*(vidEl.dataset.fps||30))}`}:null;
  if(lastFrontFrame)return {image:lastFrontFrame.bitmap,stamp:`frame:${lastFrontFrame.index}`};
  const cv=$('#front');return cv.width&&cv.height?{image:cv,stamp:`sample:${frontTime(viewHeat())}:${cv.width}:${cv.height}`}:null;
}
function updateFrontOcclusion(h) {
  const layer=$('#frontLaneOverlay'),o=overlayStyle('front');
  if(!o.enabled||!o.behindRunners){layer.style.maskImage='none';layer.style.visibility='';return;}
  const rec=h.frontRec||(h.asset?.front?{path:h.asset.front,frames:h.asset.frontFrames}:null),source=currentFrontPixels();
  if(rec){
    frontOcclusion.configure(frontCacheKey);
    frontOcclusion.loadReference(rec.frames?.[0]?OM.fileUrl(rec.frames[0]):null,OM.fileUrl(rec.path));
  }
  const mask=source&&frontOcclusion.mask(source.image,source.stamp);
  layer.dataset.occlusion=mask?'ready':frontOcclusion.failed?'unavailable':frontOcclusion.reference?'waiting-frame':'loading-background';
  layer.style.maskImage=mask?`url("${mask}")`:'none';
  // Keep live masks between worker completions. A new seek/reference has no
  // matching mask yet, so only its decorative number layer waits for the result.
  layer.style.visibility=!mask&&!frontOcclusion.failed?'hidden':'';
}
function seekFrontVideo(v,target) {
  wantedVideoTime=target;
  if(!v.seeking&&v.readyState>=1&&Math.abs(v.currentTime-target)>0.002)v.currentTime=target;
}
function frontVideo() {
  if (!vidEl) {
    const pb = $('#front').parentNode;
    vidEl = h_('video', 'frontvid'); vidEl.muted = true; vidEl.playsInline = true; vidEl.preload = 'auto';vidEl.crossOrigin='anonymous';
    vidEl.onloadedmetadata = invalidate;
    vidEl.onloadeddata=()=>{frontVideoFrame++;invalidate();};
    vidEl.onseeked=()=>{frontVideoFrame++;if(wantedVideoTime!=null&&Math.abs(vidEl.currentTime-wantedVideoTime)>0.002)seekFrontVideo(vidEl,wantedVideoTime);invalidate();};
    if(vidEl.requestVideoFrameCallback){const presented=()=>{frontVideoFrame++;invalidate();vidEl.requestVideoFrameCallback(presented);};vidEl.requestVideoFrameCallback(presented);}
    vidTag = h_('div', 'frametag');
    pb.append(vidEl, vidTag);
    applyFrontView();
  }
  return vidEl;
}
// The front camera is a recording attached to the heat: frame-exact at 30 fps, scrubbed by hovering the line-scan.
function syncFront(h,g,W,Hf) {
  const rec = h.frontRec || (h.asset && h.asset.front ? { path: h.asset.front, meta: h.asset.frontMeta,frames:h.asset.frontFrames } : null);
  const v = frontVideo(), on = !!(OM && rec);
  v.style.display = on ? 'block' : 'none'; vidTag.style.display = 'none';
  if (!on) { if (!v.paused) v.pause();frontCache?.dispose();frontCache=null;frontCacheKey=null;lastFrontFrame=null;return false; }
  const url = OM.fileUrl(rec.path);
  if (v.dataset.src !== url) { v.dataset.src = url; v.src = url; }
  const fps = (rec.meta && rec.meta.fps) || 30, ff = (rec.meta && rec.meta.first_frame_race_time_s) || 0;
  v.dataset.fps=fps;
  const cacheKey=rec.frames?.[0]||url;
  if(frontCacheKey!==cacheKey){frontCache?.dispose();frontCache=null;lastFrontFrame=null;frontCacheKey=cacheKey;if(rec.frames?.length)frontCache=new FrontFrameCache({load:async index=>{const im=new Image();im.crossOrigin='anonymous';im.src=OM.fileUrl(rec.frames[index]);await im.decode();return createImageBitmap(im);},onReady:invalidate});}
  if (h.state === 'running'&&S.hoverCol==null) {
    wantedVideoTime=null;
    const want = h.tNow - ff;
    if (want < 0) { if (!v.paused) v.pause(); return true; }
    if(frontCache)frontCache.request(Math.min(rec.frames.length-1,Math.floor(want*fps)),rec.frames.length);
    v.playbackRate = SPEED;
    if (v.paused) { v.currentTime = want; v.play().catch(() => {}); } else if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    return true;
  }
  if (!v.paused) v.pause();
  const ft = frontTime(h), t = ft != null ? ft : h.state === 'review' || h.state === 'saved' ? h.tClose : ff;
  const maxN = rec.frames?.length ? rec.frames.length-1 : v.duration ? Math.floor(v.duration * fps) - 1 : (rec.meta?.frame_count||1)-1;
  const frame = Math.max(0, Math.min(maxN, Math.floor((t - ff) * fps)));
  const target = (frame + 0.5) / fps;
  $('#front').dataset.wantedFrame=frame;
  if(frontCache&&!frontCache.failed.has(frame)) {
    wantedVideoTime=null;frontCache.request(frame,rec.frames.length);
    const decoded=frontCache.get(frame);if(decoded)lastFrontFrame={bitmap:decoded,index:frame};
    if(lastFrontFrame&&!frontCache.frames.has(lastFrontFrame.index))lastFrontFrame=null;
    v.style.display='none';g.fillStyle='#000';g.fillRect(0,0,W,Hf);
    if(lastFrontFrame){const b=lastFrontFrame.bitmap,s=Math.min(W/b.width,Hf/b.height);g.drawImage(b,(W-b.width*s)/2,(Hf-b.height*s)/2,b.width*s,b.height*s);if($('#front').dataset.frame!==String(lastFrontFrame.index))$('#front').dataset.frame=lastFrontFrame.index;}
    if(ft!=null){vidTag.style.display='block';vidTag.textContent=decoded?`${fmtT(ff+frame/fps)} s · frame ${frame+1}`:'Loading frame…';}
    return true;
  }
  g.clearRect(0,0,W,Hf);seekFrontVideo(v,target);
  if (ft != null) { vidTag.style.display = 'block'; vidTag.textContent = v.seeking||Math.abs(v.currentTime-target)>0.5/fps?'Loading frame…':`${fmtT(ff + frame / fps)} s · frame ${frame + 1}`; }
  return true;
}
function drawFront() {
  const cv = $('#front');
  if (!cv.isConnected || !cv.clientWidth) return;
  const [g, W, Hf] = fitCanvas(cv), h = viewHeat();
  if (syncFront(h,g,W,Hf)) {updateFrontOcclusion(h);return;}
  if(!replayCameras(h).front){g.fillStyle=TK.scanbg;g.fillRect(0,0,W,Hf);g.fillStyle=TK.dim;g.font='12px '+TK.sans;g.textAlign='center';g.fillText('No front camera recording',W/2,Hf/2);g.textAlign='left';return;}
  const hy = Hf * 0.17, cx = W / 2;
  const grd = g.createLinearGradient(0, 0, 0, hy);
  grd.addColorStop(0, '#1b2740'); grd.addColorStop(1, '#2b3a55');
  g.fillStyle = grd; g.fillRect(0, 0, W, hy);
  g.fillStyle = '#2f5a3a'; g.fillRect(0, hy, W, Hf - hy);
  const sp = y => W * 0.012 + (W * 0.15 - W * 0.012) * ((y - hy) / (Hf - hy));
  g.fillStyle = '#9b4a3a';
  g.beginPath(); g.moveTo(cx - 4 * sp(hy), hy); g.lineTo(cx + 4 * sp(hy), hy); g.lineTo(cx + 4 * sp(Hf), Hf); g.lineTo(cx - 4 * sp(Hf), Hf); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1;
  for (let j = 0; j <= 8; j++) { g.beginPath(); g.moveTo(cx + (j - 4) * sp(hy), hy); g.lineTo(cx + (j - 4) * sp(Hf), Hf); g.stroke(); }
  const frac = D => Math.pow(6 / D, 0.55);                 // 1 at the finish line, small far away
  const yAt = D => hy + (Hf * 0.9 - hy) * frac(D);
  const yFin = yAt(6);
  g.strokeStyle = '#ffffff'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx - 4 * sp(yFin), yFin); g.lineTo(cx + 4 * sp(yFin), yFin); g.stroke();
  if(overlayStyle('front').behindRunners){frontOcclusion.configure(`sample:${S.meet?.dir||'sample'}:${W}:${Hf}`);if(!frontOcclusion.reference)frontOcclusion.setReference(cv);}
  const ft = frontTime(h), t = ft == null ? 0 : ft;
  const banner = txt => { g.fillStyle = 'rgba(8,16,34,0.55)'; g.fillRect(0, 0, W, 22); g.fillStyle = '#d8dee9'; g.font = '11px ' + TK.sans; g.fillText(txt, 8, 15); };
  if ((h.state === 'review' || h.state === 'saved') && ft == null) { banner('Hover the line-scan to see this camera at that moment');updateFrontOcclusion(h);return; }
  const rs = h.athletes.filter(a => !a.pre).map(a => {
    let d;
    if (t <= 0.16) d = 0;
    else if (a.truth != null) d = t <= a.truth ? 100 * (t - 0.16) / (a.truth - 0.16) : 100 + (t - a.truth) * (100 / a.truth);
    else d = Math.min(a.dnfAt, 100 * (t - 0.16) / (h.base + h.spread * 0.5 - 0.16));
    return { a, D: 106 - d };
  }).filter(r => r.D > 4.2).sort((x, y) => y.D - x.D);
  rs.forEach(({ a, D }) => {
    const y = yAt(D), x = cx + (4.5 - a.lane) * sp(y), ph = Hf * 0.5 * Math.pow(frac(D), 1.3);
    const bw = ph * 0.22;
    g.fillStyle = '#1d1d1f'; g.fillRect(x - bw * 0.35, y - ph * 0.45, bw * 0.25, ph * 0.45); g.fillRect(x + bw * 0.1, y - ph * 0.45, bw * 0.25, ph * 0.45);
    g.fillStyle = a.team.c; g.fillRect(x - bw / 2, y - ph * 0.82, bw, ph * 0.4);
    g.fillStyle = '#f1f1ec'; g.fillRect(x - bw * 0.3, y - ph * 0.72, bw * 0.6, ph * 0.12);
    g.fillStyle = a.skin; g.beginPath(); g.arc(x, y - ph * 0.9, Math.max(1, ph * 0.08), 0, Math.PI * 2); g.fill();
  });
  if (h.state === 'loaded' || h.state === 'armed') banner(h.state === 'armed' ? 'In the blocks' : 'Waiting for the heat');
  else if (ft != null && h.state !== 'running') banner(`${fmtT(t)} s`);
  updateFrontOcclusion(h);
}

// ---------------------------------------------------------------- line-scan input
scanCv.addEventListener('wheel', e => {
  const h = viewHeat();
  if (!h.img) return;
  e.preventDefault();
  const v = S.view, rect = scanCv.getBoundingClientRect(), xa = unflipX(e.clientX - rect.left);
  if (e.ctrlKey || e.metaKey) {
    S.bview.linked=true;
    const colAt = v.c0 + xa / v.zx;
    v.zx = Math.max(S.cameraSetup?scanW()/Math.min(h.nCols,STRIP_TILE*8):scanW() / displayCount(h) * 0.5, Math.min(16, v.zx * Math.exp(-e.deltaY * 0.0018)));
    v.c0 = colAt - xa / v.zx; v.zoomed = true;
  } else {
    v.c0 += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / v.zx * (S.flip ? -1 : 1);
  }
  v.user = true; clampView(); renderTools(); invalidate();
}, { passive: false });
function hitFinish(h, x) {
  const marks = Object.entries(h.marks).map(([lane,m])=>({lane:+lane,col:m.col}));
  const proposals = (h.proposals || []).filter(p=>!h.marks[p.lane] && !h.status[p.lane] && !h.dismissed?.[p.lane]).map(p=>({lane:p.lane,col:p.col}));
  return [...marks,...proposals].map(p=>({...p,distance:Math.abs(xOf(p.col)-x)})).filter(p=>p.distance<=7)
    .sort((a,b)=>a.distance-b.distance || (a.lane===S.selLane?-1:1))[0];
}
function deleteSelectedFinish() {
  const h=cur(), lane=S.selLane;
  if(lane==null || !['running','review','saved'].includes(h.state)) return;
  if(!h.marks[lane] && !(h.proposals||[]).some(p=>p.lane===lane)) return;
  delete h.marks[lane];
  (h.dismissed ||= {})[lane]=true;
  h.proposals=(h.proposals||[]).filter(p=>p.lane!==lane);
  editHeat(h); renderUI();
}
// Hover scrubs the heat's front-camera recording to the frame at that column.
scanCv.addEventListener('mousemove', e => {
  if (S.drag && S.drag.moved) return;
  const h = viewHeat(), live = h.state === 'running';
  if (!(h.state === 'review' || h.state === 'saved' || (live && h.liveCol >= 0))) return;
  const r = scanCv.getBoundingClientRect();
  const col = Math.max(0, Math.min(live ? h.liveCol : h.nCols - 1, colOf(e.clientX - r.left)));
  scanCv.style.cursor = hitScanBoundary(h,e.clientX-r.left,e.clientY-r.top) ? 'ns-resize' : !S.zoomTool && hitFinish(h, e.clientX-r.left) ? 'ew-resize' : '';
  if (col !== S.hoverCol) { S.hoverCol = col; invalidate(); updateTs(); }
});
scanCv.addEventListener('mouseleave', () => { if (S.hoverCol != null) { S.hoverCol = null; invalidate(); updateTs(); } });
scanCv.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  scanCv.focus({preventScroll:true});
  S.entryNumber = ''; updateEntryNumber();
  const r = scanCv.getBoundingClientRect();
  const h = viewHeat(),boundary=!e.shiftKey&&hitScanBoundary(h,e.clientX-r.left,e.clientY-r.top);
  if(boundary) {
    const offset=(e.clientY-r.top)/S.view.zy+S.view.r0-boundary.row;
    S.drag={mode:'lane-boundary',key:boundary.key,offset,moved:false,x0:e.clientX-r.left,y0:e.clientY-r.top,x1:e.clientX-r.left,y1:e.clientY-r.top};return;
  }
  const hit = !S.zoomTool && !e.shiftKey && ['running','review','saved'].includes(h.state) ? hitFinish(h,e.clientX-r.left) : null;
  if(hit) { S.selLane=hit.lane; S.selCol=hit.col; }
  S.drag = { lane:hit?.lane, mode: hit ? 'mark' : S.zoomTool || e.shiftKey ? 'zoom' : 'pan', x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, c0: S.view.c0, r0: S.view.r0, moved: false };
});
window.addEventListener('mousemove', e => {
  const d = S.drag;
  if (!d) return;
  const r = scanCv.getBoundingClientRect();
  d.x1 = Math.max(0, Math.min(r.width, e.clientX - r.left));
  d.y1 = Math.max(0, Math.min(r.height - RULER, e.clientY - r.top));
  if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) > 5) d.moved = true;
  invalidate();
  if(d.mode==='lane-boundary'&&d.moved) {
    const h=viewHeat(),o=overlayStyle('scan'),boundaries=scanBoundaries(laneBands(h),o,rowsOf(h)),i=boundaries.findIndex(b=>b.key===d.key);
    if(i>=0){o.boundaries=Object.fromEntries(boundaries.map(b=>[b.key,b.row]));o.boundaries[d.key]=movedBoundaryRow(boundaries,i,d.y1/S.view.zy+S.view.r0-d.offset,rowsOf(h));o.positions={};saveOverlay('scan',o);}
  }
  if (d.mode === 'mark' && d.moved) {
    const h=viewHeat(), limit=h.state==='running'?h.liveCol:h.nCols-1;
    S.selCol=Math.max(0,Math.min(limit,colOf(d.x1)));
    S.hoverCol=S.selCol;
    updateTs();
  }
  if (d.mode === 'pan' && d.moved) {
    const v = S.view;
    v.focusLane=null;
    v.c0 = d.c0 - (d.x1 - d.x0) / v.zx * (S.flip ? -1 : 1);
    v.r0 = d.r0 - (d.y1 - d.y0) / v.zy;
    v.user = true; v.zoomed = true; clampView();
    document.body.classList.add('grabbing');
  }
});
window.addEventListener('mouseup', () => {
  const d = S.drag; S.drag = null;
  document.body.classList.remove('grabbing');
  if (!d) return;
  const h = viewHeat(), v = S.view;
  if (!['review', 'saved', 'running'].includes(h.state) || (h.state === 'running' && h.liveCol < 0)) return;
  if(d.mode==='lane-boundary'){invalidate();return;}
  if(d.mode === 'mark') {
    if(d.moved) setMark(d.lane,S.selCol); else renderUI();
    return;
  }
  if (d.moved && d.mode === 'zoom') {
    S.bview.linked=true;
    v.focusLane=null;
    const w = Math.abs(d.x1 - d.x0), hh = Math.abs(d.y1 - d.y0);
    if (w < 8 || hh < 8) return;
    const ca = v.c0 + unflipX(d.x0) / v.zx, cb = v.c0 + unflipX(d.x1) / v.zx;
    const r0 = v.r0 + Math.min(d.y0, d.y1) / v.zy;
    v.zx = scanW() / Math.abs(cb - ca); v.zy = scanH() / (hh / v.zy); v.c0 = Math.min(ca, cb); v.r0 = r0;
    v.zoomed = true; v.user = true; S.zoomTool = false;
    clampView(); syncCursor(); renderTools();
  } else if (d.moved) {
    renderTools();
  } else {
    const col = Math.max(0, Math.min(h.nCols - 1, colOf(d.x0)));
    // clicking on a mark or proposal tag selects that athlete
    const near = [...(h.proposals || []).map(p => ({ lane: p.lane, col: p.col })), ...Object.entries(h.marks).map(([l, m]) => ({ lane: +l, col: m.col }))]
      .find(t => Math.abs(xOf(t.col) - d.x0) < 7);
    if (near) { S.selLane = near.lane; S.selCol = near.col; } else S.selCol = col;
    renderUI();
  }
});
scanCv.addEventListener('dblclick', e => {
  const h = viewHeat();
  if (S.selLane == null || !['running', 'review', 'saved'].includes(h.state)) return;
  const r = scanCv.getBoundingClientRect();
  S.selCol = Math.max(0, Math.min(h.nCols - 1, colOf(e.clientX - r.left)));
  setMark(S.selLane, S.selCol);
});
window.addEventListener('keydown', e => {
  if(S.frameEditor){if(e.key==='Escape'){e.preventDefault();finishHeightFrame();}return;}
  if(e.target instanceof Element&&e.target.closest('#laneGutter,#workspaceSplit,.camera-source-menu,.overlay-settings,.scan-tool-menu,.scan-toolbar-dialog'))return;
  if (document.querySelector('.race-reset-dialog[open],.scan-toolbar-dialog[open]')) return;
  if (e.target instanceof Element && e.target.closest('input, select, textarea, [contenteditable=true]')) return;
  if (S.cameraSetup)return;
  if (S.tab !== 'run' || e.ctrlKey || e.metaKey || e.altKey) return;
  const h = viewHeat(), lanes = h.athletes.map(a => a.lane).sort((a, b) => a - b);
  if (/^[0-9]$/.test(e.key)) {
    e.preventDefault();
    if (S.selCol == null) { toast('Select a finish column first.'); return; }
    S.entryNumber = (S.entryNumber + e.key).slice(0, 8);
    updateEntryNumber();
    return;
  }
  if (e.key === 'Backspace' && S.entryNumber) {
    e.preventDefault(); S.entryNumber = S.entryNumber.slice(0,-1); updateEntryNumber(); return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.selLane != null) { e.preventDefault(); deleteSelectedFinish(); }
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (S.selCol == null) return;
    e.preventDefault();
    const dir = (e.key === 'ArrowLeft' ? -1 : 1) * (S.flip ? -1 : 1);   // arrows move on screen, whichever way the image faces
    const step=dir*(e.shiftKey?10:1)*(h.displaySource?h.displaySource.p/periodOf(h):1);
    S.selCol=projectionOf(h)?toOriginal(h,Math.max(0.5,Math.min(displayCount(h)-0.5,toDisplay(h,S.selCol+0.5)+step)))-0.5:Math.max(0,Math.min(h.nCols-1,S.selCol+step));
    S.hoverCol=null;
    centerOn(S.selCol); renderUI();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const i = lanes.indexOf(S.selLane);
    const n = i < 0 ? 0 : Math.max(0, Math.min(lanes.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)));
    selectLane(lanes[n]);
  } else if (e.key === 'Enter') {
    if (S.entryNumber) {
      e.preventDefault();
      const number = Number(S.entryNumber);
      let matches = h.athletes.filter(a => Number(h.unlaned ? (a.hipNumber ?? a.hip ?? a.bib ?? a.id) : a.lane) === number);
      if (h.unlaned && !matches.length) matches = h.athletes.filter(a=>Number(a.id)===number);
      if (matches.length !== 1) { toast(matches.length ? 'That number matches more than one athlete.' : `No ${h.unlaned ? 'hip or bib' : 'lane'} ${S.entryNumber} in this heat.`, true); return; }
      S.selLane = matches[0].lane;
      S.entryNumber = '';
      setMark(S.selLane, S.selCol);
    } else if (S.selLane != null && S.selCol != null) { e.preventDefault(); setMark(S.selLane, S.selCol); }
  } else if (e.key === 'Escape') {
    if (S.entryNumber) { e.preventDefault(); S.entryNumber = ''; updateEntryNumber(); return; }
    if (S.zoomTool) { S.zoomTool = false; syncCursor(); }
    else if (S.view.zoomed) fitView();
    else { S.selLane = null; S.selCol = null; }
    renderUI();
  }
});
$('#drawerClose').onclick = () => { S.tab = 'run'; renderUI(); };
window.addEventListener('resize', () => { renderTiles(); if (!S.view.zoomed && viewHeat().state !== 'running') fitView(); invalidate(); });

// ---------------------------------------------------------------- backup line-scan input (its own view, shared time)
const colAtTime = (h, t) => Math.max(0, Math.min(h.nCols - 1, Math.round((t - h.tOpen) / periodOf(h) - 0.5)));
const backupReady = h => replayCameras(h).comparison && h.img && (h.state === 'review' || h.state === 'saved' || (h.state === 'running' && h.liveCol >= 0));
function unlinkBackup(h) {
  if (S.bview.linked) Object.assign(S.bview, backupRange(h), { linked: false });
}
backupCv.addEventListener('wheel', e => {
  const h = viewHeat();
  if (!backupReady(h)) return;
  e.preventDefault(); unlinkBackup(h);
  const b = S.bview, rect = backupCv.getBoundingClientRect(), W = rect.width, mx = e.clientX - rect.left;
  if (e.ctrlKey || e.metaKey) {
    const tAt = bAxisTime(mx, b, W);
    b.spp = Math.max(periodOf(h) / 16, Math.min((h.tClose - h.tOpen) / W, b.spp * Math.exp(e.deltaY * 0.0018)));
    b.t0 = tAt - (S.flip ? W - mx : mx) * b.spp;
  } else b.t0 += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * b.spp * (S.flip ? -1 : 1);
  invalidate();
}, { passive: false });
backupCv.addEventListener('mousedown', e => {
  if(e.button===0)backupCv.focus({preventScroll:true});
  if (e.button !== 0 || !backupReady(viewHeat())) return;
  S.entryNumber = ''; updateEntryNumber();
  const r = backupCv.getBoundingClientRect();
  S.bdrag = { mode: e.shiftKey ? 'zoom' : 'pan', x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, moved: false, start: { ...backupRange(viewHeat()) } };
});
window.addEventListener('mousemove', e => {
  const d = S.bdrag;
  if (!d) return;
  const r = backupCv.getBoundingClientRect(), h = viewHeat();
  d.x1 = Math.max(0, Math.min(r.width, e.clientX - r.left)); d.y1 = Math.max(0, Math.min(r.height, e.clientY - r.top));
  if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) > 5) d.moved = true;
  if (d.moved && d.mode === 'pan') {
    unlinkBackup(h);
    const b = S.bview;
    b.t0 = d.start.t0 - (d.x1 - d.x0) * d.start.spp * (S.flip ? -1 : 1);
    b.r0 = Math.max(0, Math.min(1 - d.start.rv, d.start.r0 - (d.y1 - d.y0) / r.height * d.start.rv));
  }
  invalidate();
});
window.addEventListener('mouseup', () => {
  const d = S.bdrag; S.bdrag = null;
  if (!d) return;
  const h = viewHeat(), r = backupCv.getBoundingClientRect();
  if (d.moved && d.mode === 'zoom') {
    const w = Math.abs(d.x1 - d.x0), hh = Math.abs(d.y1 - d.y0);
    if (w > 8 && hh > 8) {
      const st = d.start, ta = bAxisTime(d.x0, st, r.width), tb = bAxisTime(d.x1, st, r.width);
      Object.assign(S.bview, { linked: false, t0: Math.min(ta, tb), spp: Math.abs(tb - ta) / r.width, r0: st.r0 + Math.min(d.y0, d.y1) / r.height * st.rv, rv: hh / r.height * st.rv });
    }
  } else if (!d.moved) {
    S.selCol = colAtTime(h, bT(d.x0, backupRange(h), r.width));     // select by time: Enter marks it, as on the primary
    renderUI();
  }
  invalidate();
});
backupCv.addEventListener('mousemove', e => {
  if (S.bdrag && S.bdrag.moved) return;
  const h = viewHeat();
  if (!backupReady(h)) return;
  const r = backupCv.getBoundingClientRect(), col = colAtTime(h, bT(e.clientX - r.left, backupRange(h), r.width));
  const lim = h.state === 'running' ? h.liveCol : h.nCols - 1;
  S.hoverCol = Math.min(col, lim); invalidate(); updateTs();
});
backupCv.addEventListener('mouseleave', () => { if (S.hoverCol != null) { S.hoverCol = null; invalidate(); updateTs(); } });
backupCv.addEventListener('dblclick', () => { S.bview.linked = true; invalidate(); });
backupCv.title = 'Wheel: scroll · Ctrl+wheel: zoom · Drag: pan · Shift+drag: zoom · Click: select · Double-click: link to the primary';

// ---------------------------------------------------------------- front camera zoom and pan (for context; the recording itself is untouched)
const frontPb = document.getElementById('front').parentNode;
const frontLaneLayer=h_('div','front-lane-overlay');frontLaneLayer.id='frontLaneOverlay';frontPb.append(frontLaneLayer);
const frontLaneButton=h_('button','btn sm','Lanes ▾');
frontLaneButton.id='frontLaneButton';
frontLaneButton.onpointerdown=e=>e.stopPropagation();frontLaneButton.onmousedown=e=>e.stopPropagation();
frontLaneButton.onclick=e=>{e.stopPropagation();showOverlaySettings('front',frontLaneButton);};
const frontHeader=frontPb.parentNode.querySelector('.ph');frontLaneButton.style.marginLeft='auto';frontHeader.append(frontLaneButton);
new ResizeObserver(()=>{clampFront();applyFrontView();updateFrontOverlay();invalidate();}).observe(frontPb);

function applyFrontView() {
  const f = S.fview, t = `translate(${f.x}px, ${f.y}px) scale(${f.s})`;
  [document.getElementById('front'), vidEl,document.getElementById('frontLaneOverlay')].forEach(el => { if (el) { el.style.transformOrigin = '0 0'; el.style.transform = t; } });
}
function clampFront() {
  const f = S.fview, W = frontPb.clientWidth, H = frontPb.clientHeight;
  f.x = Math.min(0, Math.max(W - W * f.s, f.x)); f.y = Math.min(0, Math.max(H - H * f.s, f.y));
}
frontPb.addEventListener('wheel', e => {
  e.preventDefault();
  const f = S.fview, r = frontPb.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const s2 = Math.max(1, Math.min(8, f.s * Math.exp(-e.deltaY * 0.0018)));
  f.x = mx - (mx - f.x) * (s2 / f.s); f.y = my - (my - f.y) * (s2 / f.s); f.s = s2;
  clampFront(); applyFrontView();
}, { passive: false });
frontPb.addEventListener('mousedown', e => {
  if (e.button !== 0 || S.fview.s <= 1) return;
  const f = S.fview, x0 = e.clientX, y0 = e.clientY, fx = f.x, fy = f.y;
  const move = ev => { f.x = fx + ev.clientX - x0; f.y = fy + ev.clientY - y0; clampFront(); applyFrontView(); };
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('grabbing'); };
  document.body.classList.add('grabbing');
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
});
frontPb.addEventListener('dblclick', () => { Object.assign(S.fview, { s: 1, x: 0, y: 0 }); applyFrontView(); });
frontPb.title = 'Wheel: zoom · Drag: pan · Double-click: reset';

// ---------------------------------------------------------------- frame loop (canvases redraw only while running or after a change)
let lastSec = -1, lastLiveRender = 0, lastSideStamp='';
function frame(now) {
  // A transient paint failure must not stop the operator clock and future redraws.
  requestAnimationFrame(frame);
  const h = runningHeat()||cur();
  if(S.cameraSetup){
    const p=S.cameraSetup,preview=p.heat;
    if(p.live){
      preview.tNow=preview.tOpen+(now-preview.startPerf)/1000*SPEED;
      if(!p.id&&p.sample){
        const target=Math.floor((preview.tNow-preview.tOpen)/periodOf(preview)),count=target-(preview.recvCols||0);
        if(count>0){const src=p.sample.getContext('2d').getImageData(0,0,1,rowsOf(preview)).data,data=new Uint8Array(count*rowsOf(preview)*3);for(let x=0;x<count;x++)for(let y=0;y<rowsOf(preview);y++){const d=(x*rowsOf(preview)+y)*3;data[d]=src[y*4];data[d+1]=src[y*4+1];data[d+2]=src[y*4+2];}ingestColumns(preview,preview.recvCols||0,count,data,3);}
      }
      preview.liveCol=(preview.recvCols||0)-1;preview.presentedCols=preview.liveFollow?.sample(now)??preview.recvCols;if(!S.view.user&&preview.liveCol>=0)follow(preview,now);
    }
    if(now-lastLiveRender>500){lastLiveRender=now;renderRace();renderTools();}
  }
  if (!S.cameraSetup && h.state === 'running') {
    h.tNow = (now - h.startPerf) / 1000 * SPEED;
    if(!h.asset && h.sampleStrip) {
      const target=Math.max(0,Math.floor((h.tNow-h.tOpen)/periodOf(h))),from=h.recvCols||0;
      for(let c=from;c<target;) {
        const index=Math.floor(c/STRIP_TILE),local=c%STRIP_TILE,n=Math.min(target-c,STRIP_TILE-local);
        if(!h.stripTiles[index]){const tile=document.createElement('canvas');tile.width=STRIP_TILE;tile.height=rowsOf(h);h.stripTiles[index]=tile;}
        const g=h.stripTiles[index].getContext('2d'),im=h.sampleStrip,inside=Math.max(0,Math.min(n,im.width-c));
        if(inside)g.drawImage(im,c,0,inside,im.height,local,0,inside,im.height);
        if(inside<n)g.drawImage(im,im.width-1,0,1,im.height,local+inside,0,n-inside,im.height);
        c+=n;
      }
      h.recvCols=target;h.nCols=Math.max(h.nCols,target);h.tClose=h.tOpen+target*periodOf(h);
      (h.liveFollow ||= new LiveFollow()).observe(target,now,SPEED/periodOf(h));
    }
    const lc=(h.recvCols||0)-1;
    h.liveCol=lc;h.presentedCols=h.liveFollow?.sample(now)??h.recvCols;
    if(h===cur()&&!S.view.user&&lc>=0)follow(viewHeat(),now);
    if(now-lastLiveRender>250){lastLiveRender=now;liveSuggest(h);if(h===cur()){renderAcc();const sideStamp=JSON.stringify([h.marks,h.status,h.proposals,S.selLane]);if(sideStamp!==lastSideStamp){lastSideStamp=sideStamp;renderSide();}renderProps();renderTools();}renderSchedule();if(S.tab==='events')renderMeetNavigator($('#drawerBody'));publishBoard();}
    if(h.stopMode==='timeout'&&h.tNow>=h.stopAfter)stopCapture(h);
    if(h.stopMode==='complete'&&h.athletes.length&&h.athletes.every(a=>resolved(h,a)))stopCapture(h);

    tickClock();
  } else if (h.req === 'pending' && now - lastLiveRender > 1000) { lastLiveRender = now; renderProps(); }   // "Timing… N s"
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== lastSec) { lastSec = sec; tickTod(); }
  if (dirty || h.state === 'running' || S.cameraSetup?.live) { dirty = false; drawScan(); drawBackup(); drawFront(); }
}

document.documentElement.dataset.theme = store.get('theme', 'dark');
wordmark(); readTokens(); initTiles(); initWorkspaceSplit(); initScanToolbar(); syncCursor();
const h0 = cur();
ensureStrip(h0);
if (S.autoArm) h0.state = 'armed';
fitView(); renderUI();
requestAnimationFrame(frame);
if (OM) {
  OM.on('preview.hello',d=>{const p=S.cameraSetup;if(p&&(p.starting||p.id===d.id)){p.id=d.id;rememberScanGeometry(p.heat,d);invalidate();}});
  OM.on('preview.columns',d=>{const p=S.cameraSetup;if(!p||p.id!==d.id)return;ingestColumns(p.heat,d.first,d.count,d.data,d.data.length/(d.count*p.heat.rows));p.heat.liveCol=p.heat.recvCols-1;invalidate();});
  OM.on('preview.end',d=>{const p=S.cameraSetup;if(p?.id===d.id){p.live=false;p.heat.state='review';p.heat.nCols=Math.max(1,p.heat.recvCols||1);renderUI();}});
  OM.on('preview.error',d=>{const p=S.cameraSetup;if(p&&(p.id===d.id||p.starting)){p.failed=true;p.live=false;p.heat.state='review';toast('Preview: '+d.message,true);renderUI();}});
  OM.on('meet.changed', snap => {
    if (!S.meet || snap.dir !== S.meet.dir || !snap.events) return;
    if (snap.files) S.meet.files = snap.files;
    applyMeet({ events: snap.events, people: snap.people || [], schedule: snap.schedule || [] }, false);
  });
  OM.on('engine.exit', () => toast('The engine process restarted. Capture and files are handled by the engine; re-open the meet folder if needed.', true));
  // The engine's camera: columns land in the capture store first, then arrive here to draw.
  const capHeat = id => HEATS.find(x => x.captureId === id) || (S.pendingCapture && !S.pendingCapture.captureId ? S.pendingCapture : null);
  OM.on('capture.hello', d => { const h = capHeat(d.id); if (h) { h.captureId = d.id;rememberScanGeometry(h,d);S.pendingCapture = null;invalidate(); } });
  OM.on('capture.pulse', d => { const h = capHeat(d.id); if (h && h.state === 'running') h.startPerf = performance.now(); });
  OM.on('capture.columns', d => {
    const h = capHeat(d.id);
    if (!h || h.state !== 'running' || !h.img) return;
    ingestColumns(h, d.first, d.count, d.data, d.data.length / (d.count * rowsOf(h)));
    invalidate();
  });
  OM.on('capture.end', d => { const h = capHeat(d.id); if (h && h.state === 'running') { endCapture(h); renderUI(); } });
  OM.on('capture.error', d => { toast('Camera error: ' + d.message, true); });
  occlusionAvailability.refresh();
  OM.call('autocrop.info').then(info=>{S.cropInfo=info;renderTools();}).catch(()=>{});
  OM.call('autotiming.info').then(i => { S.atInfo = i; }).catch(() => {});
  Promise.all([OM.call('settings.get'),OM.call('demo.catalog')]).then(([s,catalog])=>{S.simulationCatalog=catalog;renderDrawer();if(s.demoDir||s.simulationSourceId)openDemo(null,{id:catalog.selectedId});else if(s.meetDir)openMeet(s.meetDir);}).catch(err=>toast('Simulation sources: '+err.message,true));
}
})();
