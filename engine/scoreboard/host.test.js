import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, cp, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { fakeMuseEnv } from './testing/fake-muse.js';

test('host methods start once, publish, manage templates/assets, run a preset and restore over RPC', { timeout: 10000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openmeet-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Emulate Electron's parentPort through Node IPC without importing Electron.
  const adapter = path.join(root, 'host-adapter.mjs');
  await writeFile(adapter, `import {EventEmitter} from 'node:events';
process.parentPort = new EventEmitter();
process.parentPort.postMessage = message => process.send(message);
process.on('message', data => process.parentPort.emit('message', {data}));
await import(${JSON.stringify(new URL('../../app/engine-host.mjs', import.meta.url).href)});`);
  const bin = path.join(root, 'bin');
  // The host accepts presets only. Put a fake Muse executable first in this test's PATH.
  const env = await fakeMuseEnv(bin, `const fs=require('node:fs');
fs.writeFileSync('argv.json',JSON.stringify(argv));
fs.writeSync(1,'preset output\\n');fs.appendFileSync('index.html','<!-- host edit -->');`);
  const child = fork(adapter, [root], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.resume(); child.stderr.resume();
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  const pending = new Map(), events = []; let id = 0;
  child.on('message', message => {
    if (message.event) events.push(message);
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); message.error ? callback.reject(new Error(message.error)) : callback.resolve(message.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id; pending.set(requestId, { resolve, reject }); child.send({ id: requestId, method, params });
  });
  const [a, b] = await Promise.all([call('scoreboard.start'), call('scoreboard.start')]);
  assert.equal(a.url, b.url); assert.equal(a.port, b.port); assert.ok(a.port > 0);
  assert.match(await (await fetch(a.url)).text(), /\/scoreboard\/runtime.js/);
  const state = await call('scoreboard.publish', { state: { meet: { name: 'RPC meet' } } });
  assert.equal(state.meet.name, 'RPC meet');
  assert.equal((await (await fetch(`http://127.0.0.1:${a.port}/scoreboard/state`)).json()).meet.name, 'RPC meet');
  assert.deepEqual((await call('scoreboard.list')).map(v => v.name), ['classic']);
  await call('scoreboard.create', { name: 'overlay', from: 'results-ticker' });
  const logo = path.join(root, 'Logo.svg'); await writeFile(logo, '<svg/>');
  assert.match(await call('scoreboard.addAsset', { name: 'overlay', path: logo }), /^assets\/logo-/);
  const result = await call('scoreboard.agent', { name: 'overlay', request: 'Add a footer', preset: 'muse' });
  assert.equal(result.code, 0, result.error); assert.equal(result.restored, false);
  assert.ok(events.some(v => v.event === 'scoreboard.agentOutput' && v.data.name === 'overlay' && v.data.line === 'preset output'));
  const index = path.join(root, 'scoreboards/overlay/index.html');
  const argv = JSON.parse(await readFile(path.join(root, 'scoreboards/overlay/argv.json'), 'utf8'));
  assert.deepEqual(argv.slice(0, 5), ['exec', '--workspace', await realpath(path.dirname(index)), '--disable-web-tools', '--user-input-auto-resolve']);
  assert.equal(argv.length, 6); assert.match(argv[5], /Add a footer/);
  assert.match(await readFile(index, 'utf8'), /host edit/);
  await call('scoreboard.restore', { name: 'overlay', snapshotId: result.snapshotId });
  assert.doesNotMatch(await readFile(index, 'utf8'), /host edit/);
  await assert.rejects(call('scoreboard.agent', { name: 'overlay', request: 'x', preset: 'unknown' }), /Unknown scoreboard agent preset/);
});

test('JS-only packaged engine creates both built-ins and composes a contract without docs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openmeet-packaged-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('./', import.meta.url)), packaged = path.join(root, 'engine/scoreboard');
  await cp(source, packaged, { recursive: true, filter: file => !file.endsWith('.test.js') });
  await writeFile(path.join(root, 'engine/package.json'), '{"type":"module"}');
  const api = await import(pathToFileURL(path.join(packaged, 'index.js')).href);
  const library = path.join(root, 'library');
  await api.createTemplate(library, 'classic');
  await api.createTemplate(library, 'ticker', { from: 'results-ticker' });
  const fake = path.join(root, 'fake.cjs');
  await writeFile(fake, "require('node:fs').writeFileSync('prompt.txt',process.argv[2]);");
  const result = await api.runScoreboardAgent({ root: library, name: 'classic', request: 'Test packaging', agent: { command: process.execPath, args: [fake, '{prompt}'] } });
  assert.equal(result.code, 0);
  const prompt = await readFile(path.join(library, 'classic/prompt.txt'), 'utf8');
  assert.match(prompt, /OpenMeet scoreboard data contract v1/);
  assert.match(prompt, /startedAtMs/);
  assert.match(await readFile(path.join(library, 'ticker/index.html'), 'utf8'), /background:transparent/);
});
