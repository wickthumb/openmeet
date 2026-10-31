'use strict';
// Independent implementation of the released, source-informed RESULT projection.
const copyTime = t => ({ ticks: t.ticks, quantum: t.quantum, origin: t.origin });
const equalTime = (a, b) => a.ticks === b.ticks && a.quantum === b.quantum && a.origin === b.origin;
const assignmentAdmitted = t => t.quantum !== 0 || t.origin === -99;
const numericValid = t => t.quantum > 0;
function unsupported(message) { throw new RangeError('Unsupported RESULT binding: ' + message); }
function validateCursor(cursor, width, height) {
  if (cursor.x < 0 || cursor.y < 0 || cursor.x >= width || cursor.y >= height) cursor.active = false;
  return cursor.active;
}
// Providers are synchronous, stable and nonreentrant. Rows are owned mutable objects.
function assign(options, providers) {
  const o = options, p = providers;
  if (o.timeTrial || o.optionalPostAssignmentImageAutomation || (o.parentNotificationBatchDepth ?? 0) !== 0)
    unsupported('TT, automation or inherited batching');
  if (o.specialImage && !o.cursorActive) unsupported('special/inactive precedence');
  let row = o.target ?? null;
  const output = { prompts: [], snapshots: [], effects: [], row, candidateReads: 0 };
  const finish = result => ({ result, ...output, row });
  const effect = name => output.effects.push(name);
  if (o.specialImage) {
    if (![0, 2].includes(o.specialImageAlternateSetting)) unsupported('unreleased special setting');
    if (o.specialImageAlternateSetting === 2) {
      p.alternate();
      return finish('delegated-special-image');
    }
    return { ordinaryActionEntered: false, alternateActionRequested: false,
      candidateReads: 0, prompts: [], snapshots: [], row };
  }
  if (!o.cursorActive) return finish('no-active-cursor');
  effect('candidate-derived');
  const candidate = copyTime(p.candidate());
  output.candidateReads++;
  if (!assignmentAdmitted(candidate)) return finish('unusable-candidate');
  const field = ({ 1: 'lane', 2: 'id', 3: 'license' })[o.identityMode];
  const identity = field ? (o.explicitTarget ? row[field] : p.selectedText()) : '';
  if (!o.explicitTarget && field && identity === '') return finish('missing-identity');
  if (!o.explicitTarget) row = field ? p.lookup(field, identity) : row;
  const confirm = name => {
    output.prompts.push(name);
    const answer = p.confirm(name);
    if (typeof answer !== 'boolean') throw new TypeError('Requested confirmation needs a Boolean outcome');
    return answer;
  };
  if (row) {
    effect('existing-time-getter');
    if (p.getter(row).quantum !== 0 && !confirm('HasTime')) return finish('cancel-HasTime');
    if (row.status !== 0 && !confirm('Invalid')) return finish('cancel-Invalid');
  }
  if (candidate.quantum !== 0 && o.closeSetting >= 0) {
    if (o.closeSetting > 0) unsupported('positive close threshold');
    effect('exact-close-query');
    const others = p.exactClose(copyTime(candidate), row);
    if (others.some(other => other.token !== row?.token && other.time.ticks === candidate.ticks) &&
        !confirm('CloseToAnother')) return finish('cancel-CloseToAnother');
  }
  if (!row && field && o.listOnly && !confirm('NotInList')) return finish('cancel-NotInList');
  if (!row) {
    row = p.createRow();
    p.append(row);
    effect('new-row-appended');
    if (field) { row[field] = identity; effect('identity-assigned'); }
  }
  if (o.identityMode === 2 && !o.listOnly) {
    effect('ppl-lookup-false-overwrite');
    p.ppl(row, false);
  }
  const observe = (stage, message) => {
    const snapshot = { stage, message, status: row.status, time: copyTime(row.time), text: row.text, mode: row.mode };
    output.snapshots.push(snapshot);
    p.observe?.(snapshot, row);
  };
  if (row.status !== 0) {
    observe('status-before', 196608);
    row.status = 0; row.cache = -1;
    observe('status-after', 262164);
  }
  if (row.text !== '' || !equalTime(row.time, candidate) || row.mode !== 0) {
    observe('numeric-before', 196608);
    row.text = ''; row.time = copyTime(candidate); row.mode = 0; row.cache = -1;
    observe('numeric-after', 262164);
  }
  if (o.integrationPresent) { effect('integration-row-call'); p.integration(row); }
  for (let i = 0; i < o.contextCount; i++) { effect('context-refresh-' + i); p.refresh(i, row); }
  effect('cursor-advance-helper'); p.advanceHelper(copyTime(candidate));
  if (candidate.quantum !== 0 && o.autoAdvance) { effect('cursor-advance-provider'); p.advance(copyTime(candidate)); }
  return finish('accepted');
}
module.exports = { assign, assignmentAdmitted, numericValid, equalTime, validateCursor };
