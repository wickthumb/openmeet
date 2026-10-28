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
    ? s.entries.map(x => ({ lane: x.lane, id: x.id, first: x.first, last: x.last, team: teamFor(x.affiliation), skin: pick(SKIN), truth: null, pre: x.status || null }))
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
  const tOpen = Math.min(...fin) - 0.55, tClose = Math.max(...fin) + 0.8;
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

const S = {
  idx: 0, tab: 'run', selLane: null, selCol: null, source: 'replay', apiOnline: true,
  autoArm: store.get('autoArm', true), autoMark: store.get('autoMark', true),
  flip: store.get('flip', false), lanes: store.get('lanes', false), cropTool: false,
  files: [], view: { c0: 0, zx: 1, r0: 0, zy: 1, user: false, zoomed: false }, drag: null,
  layout: null, max: null, rects: {},
  meet: null,   // {dir, files} when a real meet folder is open (Electron); null = built-in sample meet
};
const OM = window.openmeet || null;   // the Electron bridge; absent when this page runs as the static replica
const windStr = h => (h.wind == null ? '—' : (h.wind >= 0 ? '+' : '') + h.wind.toFixed(1) + ' m/s');
const cur = () => HEATS[S.idx];

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
const colTime = (h, col) => h.tOpen + (col + 0.5) * P;
function lifText(h) {
  const tod = h.startTOD ? todStr(h.startTOD) : '';
  const wind = h.wind == null ? '' : (h.wind >= 0 ? '+' : '') + h.wind.toFixed(1);
  const lines = [[h.ev, h.rd, h.ht, q(h.name), wind, h.wind == null ? '' : 'm/s', '', '', '', '', tod].join(',')];
  const { fin, pl } = places(h);
  let prevT = null;
  fin.forEach(a => {
    const t = ceilTo(colTime(h, h.marks[a.lane].col), 3);
    const delta = prevT == null ? t : t - prevT;
    prevT = t;
    lines.push([pl[a.lane], a.id, a.lane, q(a.last), q(a.first), q(a.team.name), fmtT(t), '', fmtT(delta), '', '', tod, '', '', ''].join(','));
  });
  h.athletes.filter(a => h.status[a.lane]).forEach(a => {
    const st = h.status[a.lane];
    const t = st === 'DQ' && h.marks[a.lane] ? fmtT(colTime(h, h.marks[a.lane].col)) : '';
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
  [...h.athletes].sort((a, b) => a.lane - b.lane).forEach(a => { if (a.truth != null) drawRunner(g, h, a); });
  h.img = c; h.imgSrc = S.source;
}
function ensureStrip(h) {
  if (h.asset) { if (!h.img) blankStrip(h); return; }
  if (!h.img || (h.imgSrc !== S.source && (h.state === 'loaded' || h.state === 'armed'))) renderStrip(h);
}
// A heat whose camera is the engine's: the strip starts black and fills as the engine's columns arrive.
function blankStrip(h) {
  const c = document.createElement('canvas');
  c.width = h.nCols; c.height = rowsOf(h);
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
  h.img = c; h.imgSrc = 'engine'; h.recvCols = 0;
}
// Column-major camera bytes (count x rows x channels) into the strip at column `first`.
function ingestColumns(h, first, count, data, channels) {
  const rows = rowsOf(h), g = h.img.getContext('2d'), im = g.createImageData(count, rows), px = im.data;
  for (let c = 0; c < count; c++) {
    for (let r = 0; r < rows; r++) {
      const s = (c * rows + r) * channels, d = (r * count + c) * 4;
      px[d] = data[s]; px[d + 1] = data[s + (channels > 1 ? 1 : 0)]; px[d + 2] = data[s + (channels > 1 ? 2 : 0)]; px[d + 3] = 255;
    }
  }
  g.putImageData(im, first, 0);
  h.recvCols = Math.max(h.recvCols || 0, first + count);
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
function applyProposals(h, props, meta = {}) {
  const untouched = h.base === snap(h);
  h.proposals = props; h.model = meta.model || 'sim-0'; h.stub = !!meta.stub;
  h.req = 'done'; h.reqMs = Math.round(performance.now() - h.reqStart);
  h.proposals.forEach(p => { if (p.decision === 'auto' && !h.marks[p.lane] && !h.status[p.lane]) h.marks[p.lane] = { col: p.col, src: 'auto' }; });
  if (untouched && !h.saves) h.base = snap(h);                 // machine output on a fresh capture is part of "as captured"
  renderUI();
}
function requestProposals(h) {
  if (!S.apiOnline) { h.req = 'offline'; renderUI(); return; }
  h.req = 'pending'; h.reqStart = performance.now(); renderUI();
  if (h.asset && OM && h.captureId) {
    // Engine-fed heat: the engine reads the strip from the capture store and calls the finish service.
    OM.call('autotiming.predict', {
      captureId: h.captureId,
      heat: { event: h.ev, round: h.rd, heat: h.ht },
      startList: h.athletes.filter(a => !['DNS', 'SC'].includes(h.status[a.lane])).map(a => ({ lane: a.lane, id: String(a.id) })),
      laneRows: h.laneRows ? h.laneRows.map(b => ({ lane: b.lane, top_row: Math.round(b.top), bottom_row: Math.round(b.bottom) })) : null,
    }).then(res => applyProposals(h, res.predictions.map(p => ({ lane: p.lane, col: p.column, decision: p.decision, reason: p.reason || '', conf: p.confidence ?? 0 })).sort((a, b) => a.col - b.col), res))
      .catch(err => { h.req = 'error'; h.reqErr = err.message; renderUI(); });
    return;
  }
  setTimeout(() => {
    if (!S.apiOnline) { h.req = 'offline'; renderUI(); return; }
    applyProposals(h, makeProposals(h), { model: 'sim-0', stub: true });
  }, Math.max(250, 900 / SPEED));
}

// ---------------------------------------------------------------- heat flow: Loaded -> Armed -> Running -> Review -> Saved
function go(i) {
  if (cur().state === 'running' || i < 0 || i >= HEATS.length) return;
  S.idx = i; S.selLane = null; S.selCol = null;
  const h = cur();
  ensureStrip(h);
  if (S.autoArm && h.state === 'loaded') h.state = 'armed';
  fitView();
  renderUI();
}
function arm() { const h = cur(); if (h.state !== 'loaded') return; ensureStrip(h); h.state = 'armed'; renderUI(); }
function disarm() { const h = cur(); if (h.state === 'armed') { h.state = 'loaded'; renderUI(); } }
function fire() {
  const h = cur();
  if (h.state !== 'armed') return;
  h.state = 'running'; h.startPerf = performance.now(); h.startTOD = new Date(); h.liveCol = -1; h.tNow = 0;
  S.view.user = false; S.selCol = null;
  if (h.asset && OM) {
    blankStrip(h); h.captureId = null; S.pendingCapture = h;
    OM.call('capture.start', {
      key: `${h.ev}-${h.rd}-${h.ht}`, png: h.asset.primary, sidecar: h.asset.primaryMeta, speed: SPEED, meetDir: S.meet && S.meet.dir,
      front: h.asset.front ? { path: h.asset.front, meta: h.asset.frontMeta } : null,
    })
      .then(r => { h.captureId = r.id; h.captureDir = r.dir; if (r.front) h.frontRec = r.front; })
      .catch(err => { S.pendingCapture = null; h.state = 'armed'; toast('The camera did not start: ' + err.message, true); renderUI(); });
  }
  renderUI();
}
function recall() {
  const h = cur();
  if (h.state !== 'running') return;
  h.state = 'armed'; h.liveCol = -1; h.startTOD = null; h.tNow = 0;
  if (h.asset && OM) { OM.call('capture.stop').catch(() => {}); h.captureId = null; S.pendingCapture = null; blankStrip(h); }
  toast('Recall: false start. Heat re-armed. Set FS on the athlete from their row.');
  renderUI();
}
function endCapture(h) {
  h.state = 'review'; h.liveCol = h.nCols - 1; h.tNow = h.tClose;
  h.base = snap(h);
  fitView();
  if (S.autoMark) requestProposals(h); else h.req = 'idle';
}
function editHeat(h) { if (h.state === 'saved') h.state = 'review'; }
function setMark(lane, col) {
  const h = cur();
  if (!['review', 'saved'].includes(h.state) || col == null) return;
  const p = h.proposals && h.proposals.find(x => x.lane === lane);
  const src = p ? (p.col === col ? (p.decision === 'auto' ? 'auto' : 'checked') : 'edited') : 'manual';
  h.marks[lane] = { col, src };
  if (h.status[lane] && h.status[lane] !== 'DQ') delete h.status[lane];
  editHeat(h); renderUI();
}
function setStatus(lane, code) {
  const h = cur();
  if (h.state === 'running') return;
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
    dir: S.meet.dir,
    heat: { event: h.ev, round: h.rd, heat: h.ht, name: h.name, wind: h.wind == null ? '' : (h.wind >= 0 ? '+' : '') + h.wind.toFixed(1), windUnit: h.wind == null ? '' : 'm/s', startTimeOfDay: tod },
    results: h.athletes.map(a => {
      const st = h.status[a.lane], mk = h.marks[a.lane];
      return { id: a.id, lane: a.lane, last: a.last, first: a.first, affiliation: a.team.name, startTimeOfDay: tod, ...(st ? { status: st } : {}), ...(mk && (!st || st === 'DQ') ? { time: colTime(h, mk.col) } : {}) };
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
  if (h.state === 'running') return [{ k: 'info', t: 'Capturing. Marks open when the capture closes.' }];
  if (h.state === 'loaded') return [{ k: 'info', t: 'Heat loaded from lynx.evt. Arm when the starter is ready.' }];
  if (h.state === 'armed') return [{ k: 'info', t: 'Armed. Waiting for the start signal.' }];
  if (h.req === 'offline') w.push({ k: 'warn', t: 'Auto-timing is offline. Mark finishes by hand; capture is unaffected.' });
  if (h.req === 'error') w.push({ k: 'warn', t: `Auto-timing failed (${h.reqErr}). Mark finishes by hand, or press Auto-mark to retry.` });
  if (h.req === 'pending') w.push({ k: 'info', t: 'Auto-timing is reading the capture.' });
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
const TABS = [['run', 'Run'], ['network', 'Network'], ['meet', 'Meet Link'], ['api', 'Auto-Timing'], ['settings', 'Settings']];
function renderTabs() {
  const n = $('#tabs'); n.innerHTML = '';
  TABS.forEach(([k, label]) => {
    const b = h_('button', 'tab' + (S.tab === k ? ' on' : ''), label);
    b.onclick = () => { S.tab = k; renderUI(); };
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
  const h = cur();
  const stLabel = { loaded: 'LOADED', armed: 'ARMED', running: 'RUNNING', review: 'REVIEW', saved: 'SAVED' }[h.state];
  $('#ev').innerHTML = `
    <div class="ev-top"><span class="kicker">Event ${h.ev} · Round ${h.rd} · Heat ${h.ht} of ${h.of}</span><span class="state ${h.state}">${stLabel}</span></div>
    <div class="ev-name">${h.name}</div>
    <div class="ev-sub">${S.idx + 1} of ${HEATS.length} in schedule · ${h.athletes.length} athletes</div>`;
  const ctl = $('#ctl'); ctl.innerHTML = '';
  const running = h.state === 'running';
  const btn = (html, cls, on, dis) => { const b = h_('button', 'btn ' + cls); b.innerHTML = html; b.onclick = on; b.disabled = !!dis; ctl.append(b); return b; };
  btn(ICON.prev + 'Previous heat', '', () => go(S.idx - 1), running || S.idx === 0);
  btn('Next heat' + ICON.next, '', () => go(S.idx + 1), running || S.idx === HEATS.length - 1);
  if (h.state === 'loaded') btn('Arm', 'primary', arm);
  else if (h.state === 'armed') btn('Disarm', '', disarm);
  else if (running) btn('Recall (false start)', 'warn', recall);
  else btn('Arm', '', null, true);
  const st = btn('Start <span class="tag sim">SIM</span>', h.state === 'armed' ? 'go' : '', fire, h.state !== 'armed');
  st.title = 'Stands in for the start system on the camera network';
  const swr = h_('div', 'swrow');
  const sw = h_('button', 'sw' + (S.autoArm ? ' on' : ''));
  sw.innerHTML = '<i></i>Auto-arm next heat';
  sw.title = 'Arm each heat as soon as it loads';
  sw.onclick = () => { S.autoArm = !S.autoArm; store.set('autoArm', S.autoArm); if (S.autoArm && h.state === 'loaded') h.state = 'armed'; renderUI(); };
  swr.append(sw); ctl.append(swr);
  const ready = h.state === 'review' && h.athletes.every(a => resolved(h, a));
  const sv = btn(h.saves && h.state === 'review' ? 'Save again (rewrites LIF)' : h.state === 'saved' ? 'Saved' : 'Save results', 'go wide', save, !ready);
  if (!ready) sv.classList.remove('go');

  const w = warnings(h), top = w[0];
  $('#warn').innerHTML = top ? `<div class="warnbox ${top.k === 'ok' ? 'ok' : top.k === 'info' ? 'info' : ''}">${ICON[top.k === 'ok' ? 'ok' : top.k === 'info' ? 'info' : 'warn']}<span>${top.t}</span>${w.length > 1 ? `<span class="more">+${w.length - 1} more</span>` : ''}</div>` : '';

  const { pl } = places(h);
  const list = $('#list'); list.innerHTML = '';
  [...h.athletes].sort((a, b) => a.lane - b.lane).forEach(a => {
    const row = h_('div', 'row' + (S.selLane === a.lane ? ' sel' : ''));
    const mk = h.marks[a.lane], st = h.status[a.lane], p = h.proposals && h.proposals.find(x => x.lane === a.lane);
    let res;
    if (st) {
      res = `<span class="tag ${st === 'DQ' ? 'bad' : 'review'}">${st}</span>${st === 'DQ' && mk ? `<span class="sub num">${official(colTime(h, mk.col))}</span>` : ''}`;
    } else if (mk) {
      const src = { auto: ['AUTO', 'auto'], checked: ['CHECKED', 'info'], edited: ['EDITED', 'info'], manual: ['MANUAL', 'info'] }[mk.src];
      res = `<span class="t">${official(colTime(h, mk.col))}</span><span class="sub"><span class="num">P${pl[a.lane]} · ${fmtT(colTime(h, mk.col))}</span><span class="tag ${src[1]}">${src[0]}</span></span>`;
    } else if (p) {
      res = `<span class="t prop">${official(colTime(h, p.col))}</span><span class="sub"><span class="tag review">REVIEW</span></span>`;
    } else {
      res = `<span class="t prop">${running ? 'racing' : '—'}</span><span class="sub">${h.state === 'review' || h.state === 'saved' ? 'no time' : 'pending'}</span>`;
    }
    row.innerHTML = `
      <div class="lane">${a.lane}</div>
      <div class="who"><div class="nm">${a.last}, ${a.first}</div><div class="sc"><span class="num">#${a.id}</span> · ${a.team.name}</div></div>
      <div class="res">${res}</div>`;
    row.onclick = e => { if (e.target.closest('button')) return; selectLane(S.selLane === a.lane ? null : a.lane); };
    if (S.selLane === a.lane && !running) {
      const rc = h_('div', 'rowctl');
      ['DNS', 'DNF', 'DQ', 'FS'].forEach(code => {
        const b = h_('button', 'btn sm' + (st === code ? ' primary' : ''), code);
        b.onclick = () => setStatus(a.lane, code);
        rc.append(b);
      });
      if (mk && ['review', 'saved'].includes(h.state)) {
        const c = h_('button', 'btn sm', 'Clear mark');
        c.onclick = () => { delete h.marks[a.lane]; editHeat(h); renderUI(); };
        rc.append(c);
      }
      if (['review', 'saved'].includes(h.state)) rc.append(h_('span', 'hint', 'Enter marks at the selected column'));
      row.append(rc);
    }
    list.append(row);
  });
}
function selectLane(lane) {
  S.selLane = lane;
  const h = cur();
  if (lane != null) {
    const mk = h.marks[lane], p = h.proposals && h.proposals.find(x => x.lane === lane);
    const col = mk ? mk.col : p ? p.col : null;
    if (col != null) { S.selCol = col; centerOn(col); }
  }
  renderUI();
}

// ---------------------------------------------------------------- workspace panels
function renderRace() {
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
  tickClock();
}
function tickClock() {
  const h = cur(), c = $('#clock'), sub = $('#clocksub');
  if (!c) return;
  const done = ['review', 'saved'].includes(h.state), win = done ? places(h).fin[0] : null;
  if (h.state === 'running') c.textContent = (Math.floor(h.tNow * 10) / 10).toFixed(1);
  else if (win) c.textContent = official(colTime(h, h.marks[win.lane].col));
  else c.textContent = done ? '--.--' : '0.0';
  c.style.color = h.state === 'running' || win ? 'var(--paper)' : 'var(--dim)';
  if (sub) sub.textContent = win ? `Winner: lane ${win.lane}, ${win.first} ${win.last}` : h.state === 'running' ? 'Running time' : h.state === 'armed' ? 'Waiting for the start' : done ? 'No finishes marked yet' : 'Not armed';
}
function renderAcc() {
  const h = cur();
  const start = { loaded: 'idle', armed: 'armed', running: 'fired', review: 'fired', saved: 'fired' }[h.state];
  const cap = h.state === 'running' ? (h.liveCol >= 0 ? 'capturing' : 'waiting') : 'idle';
  const rows = [
    ['ok', 'Primary line-scan', '.21', `${S.source === 'replay' ? 'sim-replay' : 'sim-render'} · ${cap}`],
    ['ok', 'Backup line-scan', '.22', `sim · ${cap}`],
    ['ok', 'Front camera', '.30', 'sim · streaming'],
    ['ok', 'Start system', '.40', `sim · ${start}`],
    h.wind == null ? ['', 'Wind gauge', '', 'not connected'] : ['ok', 'Wind gauge', '.41', ['review', 'saved'].includes(h.state) ? `sim · ${windStr(h)}` : 'sim · ready'],
    ['', 'Scoreboard', '', 'not configured'],
  ];
  $('#acc').innerHTML = `<div class="acc">${rows.map(([d, n, ip, s]) => `<span class="dot ${d}"></span><span class="nm" title="${ip ? '192.168.0' + ip : ''}">${n}</span><span class="st">${s}</span>`).join('')}</div>`;
}
function renderProps() {
  const h = cur();
  $('#apiState').innerHTML = !S.apiOnline ? '<span class="dot warn"></span>offline' :
    h.req === 'pending' ? '<span class="dot warn"></span>reading' :
    h.req === 'error' ? '<span class="dot warn"></span>failed' :
    h.req === 'done' ? `${h.stub ? '<span class="tag sim" title="A contract stand-in that echoes simulator truth. It is not a model.">STAND-IN</span>' : ''}<span class="dot ok"></span>${h.reqMs} ms` : '<span class="dot ok"></span>';
  const box = $('#props');
  if (h.req === 'offline' || h.req === 'error') {
    box.innerHTML = `<div class="empty">${h.req === 'error' ? 'Auto-timing failed: ' + esc(h.reqErr || '') + '.' : 'The auto-timing service could not be reached.'} Every lane can still be marked by hand.</div>`;
    return;
  }
  if (!h.proposals) {
    box.innerHTML = `<div class="empty">${h.req === 'pending' ? 'Reading the capture…' : S.autoMark ? 'Proposals arrive when the capture closes. AUTO is accepted on arrival; REVIEW waits for you. Finishes within 0.02 s of a neighbour are always REVIEW.' : 'Auto-mark is off. Press Auto-mark on the line-scan bar to request proposals.'}</div>`;
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
    tr.innerHTML = `<td class="num"><b>L${p.lane}</b></td><td>${a.last}</td><td class="num">${fmtT(colTime(h, p.col))}</td><td class="num"><b>${official(colTime(h, p.col))}</b></td>
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
const PANELS = { race: 'Race', front: 'Front camera', backup: 'Backup line-scan', acc: 'Accessories', props: 'Auto-timing' };
const DEFAULT_LAYOUT = { d: 'col', r: 0.56, a: { d: 'row', r: 0.28, a: 'race', b: { d: 'row', r: 0.48, a: 'front', b: 'backup' } }, b: { d: 'row', r: 0.3, a: 'acc', b: 'props' } };
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
function saveLayout() { store.set('layout', S.layout); }
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
  const saved = store.get('layout', null);
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
function renderDrawer() {
  const d = $('#drawer');
  d.classList.toggle('open', S.tab !== 'run');
  if (S.tab === 'run') return;
  $('#drawerTitle').textContent = TABS.find(t => t[0] === S.tab)[1];
  const body = $('#drawerBody');
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
        <p>${HEATS.length} laned heats, ${entries} entries. Results are written to this same folder.</p>
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
      $('#openDemo').onclick = async () => { const dir = await OM.pickFolder('Open demo meet (rendered heats)'); if (dir) openDemo(dir); };
    }
  } else if (S.tab === 'api') {
    body.innerHTML = `
      <div class="card"><h3>Auto-timing service</h3>
        <table class="tbl">
          <tr><td>Service</td><td>TTP finish model (simulated in this replica)</td></tr>
          <tr><td>Model</td><td class="num">sim-0</td></tr>
          <tr><td>Contract</td><td class="num">POST /v1/finish-predictions</td></tr>
          <tr><td>State</td><td><span class="dot ${S.apiOnline ? 'ok' : 'warn'}"></span> ${S.apiOnline ? 'reachable' : 'offline'}</td></tr>
        </table>
        <p><label class="chk"><input type="checkbox" id="apiOff" ${S.apiOnline ? '' : 'checked'}> Simulate the service being unreachable <span class="tag sim">REPLICA ONLY</span></label></p>
      </div>
      <div class="card"><h3>Policy</h3>
        <p>AUTO proposals are accepted on arrival and tagged AUTO. REVIEW proposals wait for the operator.</p>
        <p>Finishes within 0.02 s of a neighbour are always REVIEW.</p>
        <p>The operator can override anything; the original proposal stays in the heat's log.</p>
        <p>Goal: 99.5% of delivered results correct, while auto-accepting as many as possible.</p>
        <p>Capture never waits on the service. If it is unreachable, heats are timed by hand.</p>
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

// ---------------------------------------------------------------- line-scan toolbar
function renderTools() {
  invalidate();
  const h = cur(), box = $('#tools'); box.innerHTML = '';
  const captured = h.state === 'review' || h.state === 'saved' || (h.state === 'running' && h.liveCol >= 0);
  const review = h.state === 'review' || h.state === 'saved';
  const tool = (icon, label, title, on, dis, act) => {
    const b = h_('button', 'tool' + (on ? ' on' : ''));
    b.innerHTML = icon + label; b.title = title; b.disabled = !!dis; b.onclick = act;
    box.append(b); return b;
  };
  const sep = () => box.append(h_('span', 'tsep'));
  tool(ICON.crop, 'Crop', 'Drag a box to zoom to it (Shift+drag works any time)', S.cropTool, !captured, () => { S.cropTool = !S.cropTool; renderTools(); syncCursor(); });
  tool(ICON.fit, 'Unzoom', 'Fit the whole capture (Esc)', false, !captured || !S.view.zoomed, () => { fitView(); renderUI(); });
  tool(ICON.flip, 'Flip', 'Mirror the image: winner on the left or on the right', S.flip, false, () => { S.flip = !S.flip; store.set('flip', S.flip); renderTools(); });
  tool(ICON.lanes, 'Lanes', 'Overlay lane lines on the image', S.lanes, false, () => { S.lanes = !S.lanes; store.set('lanes', S.lanes); renderTools(); });
  sep();
  tool(ICON.auto, 'Auto-mark', 'Ask the auto-timing service for proposals now', false, !review || !S.apiOnline || h.req === 'pending', () => requestProposals(h));
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
  renderTabs(); renderStatus(); renderSide(); renderRace(); renderAcc(); renderProps(); renderDrawer(); renderTools();
  const ts = $('#ts'), h = cur();
  if (S.selCol != null && h.img) { ts.textContent = fmtT(colTime(h, S.selCol)) + ' s'; ts.classList.remove('none'); }
  else { ts.textContent = '--.---'; ts.classList.add('none'); }
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
  try {
    const r = await OM.call('meet.open', { dir });
    if (!r.parsed || !r.parsed.events.some(e => e.entries.some(x => x.lane))) { toast(`No laned heats found in ${dir} (lynx.evt missing or empty).`, true); return; }
    S.meet = { dir, files: r.files };
    applyMeet(r.parsed, true);
    OM.call('settings.set', { patch: { meetDir: dir } }).catch(() => {});
    toast(`Opened ${dir}: ${HEATS.length} heats.`);
  } catch (err) { toast('Could not open the meet folder: ' + err.message, true); }
}
// A rendered demo meet (TTP simulator): meet/lynx.* plus, per heat, the primary line-scan, backup line-scan and front-camera recording.
function attachAsset(h, a) {
  if (!a || !a.primary || !a.primaryMeta || !a.primarySize) return h;
  const m = a.primaryMeta;
  h.asset = a; h.rows = m.rows || a.primarySize.height; h.nCols = a.primarySize.width;
  h.tOpen = m.first_column_race_time_s; h.tClose = h.tOpen + h.nCols * P;
  h.laneRows = Array.isArray(m.lane_rows) && m.lane_rows.length ? m.lane_rows.map(x => ({ lane: x.lane, top: x.top_row, bottom: x.bottom_row })) : null;
  h.athletes.forEach(at => { at.truth = null; });            // truth stays in the engine
  h.wind = null; h.img = null; h.frontRec = null;
  if (a.backup && a.backupMeta) { const im = new Image(); im.onload = invalidate; im.src = OM.fileUrl(a.backup); h.backupImg = im; }
  return h;
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
function fitView() {
  const h = cur(), v = S.view;
  v.zx = scanW() / h.nCols; v.c0 = 0; v.zy = scanH() / rowsOf(h); v.r0 = 0; v.zoomed = false;
}
function clampView() {
  const h = cur(), v = S.view, vis = scanW() / v.zx;
  v.c0 = Math.max(-vis * 0.05, Math.min(h.nCols - vis * 0.95, v.c0));
  v.r0 = Math.max(0, Math.min(rowsOf(h) - scanH() / v.zy, v.r0));
}
function centerOn(col) {
  const v = S.view, vis = scanW() / v.zx;
  if (col < v.c0 + vis * 0.1 || col > v.c0 + vis * 0.9) { v.c0 = col - vis / 2; clampView(); }
}
function follow(h) {
  const v = S.view;
  v.zx = 0.9; v.zy = scanH() / rowsOf(h); v.r0 = 0;
  v.c0 = Math.max(0, h.liveCol - (scanW() * 0.85) / v.zx);
}
// screen x <-> column, honouring Flip (mirrored: later times to the left)
const unflipX = x => (S.flip ? scanW() - x : x);
const xOf = col => unflipX((col + 0.5 - S.view.c0) * S.view.zx);
const colOf = x => Math.floor(S.view.c0 + unflipX(x) / S.view.zx);

function drawScan() {
  const [g, W, Hc] = fitCanvas(scanCv), Hi = Hc - RULER, h = cur(), v = S.view;
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
    g.drawImage(h.img, sx, v.r0, ex - sx, Hi / v.zy, (sx - v.c0) * v.zx, 0, (ex - sx) * v.zx, Hi);
    g.restore();
  }
  if (live) { g.fillStyle = TK.blue; g.fillRect(xOf(last) - 1, 0, 2, Hi); }

  // lane overlay: boundary lines at the finish plane, from the camera's lane geometry
  const yRow = row => (row - v.r0) * v.zy;
  const bands = laneBands(h);
  if (S.lanes) {
    g.strokeStyle = 'rgba(107,165,231,0.75)'; g.lineWidth = 1;
    [...new Set(bands.flatMap(b => [Math.round(b.top), Math.round(b.bottom)]))].forEach(row => {
      const y = Math.round(yRow(row)) + 0.5;
      if (y < 0 || y > Hi) return;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    });
  }
  g.font = '700 10px ' + TK.mono;
  bands.forEach(b => {
    const y = yRow((b.top + b.bottom) / 2 + (S.lanes ? 5 : -4));
    if (y < 8 || y > Hi - 2) return;
    g.fillStyle = 'rgba(8,16,34,0.72)'; g.fillRect(0, y - 11, 18, 13);
    g.fillStyle = '#f7f8fa'; g.fillText(String(b.lane), 6, y - 1);
  });

  // proposals not yet resolved (dashed), then marks (solid)
  const tags = [];
  (h.proposals || []).forEach(p => {
    if (h.marks[p.lane] || h.status[p.lane]) return;
    tags.push({ col: p.col, lane: p.lane, color: p.decision === 'auto' ? TK.blue : TK.amber, dashed: true });
  });
  Object.entries(h.marks).forEach(([lane, m]) => tags.push({ col: m.col, lane: +lane, color: h.status[lane] === 'DQ' ? TK.finish : TK.mint, dashed: false }));
  tags.sort((a, b) => a.col - b.col).forEach((t, i) => {
    const x = xOf(t.col);
    if (x < -20 || x > W + 20) return;
    const sel = S.selLane === t.lane;
    g.strokeStyle = t.color; g.lineWidth = sel ? 2 : 1; g.setLineDash(t.dashed ? [5, 4] : []);
    g.beginPath(); g.moveTo(x, 18); g.lineTo(x, Hi); g.stroke(); g.setLineDash([]);
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
  drawRuler(g, W, Hc, h, true);
}
function drawRuler(g, W, Hc, h, on) {
  const y0 = Hc - RULER;
  g.fillStyle = TK.deep; g.fillRect(0, y0, W, RULER);
  g.fillStyle = TK.rule2; g.fillRect(0, y0, W, 1);
  if (!on) return;
  const v = S.view, pxPerS = v.zx / P;
  const steps = [0.00125, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1];
  const step = steps.find(s => s * pxPerS >= 70) || 1;
  const dec = step < 0.01 ? 4 : step < 0.1 ? 2 : 1;
  const t0 = h.tOpen + v.c0 * P, t1 = h.tOpen + (v.c0 + W / v.zx) * P;
  g.font = '10px ' + TK.mono;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(unflipX(((t - h.tOpen) / P - v.c0) * v.zx));
    g.fillStyle = TK.dim; g.fillRect(x, y0 + 1, 1, 6);
    g.fillStyle = TK.muted; g.textAlign = S.flip ? 'right' : 'left';
    g.fillText(t.toFixed(dec), x + (S.flip ? -3 : 3), y0 + 16);
  }
  g.textAlign = 'left';
}

function drawBackup() {
  const cv = $('#backup');
  if (!cv.isConnected || !cv.clientWidth) return;
  const [g, W, Hh] = fitCanvas(cv), h = cur();
  g.fillStyle = TK.scanbg; g.fillRect(0, 0, W, Hh);
  const live = h.state === 'running', last = live ? h.liveCol : h.nCols - 1;
  if (!h.img || last < 0 || h.state === 'loaded' || h.state === 'armed') {
    g.fillStyle = TK.dim; g.font = '12px ' + TK.sans; g.textAlign = 'center';
    g.fillText('Backup capture follows the primary.', W / 2, Hh / 2); g.textAlign = 'left';
    return;
  }
  const zx = W / h.nCols, bx = x => (S.flip ? W - x : x);
  g.save();
  if (S.flip) { g.translate(W, 0); g.scale(-1, 1); }
  g.filter = 'grayscale(1) contrast(1.1)';
  if (h.backupImg && h.backupImg.complete && h.backupImg.naturalWidth) {
    // the backup camera's own image, clipped to the same race time as the primary's live edge
    const bm = h.asset.backupMeta, bLast = Math.min(h.backupImg.naturalWidth, Math.round((colTime(h, last) - bm.first_column_race_time_s) / bm.column_period_s));
    if (bLast > 0) g.drawImage(h.backupImg, 0, 0, bLast, h.backupImg.naturalHeight, 0, 0, bLast * (W / h.backupImg.naturalWidth), Hh);
  } else g.drawImage(h.img, 0, 0, last + 1, rowsOf(h), 0, 0, (last + 1) * zx, Hh);
  g.restore();
  if (S.selCol != null) { g.fillStyle = TK.finish; g.fillRect(Math.round(bx((S.selCol + 0.5) * zx)), 0, 1, Hh); }
  const v = S.view, vw = Math.min(W, (scanW() / v.zx) * zx), vx = Math.max(0, v.c0 * zx);
  g.strokeStyle = TK.blue; g.lineWidth = 1;
  g.strokeRect((S.flip ? W - vx - vw : vx) + 0.5, 0.5, vw - 1, Hh - 1);
}

// What moment the front camera shows: live while running; afterwards the hovered column, else the selected one.
function frontTime(h) {
  if (h.state === 'running') return h.tNow;
  if (h.state !== 'review' && h.state !== 'saved') return null;
  const col = S.hoverCol != null ? S.hoverCol : S.selCol;
  return col == null ? null : colTime(h, col);
}
let vidEl = null, vidTag = null;
function frontVideo() {
  if (!vidEl) {
    const pb = $('#front').parentNode;
    vidEl = h_('video', 'frontvid'); vidEl.muted = true; vidEl.playsInline = true; vidEl.preload = 'auto';
    vidEl.onloadedmetadata = invalidate;
    vidTag = h_('div', 'frametag');
    pb.append(vidEl, vidTag);
  }
  return vidEl;
}
// The front camera is a recording attached to the heat: frame-exact at 30 fps, scrubbed by hovering the line-scan.
function syncFront(h) {
  const rec = h.frontRec || (h.asset && h.asset.front ? { path: h.asset.front, meta: h.asset.frontMeta } : null);
  const v = frontVideo(), on = !!(OM && rec);
  v.style.display = on ? 'block' : 'none'; vidTag.style.display = 'none';
  if (!on) { if (!v.paused) v.pause(); return false; }
  const url = OM.fileUrl(rec.path);
  if (v.dataset.src !== url) { v.dataset.src = url; v.src = url; }
  const fps = (rec.meta && rec.meta.fps) || 30, ff = (rec.meta && rec.meta.first_frame_race_time_s) || 0;
  if (h.state === 'running') {
    const want = h.tNow - ff;
    if (want < 0) { if (!v.paused) v.pause(); return true; }
    v.playbackRate = SPEED;
    if (v.paused) { v.currentTime = want; v.play().catch(() => {}); } else if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
    return true;
  }
  if (!v.paused) v.pause();
  const ft = frontTime(h), t = ft != null ? ft : h.state === 'review' || h.state === 'saved' ? h.tClose : ff;
  const maxN = v.duration ? Math.floor(v.duration * fps) - 1 : Infinity;
  const frame = Math.max(0, Math.min(maxN, Math.floor((t - ff) * fps)));
  const target = (frame + 0.5) / fps;
  if (v.readyState >= 1 && Math.abs(v.currentTime - target) > 0.5 / fps) v.currentTime = target;
  if (ft != null) { vidTag.style.display = 'block'; vidTag.textContent = `${fmtT(ff + frame / fps)} s · frame ${frame + 1}`; }
  return true;
}
function drawFront() {
  const cv = $('#front');
  if (!cv.isConnected || !cv.clientWidth) return;
  const [g, W, Hf] = fitCanvas(cv), h = cur();
  if (syncFront(h)) { g.clearRect(0, 0, W, Hf); return; }
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
  const h = cur();
  if (!h.img) return;
  e.preventDefault();
  const v = S.view, rect = scanCv.getBoundingClientRect(), xa = unflipX(e.clientX - rect.left);
  if (e.ctrlKey || e.metaKey) {
    const colAt = v.c0 + xa / v.zx;
    v.zx = Math.max(scanW() / h.nCols * 0.5, Math.min(16, v.zx * Math.exp(-e.deltaY * 0.0018)));
    v.c0 = colAt - xa / v.zx; v.zoomed = true;
  } else {
    v.c0 += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / v.zx * (S.flip ? -1 : 1);
  }
  v.user = true; clampView(); renderTools(); invalidate();
}, { passive: false });
// Hover scrubs the heat's front-camera recording to the frame at that column.
scanCv.addEventListener('mousemove', e => {
  if (S.drag && S.drag.moved) return;
  const h = cur();
  if (h.state !== 'review' && h.state !== 'saved') return;
  const r = scanCv.getBoundingClientRect();
  const col = Math.max(0, Math.min(h.nCols - 1, colOf(e.clientX - r.left)));
  if (col !== S.hoverCol) { S.hoverCol = col; invalidate(); }
});
scanCv.addEventListener('mouseleave', () => { if (S.hoverCol != null) { S.hoverCol = null; invalidate(); } });
scanCv.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  const r = scanCv.getBoundingClientRect();
  S.drag = { mode: S.cropTool || e.shiftKey ? 'crop' : 'pan', x0: e.clientX - r.left, y0: e.clientY - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, c0: S.view.c0, r0: S.view.r0, moved: false };
});
window.addEventListener('mousemove', e => {
  const d = S.drag;
  if (!d) return;
  const r = scanCv.getBoundingClientRect();
  d.x1 = Math.max(0, Math.min(r.width, e.clientX - r.left));
  d.y1 = Math.max(0, Math.min(r.height - RULER, e.clientY - r.top));
  if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) > 5) d.moved = true;
  invalidate();
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
  const h = cur(), v = S.view;
  if (!['review', 'saved', 'running'].includes(h.state) || (h.state === 'running' && h.liveCol < 0)) return;
  if (d.moved && d.mode === 'crop') {
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
      .find(t => Math.abs(xOf(t.col) - d.x0) < 5 && d.y0 < 34);
    if (near) { S.selLane = near.lane; S.selCol = near.col; } else S.selCol = col;
    renderUI();
  }
});
scanCv.addEventListener('dblclick', e => {
  const h = cur();
  if (S.selLane == null || !['review', 'saved'].includes(h.state)) return;
  const r = scanCv.getBoundingClientRect();
  S.selCol = Math.max(0, Math.min(h.nCols - 1, colOf(e.clientX - r.left)));
  setMark(S.selLane, S.selCol);
});
window.addEventListener('keydown', e => {
  if (e.target instanceof Element && e.target.closest('input, select, textarea')) return;
  const h = cur(), lanes = h.athletes.map(a => a.lane).sort((a, b) => a - b);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (S.selCol == null) return;
    e.preventDefault();
    const dir = (e.key === 'ArrowLeft' ? -1 : 1) * (S.flip ? -1 : 1);   // arrows move on screen, whichever way the image faces
    S.selCol = Math.max(0, Math.min(h.nCols - 1, S.selCol + dir * (e.shiftKey ? 10 : 1)));
    centerOn(S.selCol); renderUI();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const i = lanes.indexOf(S.selLane);
    const n = i < 0 ? 0 : Math.max(0, Math.min(lanes.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)));
    selectLane(lanes[n]);
  } else if (/^[1-9]$/.test(e.key) && lanes.includes(+e.key)) {
    selectLane(+e.key);
  } else if (e.key === 'Enter') {
    if (S.selLane != null && S.selCol != null) { e.preventDefault(); setMark(S.selLane, S.selCol); }
  } else if (e.key === 'Escape') {
    if (S.cropTool) { S.cropTool = false; syncCursor(); }
    else if (S.view.zoomed) fitView();
    else { S.selLane = null; S.selCol = null; }
    renderUI();
  }
});
$('#drawerClose').onclick = () => { S.tab = 'run'; renderUI(); };
window.addEventListener('resize', () => { renderTiles(); if (!S.view.zoomed && cur().state !== 'running') fitView(); invalidate(); });

// ---------------------------------------------------------------- frame loop (canvases redraw only while running or after a change)
let lastSec = -1, lastLiveRender = 0;
function frame(now) {
  const h = cur();
  if (h.state === 'running') {
    h.tNow = (now - h.startPerf) / 1000 * SPEED;
    const lc = h.asset ? (h.recvCols || 0) - 1 : Math.min(h.nCols - 1, Math.floor((h.tNow - h.tOpen) / P));
    if (lc !== h.liveCol) { h.liveCol = lc; if (!S.view.user && lc >= 0) follow(h); }
    if (now - lastLiveRender > 250) { lastLiveRender = now; renderAcc(); renderSide(); renderTools(); }
    if (!h.asset && h.tNow >= h.tClose) { endCapture(h); renderUI(); }   // engine-fed heats close on the camera's end message
    tickClock();
  }
  const sec = Math.floor(Date.now() / 1000);
  if (sec !== lastSec) { lastSec = sec; tickTod(); }
  if (dirty || h.state === 'running') { dirty = false; drawScan(); drawBackup(); drawFront(); }
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
  OM.call('settings.get').then(s => { if (s.demoDir) openDemo(s.demoDir); else if (s.meetDir) openMeet(s.meetDir); }).catch(() => {});
}
})();
