import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { encodePng, pngChunk, testImage } from '../../engine/sim/png-encode.js';
import { occlusionInfo, requestOcclusion } from '../private-occlusion.mjs';

const contract = 'openmeet-occlusion-v1';
const model = { id: 'fixture-sha256:1234', validation: 'experimental' };
const png = encodePng(testImage(9, 7, 3));
const digest = createHash('sha256').update(png).digest('hex');
const mask = encodePng({ width: 9, height: 7, channels: 1,
  data: Buffer.from(Array.from({ length: 63 }, (_, i) => i % 3 ? 0 : 255)) });
const health = { ready: true, contract, foreground: 'white', model };
const result = { request_id: 'fixture-1', image_sha256: digest, width: 9, height: 7,
  mask_png_base64: mask.toString('base64'), model, foreground: 'white' };
const input = () => ({ png, requestId: 'fixture-1' });

function setup(t) {
  const saved = [process.env.OPENMEET_OCCLUSION_COMMAND, process.env.OPENMEET_OCCLUSION_URL];
  delete process.env.OPENMEET_OCCLUSION_COMMAND;
  delete process.env.OPENMEET_OCCLUSION_URL;
  t.after(() => {
    for (const [i, name] of ['OPENMEET_OCCLUSION_COMMAND', 'OPENMEET_OCCLUSION_URL'].entries()) {
      if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];
    }
  });
}

function worker(value = result, extra = '') {
  process.env.OPENMEET_OCCLUSION_COMMAND = JSON.stringify([process.execPath, '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    let raw='';for await(const chunk of process.stdin)raw+=chunk;
    const request=JSON.parse(raw);
    assert.equal(request.contract,${JSON.stringify(contract)});
    if(request.operation!=='health'){
      const image=Buffer.from(request.image.data_base64,'base64');
      assert.equal(request.image.encoding,'png');
      assert.equal(createHash('sha256').update(image).digest('hex'),request.image_sha256);
      assert.equal(request.width,9);assert.equal(request.height,7);
    }
    ${extra}
    process.stdout.write(JSON.stringify(${JSON.stringify(value)}));
  `]);
}

function http(t, body = result, status = 200) {
  process.env.OPENMEET_OCCLUSION_URL = 'http://private.invalid';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

test('unconfigured and malformed configuration fail closed without exposing it', async t => {
  setup(t);
  assert.equal((await occlusionInfo()).configured, false);
  await assert.rejects(requestOcclusion(input()), { code: 'OCCLUSION_UNCONFIGURED' });
  for (const bad of ['echo unsafe', '{}', '[]', '[""]', '["node",5]', '["nul\\u0000"]']) {
    process.env.OPENMEET_OCCLUSION_COMMAND = bad;
    const info = await occlusionInfo();
    assert.equal(info.ready, false); assert.equal(info.error, 'OCCLUSION_CONFIG');
    await assert.rejects(requestOcclusion(input()), { code: 'OCCLUSION_CONFIG' });
  }
  for (const bad of ['file:///tmp/private', 'https://secret:password@private.invalid', 'bad url']) {
    process.env.OPENMEET_OCCLUSION_URL = bad;
    assert.equal((await occlusionInfo()).error, 'OCCLUSION_CONFIG');
  }
});

test('command health reports bounded capabilities and model validation', async t => {
  setup(t); worker(health);
  const info = await occlusionInfo();
  assert.equal(info.configured, true); assert.equal(info.ready, true);
  assert.equal(info.contract, contract); assert.equal(info.foreground, 'white');
  assert.deepEqual(info.model, model); assert.equal(info.limits.concurrency, 1);
});

test('one command request binds exact derived bytes, preserves input and returns only public fields', async t => {
  setup(t); worker({ ...result, private_path: 'not returned' });
  const before = Buffer.from(png);
  assert.deepEqual(await requestOcclusion(input()), result);
  assert.deepEqual(png, before);
});

test('command arguments remain literal, including shell syntax', async t => {
  setup(t);
  const literal = '$(do-not-run) `do-not-run` ; * > /tmp/never-created';
  worker(result, `assert.equal(process.argv[1],${JSON.stringify(literal)});`);
  const argv = JSON.parse(process.env.OPENMEET_OCCLUSION_COMMAND);
  argv.push(literal); process.env.OPENMEET_OCCLUSION_COMMAND = JSON.stringify(argv);
  assert.deepEqual(await requestOcclusion(input()), result);
});

test('invalid inputs and PNG bombs are rejected before transport', async t => {
  setup(t); const calls = http(t);
  for (const requestId of ['', 'white space', 'x'.repeat(129), '\n', 'é']) {
    await assert.rejects(requestOcclusion({ png, requestId }), { code: 'OCCLUSION_INPUT' });
  }
  for (const bytes of [new Uint8Array(png), Buffer.alloc(16 * 1024 * 1024 + 1)]) {
    await assert.rejects(requestOcclusion({ png: bytes, requestId: 'fixture-1' }), { code: 'OCCLUSION_INPUT' });
  }
  const ihdr = Buffer.from(png.subarray(16, 29));
  ihdr.writeUInt32BE(32769, 0);
  const oversized = Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', ihdr), png.subarray(33)]);
  const bomb = Buffer.concat([png.subarray(0, 33), pngChunk('IDAT', deflateSync(Buffer.alloc(10000))), pngChunk('IEND', Buffer.alloc(0))]);
  for (const bytes of [Buffer.from('not png'), png.subarray(0, -1), oversized, bomb,
    Buffer.concat([png.subarray(0, 33), png.subarray(8)]), Buffer.concat([png, Buffer.from('tail')])]) {
    await assert.rejects(requestOcclusion({ png: bytes, requestId: 'fixture-1' }), { code: 'OCCLUSION_PNG' });
  }
  assert.equal(calls.length, 0);
});

test('snapshot prevents caller mutation between validation and transport', async t => {
  setup(t); http(t);
  const bytes = Buffer.from(png), request = requestOcclusion({ png: bytes, requestId: 'fixture-1' });
  bytes.fill(0);
  assert.deepEqual(await request, result);
});

test('HTTP uses URL precedence and bounded contract endpoints without redirects', async t => {
  setup(t); worker(); const calls = http(t);
  assert.deepEqual(await requestOcclusion(input()), result);
  assert.equal(calls[0].url, 'http://private.invalid/v1/occlusion');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.image_sha256, digest); assert.equal(body.request_id, 'fixture-1');
  assert.equal(body.image.data_base64, png.toString('base64'));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'http://private.invalid/health'); assert.equal(options.method, 'GET');
    return new Response(JSON.stringify(health));
  });
  assert.equal((await occlusionInfo()).ready, true);
});

test('ID, digest, size, polarity, model and base64 mismatches fail closed', async t => {
  setup(t);
  for (const patch of [{ request_id: 'stale' }, { image_sha256: '0'.repeat(64) }, { width: 10 },
    { height: 8 }, { width: '9' }, { foreground: 'black' }, { model: null },
    { model: { id: 'bad\n', validation: 'experimental' } }, { model: { id: 'model', validation: 'approved' } },
    { mask_png_base64: '' }, { mask_png_base64: '%%%%' }, { mask_png_base64: 'AA=A' },
    { mask_png_base64: mask.toString('base64') + '\n' }, { mask_png_base64: 'AB==' }]) {
    http(t, { ...result, ...patch });
    await assert.rejects(requestOcclusion(input()), { code: 'OCCLUSION_INVALID_RESPONSE' });
  }
});

test('mask must decode as binary grayscale at the exact source dimensions', async t => {
  setup(t);
  const wrongSize = encodePng({ width: 1, height: 1, channels: 1, data: Buffer.from([255]) });
  const classIds = encodePng({ width: 9, height: 7, channels: 1, data: Buffer.alloc(63, 1) });
  const corrupt = Buffer.from(mask); corrupt[40] ^= 1;
  for (const [bytes, code] of [[wrongSize, 'INVALID_RESPONSE'], [classIds, 'PNG'], [png, 'PNG'],
    [corrupt, 'PNG'], [Buffer.from('bad PNG'), 'PNG']]) {
    http(t, { ...result, mask_png_base64: bytes.toString('base64') });
    await assert.rejects(requestOcclusion(input()), { code: `OCCLUSION_${code}` });
  }
});

test('provider refusal and failures are never retried or echoed', async t => {
  setup(t);
  for (const [body, code, status] of [[{ refused: true, secret: 'private' }, 'REFUSED', 403],
    [{ error: { code: 'refused', message: 'private' } }, 'REFUSED', 200],
    [{ error: 'private diagnostic' }, 'PROVIDER', 200], [result, 'PROVIDER', 500], [null, 'INVALID_RESPONSE', 200]]) {
    const calls = http(t, body, status);
    await assert.rejects(requestOcclusion(input()), error => {
      assert.equal(error.code, `OCCLUSION_${code}`); assert.ok(!error.message.includes('private diagnostic')); return true;
    });
    assert.equal(calls.length, 1);
  }
  worker({ refused: true }); delete process.env.OPENMEET_OCCLUSION_URL;
  await assert.rejects(requestOcclusion(input()), { code: 'OCCLUSION_REFUSED' });
  worker(result, "process.stderr.write('sensitive diagnostic'); process.exit(1);");
  await assert.rejects(requestOcclusion(input()), error => error.code === 'OCCLUSION_TRANSPORT' && !error.message.includes('sensitive'));
});

test('one request at a time with no queue; health does not race inference', async t => {
  setup(t); process.env.OPENMEET_OCCLUSION_URL = 'http://private.invalid';
  let complete; const started = new Promise(resolve => { complete = resolve; });
  let release;
  t.mock.method(globalThis, 'fetch', async () => { complete(); return new Promise(resolve => { release = resolve; }); });
  const pending = requestOcclusion(input()); await started;
  await assert.rejects(requestOcclusion(input()), { code: 'OCCLUSION_BUSY' });
  assert.equal((await occlusionInfo()).error, 'OCCLUSION_BUSY');
  release(new Response(JSON.stringify(result))); await pending;
  http(t); assert.deepEqual(await requestOcclusion(input()), result);
});

test('HTTP byte limits apply to declared size and streamed bytes', async t => {
  setup(t); process.env.OPENMEET_OCCLUSION_URL = 'http://private.invalid';
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(24 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(requestOcclusion(input()), { code: 'OCCLUSION_LIMIT' }); assert.equal(cancelled, true);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { 'content-length': String(24 * 1024 * 1024 + 1) } }));
  await assert.rejects(requestOcclusion(input()), { code: 'OCCLUSION_LIMIT' });
});

test('HTTP deadline aborts and releases the concurrency slot', async t => {
  setup(t); process.env.OPENMEET_OCCLUSION_URL = 'http://private.invalid';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let start; const started = new Promise(resolve => { start = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    start(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const pending = requestOcclusion(input()); await started;
  const rejected = assert.rejects(pending, { code: 'OCCLUSION_TIMEOUT' });
  t.mock.timers.tick(120000); await rejected;
  http(t); assert.deepEqual(await requestOcclusion(input()), result);
});

test('command stdout and health buffers are bounded and killed workers release the slot', async t => {
  setup(t); worker(result, 'process.stdout.write(Buffer.alloc(24*1024*1024+1,65));');
  await assert.rejects(requestOcclusion(input()), { code: 'OCCLUSION_LIMIT' });
  worker(health, 'process.stdout.write(Buffer.alloc(16385,65));');
  assert.equal((await occlusionInfo()).error, 'OCCLUSION_LIMIT');
  worker(health, 'setInterval(()=>{},1000);await new Promise(()=>{});');
  assert.equal((await occlusionInfo()).error, 'OCCLUSION_TIMEOUT');
  worker(); assert.deepEqual(await requestOcclusion(input()), result);
});

test('health refuses wrong contract, polarity or unvalidated metadata', async t => {
  setup(t);
  for (const patch of [{ contract: 'other' }, { ready: false }, { foreground: 'black' }, { model: null }]) {
    http(t, { ...health, ...patch }); assert.equal((await occlusionInfo()).ready, false);
  }
});
