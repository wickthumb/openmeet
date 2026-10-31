'use strict';
// Independent implementation of the supplied EVT-v1 behavioral release.
const ppl = require('./ppl.cjs');
const trim = text => text.replace(/^[ \t]+|[ \t]+$/g, '');
const clone = value => JSON.parse(JSON.stringify(value));
const mapping = [[0,'id'],[1,'lane'],[2,'last'],[3,'first'],[4,'affiliation'],
  [6,'license'],[11,'user1'],[12,'user2'],[13,'user3']];

function logicalRecords(text) {
  // Released ASCII profile: control-Z terminates the logical file.
  return text.replace(/\r\n/g, '\n').split('\x1a', 1)[0].split('\n')
    .filter(line => line !== '' && line[0] !== ';');
}
function validate(profile, fault) {
  const required = { databaseMode:1, databaseFormat:0, charMode:0,
    normalizedNewlineMode:1, statusPrefixCodeUnit:0, eventTimeTrialFlag:false,
    allAllocationsSucceed:true, callbacksStable:true, optionalHeaderFieldsAbsent:true,
    selectedGroupCount:1, sortingProvider:null };
  for (const [key, value] of Object.entries(required)) {
    if (profile[key] !== value) throw new Error('Unsupported EVT profile: ' + key);
  }
  if (typeof profile.managerImportEnabled !== 'boolean' ||
      typeof profile.pplAvailability !== 'boolean' || !Array.isArray(profile.pplRecords) ||
      typeof profile.selectedTableToken !== 'string' ||
      !profile.constructorTime || profile.constructorTime.ticks !== 0 ||
      profile.constructorTime.quantum !== 0 || profile.constructorTime.origin !== -1)
    throw new Error('Explicit released providers required');
  if (fault !== undefined) {
    if (!Number.isInteger(fault) || fault < 0 ||
        profile.exceptionContinuation !== 'selected-matching-handler-returns')
      throw new Error('Unsupported fault continuation');
  } else if (!profile.allIoSucceeds || profile.exceptionContinuation !== 'ordinary-no-error') {
    throw new Error('Unsupported general IO/exception profile');
  }
}

// Callbacks observe already appended rows and each actual text change.
function importNormal({request, fileExists, logicalText, initialEvent = null,
  profile, providers = {}, faultBeforeEntry}, observers = {}) {
  const p = {...profile, ...providers}; // Nested providers replace complete objects.
  validate(p, faultBeforeEntry);
  const result = {returnEvent:null, event:initialEvent, oldRowsDestroyed:false,
    createdNewEvent:false, destroyedNewEvent:false, foundHeaderLine:null, stopReason:'no-evt'};
  if (!fileExists) return result;
  if (/[^\x00-\x7f]/.test(logicalText) || /\r(?!\n)/.test(logicalText))
    throw new Error('Unsupported text outside released ASCII/newline profile');
  const records = logicalRecords(logicalText);
  let header, index;
  for (index = 0; index < records.length; index++) {
    const fields = ppl.extract(records[index]);
    const identity = [trim(fields[0]), trim(fields[1] ?? '') || '1', trim(fields[2] ?? '') || '1'];
    if (identity[0] && identity.every((value, i) => value === request[['event','round','heat'][i]])) {
      header = fields;
      break;
    }
  }
  if (!header) { result.stopReason = 'not-found'; return result; }
  result.foundHeaderLine = records[index];
  let event = initialEvent;
  if (event === null) {
    const n = p.newEventProvider;
    if (!n || n.templateHelperResult !== 0 || typeof n.eventToken !== 'string' ||
        typeof n.postTemplateGroupToken !== 'string' || typeof n.postTemplateTableToken !== 'string' ||
        !Array.isArray(n.postTemplateRows) || !Number.isInteger(n.postTemplateTableFlags) ||
        !Number.isInteger(n.postTemplateFlags)) throw new Error('Unsupported template provider');
    event = {token:n.eventToken, event:'', round:'', heat:'', name:'',
      tableToken:n.postTemplateTableToken, tableFlags:n.postTemplateTableFlags,
      rows:clone(n.postTemplateRows)};
    result.createdNewEvent = true;
    result.event = event;
  }
  Object.assign(event, {event:request.event, round:request.round, heat:request.heat, name:header[3] ?? ''});
  if (!p.managerImportEnabled) {
    result.returnEvent = event.token;
    result.stopReason = 'metadata-only';
    return result;
  }
  if (event.tableToken !== p.selectedTableToken)
    throw new Error('Unsupported distinct selected table binding; see Q4');
  result.oldRowsDestroyed = initialEvent !== null;
  event.rows.length = 0;
  event.tableFlags = 2;
  let admitted = 0;
  result.stopReason = 'eof';
  for (index++; index < records.length; index++) {
    const record = records[index];
    if (![' ', '\t', ','].includes(record[0])) {
      result.stopReason = 'next-unprefixed-record';
      break;
    }
    if (faultBeforeEntry === admitted) {
      result.stopReason = 'selected-read-error-returning-handler';
      if (result.createdNewEvent) { result.event = null; result.destroyedNewEvent = true; }
      return result;
    }
    event.tableFlags |= 1;
    const row = Object.fromEntries(['id','lane',...ppl.fields].map(field => [field,'']));
    row.time = {ticks:0, quantum:0, origin:-1};
    event.rows.push(row);
    if (observers.onAppend) observers.onAppend(row, event);
    const values = ppl.extract(record.replace(/^[ \t]+/, '').replace(/^,/, ''));
    for (const [position, field] of mapping) {
      if (position >= values.length) continue;
      const value = trim(values[position]);
      if (row[field] !== value) {
        row[field] = value;
        if (observers.onChange) observers.onChange(field, value, row, event);
      }
    }
    if (p.pplAvailability) ppl.lookup(row, p.pplRecords, false,
      observers.onChange && ((field,value,current) => observers.onChange(field,value,current,event)));
    admitted++;
  }
  result.returnEvent = event.token;
  return result;
}
module.exports = {importNormal, logicalRecords};

