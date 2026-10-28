import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import vm from 'node:vm';
import { createScoreboardServer } from './server.js';
import { createTemplate } from './templates.js';

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openmeet-server-'));
  await createTemplate(root, 'classic');
  const server = createScoreboardServer({ root, host: '127.0.0.1' });
  await server.listen();
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  return { root, server, base: `http://127.0.0.1:${server.port}` };
}

// Raw http preserves ../ for security tests; fetch normalizes those paths.
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, res => {
      const chunks = []; res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
  });
}

async function feed(t, base) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(base + '/scoreboard/feed', { signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  return async function next() {
    for (;;) {
      const split = buffer.indexOf('\n\n');
      if (split !== -1) {
        const message = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const event = message.match(/^event: (.+)$/m), data = message.match(/^data: (.+)$/m);
        if (event && data) return { event: event[1], data: JSON.parse(data[1]) };
        continue;
      }
      const item = await reader.read();
      if (item.done) throw new Error('Feed closed');
      buffer += decoder.decode(item.value, { stream: true });
    }
  };
}

test('HTTP serves classic, JSON, runtime, asset MIME, CSP and no-store', async t => {
  const { root, server } = await setup(t);
  assert.equal(server.url('classic'), `http://127.0.0.1:${server.port}/scoreboard/classic/`);
  const page = await get(server.port, '/scoreboard/classic/');
  assert.equal(page.status, 200); assert.match(page.body, /src="\/scoreboard\/runtime.js"/);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['content-security-policy'], "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'");
  assert.equal((await get(server.port, '/scoreboard/classic')).status, 308);
  await writeFile(path.join(root, 'classic/assets/test.svg'), '<svg/>');
  assert.equal((await get(server.port, '/scoreboard/classic/assets/test.svg')).headers['content-type'], 'image/svg+xml');
  assert.equal(JSON.parse((await get(server.port, '/scoreboard/state')).body).clock.frozenS, 0);
  assert.match((await get(server.port, '/scoreboard/runtime.js')).headers['content-type'], /javascript/);
});

test('SSE delivers initial state, published updates, and latest state on reconnect', { timeout: 8000 }, async t => {
  const { server, base } = await setup(t), next = await feed(t, base);
  const initial = await next(); assert.equal(initial.event, 'state'); assert.deepEqual(initial.data.lanes, []);
  assert.equal((await next()).event, 'version');
  server.publish({ meet: { name: 'District meet' }, clock: { running: true, startedAtMs: 1000, speed: 2 } });
  const update = await next(); assert.equal(update.data.meet.name, 'District meet'); assert.equal(update.data.clock.speed, 2);
  const again = await feed(t, base); assert.equal((await again()).data.meet.name, 'District meet');
  const saved = JSON.parse((await get(server.port, '/scoreboard/state')).body);
  assert.equal(saved.meet.name, 'District meet');
});

test('traversal, encoded traversal, hidden history, and symlink escapes are blocked', async t => {
  const { root, server } = await setup(t);
  await writeFile(path.join(root, 'secret.txt'), 'secret');
  await symlink(root, path.join(root, 'classic/assets/escape'));
  await symlink(path.join(root, 'secret.txt'), path.join(root, 'classic/assets/link.txt'));
  for (const urlPath of [
    '/scoreboard/classic/../../secret.txt', '/scoreboard/classic/%2e%2e/secret.txt',
    '/scoreboard/classic/%252e%252e%252fsecret.txt', '/scoreboard/classic/..%5csecret.txt',
    '/scoreboard/classic/%2F..%2Fsecret.txt', '/scoreboard/classic/.history/1/index.html',
    '/scoreboard/classic/assets/escape/secret.txt', '/scoreboard/classic/assets/link.txt',
    '/scoreboard/classic/%00.html', '/scoreboard/classic/%E0%A4%A',
  ]) {
    const result = await get(server.port, urlPath);
    assert.ok([403, 404].includes(result.status), `${urlPath}: ${result.status}`);
    assert.doesNotMatch(result.body, /secret/);
  }
});

test('nested template edits bump that template version and close releases feeds', { timeout: 8000 }, async t => {
  const { root, server, base } = await setup(t), next = await feed(t, base);
  await next(); const initial = (await next()).data.classic;
  await mkdir(path.join(root, 'classic/assets/nested'));
  await writeFile(path.join(root, 'classic/assets/nested/logo.svg'), '<svg/>');
  let changed;
  while (!changed || changed === initial) { const event = await next(); if (event.event === 'version') changed = event.data.classic; }
  assert.notEqual(changed, initial);
  await server.close(); await server.close();
  await assert.rejects(fetch(base + '/scoreboard/state'));
});

test('runtime parses, delivers current state immediately, reconnect versions reload and clock math is right', async t => {
  const { server } = await setup(t);
  const script = (await get(server.port, '/scoreboard/runtime.js')).body;
  const handlers = {}, sources = []; let reloads = 0;
  class EventSource {
    constructor(url) { assert.equal(url, '/scoreboard/feed'); sources.push(this); }
    addEventListener(name, callback) { handlers[name] = callback; }
    close() {}
  }
  const context = { window: {}, Date: { now: () => 6000 }, EventSource, console,
    location: { pathname: '/scoreboard/classic/', reload() { reloads++; } }, addEventListener() {} };
  vm.runInNewContext(script, context);
  const api = context.window.OpenMeetScoreboard;
  assert.equal(api.raceTime({ clock: { running: true, startedAtMs: 1000, speed: 2 } }), 10);
  assert.equal(api.raceTime({ clock: { running: false, frozenS: 11.82 } }), 11.82);
  assert.equal(api.raceTime({ clock: { running: true, startedAtMs: 7000, speed: 4 } }), 0);
  assert.equal(api.raceTime({ clock: { running: true, startedAtMs: 0, speed: 0 } }), 0);
  assert.equal(api.raceTime(null), 0);
  const received = [], unsub = api.onData(s => received.push(s));
  assert.equal(received.length, 0);
  handlers.state({ data: '{"meet":{"name":"Test"}}' });
  assert.equal(received.length, 1);
  let immediate;
  api.onData(s => { immediate = s; }); assert.equal(immediate.meet.name, 'Test');
  unsub(); handlers.state({ data: '{}' }); assert.equal(received.length, 1);
  handlers.version({ data: '{"classic":"a"}' }); assert.equal(reloads, 0);
  handlers.version({ data: '{"classic":"a","other":"b"}' }); assert.equal(reloads, 0);
  handlers.version({ data: '{"classic":"b"}' }); assert.equal(reloads, 1);
  assert.equal(sources.length, 1);
});
