// Transport and validation only. The private learned model never ships with OpenMeet.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { crc32 } from 'node:zlib';

const CONTRACT = 'openmeet-occlusion-v1';
const LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  maskBytes: 16 * 1024 * 1024,
  responseBytes: 24 * 1024 * 1024,
  pixels: 16 * 1024 * 1024,
  dimension: 32768,
  timeoutMs: 120000,
  healthTimeoutMs: 3000,
  concurrency: 1,
});
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
let active = false;
let decoder;

function fail(code, message) {
  return Object.assign(new Error(message), { code: `OCCLUSION_${code}` });
}

function configuration() {
  // Match the cropper's URL-first precedence. Never include configuration in errors.
  if (process.env.OPENMEET_OCCLUSION_URL) {
    let url;
    try { url = new URL(process.env.OPENMEET_OCCLUSION_URL); } catch { /* below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw fail('CONFIG', 'Invalid private occlusion URL');
    }
    return { url };
  }
  if (!process.env.OPENMEET_OCCLUSION_COMMAND) return null;
  let argv;
  try { argv = JSON.parse(process.env.OPENMEET_OCCLUSION_COMMAND); } catch { /* below */ }
  if (!Array.isArray(argv) || !argv.length || argv.length > 64 || argv.some(a =>
    typeof a !== 'string' || a.includes('\0') || Buffer.byteLength(a) > 8192) || !argv[0].trim()) {
    throw fail('CONFIG', 'Private occlusion command must be a JSON argv array');
  }
  return { argv };
}

function modelInfo(model) {
  if (!model || typeof model.id !== 'string' || !/^[\x21-\x7e]{1,160}$/.test(model.id) ||
      !['experimental', 'independently-validated'].includes(model.validation)) {
    throw fail('INVALID_RESPONSE', 'Invalid occlusion model metadata');
  }
  return { id: model.id, validation: model.validation };
}

// Check dimensions before decoding, and reject structures that could override IHDR.
async function validatePng(png, maxBytes, mask = false) {
  if (!Buffer.isBuffer(png) || png.length > maxBytes || png.length < 45 ||
      !png.subarray(0, 8).equals(SIGNATURE)) throw fail('PNG', 'Invalid or oversized occlusion PNG');
  let offset = 8, width, height, colour, ended = false, sawData = false, dataEnded = false;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw fail('PNG', 'Truncated occlusion PNG');
    const length = png.readUInt32BE(offset), end = offset + 12 + length;
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (end > png.length || !/^[A-Za-z]{4}$/.test(type) ||
        crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) {
      throw fail('PNG', 'Invalid occlusion PNG chunk');
    }
    if (offset === 8) {
      if (type !== 'IHDR' || length !== 13) throw fail('PNG', 'Missing occlusion PNG header');
      width = png.readUInt32BE(16); height = png.readUInt32BE(20); colour = png[25];
      if (!width || !height || width > LIMITS.dimension || height > LIMITS.dimension ||
          width * height > LIMITS.pixels || png[24] !== 8 || ![0, 2, 6].includes(colour) ||
          png[26] || png[27] || png[28] || (mask && colour !== 0)) {
        throw fail('PNG', 'Unsupported occlusion PNG dimensions or format');
      }
    } else if (type === 'IHDR' || type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      throw fail('PNG', 'Duplicate or animated occlusion PNG header');
    }
    if (type === 'IDAT') {
      if (dataEnded) throw fail('PNG', 'Nonconsecutive occlusion PNG data');
      sawData = true;
    } else if (sawData) dataEnded = true;
    if (type === 'IEND') {
      if (length || end !== png.length || !sawData) throw fail('PNG', 'Invalid occlusion PNG ending');
      ended = true;
    }
    offset = end;
  }
  if (!ended) throw fail('PNG', 'Missing occlusion PNG ending');
  // Reuse the app's ordinary PNG codec, including bounded inflate and all row filters.
  decoder ??= import([new URL('./engine/sim/png.js', import.meta.url),
    new URL('../engine/sim/png.js', import.meta.url)].find(url => existsSync(url))?.href ?? './engine/sim/png.js');
  let image;
  try { image = (await decoder).decodePng(png); }
  catch { throw fail('PNG', 'Invalid occlusion PNG pixel data'); }
  if (mask && image.data.some(value => value !== 0 && value !== 255)) {
    throw fail('PNG', 'Occlusion mask must contain only black and white pixels');
  }
  return { width, height };
}

function parseResponse(bytes) {
  let result;
  try { result = JSON.parse(bytes); } catch { throw fail('INVALID_RESPONSE', 'Invalid private occlusion JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw fail('INVALID_RESPONSE', 'Invalid private occlusion response');
  }
  if (result.refused === true || result.status === 'refused' || result.error?.code === 'refused') {
    throw fail('REFUSED', 'Private occlusion provider refused this request');
  }
  if (result.error) throw fail('PROVIDER', 'Private occlusion provider failed');
  return result;
}

async function transport(config, payload, health = false) {
  const timeout = health ? LIMITS.healthTimeoutMs : LIMITS.timeoutMs;
  const maxBytes = health ? 16384 : LIMITS.responseBytes;
  if (config.url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(new URL(health ? '/health' : '/v1/occlusion', config.url), {
        method: health ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        ...(health ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
      });
      if (Number(response.headers.get('content-length')) > maxBytes) {
        throw fail('LIMIT', 'Private occlusion response exceeds byte limit');
      }
      const chunks = []; let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maxBytes) throw fail('LIMIT', 'Private occlusion response exceeds byte limit');
        chunks.push(chunk);
      }
      const result = parseResponse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) throw fail('PROVIDER', 'Private occlusion HTTP request failed');
      return result;
    } catch (error) {
      if (error.code?.startsWith('OCCLUSION_')) throw error;
      throw fail(controller.signal.aborted ? 'TIMEOUT' : 'TRANSPORT', 'Private occlusion HTTP request failed');
    } finally { controller.abort(); clearTimeout(timer); }
  }
  return new Promise((resolve, reject) => {
    const child = execFile(config.argv[0], config.argv.slice(1), {
      timeout, maxBuffer: maxBytes, killSignal: 'SIGKILL', windowsHide: true, shell: false,
    }, (error, stdout) => {
      if (error) {
        const code = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'LIMIT' : error.killed ? 'TIMEOUT' : 'TRANSPORT';
        reject(fail(code, 'Private occlusion worker failed')); return;
      }
      try { resolve(parseResponse(stdout)); } catch (err) { reject(err); }
    });
    // Broken pipes and provider diagnostics must never leak images, paths or secrets.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Probe configuration/health without retaining images or launching a server. */
export async function occlusionInfo() {
  const base = { configured: false, ready: false, contract: CONTRACT, foreground: 'white', limits: { ...LIMITS } };
  let config;
  try { config = configuration(); }
  catch (error) { return { ...base, configured: true, error: error.code }; }
  if (!config) return base;
  if (active) return { ...base, configured: true, error: 'OCCLUSION_BUSY' };
  active = true;
  try {
    const info = await transport(config, { operation: 'health', contract: CONTRACT }, true);
    if (info.ready !== true || info.contract !== CONTRACT || info.foreground !== 'white') {
      throw fail('INVALID_RESPONSE', 'Private occlusion worker is not ready for this contract');
    }
    return { ...base, configured: true, ready: true, model: modelInfo(info.model) };
  } catch (error) { return { ...base, configured: true, error: error.code ?? 'OCCLUSION_TRANSPORT' }; }
  finally { active = false; }
}

/** Send one derived PNG; return a validated, image-bound binary BODY mask. No retries. */
export async function requestOcclusion({ png, requestId } = {}) {
  if (typeof requestId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(requestId)) {
    throw fail('INPUT', 'Occlusion request ID must be 1–128 printable non-space ASCII characters');
  }
  if (!Buffer.isBuffer(png) || png.length > LIMITS.inputBytes) throw fail('INPUT', 'Expected a bounded PNG Buffer');
  if (active) throw fail('BUSY', 'A private occlusion request is already running');
  const config = configuration();
  if (!config) throw fail('UNCONFIGURED', 'Configure a private occlusion worker first');
  active = true;
  try {
    // Snapshot before the first await so a caller cannot change the image/hash pairing.
    const image = Buffer.from(png);
    const dimensions = await validatePng(image, LIMITS.inputBytes);
    const digest = createHash('sha256').update(image).digest('hex');
    const result = await transport(config, {
      contract: CONTRACT, request_id: requestId, image_sha256: digest,
      ...dimensions, image: { encoding: 'png', data_base64: image.toString('base64') },
    });
    if (result.request_id !== requestId || result.image_sha256 !== digest ||
        result.width !== dimensions.width || result.height !== dimensions.height || result.foreground !== 'white') {
      throw fail('INVALID_RESPONSE', 'Private occlusion response does not match the requested image');
    }
    const model = modelInfo(result.model), encoded = result.mask_png_base64;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(LIMITS.maskBytes / 3) ||
        encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw fail('INVALID_RESPONSE', 'Invalid occlusion mask encoding');
    }
    const mask = Buffer.from(encoded, 'base64');
    if (mask.toString('base64') !== encoded) throw fail('INVALID_RESPONSE', 'Noncanonical occlusion mask encoding');
    const maskSize = await validatePng(mask, LIMITS.maskBytes, true);
    if (maskSize.width !== dimensions.width || maskSize.height !== dimensions.height) {
      throw fail('INVALID_RESPONSE', 'Occlusion mask dimensions do not match the image');
    }
    return { request_id: requestId, image_sha256: digest, ...dimensions,
      mask_png_base64: encoded, model, foreground: 'white' };
  } finally { active = false; }
}
