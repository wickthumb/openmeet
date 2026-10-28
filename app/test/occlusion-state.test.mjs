import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scanMaskPreferences,modelMaskStatus,OcclusionAvailability} from '../renderer/occlusion-state.mjs';

test('Learned becomes the camera default once and later explicit Simple choices survive',()=>{
  assert.equal(scanMaskPreferences().occlusionMethod,'learned');
  const old={occlusionMethod:'simple',positions:{1:{top:20,bottom:50}}};
  const migrated=scanMaskPreferences(old);assert.equal(migrated.occlusionMethod,'learned');assert.deepEqual(migrated.positions,old.positions);
  const selected={...migrated,occlusionMethod:'simple'};assert.equal(scanMaskPreferences(selected),selected);assert.equal(old.occlusionMethod,'simple');
});
test('a ready service is never called unavailable merely because no mask exists yet',()=>{
  const active={method:'learned',enabled:true,behind:true,state:'review',captureId:'race',service:{configured:true,ready:true}};
  assert.equal(modelMaskStatus(active),'Ready');
  assert.equal(modelMaskStatus({...active,enabled:false}),'Enable lane overlays');
  assert.equal(modelMaskStatus({...active,behind:false}),'Enable Behind runners');
  assert.equal(modelMaskStatus({...active,busy:true}),'Generating mask…');
  assert.equal(modelMaskStatus({...active,checking:true}),'Connecting…');
  assert.equal(modelMaskStatus({...active,service:{configured:true,ready:false}}),'Private service unavailable');
});
test('explicit refresh recovers from failed startup and coalesces concurrent probes',async()=>{
  let count=0,release;const values=[{configured:true,ready:false,error:'OCCLUSION_TIMEOUT'},{configured:true,ready:true}];
  const availability=new OcclusionAvailability(()=>{const value=values[count++];return count===2?new Promise(r=>release=()=>r(value)):value;});
  await availability.refresh();assert.equal(availability.info.ready,false);
  const first=availability.refresh(),second=availability.refresh();assert.equal(first,second);await Promise.resolve();release();await first;
  assert.equal(count,2);assert.equal(availability.info.ready,true);assert.equal(availability.checking,false);
});
test('busy health preserves a known working connection and refusal is never retried',async()=>{
  const values=[{configured:true,ready:true},{configured:true,ready:false,error:'OCCLUSION_BUSY'},{configured:true,ready:false,error:'OCCLUSION_REFUSED'}];let count=0;
  const availability=new OcclusionAvailability(()=>values[count++]);
  await availability.refresh();await availability.refresh();assert.equal(availability.info.ready,true);
  await availability.refresh();await availability.refresh();assert.equal(count,3);assert.equal(availability.info.error,'OCCLUSION_REFUSED');
});
