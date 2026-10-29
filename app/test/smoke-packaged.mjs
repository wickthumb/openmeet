// Node 22.12+; no Electron/dev dependencies needed by this test runner.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.argv[2];
if (!binary) {
  console.error('Usage: node app/test/smoke-packaged.mjs <path-to-binary> [electron-test-flags...]');
  process.exit(1);
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('CDP connection closed'));
    }
    pending.clear();
  });
  return {
    socket,
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

const userData = await mkdtemp(path.join(tmpdir(), 'openmeet-smoke-'));
let child;
let cdp;
let exited;
let stopped = false;
let logs = '';
const capture = chunk => { logs = (logs + chunk.toString()).slice(-16_000); };
try {
  const port = await unusedPort();
  const executable = path.resolve(binary);
  console.log(`Launching ${executable}`);
  // A separate process group lets cleanup stop Chromium and the utility process too.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(executable, [
    ...process.argv.slice(3),
    '--ozone-platform=headless',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
  ], { env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  let launchError;
  exited = new Promise(resolve => {
    child.once('error', error => { launchError = error; stopped = true; resolve(); });
    child.once('exit', () => { stopped = true; resolve(); });
  });

  const deadline = Date.now() + 45_000;
  let page;
  while (Date.now() < deadline) {
    if (stopped) throw launchError || new Error(`OpenMeet exited before CDP was ready (${child.exitCode ?? child.signalCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      const targets = await response.json();
      page = targets.find(target => target.type === 'page' && target.url.startsWith('file:') && target.url.endsWith('/renderer/index.html'));
      if (page?.webSocketDebuggerUrl) break;
    } catch { /* Chromium has not opened its debugging endpoint yet. */ }
    await delay(200);
  }
  assert.ok(page?.webSocketDebuggerUrl, 'OpenMeet renderer did not appear within 45 seconds');
  cdp = await connect(page.webSocketDebuggerUrl);
  console.log(`CDP connected: ${page.url}`);

  let ready = false;
  while (Date.now() < deadline) {
    const result = await cdp.call('Runtime.evaluate', {
      expression: "typeof window.openmeet?.call === 'function'",
      returnByValue: true,
    });
    if (result.result.value === true) { ready = true; break; }
    await delay(100);
  }
  assert.ok(ready, 'Preload did not expose window.openmeet.call');
  const evaluation = await cdp.call('Runtime.evaluate', {
    expression: "window.openmeet.call('ping')",
    awaitPromise: true,
    returnByValue: true,
  });
  assert.equal(evaluation.exceptionDetails, undefined, JSON.stringify(evaluation.exceptionDetails));
  const ping = evaluation.result.value;
  console.log(`ping: ${JSON.stringify(ping)}`);
  assert.equal(ping?.ok, true, 'Engine ping failed');
  assert.equal(ping?.core, true, 'Packaged engine core was not loaded');
  console.log('PASS: packaged OpenMeet engine returned core: true');
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  if (logs) console.error(logs);
  process.exitCode = 1;
} finally {
  cdp?.socket.close();
  if (child?.pid) {
    const kill = signal => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    kill('SIGTERM');
    if (!stopped) await Promise.race([exited, delay(3000)]);
    kill('SIGKILL');
    await exited;
  }
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
