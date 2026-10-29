import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStartJournal } from './starts.js';

test('accidental and official pulses survive reopening; reassignment changes elapsed time only', t => {
 const dir = mkdtempSync(join(tmpdir(), 'om-starts-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const j = openStartJournal(dir);
 const early = j.record({clockId:'sensor-A',timeS:100,wallTimeMs:100000});
 const real = j.record({clockId:'sensor-A',timeS:103.25,wallTimeMs:103250});
 const assignment = j.assign({heatKey:'3-1-1',triggerId:real.id,referenceTriggerId:early.id});
 assert.equal(assignment.offsetS,3.25);
 const finishTime=112.5, finishColumn=9000;
 assert.equal(finishTime-early.timeS-assignment.offsetS,9.25);
 assert.equal(finishColumn,9000);
 const reopened=openStartJournal(dir);
 assert.equal(reopened.list().triggers.length,2);
 assert.equal(reopened.list().assignments['3-1-1'].triggerId,real.id);
 reopened.assign({heatKey:'3-1-1',triggerId:early.id,referenceTriggerId:early.id});
 assert.equal(reopened.list().history.length,2);
 assert.equal(reopened.list().assignments['3-1-1'].offsetS,0);
 const unrelated=j.record({clockId:'sensor-B',timeS:103.25});
 assert.throws(()=>j.assign({heatKey:'3-1-1',triggerId:unrelated.id,referenceTriggerId:early.id}),/different clocks/);
});
