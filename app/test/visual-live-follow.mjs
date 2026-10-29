// Actual Electron/CDP live-follow regression. No product globals, models, or installs.
// node app/test/visual-live-follow.mjs /absolute/app /path/to/demo
// Optional third argument: a NEW /tmp/openmeet-follow-* directory.
// Options: --scenario=ordinary|native|all --sample-ms=5000 --timeout-ms=90000 --profile-ms=3000
// Raw RAF/paint/batch traces, screenshots, captures, profiles, and reports stay in that directory.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const options = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const [appArg, demoArg, outputArg] = positional;
if (!appArg || !demoArg) throw Error('Usage: node app/test/visual-live-follow.mjs <absolute-app-dir> <demo-dir> [NEW /tmp/openmeet-follow-*] [--scenario=ordinary|native|all]');
const appDir = realpathSync(appArg), demoDir = realpathSync(demoArg);
const scenario = options.scenario || 'all';
if (!['all', 'ordinary', 'native'].includes(scenario)) throw Error('Invalid --scenario');
const sampleMs = Number(options['sample-ms'] || 5000), timeoutMs = Number(options['timeout-ms'] || 90000), profileMs = Number(options['profile-ms'] || 0);
if (!(sampleMs >= 3000 && sampleMs <= 15000 && timeoutMs >= 45000 && timeoutMs <= 180000)) throw Error('Invalid sampling/timeout bounds');
if (!(profileMs === 0 || profileMs >= 2000 && profileMs <= 10000)) throw Error('Invalid --profile-ms');
let outDir;
if (outputArg) {
  outDir = path.resolve(outputArg);
  if (path.dirname(outDir) !== '/tmp' || !path.basename(outDir).startsWith('openmeet-follow-') || existsSync(outDir)) {
    throw Error('Output must be a NEW direct child of /tmp named openmeet-follow-*');
  }
  mkdirSync(outDir);
} else outDir = mkdtempSync('/tmp/openmeet-follow-');
console.log('OUTPUT', outDir);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let interrupted = false;
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const originalSidecar = JSON.parse(readFileSync(path.join(demoDir, 'heat-1/primary.json')));
const originalSourceHash = Object.fromEntries(['primary.json', 'primary.png'].map(n => [n, sha(readFileSync(path.join(demoDir, 'heat-1', n)))]));
const { encodePng } = await import(pathToFileURL(path.join(appDir, '../engine/sim/png-encode.js')).href);
const { simReplay } = await import(pathToFileURL(path.join(appDir, '../engine/sim/replay.js')).href);
const report = { startedAt: new Date().toISOString(), outDir, appDir, demoDir, sampleMs, profileMs, results: [], assertions: [], limitations: [
  'Headless Electron measures delivered RAF callbacks and actual canvas paints; it does not measure a physical display compositor.',
  'Native 2000-row/6000-column/s stress reports cadence without a fixed FPS pass threshold.',
] };
function check(condition, name, details) {
  report.assertions.push({ pass: !!condition, name, ...(details === undefined ? {} : { details }) });
  console.log(condition ? 'PASS' : 'FAIL', name, details === undefined ? '' : JSON.stringify(details));
  return !!condition;
}
function requireThat(condition, name) { if (!condition) throw Error(name); }
function distribution(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { count: 0 };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const q = p => v[Math.floor((v.length - 1) * p)];
  return { count: v.length, min: v[0], p50: q(.5), p90: q(.9), p95: q(.95), p99: q(.99), max: v.at(-1), mean,
    stddev: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) };
}
function prefixHash(file, size) {
  const fd = openSync(file, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let at = 0; at < size;) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - at), at);
      requireThat(n > 0, 'Unexpected truncated evidence file'); hash.update(buffer.subarray(0, n)); at += n;
    }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
function evidence(dir, rows) {
  const columnsBytes = statSync(path.join(dir, 'columns.bin')).size, timesBytes = statSync(path.join(dir, 'times.f64')).size;
  const count = Math.min(Math.floor(columnsBytes / (rows * 3)), Math.floor(timesBytes / 8));
  return { count, columnsBytes, timesBytes, prefixBytes: count * rows * 3,
    columnsSha256: prefixHash(path.join(dir, 'columns.bin'), count * rows * 3),
    timesSha256: prefixHash(path.join(dir, 'times.f64'), count * 8) };
}
function verifyPrefix(dir, before) {
  return prefixHash(path.join(dir, 'columns.bin'), before.prefixBytes) === before.columnsSha256
    && prefixHash(path.join(dir, 'times.f64'), before.count * 8) === before.timesSha256;
}
function fixture(root) {
  const dir = path.join(root, 'fixture'); mkdirSync(dir);
  // Only this heat is exercised. Use the real video path rather than copying the
  // optional full-resolution PNG frame cache (hundreds of MB per unused heat).
  mkdirSync(path.join(dir, 'heat-1'));
  for (const name of ['primary.png', 'primary.json', 'backup.png', 'backup.json', 'front.mp4', 'front.json']) {
    const src = path.join(demoDir, 'heat-1', name), dest = path.join(dir, 'heat-1', name);
    if (!existsSync(src)) continue;
    if (name.endsWith('.json')) copyFileSync(src, dest);
    else { try { linkSync(src, dest); } catch { copyFileSync(src, dest); } }
  }
  mkdirSync(path.join(dir, 'meet'));
  for (const name of readdirSync(path.join(demoDir, 'meet')).filter(n => /^lynx\./.test(n))) copyFileSync(path.join(demoDir, 'meet', name), path.join(dir, 'meet', name));
  const width = 1200, height = 2000, data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    data[i] = 20 + (Math.floor(x / 80) % 2) * 50; data[i + 1] = 40 + (y % 100); data[i + 2] = 70;
  }
  writeFileSync(path.join(dir, 'heat-1/scan-native.png'), encodePng({ width, height, channels: 3, data }));
  json(path.join(dir, 'heat-1/scan-native.json'), { rows: height, columns: width, column_period_s: 1 / 6000,
    first_column_race_time_s: .05, camera_name: 'Native 2000-row 6000 columns/s', truth: [],
    lane_rows: originalSidecar.lane_rows.map(b => ({ lane: b.lane, top_row: b.top_row * height / originalSidecar.rows, bottom_row: b.bottom_row * height / originalSidecar.rows })) });
  return dir;
}

// The remote object retains this closure. Nothing is assigned to window, the application,
// or its module scope. Native calls are forwarded unchanged and subscriptions are read-only.
function installProbe() {
  const proto = CanvasRenderingContext2D.prototype;
  const originalDraw = proto.drawImage, originalFill = proto.fillRect, originalPut = proto.putImageData;
  const rafs = [], paints = [], batches = [], events = [], instrumentationErrors = [];
  let alive = true, rafId, phase = 'setup', current = null, received = 0, rows = 0, captureId = null, writes = [];
  const tiles = new WeakMap();
  const isScan = g => g.canvas.id === 'scan';
  function begin() {
    current = { at: performance.now(), phase, received, width: document.querySelector('#scan').clientWidth, draws: [] };
    paints.push(current);
  }
  proto.fillRect = function(...a) {
    if (alive && isScan(this) && a[0] === 0 && a[1] === 0 && a[2] === this.canvas.clientWidth && a[3] === this.canvas.clientHeight) begin();
    // The blue newest-column marker uses canonical liveCol. Derive that column
    // from its actual geometry as a separate check from viewport presentation.
    if (alive && isScan(this) && current?.c0 !== undefined && a[1] === 0 && a[2] === 2 && a[3] === current.draws[0]?.dh) {
      const x = current.flip ? current.width - (a[0] + 1) : a[0] + 1;
      current.canonicalLiveCol = current.c0 + x / current.zx - .5;
    }
    return Reflect.apply(originalFill, this, a);
  };
  proto.putImageData = function(...a) {
    const result = Reflect.apply(originalPut, this, a);
    if (alive && this.canvas.width === 2048 && this.canvas.height === rows) writes.push({ canvas: this.canvas, local: a[1], count: a[0].width });
    return result;
  };
  proto.drawImage = function(...a) {
    if (alive && isScan(this) && a.length === 9 && a[0].width === 2048) {
      const index = tiles.get(a[0]);
      if (index === undefined) instrumentationErrors.push('Unmapped 2048-wide source tile');
      else {
        if (!current) begin();
        const [, sx, sy, sw, sh, dx, dy, dw, dh] = a, zx = dw / sw, c0 = index * 2048 + sx - dx / zx;
        const transform = this.getTransform();
        current.draws.push({ index, sx, sy, sw, sh, dx, dy, dw, dh, zx, c0, flip: transform.a < 0 });
        if (current.c0 === undefined) Object.assign(current, { c0, zx, r0: sy, rowsShown: sh, flip: transform.a < 0 });
        else if (Math.abs(current.c0 - c0) > 1e-5 || Math.abs(current.zx - zx) > 1e-7) instrumentationErrors.push('Tile viewport derivations disagree');
      }
    }
    return Reflect.apply(originalDraw, this, a);
  };
  function frame(at) {
    if (!alive) return;
    if (current && current.rafAt === undefined) { current.rafAt = at; current.clock = Number(document.querySelector('#clock')?.textContent); }
    const layer=document.querySelector('#frontLaneOverlay'),video=document.querySelector('video.frontvid');
    rafs.push({ at, observedAt: performance.now(), phase, received, frontMask:layer?.style.maskImage,
      frontOcclusion:layer?.dataset.occlusion,videoTime:video?.currentTime,videoPlaying:!!video&&!video.paused&&!video.seeking });
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
  const off = [
    window.openmeet.on('capture.hello', d => { rows = d.rows; captureId = d.id; writes = []; received = 0; events.push({ event: 'hello', at: performance.now(), ...d }); }),
    window.openmeet.on('capture.pulse', d => events.push({ event: 'pulse', at: performance.now(), ...d })),
    window.openmeet.on('capture.columns', d => {
      let offset = 0;
      for (const w of writes) {
        const index = Math.floor((d.first + offset) / 2048);
        if (w.local !== (d.first + offset) % 2048) instrumentationErrors.push('Tile ingestion offset mismatch');
        tiles.set(w.canvas, index); offset += w.count;
      }
      if (offset !== d.count) instrumentationErrors.push(`Tile ingestion count ${offset} != ${d.count}`);
      writes = []; received = d.first + d.count;
      batches.push({ at: performance.now(), phase, first: d.first, count: d.count, period: d.period, received });
    }),
    window.openmeet.on('capture.end', d => events.push({ event: 'end', at: performance.now(), ...d })),
    window.openmeet.on('capture.error', d => instrumentationErrors.push('Capture: ' + d.message)),
    window.openmeet.on('engine.exit', d => instrumentationErrors.push('Engine exited: ' + d.code)),
  ];
  const controlClick = e => { const tool = e.target.closest('[data-tool]')?.dataset.tool; if (tool) events.push({ event: 'control', tool, phase, at: performance.now() }); };
  document.addEventListener('click', controlClick, true);
  return {
    mark(name) { phase = name; return performance.now(); },
    status() { return { received, rows, captureId, at: performance.now(), last: paints.filter(p => Number.isFinite(p.c0)).at(-1), recent: paints.filter(p => Number.isFinite(p.c0)).slice(-10) }; },
    snapshot() { return { rafs, paints, batches, events, instrumentationErrors }; },
    stop() { alive = false; cancelAnimationFrame(rafId); off.forEach(f => f()); document.removeEventListener('click', controlClick, true); proto.drawImage = originalDraw; proto.fillRect = originalFill; proto.putImageData = originalPut; },
  };
}

function metrics(trace, phase, rate) {
  const paints = trace.paints.filter(p => p.phase === phase && Number.isFinite(p.c0));
  const rafs = trace.rafs.filter(p => p.phase === phase);
  const steps = paints.slice(1).map((p, i) => {
    const prev = paints[i], dt = p.at - prev.at, rafDt = p.rafAt - prev.rafAt, columns = p.c0 - prev.c0;
    return { dt, rafDt, columns, pixels: columns * p.zx, velocity: columns * p.zx * 1000 / rafDt,
      paintStartVelocity: columns * p.zx * 1000 / dt,
      columnsPerSecond: columns * 1000 / rafDt, unchangedReceived: p.received === prev.received };
  });
  const between = steps.filter(s => s.unchangedReceived), moving = s => s.columns > 1e-4;
  return { phase, paints: paints.length, elapsedMs: paints.length > 1 ? paints.at(-1).at - paints[0].at : 0,
    rafGapMs: distribution(rafs.slice(1).map((p, i) => p.at - rafs[i].at)),
    paintGapMs: distribution(steps.map(s => s.dt)), stepColumns: distribution(steps.map(s => s.columns)),
    stepPx: distribution(steps.map(s => s.pixels)), velocityPxPerSecond: distribution(steps.map(s => s.velocity)),
    velocityColumnsPerSecond: distribution(steps.map(s => s.columnsPerSecond)),
    velocityTimebase: 'paired delivered RAF timestamps', paintStartVelocityPxPerSecond: distribution(steps.map(s => s.paintStartVelocity)),
    expectedVelocityPxPerSecond: paints[0]?.zx * rate,
    zeroSteps: steps.filter(s => Math.abs(s.columns) <= 1e-4).length,
    positiveSteps: steps.filter(moving).length, reverseSteps: steps.filter(s => s.columns < -1e-4).length,
    batchSizedSteps: steps.filter(s => s.columns >= 64 * .9).length,
    unchangedReceivedSteps: between.length, movingBetweenBatches: between.filter(moving).length,
    betweenBatchMotionFraction: between.length ? between.filter(moving).length / between.length : null,
    positiveMotionFraction: steps.length ? steps.filter(moving).length / steps.length : null,
    zx: distribution(paints.map(p => p.zx)),
    lagColumns: distribution(paints.map(p => p.received - (p.c0 + p.width / p.zx))),
    rafGapsOver50ms: rafs.slice(1).filter((p, i) => p.at - rafs[i].at > 50).length,
    rafGapsOver100ms: rafs.slice(1).filter((p, i) => p.at - rafs[i].at > 100).length,
  };
}

async function runCase(kind) {
  const root = path.join(outDir, kind); mkdirSync(root);
  const meetDir = fixture(root), userData = path.join(root, 'userdata'); mkdirSync(userData);
  const native = kind === 'native', rate = native ? 6000 : 800, rows = native ? 2000 : 640;
  const png = path.join(meetDir, 'heat-1', native ? 'scan-native.png' : 'primary.png');
  const sidecarPath = png.replace(/\.png$/, '.json'), sidecar = JSON.parse(readFileSync(sidecarPath));
  requireThat(sidecar.rows === rows && sidecar.column_period_s === 1 / rate, 'Fixture does not match requested geometry/rate');
  json(path.join(userData, 'openmeet-settings.json'), { demoDir: meetDir });
  const sourceVersion = () => Object.fromEntries(readdirSync(path.join(appDir, 'renderer')).filter(f => /\.(js|mjs)$/.test(f)).sort().map(f => ['renderer/' + f, sha(readFileSync(path.join(appDir, 'renderer', f)))]));
  const result = { kind, root, meetDir, source: { png, sidecarPath, rows, rate, columns: sidecar.columns, firstTime: sidecar.first_column_race_time_s }, rendererBefore: sourceVersion() };
  report.results.push(result);
  let proc, ws, watchdog, probeId, plog = '', expired = false, closed = false, nextId = 0;
  const pending = new Map(), runtimeErrors = [];
  let evaluate, send, probe, trace, captureDir;
  const killGroup = signal => { if (proc?.pid) try { process.kill(-proc.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  const signalHandler = () => { interrupted = true; expired = true; ws?.close(); killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 1500).unref(); };
  process.once('SIGINT', signalHandler); process.once('SIGTERM', signalHandler);
  try {
    const env = { ...process.env, XDG_CACHE_HOME: path.join(root, 'cache'), XDG_CONFIG_HOME: path.join(root, 'config') };
    for (const k of Object.keys(env)) if (k.startsWith('OPENMEET_') || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
    const args = [appDir, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${userData}`,
      '--ozone-platform=headless', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--no-first-run'];
    // GNU timeout also bounds the process if this Node harness itself is interrupted.
    proc = spawn('/usr/bin/timeout', ['--signal=TERM', '--kill-after=4s', `${Math.ceil(timeoutMs / 1000)}s`, path.join(appDir, 'node_modules/electron/dist/electron'), ...args],
      { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError; proc.on('error', e => { spawnError = e; });
    proc.stdout.on('data', d => { plog += d; }); proc.stderr.on('data', d => { plog += d; });
    watchdog = setTimeout(() => { expired = true; killGroup('SIGTERM'); ws?.close(); }, timeoutMs);
    const poll = async (fn, label, ms = 20000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (expired) throw Error('Scenario process timeout');
        if (spawnError) throw spawnError;
        if (proc.exitCode !== null || proc.signalCode !== null || /FATAL:/.test(plog)) throw Error(`Electron exited ${proc.exitCode ?? proc.signalCode}: ${plog.slice(-2500)}`);
        const value = await fn(); if (value) return value; await sleep(100);
      }
      throw Error('Timed out: ' + label);
    };
    const port = await poll(() => { const m = plog.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/); return m && Number(m[1]); }, 'Electron DevTools endpoint');
    const page = await poll(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()).find(t => t.type === 'page' && /index\.html/.test(t.url)); } catch { return null; } }, 'console page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('CDP connection timeout')), 10000); ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true }); ws.addEventListener('error', e => { clearTimeout(t); reject(e); }, { once: true }); });
    ws.addEventListener('message', event => {
      const m = JSON.parse(event.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); }
      if (m.method === 'Runtime.exceptionThrown') runtimeErrors.push(m.params.exceptionDetails.exception?.description || JSON.stringify(m.params.exceptionDetails));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') runtimeErrors.push(m.params.args.map(a => a.value || a.description).join(' '));
    });
    ws.addEventListener('close', () => { closed = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('CDP closed')); } pending.clear(); });
    send = (method, params = {}) => new Promise((resolve, reject) => {
      if (closed || expired) return reject(Error('CDP unavailable / timeout'));
      const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
    function value(r) { if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result?.value; }
    evaluate = async expression => value(await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }));
    probe = async (method, ...args) => value(await send('Runtime.callFunctionOn', { objectId: probeId,
      functionDeclaration: `function(...args){return this[${JSON.stringify(method)}](...args)}`, arguments: args.map(value => ({ value })), returnByValue: true }));
    const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(root, name + '.png'), Buffer.from(r.data, 'base64')); };
    const clickSelector = async selector => requireThat(await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)return false;b.click();return true})()`), 'Missing enabled control: ' + selector);
    const clickText = async text => requireThat(await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)})&&!b.disabled&&b.getClientRects().length);if(!b)return false;b.click();return true})()`), 'Missing button: ' + text);
    const tool = async id => {
      if (await evaluate(`(()=>{const b=document.querySelector('#tools [data-tool="${id}"]');if(!b||b.disabled)return false;b.click();return true})()`)) return;
      await clickSelector('#tools [data-more]'); await clickSelector(`[role="menu"] [data-tool="${id}"]`);
    };
    const bounds = selector => evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    const frameValues = () => evaluate(`Object.fromEntries([...document.querySelectorAll('#scanHeightEditor [data-edge]')].map(e=>[e.dataset.edge,+e.getAttribute('aria-valuenow')]))`);
    const dragFrame = async (edge, fraction) => {
      const r = await bounds('#scanHeightEditor'), b = await bounds(`#scanHeightEditor [data-edge="${edge}"]`), x = b.x + 45, y = b.y + b.h / 2;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y + fraction * r.h, buttons: 1, button: 'left' });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: y + fraction * r.h, button: 'left', clickCount: 1 });
      await sleep(60);
    };
    const waitReady = () => poll(() => evaluate(`!!window.openmeet&&document.querySelector('#scanCameraLabel')?.textContent.includes(${JSON.stringify(native ? 'Native 2000-row' : 'Line-scan A')})&&!!document.querySelector('#ctl .go')`), 'loaded disposable camera');
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await poll(() => evaluate(`!!window.openmeet&&document.querySelector('#scanCameraLabel')?.textContent.includes('Line-scan A')&&!!document.querySelector('#ctl .go')`), 'demo loaded');
    if (native) { await clickSelector('#scanCameraLabel'); await clickText('Native 2000-row'); await waitReady(); }
    // A small saved-framing smoke check; exhaustive framing is in visual-framing.mjs.
    await tool('height'); await sleep(100); await dragFrame('top', .2); await dragFrame('bottom', -.1);
    result.framing = await frameValues(); await clickSelector('#scanHeightEditor [data-height-done]');
    await send('Page.reload'); await sleep(250); await waitReady();
    await tool('height'); await sleep(100);
    check(JSON.stringify(await frameValues()) === JSON.stringify(result.framing), `${kind}: saved height framing survives reload`, result.framing);
    await clickSelector('#scanHeightEditor [data-height-done]');
    // Enable the expensive public overlay path, including pending yellow and inactive shading.
    await tool('lanes');
    for (const [key, enabled] of [['enabled', true], ['behindRunners', true], ['needsFinish', true], ['shadeInactive', true]]) {
      await evaluate(`(()=>{const e=document.querySelector('.overlay-settings [data-key="${key}"]');if(!e)throw Error('Missing overlay ${key}');e.checked=${enabled};e.dispatchEvent(new Event('input'))})()`);
    }
    await evaluate(`(()=>{const e=document.querySelector('.overlay-settings [data-occlusion]');if(e){e.value='simple';e.dispatchEvent(new Event('change'))}})()`);
    await clickSelector('.overlay-settings [data-close]');
    // Public front overlay, with fixed-background mask at the actual presented video cadence.
    if (await evaluate(`!!document.querySelector('#frontLaneButton')`)) {
      await clickSelector('#frontLaneButton');
      for (const key of ['enabled', 'behindRunners']) await evaluate(`(()=>{const e=document.querySelector('#overlay-settings-front [data-key="${key}"]');if(e){e.checked=true;e.dispatchEvent(new Event('input'))}})()`);
      await clickSelector('.overlay-settings [data-close]'); result.frontBehindRunners = true;
    }
    // Disable automatic suggestions through the UI so no service/model is needed.
    await tool('auto');
    await evaluate(`(()=>{const e=document.querySelector('[data-auto-toggle]');if(e.checked){e.checked=false;e.dispatchEvent(new Event('change'))}})()`);
    await evaluate(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    const installed = await send('Runtime.evaluate', { expression: `(${installProbe.toString()})()`, returnByValue: false });
    if (installed.exceptionDetails) throw Error(installed.exceptionDetails.exception?.description);
    probeId = installed.result.objectId;
    await probe('mark', 'condensation'); await clickText('Start ');
    const status = await poll(async () => {
      const s = await probe('status');
      return s.rows === rows && s.recent.length === 10 && s.recent.every(p => p.c0 > 64 && Math.abs(p.zx - .6) < 1e-5) ? s : false;
    }, 'zoom condensation settled', 30000);
    captureDir = path.join(meetDir, 'meet/openmeet/captures', status.captureId); result.captureDir = captureDir;
    await probe('mark', 'steady'); await sleep(sampleMs); await probe('mark', 'controls');
    trace = await probe('snapshot'); result.steady = metrics(trace, 'steady', rate);
    console.log('STEADY_METRICS', kind, JSON.stringify(result.steady));
    json(path.join(root, 'steady-metrics.json'), result.steady);
    await shot('01-steady');
    if (profileMs) {
      // Profile moving video, not its still preroll. This is separate from the
      // unprofiled steady performance sample above.
      const frontMeta = JSON.parse(readFileSync(path.join(meetDir, 'heat-1/front.json')));
      await poll(async () => (await probe('status')).received > Math.round((frontMeta.first_frame_race_time_s + .2) * rate), 'moving source video interval', 22000);
      await probe('mark', 'profile');
      await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 1000 }); await send('Profiler.start');
      await sleep(profileMs); const { profile } = await send('Profiler.stop'); await send('Profiler.disable');
      json(path.join(root, 'cpu.cpuprofile'), profile);
      const nodes = new Map(profile.nodes.map(n => [n.id, n])), parents = new Map(), self = new Map(), inclusive = new Map();
      for (const node of profile.nodes) for (const id of node.children || []) parents.set(id, node.id);
      for (let i = 0; i < profile.samples.length; i++) {
        let id = profile.samples[i]; const ms = profile.timeDeltas[i] / 1000;
        self.set(id, (self.get(id) || 0) + ms);
        while (id !== undefined) { inclusive.set(id, (inclusive.get(id) || 0) + ms); id = parents.get(id); }
      }
      const functions = profile.nodes.map(n => ({ function: n.callFrame.functionName || '(anonymous)', url: n.callFrame.url, line: n.callFrame.lineNumber + 1, selfMs: self.get(n.id) || 0, inclusiveMs: inclusive.get(n.id) || 0 }));
      result.profile = { durationMs: (profile.endTime - profile.startTime) / 1000, samples: profile.samples.length,
        topSelf: [...functions].sort((a, b) => b.selfMs - a.selfMs).slice(0, 25),
        topInclusive: [...functions].filter(f => f.url).sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 30) };
      json(path.join(root, 'cpu-summary.json'), result.profile); console.log('CPU_PROFILE', kind, JSON.stringify(result.profile));
      trace = await probe('snapshot'); result.profileCadence = metrics(trace, 'profile', rate); await probe('mark', 'controls');
    }

    const beforeWheel = await probe('status'), evidenceBefore = evidence(captureDir, rows);
    const scan = await bounds('#scan'); await probe('mark', 'wheel');
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scan.x + scan.w / 2, y: scan.y + scan.h / 2, deltaX: 0, deltaY: -240 });
    await sleep(150); await probe('mark', 'paused'); const pausedStart = await probe('status');
    await sleep(1200); const pausedEnd = await probe('status');
    result.pause = { before: beforeWheel.received, after: pausedEnd.received,
      c0Before: beforeWheel.last.c0, c0Start: pausedStart.last.c0, c0End: pausedEnd.last.c0,
      evidenceBefore, evidenceAfter: evidence(captureDir, rows) };
    trace = await probe('snapshot');
    const pausePaints = trace.paints.filter(p => p.phase === 'paused' && Number.isFinite(p.c0));
    check(pausePaints.length >= 3 && pausePaints.every(p => Math.abs(p.c0 - pausedStart.last.c0) < 1e-5 && Math.abs(p.zx - pausedStart.last.zx) < 1e-7), `${kind}: wheel pauses viewport while capture continues`);
    check(pausedEnd.received > pausedStart.received && result.pause.evidenceAfter.columnsBytes > evidenceBefore.columnsBytes && result.pause.evidenceAfter.timesBytes > evidenceBefore.timesBytes, `${kind}: received columns and both capture files grow while paused`, { receivedDelta: pausedEnd.received - pausedStart.received, columnsBytesDelta: result.pause.evidenceAfter.columnsBytes - evidenceBefore.columnsBytes, timesBytesDelta: result.pause.evidenceAfter.timesBytes - evidenceBefore.timesBytes });
    check(verifyPrefix(captureDir, evidenceBefore), `${kind}: live display controls preserve stored pixel/time prefixes`);
    check(await evaluate(`document.querySelector('#tools [data-tool="follow"]')?.getAttribute('aria-pressed')==='false'`), `${kind}: wheel disables Follow`);
    await shot('02-paused');
    const resumeAt = await probe('mark', 'resume'); await tool('follow'); await sleep(1600); await probe('mark', 'post-resume');
    trace = await probe('snapshot');
    const followAt = trace.events.find(e => e.event === 'control' && e.tool === 'follow' && e.phase === 'resume')?.at;
    const resumePaints = trace.paints.filter(p => p.phase === 'resume' && p.at > followAt && Number.isFinite(p.c0));
    const backlog = pausedEnd.received - scan.w / pausedEnd.last.zx - pausedEnd.last.c0;
    result.resume = { resumeAt, followAt, backlogColumns: backlog, firstStepColumns: resumePaints[0]?.c0 - pausedEnd.last.c0,
      intermediatePaints: resumePaints.filter(p => p.c0 > pausedEnd.last.c0 + 1e-4 && p.c0 < pausedEnd.last.c0 + backlog * .9).length,
      metrics: metrics(trace, 'resume', rate) };
    check(resumePaints.at(-1)?.c0 > pausedEnd.last.c0 + backlog * .8, `${kind}: Follow resumes forward motion`, result.resume);
    if (!native) check(result.resume.intermediatePaints >= 3 && result.resume.firstStepColumns < backlog * .5, `${kind}: Follow resumes over multiple paints without a snap`);
    await probe('mark', 'flipped'); await tool('flip'); await sleep(900); await probe('mark', 'post-flip');
    trace = await probe('snapshot');
    const flipAt = trace.events.find(e => e.event === 'control' && e.tool === 'flip' && e.phase === 'flipped')?.at;
    const flipped = trace.paints.filter(p => p.phase === 'flipped' && p.at > flipAt && Number.isFinite(p.c0));
    check(flipped.length >= 3 && flipped.every(p => p.flip), `${kind}: Flip mirrors source tile transform during live following`);
    result.flipped = metrics(trace, 'flipped', rate);
    await shot('03-flipped'); await tool('flip'); await sleep(150);
    check((await probe('status')).last.flip === false, `${kind}: Flip restores source tile transform`);
    check(verifyPrefix(captureDir, evidenceBefore), `${kind}: Follow and Flip preserve original stored prefixes`);
    // Ordinary source keeps its original ~11.6s first time; explicitly reach the held-open tail.
    const endColumns = Math.round(sidecar.first_column_race_time_s / sidecar.column_period_s) + sidecar.columns;
    await poll(async () => (await probe('status')).received > endColumns + 128, 'replay remains open after source image ends', native ? 10000 : 22000);
    check(await evaluate(`!![...document.querySelectorAll('#ctl button')].find(b=>b.textContent==='Stop capture')`), `${kind}: replay holds capture open beyond source image`);
    await probe('mark', 'stop'); await clickText('Stop capture');
    await poll(() => evaluate(`document.querySelector('.state')?.textContent==='REVIEW'`), 'capture closed');
    trace = await probe('snapshot'); json(path.join(root, 'trace.json'), trace);
    check(trace.instrumentationErrors.length === 0, `${kind}: every source draw has consistent tile-derived c0/zx`, trace.instrumentationErrors);
    if(result.frontBehindRunners){
      const playing=trace.rafs.filter(f=>f.videoPlaying&&f.videoTime>0);
      const masks=new Set(playing.map(f=>f.frontMask).filter(m=>m?.includes('blob:')));
      result.frontMasks={playingFrames:playing.length,distinctBlobMasks:masks.size,unavailableFrames:trace.rafs.filter(f=>f.frontOcclusion==='unavailable').length};
      check(masks.size>=2&&result.frontMasks.unavailableFrames===0, `${kind}: actual front worker masks appear and change during playing video`, result.frontMasks);
    }
    const measured = trace.paints.filter(p => ['steady', 'paused', 'resume', 'flipped'].includes(p.phase) && Number.isFinite(p.c0));
    check(measured.every(p => Math.abs(p.r0 - result.framing.top) <= 1 && Math.abs(p.rowsShown - (result.framing.bottom - result.framing.top)) <= 2), `${kind}: live wheel/Follow/Flip retain saved native-row framing`);
    const liveFollowing = trace.paints.filter(p => ['steady', 'flipped'].includes(p.phase) && Number.isFinite(p.c0));
    check(liveFollowing.every(p => p.c0 + p.width / p.zx <= p.received + 1e-4), `${kind}: presentation viewport never exceeds received columns`);
    check(measured.every(p => Number.isFinite(p.canonicalLiveCol) && Math.abs(p.canonicalLiveCol - (p.received - 1)) < 1e-5), `${kind}: canonical newest-column marker stays at received minus one`);
    const clockSamples = measured.filter(p => Number.isFinite(p.rafAt) && Number.isFinite(p.clock));
    const clockAnchor = clockSamples[0];
    result.clockDriftSeconds = distribution(clockSamples.map(p => p.clock - clockAnchor.clock - (p.rafAt - clockAnchor.rafAt) / 1000));
    check(clockSamples.length >= 10 && clockSamples.every(p => Math.abs(p.clock - clockAnchor.clock - (p.rafAt - clockAnchor.rafAt) / 1000) < .12), `${kind}: operator clock tracks elapsed RAF time through view controls`, result.clockDriftSeconds);
    check(trace.batches.length > 20 && trace.batches.every((b, i) => b.first === (i ? trace.batches[i - 1].received : 0) && b.period === 1 / rate && b.count <= 64), `${kind}: canonical source batches stay contiguous with exact period`);
    if (!native) {
      const m = result.steady;
      check(m.paints >= 30 && m.unchangedReceivedSteps >= 10 && m.betweenBatchMotionFraction >= .7 && m.positiveMotionFraction >= .85,
        `${kind}: continuous viewport motion between 64-column deliveries`, { paints: m.paints, unchangedReceivedSteps: m.unchangedReceivedSteps, movingBetweenBatches: m.movingBetweenBatches, fraction: m.betweenBatchMotionFraction, zeroSteps: m.zeroSteps });
      check(m.reverseSteps === 0 && m.velocityColumnsPerSecond.p50 > rate * .5 && m.velocityColumnsPerSecond.p50 < rate * 1.5,
        `${kind}: steady motion preserves forward source rate without an FPS threshold`, { medianColumnsPerSecond: m.velocityColumnsPerSecond.p50, reverseSteps: m.reverseSteps });
    } else check(result.steady.positiveSteps > 3 && result.steady.reverseSteps === 0, `${kind}: stress viewport advances monotonically`);

    // Independent full-source oracle: compare every byte and IEEE754 timestamp with
    // an unthrottled replay, including preroll and indefinitely repeated final columns.
    const fd = openSync(path.join(captureDir, 'columns.bin'), 'r'), times = readFileSync(path.join(captureDir, 'times.f64'));
    const count = times.length / 8; let first = 0, timestampMismatches = 0, pixelMismatches = 0;
    const expectedPixels = createHash('sha256'), expectedTimes = createHash('sha256');
    try {
      requireThat(Number.isInteger(count), 'Timestamp file has partial double');
      for await (const msg of simReplay({ png, sidecar, realtime: false, preRollFrom: 0, holdOpen: true })) {
        if (msg.type !== 'columns') continue;
        requireThat(first + msg.count <= count, 'Capture ended in a partial source batch');
        const actual = Buffer.alloc(msg.data.length), n = readSync(fd, actual, 0, actual.length, first * rows * 3);
        if (n !== actual.length || !actual.equals(Buffer.from(msg.data))) pixelMismatches++;
        expectedPixels.update(msg.data); const timeBytes = Buffer.alloc(msg.count * 8);
        for (let i = 0; i < msg.count; i++) {
          const expected = msg.firstHwTime + i * msg.period;
          timeBytes.writeDoubleLE(expected, i * 8);
          if (times.readDoubleLE((first + i) * 8) !== expected) timestampMismatches++;
        }
        expectedTimes.update(timeBytes); first += msg.count; if (first === count) break;
      }
    } finally { closeSync(fd); }
    result.evidence = { count, pixelMismatchedBatches: pixelMismatches, timestampMismatches,
      columnsBytes: statSync(path.join(captureDir, 'columns.bin')).size, timesBytes: times.length,
      expectedColumnsSha256: expectedPixels.digest('hex'), expectedTimesSha256: expectedTimes.digest('hex'), ...evidence(captureDir, rows) };
    check(first === count && count === trace.batches.at(-1)?.received && result.evidence.columnsBytes === count * rows * 3 && timestampMismatches === 0 && pixelMismatches === 0,
      `${kind}: all captured pixels and float64 times exactly match untouched source replay`, result.evidence);
    await shot('04-review'); await probe('stop');
    result.rendererAfter = sourceVersion(); result.rendererChangedDuringRun = JSON.stringify(result.rendererBefore) !== JSON.stringify(result.rendererAfter);
    check(runtimeErrors.length === 0, `${kind}: no renderer runtime errors`, runtimeErrors);
    result.pass = !report.assertions.some(a => a.name.startsWith(kind + ':') && !a.pass);
  } catch (error) {
    result.error = error.stack || String(error); result.pass = false;
    console.error('SCENARIO_ERROR', kind, result.error);
    if (probeId && !closed && !expired) try { trace = await probe('snapshot'); json(path.join(root, 'trace.json'), trace); } catch {}
    if (send && !closed && !expired) try { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(root, 'failure.png'), Buffer.from(r.data, 'base64')); } catch {}
  } finally {
    if (watchdog) clearTimeout(watchdog);
    try { ws?.close(); } catch {}
    killGroup('SIGTERM'); await sleep(500); killGroup('SIGKILL');
    process.removeListener('SIGINT', signalHandler); process.removeListener('SIGTERM', signalHandler);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('Scenario cleanup')); } pending.clear();
    result.runtimeErrors = runtimeErrors; result.processExitCode = proc?.exitCode; result.processSignal = proc?.signalCode;
    writeFileSync(path.join(root, 'electron.log'), plog); json(path.join(root, 'result.json'), result);
    json(path.join(outDir, 'report.json'), report);
  }
  console.log('SCENARIO_RESULT', kind, result.pass ? 'PASS' : 'FAIL', path.join(root, 'result.json'));
}

for (const kind of scenario === 'all' ? ['ordinary', 'native'] : [scenario]) { if (interrupted) break; await runCase(kind); }
check(['primary.json', 'primary.png'].every(n => sha(readFileSync(path.join(demoDir, 'heat-1', n))) === originalSourceHash[n]), 'original demo source pixels and timing sidecar unchanged');
report.finishedAt = new Date().toISOString();
report.pass = report.results.every(r => r.pass) && report.assertions.every(a => a.pass);
json(path.join(outDir, 'report.json'), report);
console.log(report.pass ? 'PASS live-follow' : 'FAIL live-follow', path.join(outDir, 'report.json'));
process.exitCode = report.pass ? 0 : 1;
