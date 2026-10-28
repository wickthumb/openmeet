import { scanBoundaries, movedBoundaryRow, scanBackground, writeForegroundMask, foregroundInRows } from './scan-overlays.mjs';
import { FrontFrameCache, linkedCameraRange, cameraAsset } from './front-preview.mjs';

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
  crop: svg('<path d="M3 1v8h8M1 3h8v8"/>'),
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
  return {
    ev: e.event, rd: e.round, ht: e.heat, name: e.name || `Event ${e.event}`,
    of: all.filter(x => x.event === e.event && x.round === e.round).length,
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
  flip: store.get('flip', false), lanes: store.get('lanes', false), cropTool: false,
  files: [], view: { c0: 0, zx: 1, r0: 0, zy: 1, user: false, zoomed: false }, drag: null,
  layout: null, max: null, rects: {},
  meet: null,   // {dir, files} when a real meet folder is open (Electron); null = built-in sample meet
  bview: { linked: true, t0: 0, spp: 0.00125, r0: 0, rv: 1 }, bdrag: null,   // backup line-scan view (race time)
  fview: { s: 1, x: 0, y: 0 },                                               // front camera zoom/pan
};
const OM = window.openmeet || null;   // the Electron bridge; absent when this page runs as the static replica
const windStr = h => (h.wind == null ? '—' : (h.wind >= 0 ? '+' : '') + h.wind.toFixed(1) + ' m/s');
const cur = () => HEATS[S.idx];
const viewHeat = () => S.cameraSetup?.heat || cur();

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
const rowsOf = h => h.rows || IMG_H;
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
  if (h.asset) { if (!h.img) blankStrip(h); return; }
  if (!h.img || (h.imgSrc !== S.source && (h.state === 'loaded' || h.state === 'armed'))) renderStrip(h);
}
// A heat whose camera is the engine's: the strip starts black and fills as the engine's columns arrive.
const STRIP_TILE = 2048;
function blankStrip(h) {
  h.stripTiles = [];
  h.foregroundTiles = []; h.overlayBackground = null; h.sampleForeground = null;
  h.guideRenderCache=null;
  h.img = document.createElement('canvas'); h.img.width=1; h.img.height=rowsOf(h);
  h.imgSrc = 'engine'; h.recvCols = 0;
}
function drawStrip(g,h,sx,sy,sw,sh,dx,dy,dw,dh) {
  if(!h.stripTiles) { g.drawImage(h.img,sx,sy,sw,sh,dx,dy,dw,dh); return; }
  if(sw<=0)return;
  const lo=Math.floor(sx/STRIP_TILE),hi=Math.floor((sx+sw-1)/STRIP_TILE);
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
  h.proposals = props.filter(p=>!h.dismissed?.[p.lane]); h.model = meta.model || 'sim-0'; h.stub = !!meta.stub;
  h.inputDerived=!!meta.inputDerived;
  h.req = 'done'; h.reqMs = Math.round(performance.now() - h.reqStart);
  h.proposals.forEach(p => {
    const mk = h.marks[p.lane];
    if (h.status[p.lane] || h.dismissed?.[p.lane]) return;
    if (p.decision === 'auto' && (!mk || mk.src === 'auto')) h.marks[p.lane] = { col: p.col, src: 'auto' };
    else if (p.decision === 'review' && mk && mk.src === 'auto') delete h.marks[p.lane];   // a live auto-accept the final pass flags goes back to review
  });
  if (untouched && !h.saves) h.base = snap(h);                 // machine output on a fresh capture is part of "as captured"
  renderUI();
}
const predictParams = (h, extra = {}) => ({
  captureId: h.captureId,
  heat: { event: h.ev, round: h.rd, heat: h.ht },
  startList: h.athletes.filter(a => !['DNS', 'SC'].includes(h.status[a.lane])).map(a => ({ lane: a.lane, id: String(a.id) })),
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
    if (p.decision === 'auto' && colTime(h, p.col) + 0.02 <= settledT) h.marks[p.lane] = { col: p.col, src: 'auto' };
  });
}
function liveSuggest(h) {
  if (!S.autoMark || !S.apiOnline || h.liveCol < 0) return;
  if (h.asset && OM) {
    if (!h.captureId || h.liveBusy || (S.atInfo && !S.atInfo.live)) return;
    if (h.liveTo != null && colTime(h, h.liveCol) - colTime(h, h.liveTo) < LIVE_EVERY) return;
    const fromCol = Math.max(0, (h.liveTo == null ? 0 : h.liveTo) - Math.round(0.6 / periodOf(h))), toCol = h.liveCol;
    const runVersion = h.runVersion;
    h.liveBusy = true; h.req = 'live';
    OM.call('autotiming.predict', predictParams(h, { fromCol, toCol })).then(res => {
      if (h.runVersion !== runVersion || h.state !== 'running') return;
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
  if(cur().state==='running'||S.cameraSetup?.starting)return;
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
  $('#ev').innerHTML='<div class="ev-top"><span class="kicker">CAMERA ALIGNMENT</span><span class="tag sim">SIMULATOR</span></div><div class="ev-name">Align cameras & overlays</div><div class="ev-sub">Preview only · no race start or results</div>';
  const ctl=$('#ctl');ctl.innerHTML='';
  renderCameraRoles(ctl);
  const stop=h_('button','btn primary wide',setup.starting?'Starting preview…':setup.live?'Stop preview':'Start preview');stop.disabled=setup.starting||setup.stopping;stop.onclick=()=>setup.live?stopCameraSetup():startCameraSetup();ctl.append(stop);
  const modes=h_('div','setup-modes wide');
  ['alignment','overlays'].forEach(mode=>{const b=h_('button','btn sm'+(setup.mode===mode?' primary':''),mode==='alignment'?'Alignment':'Overlays');b.onclick=()=>{setup.mode=mode;renderUI();};modes.append(b);});ctl.append(modes);
  const done=h_('button','btn wide','Return to race');done.disabled=setup.starting||setup.stopping;done.onclick=()=>stopCameraSetup(true);ctl.append(done);
  $('#warn').innerHTML='';
  $('#list').innerHTML=`<div class="setup-help"><p>${setup.mode==='alignment'?'Use the live image to align the finish-line view. Pan and zoom as needed.':'Open Lanes ▾ on either camera to place and style your lane guides.'}</p><p>You can stop the preview and keep the image visible while adjusting overlays.</p><p class="dimtext">This build uses simulated camera input. Real camera drivers are planned.</p></div>`;
}

// ---------------------------------------------------------------- heat flow: Loaded -> Armed -> Running -> Review -> Saved
function go(i) {
  if (S.cameraSetup || cur().state === 'running' || i < 0 || i >= HEATS.length) return;
  S.idx = i; S.selLane = null; S.selCol = null; S.entryNumber = ''; S.hoverCol = null;
  S.bview.linked = true; Object.assign(S.fview, { s: 1, x: 0, y: 0 }); applyFrontView();
  const h = cur();
  ensureStrip(h);
  if (S.autoArm && h.state === 'loaded') h.state = 'armed';
  fitView();
  renderUI();
}
function arm() { if(S.cameraSetup)return; const h = cur(); if (h.state !== 'loaded') return; ensureStrip(h); h.state = 'armed'; renderUI(); }
function disarm() { const h = cur(); if (h.state === 'armed') { h.state = 'loaded'; renderUI(); } }
function fire() {
  if(S.cameraSetup)return;
  const h = cur();
  if (h.state !== 'armed') return;
  h.runVersion = (h.runVersion || 0) + 1;
  h.stopMode=S.autoStop; h.stopAfter=S.stopAfter; h.stopping=false;
  h.state = 'running'; h.startPerf = performance.now(); h.startTOD = new Date(); h.liveCol = -1; h.tNow = 0;
  h.startCorrection = 0; h.startReference = null; h.startTriggerId = null; h.dismissed = {}; h.inputDerived=false;
  if(!h.asset) { h.sampleStrip=h.sampleStrip||h.img; blankStrip(h); }
  h.proposals = null; h.allProps = null; h.liveTo = null; h.liveBusy = false; h.req = 'idle';
  S.view.user = false; S.view.followZoom=null; S.selCol = null;
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
  const key=attemptKey(h),attempts=attemptsByHeat.get(key)||[h];
  if(!attempts.includes(h))attempts.push(h);
  h.attemptNumber ||= attempts.indexOf(h)+1;
  const next={...h,attemptNumber:attempts.length+1,state:'armed',marks:{},status:{},proposals:null,req:'idle',img:null,
    stripTiles:null,recvCols:0,liveCol:-1,tNow:0,startPerf:0,startTOD:null,startReference:null,startTriggerId:null,startCorrection:0,
    captureId:null,captureDir:null,frontRec:null,saves:0,lif:null,base:null,allProps:null,liveTo:null,liveBusy:false,dismissed:{},
    stopping:false,restartAfterStop:false,runVersion:(h.runVersion||0)+1};
  next.athletes.forEach(a=>{if(a.pre)next.status[a.lane]=a.pre;});
  if(next.asset)attachAsset(next,next.asset);
  else {next.img=h.sampleStrip||h.img;next.nCols=next.img?.width||h.nCols;next.tClose=next.tOpen+next.nCols*periodOf(next);}
  attempts.push(next);attemptsByHeat.set(key,attempts);HEATS[S.idx]=next;
  S.selLane=null;S.selCol=null;S.hoverCol=null;S.entryNumber='';S.view.user=false;S.view.followZoom=null;
  ensureStrip(next);fitView();renderUI();
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
function stopCapture() {
  const h=cur(); if(h.state!=='running'||h.stopping)return;
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
  h.base=snap(h);fitView();
  if(h.restartAfterStop){h.restartAfterStop=false;prepareRestart(h);return;}
  if(S.autoMark&&h.nCols>0)requestProposals(h);else h.req='idle';
}
function editHeat(h) { if (h.state === 'saved') h.state = 'review'; }
function setMark(lane, col) {
  if(S.cameraSetup)return;
  const h = cur();
  if (col == null || !(['review', 'saved'].includes(h.state) || (h.state === 'running' && col <= h.liveCol))) return;   // marking works while capturing too
  const p = h.proposals && h.proposals.find(x => x.lane === lane);
  const src = p ? (p.col === col ? 'checked' : 'edited') : 'manual';
  if (h.dismissed) delete h.dismissed[lane];
  h.marks[lane] = { col, src };
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
    dir: S.meet.resultsDir || S.meet.dir, captureId:h.captureId || null,
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
  if (h.req === 'pending') w.push({ k: 'info', t: 'Timing: AI suggestions are on the way. You can mark by hand meanwhile.' });
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
const TABS = [['run', 'Run'], ['alignment', 'Camera alignment'], ['board', 'Scoreboard'], ['network', 'Network'], ['meet', 'Meet Link'], ['api', 'Auto-Timing'], ['starts', 'Starts'], ['settings', 'Settings']];
function renderTabs() {
  const n = $('#tabs'); n.innerHTML = '';
  TABS.forEach(([k, label]) => {
    const b = h_('button', 'tab' + (S.tab === k ? ' on' : ''), label);
    b.disabled=!!(S.cameraSetup?.starting||S.cameraSetup?.stopping)||(k==='alignment'&&cur().state==='running');
    if(k==='alignment'&&cur().state==='running')b.title='Stop race capture before entering camera alignment';
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
    ['Cameras', true, '5 devices on the camera network'],
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
    <div class="ev-top"><span class="kicker">Event ${h.ev} · Round ${h.rd} · Heat ${h.ht} of ${h.of}</span><span class="state ${h.state}">${stLabel}</span></div>
    <div class="ev-name">${h.name}</div>
    <div class="ev-sub">${S.idx + 1} of ${HEATS.length} in schedule · ${h.athletes.length} athletes</div>`;
  const ctl = $('#ctl'); ctl.innerHTML = '';
  const running = h.state === 'running';
  const actions=h_('div','race-actions wide');
  const btn = (html, cls, on, dis) => { const b = h_('button', 'btn ' + cls); b.innerHTML = html; b.onclick = on; b.disabled = !!dis; actions.append(b); return b; };
  const nav=h_('div','heat-nav wide');
  const prev=h_('button','btn sm'),next=h_('button','btn sm');prev.innerHTML=ICON.prev;next.innerHTML=ICON.next;
  prev.title='Previous heat';prev.setAttribute('aria-label','Previous heat');prev.disabled=running||S.idx===0;prev.onclick=()=>go(S.idx-1);
  next.title='Next heat';next.setAttribute('aria-label','Next heat');next.disabled=running||S.idx===HEATS.length-1;next.onclick=()=>go(S.idx+1);
  nav.append(prev,h_('span','dimtext',`Heat ${h.ht} of ${h.of}`),next);ctl.append(nav);
  const ready=h.state==='review'&&h.athletes.every(a=>resolved(h,a));
  if(running)btn(h.stopping?'Stopping…':'Stop capture','go wide',stopCapture,h.stopping);
  else if(h.state==='loaded')btn('Arm heat','primary wide',arm);
  else if(h.state==='armed')btn('Start <span class="tag sim">SIM</span>','go wide',fire);
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
      res = `<span class="t" title="${fmtT(raceTime(h,mk.col))} s">${official(raceTime(h,mk.col))}</span><span class="sub"><span class="num">P${pl[a.lane]}</span><span class="result-source" title="${src[0]}">${mk.src==='auto'?'AI':mk.src==='manual'?'Manual':'Checked'}</span></span>`;
    } else if (p) {
      res = `<span class="t prop">${official(raceTime(h, p.col))}</span><span class="sub"><span class="tag review">REVIEW</span></span>`;
    } else {
      res = `<span class="t prop">${running ? 'racing' : '—'}</span><span class="sub">${h.state === 'review' || h.state === 'saved' ? 'no time' : 'pending'}</span>`;
    }
    row.innerHTML = `
      <div class="lane">${a.lane}</div>
      <div class="who"><div class="nm">${a.last}, ${a.first}</div><div class="sc">${a.team.name} <span class="athlete-id">· #${a.id}</span></div></div>
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
  if (h.state === 'running') c.textContent = (Math.floor((h.tNow - (h.startCorrection || 0)) * 10) / 10).toFixed(1);
  else if (win) c.textContent = official(raceTime(h, h.marks[win.lane].col));
  else c.textContent = done ? '--.--' : '0.0';
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
  const start = { loaded: 'idle', armed: 'armed', running: 'fired', review: 'fired', saved: 'fired' }[h.state];
  const cap = h.state === 'running' ? (h.liveCol >= 0 ? 'capturing' : 'waiting') : 'idle';
  const rows = [
    ['ok', 'Primary line-scan', '.21', `${h.asset || S.source === 'render' ? 'sim-render' : 'sim-replay'} · ${cap}`],
    ['ok', 'Backup line-scan', '.22', `sim · ${cap}`],
    ['ok', 'Front camera', '.30', 'sim · streaming'],
    ['ok', 'Start system', '.40', `sim · ${start}`],
    h.wind == null ? ['', 'Wind gauge', '', 'not connected'] : ['ok', 'Wind gauge', '.41', ['review', 'saved'].includes(h.state) ? `sim · ${windStr(h)}` : 'sim · ready'],
    ['', 'Scoreboard', '', 'not configured'],
  ];
  $('#acc').innerHTML = `<div class="acc">${rows.map(([d, n, ip, s]) => `<span class="dot ${d}"></span><span class="nm" title="${ip ? '192.168.0' + ip : ''}">${n}</span><span class="st">${s}</span>`).join('')}</div>`;
}
function renderProps() {
  if(S.cameraSetup){$('#apiState').textContent='Setup';$('#props').innerHTML='<div class="empty">Timing suggestions are paused during camera setup.</div>';return;}
  const h = cur();
  $('#apiState').innerHTML = !S.apiOnline ? '<span class="dot warn"></span>offline' :
    h.req === 'pending' ? '<span class="dot warn"></span>timing…' :
    h.req === 'error' ? '<span class="dot warn"></span>failed' :
    h.req === 'live' ? `${h.stub ? '<span class="tag sim" title="A contract stand-in that echoes simulator truth. It is not a model.">STAND-IN</span>' : ''}<span class="dot ok"></span>live` :
    h.req === 'done' ? `${h.stub ? '<span class="tag sim" title="A contract stand-in that echoes simulator truth. It is not a model.">STAND-IN</span>' : ''}<span class="dot ok"></span>${h.reqMs} ms` : '<span class="dot ok"></span>';
  if(h.inputDerived) $('#apiState').append(h_('span','tag info','GUIDED INPUT'));
  const box = $('#props');
  if (h.req === 'offline' || h.req === 'error') {
    box.innerHTML = `<div class="empty">${h.req === 'error' ? 'Auto-timing failed: ' + esc(h.reqErr || '') + '.' : 'The auto-timing service could not be reached.'} Every lane can still be marked by hand.</div>`;
    return;
  }
  if (!h.proposals) {
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

function renderDrawer() {
  const d = $('#drawer');
  d.classList.toggle('open', S.tab !== 'run' && S.tab !== 'alignment');
  if (S.tab === 'run' || S.tab === 'alignment') return;
  $('#drawerTitle').textContent = TABS.find(t => t[0] === S.tab)[1];
  const body = $('#drawerBody');
  body.classList.toggle('boardbody', S.tab === 'board');
  if (S.tab === 'board') { renderBoard(body); return; }
  body.dataset.tab = S.tab;
  if (S.tab === 'starts') { renderStarts(body); return; }
  if (S.tab === 'network') {
    body.innerHTML = `
      <div class="card"><h3>Camera network (closed loop)</h3>
        <p>Static addresses, no gateway. Cameras, start system and accessories live here, never on the internet side.</p>
        <table class="tbl"><tr><th>Device</th><th>Address</th><th>Driver</th><th>State</th></tr>
          <tr><td>This computer</td><td class="num">192.168.0.10/24</td><td>Ethernet</td><td><span class="dot ok"></span> up</td></tr>
          <tr><td>Primary line-scan</td><td class="num">192.168.0.21</td><td id="srcCell"></td><td><span class="dot ok"></span> 800 col/s</td></tr>
          <tr><td>Backup line-scan</td><td class="num">192.168.0.22</td><td>sim</td><td><span class="dot ok"></span> 800 col/s</td></tr>
          <tr><td>Front camera</td><td class="num">192.168.0.30</td><td>sim</td><td><span class="dot ok"></span> 30 fps</td></tr>
          <tr><td>Start system</td><td class="num">192.168.0.40</td><td>sim</td><td><span class="dot ok"></span> ready</td></tr>
          <tr><td>Wind gauge</td><td class="num">192.168.0.41</td><td>sim</td><td><span class="dot ok"></span> ready</td></tr>
        </table>
        <p>The simulated cameras stream like real ones: hello, start pulse, timestamped columns.</p>
      </div>
      <div class="card"><h3>Internet uplink</h3>
        <p>A second connection (Wi-Fi or hotspot). RunMeet is online; it reaches OpenMeet through AthleticLOCAL and the meet folder, not through this connection.</p>
        <table class="tbl"><tr><th>Service</th><th>State</th></tr>
          <tr><td>Internet</td><td><span class="dot ok"></span> online</td></tr>
          <tr><td>Auto-timing API</td><td><span class="dot ${S.apiOnline ? 'ok' : 'warn'}"></span> ${S.apiOnline ? 'reachable' : 'offline'}</td></tr>
        </table>
      </div>`;
    const sel = h_('select');
    sel.innerHTML = '<option value="replay">sim-replay · web photo finish</option><option value="render">sim-render · TTP simulator</option>';
    sel.value = S.source;
    sel.onchange = () => { S.source = sel.value; ensureStrip(cur()); renderUI(); };
    $('#srcCell').append(sel);
    const cameras=h_('div','card');cameras.append(h_('h3','','Capture cameras'));renderCameraRoles(cameras);body.prepend(cameras);
  } else if (S.tab === 'meet') {
    const last = S.files[S.files.length - 1], entries = HEATS.reduce((n, h) => n + h.athletes.length, 0);
    const kb = n => (n == null ? '' : n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' kB');
    const fileRow = f => { const m = S.meet.files[f]; return `<tr><td class="num">${f}</td><td>${m ? kb(m.size) : 'absent'}</td><td>${m ? new Date(m.mtimeMs).toTimeString().slice(0, 8) : '—'}</td><td><span class="dot ${m ? 'ok' : ''}"></span> ${m ? 'watching' : f === 'lynx.evt' ? 'required' : 'optional'}</td></tr>`; };
    const folderCard = !OM ? null : `
      <div class="card"><h3>Meet folder</h3>
        ${S.meet ? `<p class="num">${esc(S.meet.dir)}</p>` : '<p>No meet folder is open, so the built-in sample meet is loaded. Point this at the folder your meet manager (RunMeet through AthleticLOCAL, Hy-Tek, ...) writes lynx.evt to.</p>'}
        <p><button class="btn sm primary" id="openMeet">Open meet folder…</button> <button class="btn sm" id="openDemo">Open demo meet…</button> ${S.meet ? '<button class="btn sm" id="closeMeet">Use the sample meet</button>' : ''}</p>
        ${S.meet && S.meet.demo ? `<p class="dimtext">Cameras: rendered by the TTP simulator from <span class="num">${esc(S.meet.demo)}</span></p>` : ''}
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
      $('#openDemo').onclick = async () => { const dir = await OM.pickFolder('Open demo meet (rendered heats)'); if (dir) openDemo(dir); };
    }
  } else if (S.tab === 'api') {
    body.innerHTML = `
      <div class="card"><h3>Auto-timing service</h3>
        <p>AI-suggested finish times for operator review. The operator approves every result.</p>
        <table class="tbl">
          <tr><td>Service</td><td>${OM ? 'Stand-in on this computer: echoes simulator truth, not a model' : 'TTP finish model (simulated in this replica)'}</td></tr>
          <tr><td>Model</td><td class="num">${esc(cur().model || (OM ? 'stub-truth-0' : 'sim-0'))}</td></tr>
          <tr><td>Contract</td><td class="num">POST /v1/finish-predictions</td></tr>
          <tr><td>State</td><td><span class="dot ${S.apiOnline ? 'ok' : 'warn'}"></span> ${S.apiOnline ? 'reachable' : 'offline'}</td></tr>
        </table>
        <p><label class="chk"><input type="checkbox" id="apiOff" ${S.apiOnline ? '' : 'checked'}> Simulate the service being unreachable</label></p>
      </div>
      <div class="card"><h3>How suggestions are used</h3>
        <p>Each finisher gets a suggested time. REVIEW suggestions wait for the operator; nothing is delivered until the heat is saved.</p>
        <p>AUTO is reserved for suggestions the model is confident in. Today almost everything comes back REVIEW: on unseen meets the auto rule is not yet reliable.</p>
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
      <div class="card"><h3>More settings</h3><p>To be discussed.</p></div>`;
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
  const h = cur(), done = ['review', 'saved'].includes(h.state), { fin, pl } = places(h), win = done ? fin[0] : null;
  const timeOf = a => (h.marks[a.lane] && (!h.status[a.lane] || h.status[a.lane] === 'DQ') ? ceilTo(raceTime(h, h.marks[a.lane].col), 2) : null);
  const lanes = [...h.athletes].sort((a, b) => a.lane - b.lane).map(a => ({
    lane: h.unlaned ? null : a.lane, id: a.id, first: a.first, last: a.last, affiliation: a.team.name,
    status: h.status[a.lane] || null, time: timeOf(a), place: pl[a.lane] || null,
  }));
  return {
    meet: { name: S.meet ? (S.meet.demo ? 'OpenMeet Demo Meet' : S.meet.dir.split(/[\\/]/).filter(Boolean).slice(-1)[0]) : 'OpenMeet Sample Meet', logo: null },
    heat: { event: h.ev, round: h.rd, heat: h.ht, of: h.of, name: h.name, state: h.state },
    clock: {
      running: h.state === 'running', speed: SPEED,
      startedAtMs: h.state === 'running' && h.startTOD ? h.startTOD.getTime() : null,
      frozenS: win ? ceilTo(raceTime(h, h.marks[win.lane].col), 2) : null,
    },
    lanes, results: lanes.filter(l => l.place).sort((a, b) => a.place - b.place),
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
const overlayDefaults = { fontSize:16, weight:700, thickness:1, textColor:'#ffffff', lineColor:'#6ba5e7', opacity:0.65, edit:false, positions:{} };
function overlayKey(kind) { return `overlay:${S.meet?.dir || 'sample'}:${kind}`; }
function cameraOverlayKey(kind){return kind==='scan'?`${overlayKey(kind)}:${viewHeat().asset?.mainCameraId||'primary'}`:overlayKey(kind);}
function overlayStyle(kind) { const camera=viewHeat().asset?.mainCameraId||'primary',saved=store.get(cameraOverlayKey(kind),kind!=='scan'||camera==='primary'?store.get(overlayKey(kind),{}):{});return { ...overlayDefaults, ...(kind==='front'?{fontSize:28,opacity:0.5,enabled:false,laneCount:8,placement:'anchors',firstScale:1,lastScale:0.55}:{enabled:S.lanes,behindRunners:true}), ...saved,positions:{...(saved.positions||{})},boundaries:{...(saved.boundaries||{})},sizes:{...(saved.sizes||{})} }; }
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
  const o=overlayStyle('scan');if(!o.modelInput)return null;
  const rows=[...new Set(scanBoundaries(laneBands(h),o,rowsOf(h)).map(b=>Math.round(b.row)))];
  return {enabled:true,rows,color:o.lineColor,thickness:Math.max(1,Math.round(o.thickness))};
}
function saveOverlay(kind,value) { store.set(cameraOverlayKey(kind),value); if(kind==='scan'){S.lanes=value.enabled;store.set('lanes',S.lanes);} updateFrontOverlay(); invalidate(); }
let overlayMenu=null;
function showOverlaySettings(kind,anchor) {
  overlayMenu?.remove();
  const o=overlayStyle(kind),menu=h_('div','overlay-settings');overlayMenu=menu;
  menu.innerHTML=`<div class="overlay-title">${kind==='front'?'Front camera':'Line-scan'} lanes<button class="btn sm" data-close>×</button></div>
    <label><span>Show overlay</span><input data-key="enabled" type="checkbox" ${o.enabled?'checked':''}></label>
    <label><span>${kind==='scan'?'Edit boundary lines':'Drag to position'}</span><input data-key="edit" type="checkbox" ${o.edit?'checked':''}></label>
    ${kind==='front'?`<label><span>Lane count</span><input data-lane-count type="number" min="2" max="24" value="${o.laneCount}"></label>
    <label><span>Positioning</span><select data-placement><option value="anchors">Set first + last</option><option value="individual">Fine-tune each lane</option></select></label>
    <label><span>First lane size</span><input data-end-size="first" type="number" min="8" max="160" value="${Math.round(o.fontSize*o.firstScale)}"></label>
    <label><span>Last lane size</span><input data-end-size="last" type="number" min="8" max="160" value="${Math.round(o.fontSize*o.lastScale)}"></label>
    <p class="dimtext overlay-hint">Place the first and last numbers; the rest follow their positions and sizes. In fine-tune mode, drag any number. Alt + wheel adjusts its size.</p>`:''}
    ${kind==='scan'?`<p class="dimtext overlay-hint">Drag a line or its number. Each line is a shared lane boundary; neighbouring lines stay put.</p><label><span>Guides behind runners</span><input data-key="behindRunners" type="checkbox" ${o.behindRunners?'checked':''}></label><label><span>Lane guides in model input</span><input data-key="modelInput" type="checkbox" ${o.modelInput?'checked':''}></label><p class="dimtext overlay-hint">Renders opaque guide lines into a derived image. Original pixels stay unchanged. No finish marks or text are included.</p>`:''}
    <label><span>Font size</span><input data-key="fontSize" type="number" min="8" max="96" value="${o.fontSize}"></label>
    <label><span>Font weight</span><select data-key="weight">${[400,500,600,700,800,900].map(v=>`<option ${v===o.weight?'selected':''}>${v}</option>`).join('')}</select></label>
    <label><span>Line thickness</span><input data-key="thickness" type="number" min="0" max="12" step="0.5" value="${o.thickness}"></label>
    <label><span>Text color</span><input data-key="textColor" type="color" value="${o.textColor}"></label>
    <label><span>Line color</span><input data-key="lineColor" type="color" value="${o.lineColor}"></label>
    <label><span>Opacity</span><input data-key="opacity" type="range" min="0.1" max="1" step="0.05" value="${o.opacity}"></label>
    <div class="overlay-actions"><button class="btn sm" data-reset>Reset positions</button><button class="btn sm" data-defaults>Reset appearance</button></div>`;
  menu.querySelector('[data-close]').onclick=()=>{menu.remove();overlayMenu=null;};
  menu.querySelectorAll('[data-key]').forEach(input=>{input.oninput=()=>{
    const key=input.dataset.key;
    let value=input.type==='checkbox'?input.checked:input.type==='color'?input.value:Number(input.value);
    const limits={fontSize:[8,96],thickness:[0,12],opacity:[0.1,1],weight:[400,900]};
    if(limits[key]) {if(!Number.isFinite(value))return;value=Math.max(limits[key][0],Math.min(limits[key][1],value));}
    o[key]=value;
    if(kind==='front'&&key==='fontSize')menu.querySelectorAll('[data-end-size]').forEach(e=>{e.value=Math.round(o.fontSize*(e.dataset.endSize==='first'?o.firstScale:o.lastScale));});
    saveOverlay(kind,o);
  };});
  if(kind==='front'){
    const count=menu.querySelector('[data-lane-count]'),placement=menu.querySelector('[data-placement]');placement.value=o.placement||'anchors';
    count.onchange=()=>{const last=frontLanePoint(o,o.laneCount),first=frontLanePoint(o,1);o.laneCount=Math.max(2,Math.min(24,Math.round(Number(count.value)||8)));count.value=o.laneCount;o.positions={1:first,[o.laneCount]:last};o.sizes={};spreadFrontLanes(o);saveOverlay(kind,o);};
    placement.onchange=()=>{o.placement=placement.value;saveOverlay(kind,o);};
    menu.querySelectorAll('[data-end-size]').forEach(input=>{input.oninput=()=>{const size=Math.max(8,Math.min(160,Number(input.value)||8));o[input.dataset.endSize==='first'?'firstScale':'lastScale']=size/o.fontSize;o.sizes={};if(o.placement==='anchors')spreadFrontLanes(o);saveOverlay(kind,o);};});
  }
  menu.querySelector('[data-reset]').onclick=()=>{o.positions={};o.boundaries={};saveOverlay(kind,o);};
  menu.querySelector('[data-defaults]').onclick=()=>{saveOverlay(kind,{...overlayDefaults,...(kind==='front'?{fontSize:28,opacity:0.5,laneCount:o.laneCount,placement:o.placement,firstScale:1,lastScale:0.55}:{behindRunners:true,modelInput:o.modelInput}),enabled:o.enabled,positions:o.positions,boundaries:o.boundaries});showOverlaySettings(kind,anchor);};
  document.body.append(menu);const r=anchor.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(innerWidth-270,r.left))+'px';menu.style.top=Math.max(8,Math.min(innerHeight-menu.offsetHeight-8,r.bottom+5))+'px';
}
function updateFrontOverlay() {
  const layer=document.getElementById('frontLaneOverlay');if(!layer)return;
  const o=overlayStyle('front'),lanes=Array.from({length:o.laneCount},(_,i)=>i+1);
  layer.hidden=!o.enabled;if(!o.enabled)return;layer.style.opacity=o.opacity;
  layer.innerHTML=lanes.map(lane=>{
    const pos=frontLanePoint(o,lane),movable=o.edit&&(o.placement==='individual'||lane===1||lane===o.laneCount);
    return `<span class="front-lane${o.edit&&o.placement==='anchors'&&(lane===1||lane===o.laneCount)?' lane-anchor':''}" data-lane="${lane}" style="left:${pos.x*100}%;top:${pos.y*100}%;font-size:${frontLaneSize(o,lane)}px;font-weight:${o.weight};color:${o.textColor};-webkit-text-stroke:${o.thickness}px ${o.lineColor};cursor:${movable?'grab':'default'};pointer-events:${movable?'auto':'none'}">${lane}</span>`;
  }).join('');
  layer.querySelectorAll('.front-lane').forEach(label=>{
    const lane=Number(label.dataset.lane);
    label.onwheel=e=>{if(!o.edit||!e.altKey)return;e.preventDefault();e.stopPropagation();o.sizes[lane]=Math.max(8,Math.min(160,frontLaneSize(o,lane)+(e.deltaY<0?1:-1)));saveOverlay('front',o);};
    label.onpointerdown=e=>{
      if(!o.edit)return;e.preventDefault();e.stopPropagation();label.setPointerCapture(e.pointerId);
      const rect=frontPb.getBoundingClientRect(),f=S.fview;
      const move=ev=>{
        const x=Math.max(0.02,Math.min(0.98,(ev.clientX-rect.left-f.x)/f.s/rect.width)),y=Math.max(0.02,Math.min(0.98,(ev.clientY-rect.top-f.y)/f.s/rect.height));
        o.positions[lane]={x,y};if(o.placement==='anchors')spreadFrontLanes(o);
        layer.querySelectorAll('.front-lane').forEach(el=>{const p=frontLanePoint(o,Number(el.dataset.lane));el.style.left=p.x*100+'%';el.style.top=p.y*100+'%';});
      };
      const up=()=>{label.onpointermove=null;label.onpointerup=null;label.onpointercancel=null;saveOverlay('front',o);};
      label.onpointermove=move;label.onpointerup=up;label.onpointercancel=up;
    };
  });
}

// ---------------------------------------------------------------- line-scan toolbar
function renderTools() {
  invalidate();
  const h = viewHeat(), box = $('#tools'); box.innerHTML = '';
  $('#scanCameraLabel').textContent=h.asset?.mainCameraLabel||'Main scan';
  $('#scanCameraLabel').title='Main line-scan camera · choose cameras in Camera alignment';
  const backupTitle=backupCv?.parentNode?.parentNode?.querySelector('.kicker');if(backupTitle)backupTitle.textContent=h.asset?.comparisonCameraLabel?`${h.asset.comparisonCameraLabel} · comparison`:'Backup line-scan';
  const captured = h.state === 'review' || h.state === 'saved' || (h.state === 'running' && h.liveCol >= 0);
  const review = !S.cameraSetup && (h.state === 'review' || h.state === 'saved');
  const tool = (icon, label, title, on, dis, act) => {
    const b = h_('button', 'tool' + (on ? ' on' : ''));
    b.innerHTML = icon + label; b.title = title; b.disabled = !!dis; b.onclick = act;
    box.append(b); return b;
  };
  const sep = () => box.append(h_('span', 'tsep'));
  tool(ICON.next, 'Follow live', 'Return to the latest captured columns', h.state==='running'&&!S.view.user, h.state!=='running', () => {
    S.view.followZoom=S.view.zx;S.view.user=false;S.view.zoomed=false;S.cropTool=false;S.hoverCol=null;
    follow(h);renderTools();invalidate();
  });
  tool(ICON.crop, 'Crop', 'Drag a box to zoom to it (Shift+drag works any time)', S.cropTool, !captured, () => { S.cropTool = !S.cropTool; renderTools(); syncCursor(); });
  tool(ICON.fit, 'Unzoom', 'Fit the whole capture (Esc)', false, !captured || !S.view.zoomed, () => { fitView(); renderUI(); });
  tool(ICON.auto, 'Mark', 'Create or replace the selected athlete’s finish here (Enter)', false, !!S.cameraSetup || !captured || S.selLane == null || S.selCol == null, () => setMark(S.selLane,S.selCol));
  tool(ICON.clear, 'Delete mark', 'Remove the selected finish (Delete)', false, !!S.cameraSetup || !captured || S.selLane == null, deleteSelectedFinish);
  tool(ICON.flip, 'Flip', 'Mirror the image: winner on the left or on the right', S.flip, false, () => { S.flip = !S.flip; store.set('flip', S.flip); renderTools(); });
  const laneOptions=tool(ICON.lanes, 'Lanes ▾', 'Lane overlay appearance and positions', overlayStyle('scan').enabled, false, () => showOverlaySettings('scan',laneOptions));
  sep();
  tool(ICON.auto, 'Auto-mark', 'Ask the finish model for suggested times now (for your review)', false, !review || !S.apiOnline || h.req === 'pending', () => requestProposals(h));
  const sw = h_('button', 'sw' + (S.autoMark ? ' on' : ''));
  sw.innerHTML = '<i></i>Auto';
  sw.title = 'Run Auto-mark automatically when each capture closes';
  sw.onclick = () => { S.autoMark = !S.autoMark; store.set('autoMark', S.autoMark); renderUI(); };
  box.append(sw);
  sep();
  tool(ICON.clear, 'Clear', 'Remove every mark in this heat (statuses stay)', false, !review || !Object.keys(h.marks).length, clearMarks);
  tool(ICON.revert, 'Revert', h.saves ? 'Back to the last saved results' : 'Back to the capture as it closed', false, !review || !h.base || h.base === snap(h), revert);
}
function syncCursor() { scanCv.classList.toggle('crop', S.cropTool); }

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
    HEATS = evs.map(e => buildHeat(specFromEvent(e, evs)));
    S.idx = 0; S.files = []; S.selLane = null; S.selCol = null;
    const h = cur(); ensureStrip(h); if (S.autoArm) h.state = 'armed';
    fitView(); renderUI();
    return;
  }
  // Live re-seed from the meet manager: heats not yet started take the new start list; a heat that already ran only warns.
  const notes = [];
  evs.forEach(e => {
    const spec = specFromEvent(e, evs), i = HEATS.findIndex(h => h.ev === e.event && h.rd === e.round && h.ht === e.heat);
    if (i < 0) { HEATS.push(buildHeat(spec)); notes.push(`${spec.name} heat ${e.heat} added`); return; }
    const h = HEATS[i];
    if (JSON.stringify(h.entries) === JSON.stringify(spec.entries)) return;
    if (h.state === 'loaded' || h.state === 'armed') {
      const nh = buildHeat(spec); nh.state = h.state;
      if (h.asset) attachAsset(nh, h.asset);
      ensureStrip(nh); HEATS[i] = nh;
      notes.push(`${spec.name} heat ${e.heat} re-seeded`);
    } else notes.push(`${spec.name} heat ${e.heat} changed after it ran: check it against the meet manager`);
  });
  if (notes.length) toast('Meet folder changed: ' + notes.join('; ') + '.', notes.some(n => n.includes('after it ran')));
  renderUI();
}
async function openMeet(dir) {
  if(S.cameraSetup)await stopCameraSetup(true);
  try {
    const r = await OM.call('meet.open', { dir });
    if (!r.parsed || !r.parsed.events.some(e => e.entries.some(x => x.lane))) { toast(`No laned heats found in ${dir} (lynx.evt missing or empty).`, true); return; }
    const s = await OM.call('settings.get').catch(() => ({}));
    S.meet = { dir, files: r.files, resultsDir: s.resultsFor && s.resultsFor[dir] ? s.resultsFor[dir] : null };
    applyMeet(r.parsed, true);
    OM.call('settings.set', { patch: { meetDir: dir } }).catch(() => {});
    toast(`Opened ${dir}: ${HEATS.length} heats.`);
  } catch (err) { toast('Could not open the meet folder: ' + err.message, true); }
}
// A rendered demo meet (TTP simulator): meet/lynx.* plus, per heat, the primary line-scan, backup line-scan and front-camera recording.
function attachAsset(h, a) {
  if(a)a=cameraAsset(a,store.get(cameraRoleKey(),{}));
  if (!a || !a.primary || !a.primaryMeta || !a.primarySize) return h;
  const m = a.primaryMeta;
  // the engine's camera streams from the gun: pre-roll columns from race time 0, then the rendered finish window
  const nPre = Math.max(0, Math.round(m.first_column_race_time_s / m.column_period_s));
  h.asset = a; h.rows = m.rows || a.primarySize.height; h.nCols = nPre + a.primarySize.width;
  h.tOpen = m.first_column_race_time_s - nPre * m.column_period_s; h.tClose = h.tOpen + h.nCols * m.column_period_s;
  h.laneRows = Array.isArray(m.lane_rows) && m.lane_rows.length ? m.lane_rows.map(x => ({ lane: x.lane, top: x.top_row, bottom: x.bottom_row })) : null;
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
    select.onchange=async()=>{
      const next={main:selected.mainCameraId,comparison:selected.comparisonCameraId,[key]:select.value};
      if(next.main===next.comparison)next.comparison=scans.find(s=>s.id!==next.main)?.id;
      const preview=!!S.cameraSetup;if(preview){await stopCameraSetup(true);if(S.cameraSetup)return;}
      store.set(cameraRoleKey(),next);
      for(const h of HEATS)if(h.asset&&['loaded','armed'].includes(h.state))attachAsset(h,h.asset);
      ensureStrip(cur());fitView();if(preview)await startCameraSetup();else renderUI();
    };
    row.append(h_('span','',label),select);box.append(row);
  }
  container.append(box);
  if(['review','saved'].includes(cur().state))box.append(h_('p','dimtext','Camera roles apply to new captures; earlier attempts keep their recorded source.'));
}
async function openDemo(dir) {
  try {
    const r = await OM.call('assets.open', { dir });
    if (!r.meet || !r.meet.files['lynx.evt']) { toast(`No meet/lynx.evt in ${dir}.`, true); return; }
    await openMeet(r.meet.dir);
    if (!S.meet) return;
    HEATS.forEach((h, i) => attachAsset(h, r.heats[i]));
    S.meet.demo = dir;
    const h = cur(); h.img = null; ensureStrip(h); fitView(); renderUI();
    OM.call('settings.set', { patch: { demoDir: dir } }).catch(() => {});
    toast(`Demo meet: ${r.heats.length} simulated heats with primary, backup and front cameras.`);
  } catch (err) { toast('Could not open the demo meet: ' + err.message, true); }
}
function closeMeet() {
  if(S.cameraSetup){stopCameraSetup(true).then(closeMeet);return;}
  S.meet = null; HEATS = SPECS.map(buildHeat); S.idx = 0; S.files = [];
  OM.call('settings.set', { patch: { meetDir: null, demoDir: null } }).catch(() => {});
  const h = cur(); ensureStrip(h); if (S.autoArm) h.state = 'armed';
  fitView(); renderUI();
}

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
const scanCv = $('#scan');
const scanW = () => scanCv.clientWidth, scanH = () => scanCv.clientHeight - RULER;
// The line-scan never condenses past MIN_ZX px per column (about 3 s of race on a laptop screen):
// beyond that it scrolls instead. The default view ends at the capture's end, where the finishers are.
const MIN_ZX = 0.6;
function fitView() {
  const h = viewHeat(), v = S.view, W = scanW();
  S.bview.linked=true;
  v.zx = Math.max(MIN_ZX, Math.min(1, W / h.nCols));
  v.c0 = Math.max(0, h.nCols - W / v.zx);
  v.zy = scanH() / rowsOf(h); v.r0 = 0; v.zoomed = false;
}
function clampView() {
  const h = viewHeat(), v = S.view, vis = scanW() / v.zx;
  v.c0 = Math.max(h.preview?(h.minCol||0):-vis*0.05, Math.min(h.nCols - vis * 0.95, v.c0));
  v.r0 = Math.max(0, Math.min(rowsOf(h) - scanH() / v.zy, v.r0));
}
function focusFinish(col) {
  const v = S.view;
  v.zx = Math.max(v.zx, 1.5);
  v.c0 = col + 0.5 - scanW() / (2 * v.zx);
  v.zoomed = true; v.user = true;
  clampView();
}
function centerOn(col) {
  const v = S.view, vis = scanW() / v.zx;
  if (col < v.c0 + vis * 0.1 || col > v.c0 + vis * 0.9) { v.c0 = col - vis / 2; clampView(); }
}
// While running: the scan streams in at 1:1, condenses down to MIN_ZX, then autoscrolls with the live edge at the right.
function follow(h) {
  const v = S.view, W = scanW(), n = Math.max(1, h.liveCol + 1);
  v.zy = scanH() / rowsOf(h); v.r0 = 0;
  v.zx = Math.max(MIN_ZX, v.followZoom ?? Math.min(1, W / n));      // stream in at 1:1, condense to the floor, then autoscroll
  v.c0 = Math.max(0, n - W / v.zx);
}
// screen x <-> column, honouring Flip (mirrored: later times to the left)
const unflipX = x => (S.flip ? scanW() - x : x);
const xOf = col => unflipX((col + 0.5 - S.view.c0) * S.view.zx);
const colOf = x => Math.floor(S.view.c0 + unflipX(x) / S.view.zx);

function sampleForeground(h) {
  if(h.asset||h.preview||h.sampleForeground)return;
  const source=h.sampleStrip||h.img;if(!source?.width)return;
  const image={data:source.getContext('2d').getImageData(0,0,source.width,source.height).data,width:source.width,height:source.height,channels:4,layout:'rows'};
  h.overlayBackground=scanBackground(image);
  h.sampleForeground=new Uint8Array(Math.ceil(image.width*image.height/8));
  writeForegroundMask(h.sampleForeground,0,image,h.overlayBackground);
}
function guideOccluded(h, x0, x1, row0, row1) {
  const first=Math.max(0,Math.min(colOf(x0),colOf(x1))-1),last=Math.min((h.state==='running'?h.liveCol:h.nCols-1),Math.max(colOf(x0),colOf(x1))+1);
  const rows=rowsOf(h),lo=Math.max(0,Math.floor(row0)-2),hi=Math.min(rows-1,Math.ceil(row1)+2);
  for(let c=first;c<=last;c++) {
    const mask=h.sampleForeground||h.foregroundTiles?.[Math.floor(c/STRIP_TILE)];
    const local=h.sampleForeground?c:c%STRIP_TILE;
    if(foregroundInRows(mask,local,rows,lo,hi))return true;
  }
  return false;
}
function hitScanBoundary(h,x,y) {
  const o=overlayStyle('scan'),captured=h.state==='review'||h.state==='saved'||(h.state==='running'&&h.liveCol>=0);
  if(!captured||!o.enabled||!o.edit||S.cropTool||y<0||y>scanH())return null;
  return scanBoundaries(laneBands(h),o,rowsOf(h)).map(b=>{
    const lineY=(b.row-S.view.r0)*S.view.zy;
    const label=b.below!=null&&x<Math.max(40,String(b.below).length*o.fontSize)&&y>=lineY+2&&y<=lineY+o.fontSize+6;
    const distance=Math.abs(lineY-y);
    return {...b,d:distance<=8?distance:label?8:Infinity};
  }).filter(b=>b.d<=8).sort((a,b)=>a.d-b.d)[0]||null;
}
function guideRenderData(h,o,W,Hi,g) {
  const v=S.view,key=JSON.stringify([W,Hi,v.c0,v.zx,v.r0,v.zy,S.flip,h.recvCols,h.nCols,o.behindRunners,o.thickness,o.fontSize,o.weight,o.boundaries,o.positions]);
  if(h.guideRenderCache?.key===key)return h.guideRenderCache.lines;
  const lines=scanBoundaries(laneBands(h),o,rowsOf(h)).map(b=>{
    const y=(b.row-v.r0)*v.zy,path=new Path2D();
    if(y>=0&&y<=Hi&&o.thickness>0) {
      if(!o.behindRunners){path.moveTo(0,y);path.lineTo(W,y);}
      else {const half=o.thickness/(2*v.zy);let start=null;for(let x=0;x<=W;x++){
        const hidden=x>=W||guideOccluded(h,x,x+1,b.row-half,b.row+half);
        if(!hidden&&start==null)start=x;
        if(hidden&&start!=null){path.moveTo(start,y);path.lineTo(x,y);start=null;}
      }}
    }
    const baseline=y+o.fontSize+3,width=b.below==null?0:g.measureText(String(b.below)).width;
    const label=b.below!=null&&baseline>=0&&baseline<=Hi&&(!o.behindRunners||!guideOccluded(h,6,6+width,b.row+3/v.zy,b.row+(o.fontSize+3)/v.zy));
    return {boundary:b,path,baseline,label};
  });
  h.guideRenderCache={key,lines};return lines;
}

function drawScan() {
  const [g, W, Hc] = fitCanvas(scanCv), Hi = Hc - RULER, h = viewHeat(), v = S.view;
  g.fillStyle = TK.scanbg; g.fillRect(0, 0, W, Hc);
  const live = h.state === 'running', last = live ? h.liveCol : h.nCols - 1;
  const captured = h.state === 'review' || h.state === 'saved' || (live && h.liveCol >= 0);
  if (!captured) {
    g.fillStyle = TK.dim; g.font = '600 13px ' + TK.sans; g.textAlign = 'center';
    const msg = { loaded: 'Heat loaded. Arm to receive the start.', armed: 'Armed. The capture streams here after the start.', running: 'Running. Capture opens as the field reaches the line.' }[h.state];
    g.fillText(msg, W / 2, Hi / 2 - 8);
    g.font = '12px ' + TK.sans;
    g.fillText('Wheel: scroll · Ctrl+wheel: zoom · Drag: pan · Shift+drag: crop · Click: select column · Arrows: nudge · Enter or double-click: mark', W / 2, Hi / 2 + 14);
    g.textAlign = 'left';
    drawRuler(g, W, Hc, h, false);
    return;
  }
  const vis = W / v.zx, sx = Math.max(0, v.c0), ex = Math.min(last + 1, v.c0 + vis);
  g.imageSmoothingEnabled = v.zx < 3;
  if (ex > sx) {
    g.save();
    if (S.flip) { g.translate(W, 0); g.scale(-1, 1); }
    drawStrip(g,h,sx,v.r0,ex-sx,Hi/v.zy,(sx-v.c0)*v.zx,0,(ex-sx)*v.zx,Hi);
    g.restore();
  }
  if (live) { g.fillStyle = TK.blue; g.fillRect(xOf(last) - 1, 0, 2, Hi); }

  // Decorative lane guides can be adjusted without changing the model's lane geometry.
  const o=overlayStyle('scan');
  if(o.enabled) {
    if(o.behindRunners)sampleForeground(h);
    g.save();g.globalAlpha=o.opacity;g.strokeStyle=o.lineColor;g.lineWidth=o.thickness;g.font=`${o.weight} ${o.fontSize}px ${TK.mono}`;
    guideRenderData(h,o,W,Hi,g).forEach(line=>{
      if(o.thickness>0)g.stroke(line.path);
      if(line.label){g.fillStyle=o.textColor;g.fillText(String(line.boundary.below),6,line.baseline);}
    });g.restore();
  }

  // proposals not yet resolved (dashed), then marks (solid)
  g.font='700 10px '+TK.mono;
  const tags = [];
  (h.proposals || []).forEach(p => {
    if (h.marks[p.lane] || h.status[p.lane] || h.dismissed?.[p.lane]) return;
    tags.push({ col: p.col, lane: p.lane, color: p.decision === 'auto' ? TK.blue : TK.amber, dashed: true });
  });
  Object.entries(h.marks).forEach(([lane, m]) => tags.push({ col: m.col, lane: +lane, color: h.status[lane] === 'DQ' ? TK.finish : TK.mint, dashed: false }));
  tags.sort((a, b) => a.col - b.col).forEach((t, i) => {
    const x = xOf(S.drag?.mode === 'mark' && S.drag.lane === t.lane && S.drag.moved ? S.selCol : t.col);
    if (x < -20 || x > W + 20) return;
    const sel = S.selLane === t.lane;
    g.strokeStyle = t.color; g.lineWidth = sel ? 2 : 1; g.setLineDash(t.dashed ? [5, 4] : []);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Hi); g.stroke(); g.setLineDash([]);
    const ty = 3 + (i % 2) * 15;
    g.fillStyle = t.color; g.fillRect(x - 8, ty, 16, 13);
    if (sel) { g.strokeStyle = TK.paper; g.lineWidth = 1; g.strokeRect(x - 8.5, ty - 0.5, 17, 14); }
    g.fillStyle = TK['on-accent']; g.textAlign = 'center'; g.fillText(String(t.lane), x, ty + 10); g.textAlign = 'left';
  });

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
  if (S.drag && S.drag.mode === 'crop' && S.drag.moved) {
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
function drawRuler(g, W, Hc, h, on) {
  const y0 = Hc - RULER;
  g.fillStyle = TK.deep; g.fillRect(0, y0, W, RULER);
  g.fillStyle = TK.rule2; g.fillRect(0, y0, W, 1);
  if (!on) return;
  const v = S.view, period=periodOf(h), pxPerS = v.zx / period;
  const steps = [0.00125, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  const step = steps.find(s => s * pxPerS >= 70) || 1;
  const dec = step < 0.01 ? 4 : step < 0.1 ? 2 : 1;
  const t0 = h.tOpen + v.c0 * period, t1 = h.tOpen + (v.c0 + W / v.zx) * period;
  g.font = '10px ' + TK.mono;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(unflipX(((t - h.tOpen) / period - v.c0) * v.zx));
    g.fillStyle = TK.dim; g.fillRect(x, y0 + 1, 1, 6);
    g.fillStyle = TK.muted; g.textAlign = S.flip ? 'right' : 'left';
    g.fillText((t-(h.startCorrection||0)).toFixed(dec), x + (S.flip ? -3 : 3), y0 + 16);
  }
  g.textAlign = 'left';
}

// The backup line-scan has its own zoom and pan in race time. Until the operator moves it, it shows the
// primary's time window; double-click links it back. Hover and click are shared with the primary by time.
function backupSource(h) {
  if (h.backupImg && h.backupImg.complete && h.backupImg.naturalWidth) {
    const bm = h.asset.backupMeta;
    return { img: h.backupImg, t: bm.first_column_race_time_s, p: bm.column_period_s, w: h.backupImg.naturalWidth, rows: h.backupImg.naturalHeight, own: true };
  }
  return { img: h.img, t: h.tOpen, p: periodOf(h), w: h.nCols, rows: rowsOf(h), own: false };
}
function backupRange(h) {
  if (S.bview.linked) return linkedCameraRange(S.view,{rows:rowsOf(h),height:scanH(),width:scanW(),period:periodOf(h),timeOrigin:h.tOpen,otherWidth:backupCv.clientWidth});
  return S.bview;
}
const backupCv = document.getElementById('backup');
const bX = (t, r, W) => { const x = (t - r.t0) / r.spp; return S.flip ? W - x : x; };
const bT = (x, r, W) => r.t0 + (S.flip ? W - x : x) * r.spp;
function drawBackup() {
  const cv = backupCv;
  if (!cv.isConnected || !cv.clientWidth) return;
  const [g, W, Hh] = fitCanvas(cv), h = viewHeat();
  g.fillStyle = TK.scanbg; g.fillRect(0, 0, W, Hh);
  const live = h.state === 'running', last = live ? h.liveCol : h.nCols - 1;
  if (!h.img || last < 0 || h.state === 'loaded' || h.state === 'armed') {
    g.fillStyle = TK.dim; g.font = '12px ' + TK.sans; g.textAlign = 'center';
    g.fillText('Backup capture follows the primary.', W / 2, Hh / 2); g.textAlign = 'left';
    return;
  }
  const src = backupSource(h), r = backupRange(h), liveT = colTime(h, last) + periodOf(h) / 2;
  const tEnd = Math.min(liveT, r.t0 + W * r.spp), sy = r.r0 * src.rows, sh = r.rv * src.rows;
  const x = t => (t - r.t0) / r.spp;
  g.save();
  if (S.flip) { g.translate(W, 0); g.scale(-1, 1); }
  if (!src.own) g.filter = 'grayscale(1) contrast(1.1)';
  g.imageSmoothingEnabled = src.p / r.spp < 3;
  // empty scene from the gun until this camera's first frame (sim renders cover the finish window only)
  if (src.own && src.t > r.t0) {
    const a = Math.max(r.t0, h.tOpen), b = Math.min(src.t, tEnd);
    if (b > a) g.drawImage(src.img, 0, sy, 1, sh, x(a), 0, x(b) - x(a), Hh);
  }
  const i0 = Math.max(0, Math.floor((r.t0 - src.t) / src.p)), i1 = Math.min(src.w, Math.ceil((tEnd - src.t) / src.p));
  if (i1 > i0) { if(src.own) g.drawImage(src.img, i0, sy, i1 - i0, sh, x(src.t + i0 * src.p), 0, (i1 - i0) * src.p / r.spp, Hh); else drawStrip(g,h,i0,sy,i1-i0,sh,x(src.t+i0*src.p),0,(i1-i0)*src.p/r.spp,Hh); }
  g.restore();
  // marks, then the shared hover and selected hairlines
  Object.values(h.marks).forEach(m => { g.fillStyle = TK.mint; g.fillRect(Math.round(bX(colTime(h, m.col), r, W)), 0, 1, Hh); });
  if (S.hoverCol != null) { g.fillStyle = 'rgba(247,248,250,0.5)'; g.fillRect(Math.round(bX(colTime(h, S.hoverCol), r, W)), 0, 1, Hh); }
  if (S.selCol != null) { g.fillStyle = TK.finish; g.fillRect(Math.round(bX(colTime(h, S.selCol), r, W)), 0, 1, Hh); }
  const d = S.bdrag;
  if (d && d.mode === 'crop' && d.moved) {
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
let vidEl = null, vidTag = null, frontCache=null, frontCacheKey=null, lastFrontFrame=null, wantedVideoTime=null;
function seekFrontVideo(v,target) {
  wantedVideoTime=target;
  if(!v.seeking&&v.readyState>=1&&Math.abs(v.currentTime-target)>0.002)v.currentTime=target;
}
function frontVideo() {
  if (!vidEl) {
    const pb = $('#front').parentNode;
    vidEl = h_('video', 'frontvid'); vidEl.muted = true; vidEl.playsInline = true; vidEl.preload = 'auto';
    vidEl.onloadedmetadata = invalidate;
    vidEl.onseeked=()=>{if(wantedVideoTime!=null&&Math.abs(vidEl.currentTime-wantedVideoTime)>0.002)seekFrontVideo(vidEl,wantedVideoTime);invalidate();};
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
  const cacheKey=rec.frames?.[0]||url;
  if(frontCacheKey!==cacheKey){frontCache?.dispose();frontCache=null;lastFrontFrame=null;frontCacheKey=cacheKey;if(rec.frames?.length)frontCache=new FrontFrameCache({load:async index=>{const im=new Image();im.src=OM.fileUrl(rec.frames[index]);await im.decode();return createImageBitmap(im);},onReady:invalidate});}
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
  if (syncFront(h,g,W,Hf)) return;
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
  const ft = frontTime(h), t = ft == null ? 0 : ft;
  const banner = txt => { g.fillStyle = 'rgba(8,16,34,0.55)'; g.fillRect(0, 0, W, 22); g.fillStyle = '#d8dee9'; g.font = '11px ' + TK.sans; g.fillText(txt, 8, 15); };
  if ((h.state === 'review' || h.state === 'saved') && ft == null) { banner('Hover the line-scan to see this camera at that moment'); return; }
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
    v.zx = Math.max(S.cameraSetup?scanW()/Math.min(h.nCols,STRIP_TILE*8):scanW() / h.nCols * 0.5, Math.min(16, v.zx * Math.exp(-e.deltaY * 0.0018)));
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
  const h=viewHeat(), lane=S.selLane;
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
  scanCv.style.cursor = hitScanBoundary(h,e.clientX-r.left,e.clientY-r.top) ? 'ns-resize' : !S.cropTool && hitFinish(h, e.clientX-r.left) ? 'ew-resize' : '';
  if (col !== S.hoverCol) { S.hoverCol = col; invalidate(); updateTs(); }
});
scanCv.addEventListener('mouseleave', () => { if (S.hoverCol != null) { S.hoverCol = null; invalidate(); updateTs(); } });
scanCv.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  S.entryNumber = ''; updateEntryNumber();
  const r = scanCv.getBoundingClientRect();
  const h = viewHeat(),boundary=!e.shiftKey&&hitScanBoundary(h,e.clientX-r.left,e.clientY-r.top);
  if(boundary) {
    const offset=(e.clientY-r.top)/S.view.zy+S.view.r0-boundary.row;
    S.drag={mode:'lane-boundary',key:boundary.key,offset,moved:false,x0:e.clientX-r.left,y0:e.clientY-r.top,x1:e.clientX-r.left,y1:e.clientY-r.top};return;
  }
  const hit = !S.cropTool && !e.shiftKey && ['running','review','saved'].includes(h.state) ? hitFinish(h,e.clientX-r.left) : null;
  if(hit) { S.selLane=hit.lane; S.selCol=hit.col; }
  S.drag = { lane:hit?.lane, mode: hit ? 'mark' : S.cropTool || e.shiftKey ? 'crop' : 'pan', x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, c0: S.view.c0, r0: S.view.r0, moved: false };
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
  if (d.moved && d.mode === 'crop') {
    S.bview.linked=true;
    const w = Math.abs(d.x1 - d.x0), hh = Math.abs(d.y1 - d.y0);
    if (w < 8 || hh < 8) return;
    const ca = v.c0 + unflipX(d.x0) / v.zx, cb = v.c0 + unflipX(d.x1) / v.zx;
    const r0 = v.r0 + Math.min(d.y0, d.y1) / v.zy;
    v.zx = scanW() / Math.abs(cb - ca); v.zy = scanH() / (hh / v.zy); v.c0 = Math.min(ca, cb); v.r0 = r0;
    v.zoomed = true; v.user = true; S.cropTool = false;
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
  if (document.querySelector('.race-reset-dialog[open]')) return;
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
    S.selCol = Math.max(0, Math.min(h.nCols - 1, S.selCol + dir * (e.shiftKey ? 10 : 1)));
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
    if (S.cropTool) { S.cropTool = false; syncCursor(); }
    else if (S.view.zoomed) fitView();
    else { S.selLane = null; S.selCol = null; }
    renderUI();
  }
});
$('#drawerClose').onclick = () => { S.tab = 'run'; renderUI(); };
window.addEventListener('resize', () => { renderTiles(); if (!S.view.zoomed && viewHeat().state !== 'running') fitView(); invalidate(); });

// ---------------------------------------------------------------- backup line-scan input (its own view, shared time)
const colAtTime = (h, t) => Math.max(0, Math.min(h.nCols - 1, Math.round((t - h.tOpen) / periodOf(h) - 0.5)));
const backupReady = h => h.img && (h.state === 'review' || h.state === 'saved' || (h.state === 'running' && h.liveCol >= 0));
function unlinkBackup(h) {
  if (S.bview.linked) Object.assign(S.bview, backupRange(h), { linked: false });
}
backupCv.addEventListener('wheel', e => {
  const h = viewHeat();
  if (!backupReady(h)) return;
  e.preventDefault(); unlinkBackup(h);
  const b = S.bview, rect = backupCv.getBoundingClientRect(), W = rect.width, mx = e.clientX - rect.left;
  if (e.ctrlKey || e.metaKey) {
    const tAt = bT(mx, b, W);
    b.spp = Math.max(periodOf(h) / 16, Math.min((h.tClose - h.tOpen) / W, b.spp * Math.exp(e.deltaY * 0.0018)));
    b.t0 = tAt - (S.flip ? W - mx : mx) * b.spp;
  } else b.t0 += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * b.spp * (S.flip ? -1 : 1);
  invalidate();
}, { passive: false });
backupCv.addEventListener('mousedown', e => {
  if (e.button !== 0 || !backupReady(viewHeat())) return;
  S.entryNumber = ''; updateEntryNumber();
  const r = backupCv.getBoundingClientRect();
  S.bdrag = { mode: e.shiftKey ? 'crop' : 'pan', x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, moved: false, start: { ...backupRange(viewHeat()) } };
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
  if (d.moved && d.mode === 'crop') {
    const w = Math.abs(d.x1 - d.x0), hh = Math.abs(d.y1 - d.y0);
    if (w > 8 && hh > 8) {
      const st = d.start, ta = bT(d.x0, st, r.width), tb = bT(d.x1, st, r.width);
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
backupCv.title = 'Wheel: scroll · Ctrl+wheel: zoom · Drag: pan · Shift+drag: crop · Click: select · Double-click: link to the primary';

// ---------------------------------------------------------------- front camera zoom and pan (for context; the recording itself is untouched)
const frontPb = document.getElementById('front').parentNode;
const frontLaneLayer=h_('div','front-lane-overlay');frontLaneLayer.id='frontLaneOverlay';frontPb.append(frontLaneLayer);
const frontLaneButton=h_('button','btn sm','Lanes ▾');
frontLaneButton.onpointerdown=e=>e.stopPropagation();frontLaneButton.onmousedown=e=>e.stopPropagation();
frontLaneButton.onclick=e=>{e.stopPropagation();showOverlaySettings('front',frontLaneButton);};
const frontHeader=frontPb.parentNode.querySelector('.ph');frontLaneButton.style.marginLeft='auto';frontHeader.append(frontLaneButton);

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
  const h = cur();
  if(S.cameraSetup){
    const p=S.cameraSetup,preview=p.heat;
    if(p.live){
      preview.tNow=preview.tOpen+(now-preview.startPerf)/1000*SPEED;
      if(!p.id&&p.sample){
        const target=Math.floor((preview.tNow-preview.tOpen)/periodOf(preview)),count=target-(preview.recvCols||0);
        if(count>0){const src=p.sample.getContext('2d').getImageData(0,0,1,rowsOf(preview)).data,data=new Uint8Array(count*rowsOf(preview)*3);for(let x=0;x<count;x++)for(let y=0;y<rowsOf(preview);y++){const d=(x*rowsOf(preview)+y)*3;data[d]=src[y*4];data[d+1]=src[y*4+1];data[d+2]=src[y*4+2];}ingestColumns(preview,preview.recvCols||0,count,data,3);}
      }
      preview.liveCol=(preview.recvCols||0)-1;if(!S.view.user&&preview.liveCol>=0)follow(preview);
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
    }
    const lc=(h.recvCols||0)-1;
    if (lc !== h.liveCol) { h.liveCol = lc; if (!S.view.user && lc >= 0) follow(h); }
    if (now - lastLiveRender > 250) { lastLiveRender = now; liveSuggest(h); renderAcc(); const sideStamp=JSON.stringify([h.marks,h.status,h.proposals,S.selLane]);if(sideStamp!==lastSideStamp){lastSideStamp=sideStamp;renderSide();} renderProps(); renderTools(); renderSchedule(); publishBoard(); }
    if(h.stopMode==='timeout'&&h.tNow>=h.stopAfter)stopCapture();
    if(h.stopMode==='complete'&&h.athletes.length&&h.athletes.every(a=>resolved(h,a)))stopCapture();

    tickClock();
  } else if (h.req === 'pending' && now - lastLiveRender > 1000) { lastLiveRender = now; renderProps(); }   // "Timing… N s"
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== lastSec) { lastSec = sec; tickTod(); }
  if (dirty || h.state === 'running' || S.cameraSetup?.live) { dirty = false; drawScan(); drawBackup(); drawFront(); }
  requestAnimationFrame(frame);
}

document.documentElement.dataset.theme = store.get('theme', 'dark');
wordmark(); readTokens(); initTiles(); syncCursor();
const h0 = cur();
ensureStrip(h0);
if (S.autoArm) h0.state = 'armed';
fitView(); renderUI();
requestAnimationFrame(frame);
if (OM) {
  OM.on('preview.hello',d=>{const p=S.cameraSetup;if(p&&(p.starting||p.id===d.id)){p.id=d.id;p.heat.rows=d.rows;}});
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
  OM.on('capture.hello', d => { const h = capHeat(d.id); if (h) { h.captureId = d.id; S.pendingCapture = null; } });
  OM.on('capture.pulse', d => { const h = capHeat(d.id); if (h && h.state === 'running') h.startPerf = performance.now(); });
  OM.on('capture.columns', d => {
    const h = capHeat(d.id);
    if (!h || h.state !== 'running' || !h.img) return;
    ingestColumns(h, d.first, d.count, d.data, d.data.length / (d.count * rowsOf(h)));
    invalidate();
  });
  OM.on('capture.end', d => { const h = capHeat(d.id); if (h && h.state === 'running') { endCapture(h); renderUI(); } });
  OM.on('capture.error', d => { toast('Camera error: ' + d.message, true); });
  OM.call('autotiming.info').then(i => { S.atInfo = i; }).catch(() => {});
  OM.call('settings.get').then(s => { if (s.demoDir) openDemo(s.demoDir); else if (s.meetDir) openMeet(s.meetDir); }).catch(() => {});
}
})();
