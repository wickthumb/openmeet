import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './files.js';

const SIDES = new Set(['inside', 'outside', 'unspecified']);
const DIRECTIONS = new Set(['normal', 'reverse']);
const own = (o, key) => Object.hasOwn(o, key);
const copy = value => structuredClone(value);
function idValue(value, kind) {
  if (typeof value !== 'string' || !/^[\w-]+$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw Error(`Invalid ${kind} id`);
  return value;
}
function nameValue(value, kind) {
  if (typeof value !== 'string' || !value.trim()) throw Error(`${kind} needs a name`);
  return value.trim();
}

// Synchronous transactions keep concurrent RPC edits ordered, including initialization.
export function createCameraConfig({ sampleDir, cameras = () => [], onSetupChange = () => {} }) {
  const fileFor = meetDir => path.join(path.resolve(meetDir || sampleDir), 'openmeet', 'camera-setup.json');
  function revision(config, values) {
    const previous = own(config.setups, values.cameraId) ? config.setups[values.cameraId] : null;
    const setup = { ...values, revision: (previous?.revision || 0) + 1,
      effectiveAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.effectiveAt) + 1 : 0)).toISOString() };
    config.setups[values.cameraId] = setup;
    config.history.push(copy(setup));
    return setup;
  }
  function load(meetDir) {
    const file = fileFor(meetDir);
    let config, changed = false;
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      config = { version: 1, locations: [{ id: 'home', name: 'Home finish' }], setups: {}, history: [], heats: {} };
      changed = true;
    }
    if (config.version !== 1 || !Array.isArray(config.locations) || !config.setups || !Array.isArray(config.history) || !config.heats) throw Error('Unsupported camera setup configuration');
    for (const camera of cameras()) {
      idValue(camera.id, 'camera');
      if (!own(config.setups, camera.id)) {
        revision(config, { cameraId: camera.id, label: camera.label || camera.id, locationId: 'home', side: 'unspecified', direction: 'normal' });
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(file, config);
    return { file, config };
  }
  function location(config, id) {
    if (!config.locations.some(item => item.id === id)) throw Error('Unknown finish location');
  }
  return {
    fileFor,
    get({ meetDir } = {}) { return copy(load(meetDir).config); },
    saveLocation({ meetDir, id, name }) {
      const { file, config } = load(meetDir);
      id = id == null ? `finish-${randomUUID()}` : idValue(id, 'location');
      name = nameValue(name, 'Finish location');
      const existing = config.locations.find(item => item.id === id);
      if (existing) existing.name = name;
      else config.locations.push({ id, name });
      writeJsonAtomic(file, config);
      return copy(config);
    },
    saveSetup({ meetDir, cameraId, label, locationId, side, direction }) {
      idValue(cameraId, 'camera');
      if (!cameras().some(camera => camera.id === cameraId)) throw Error('Unknown camera source');
      if (!SIDES.has(side)) throw Error('Camera side must be inside, outside or unspecified');
      if (!DIRECTIONS.has(direction)) throw Error('Camera direction must be normal or reverse');
      const { file, config } = load(meetDir);
      location(config, locationId);
      const previousSetup = copy(config.setups[cameraId]);
      const setup = revision(config, { cameraId, label: nameValue(label, 'Camera'), locationId, side, direction });
      writeJsonAtomic(file, config);
      onSetupChange({ file, cameraId, previousSetup, setup: copy(setup) });
      return copy(config);
    },
    assignHeat({ meetDir, heatKey, locationId, timingCameraId }) {
      if (typeof heatKey !== 'string' || !heatKey.trim() || ['__proto__', 'constructor', 'prototype'].includes(heatKey)) throw Error('Heat needs a key');
      if (!cameras().some(camera => camera.id === timingCameraId)) throw Error('Unknown camera source');
      const { file, config } = load(meetDir);
      location(config, locationId);
      if (config.setups[timingCameraId]?.locationId !== locationId) throw Error('Timing camera must match the selected finish location');
      config.heats[heatKey] = { locationId, timingCameraId };
      writeJsonAtomic(file, config);
      return copy(config);
    },
  };
}
