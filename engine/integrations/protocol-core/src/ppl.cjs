'use strict';

// Independent implementation of the released PPL-v1 logical-record contract.
const fields = Object.freeze(['last', 'first', 'affiliation', 'license', 'user1', 'user2', 'user3']);
const trim = text => text.replace(/^[ \t]+|[ \t]+$/g, '');

function extract(text) {
  const result = [];
  let start = 0;
  for (;;) {
    let end = text.indexOf(',', start);
    if (end < 0) end = text.length;
    let opening = start;
    while (text[opening] === ' ' || text[opening] === '\t') opening++;
    let value;
    if (text[opening] === '"') {
      for (let closing = opening + 1; closing < text.length; closing++) {
        if (text[closing] !== '"') continue;
        let after = closing + 1;
        while (text[after] === ' ' || text[after] === '\t') after++;
        if (after === text.length || text[after] === ',') {
          value = text.slice(opening + 1, closing);
          end = after;
          break;
        }
      }
    }
    result.push(value === undefined ? text.slice(start, end) : value);
    if (end === text.length) return result;
    start = end + 1;
  }
}

function lookup(row, records, overwrite = false, onChange) {
  const changed = [];
  if (row === null || row === undefined || row.id === '' ||
      (!overwrite && fields.every(field => row[field] !== ''))) {
    return { found: false, row: row ?? null, changed };
  }
  for (const record of records) {
    const values = extract(record);
    if (values[0] !== row.id) continue;
    fields.forEach((field, index) => {
      if ((overwrite || row[field] === '') && index + 1 < values.length) {
        const value = trim(values[index + 1]);
        if (row[field] !== value) {
          row[field] = value;
          changed.push(field);
          if (onChange) onChange(field, value, row);
        }
      }
    });
    return { found: true, row, changed };
  }
  return { found: false, row, changed };
}

function availability(state, { interval, now, exists }) {
  if (!Number.isInteger(interval) || interval < -2147483648 || interval > 2147483647)
    throw new RangeError('interval must be signed32');
  if (interval < 0) {
    state.deadline = 0;
    return { state, result: Boolean(exists()), probe: true };
  }
  if (state.deadline !== 0 && ((now - state.deadline) | 0) < 0) {
    state.fresh = false;
    return { state, result: state.previousExists, probe: false };
  }
  const result = Boolean(exists());
  state.deadline = interval > 0 ? (now + interval) >>> 0 : 0;
  state.fresh = state.previousExists = result;
  return { state, result, probe: true };
}

function metadataDifferent(oldValue, newValue) {
  if (!Array.isArray(oldValue) || oldValue.length !== 8 ||
      !Array.isArray(newValue) || newValue.length !== 8 ||
      !oldValue.every(Number.isInteger) || !newValue.every(Number.isInteger))
    throw new TypeError('Two explicit eight-integer metadata arrays required');
  return oldValue.some((value, index) => index !== 3 && value !== newValue[index]);
}

function rebuild(cache, records, allocationBudget = null) {
  if (allocationBudget !== null && (!Number.isInteger(allocationBudget) || allocationBudget < 0))
    throw new RangeError('allocationBudget must be null or a nonnegative integer');
  let used = 0;
  let remaining = allocationBudget;
  for (const record of records) {
    if (extract(record)[0] === '') continue;
    if (used === cache.length) {
      if (remaining === 0) break;
      if (remaining !== null) remaining--;
    }
    cache[used++] = record;
  }
  cache.length = used;
  return cache;
}

function createState(savedMetadata) {
  return { deadline: 0, fresh: false, previousExists: false,
    savedMetadata: savedMetadata ? [...savedMetadata] : Array(8).fill(-1), cache: [], streamOpen: false };
}

// Source supplies stable logical records and resolved metadata, never physical IO.
function prepare(state, interval, source, allocationBudget = null) {
  if (interval < 0) {
    source.open();
    state.streamOpen = true;
    return;
  }
  if (!state.fresh) return;
  const sampled = source.metadata();
  if (metadataDifferent(state.savedMetadata, sampled)) {
    source.open();
    state.streamOpen = true;
    rebuild(state.cache, source.records(), allocationBudget);
    source.close();
    state.streamOpen = false;
    state.savedMetadata = [...sampled];
  }
  state.fresh = false;
}

function preparedLookup(state, interval, source, row, overwrite = false, onChange) {
  const records = interval < 0 ? (function* () {
    source.rewind();
    yield* source.records();
  })() : state.cache;
  return lookup(row, records, overwrite, onChange);
}

function cleanup(state, interval, source) {
  if (interval < 0) {
    source.close();
    state.streamOpen = false;
  } else if (state.fresh) {
    source.close();
    state.streamOpen = false;
    state.previousExists = false;
    state.fresh = false;
  }
}

function operate(state, { mode, characterMode, interval, now, row, overwrite = false,
  allocationBudget = null }, source, onChange) {
  if (mode !== 'file' || typeof characterMode !== 'string' || !characterMode)
    throw new Error('Requires file mode and externally resolved characterMode');
  if (!availability(state, { interval, now, exists: () => source.exists() }).result)
    return { found: false, row: row ?? null, changed: [] };
  prepare(state, interval, source, allocationBudget);
  const result = preparedLookup(state, interval, source, row, overwrite, onChange);
  cleanup(state, interval, source);
  return result;
}

module.exports = { fields, extract, lookup, availability, metadataDifferent, rebuild,
  createState, prepare, preparedLookup, cleanup, operate };
