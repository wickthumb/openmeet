import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrontFrameCache,linkedCameraRange,cameraAsset} from '../renderer/front-preview.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('rapid scrubbing prioritizes the latest target and does not display stale completions',async()=>{
  const loads=[],ready=[],resolvers=new Map();
  const cache=new FrontFrameCache({concurrency:1,load:i=>{loads.push(i);return new Promise(r=>resolvers.set(i,r));},onReady:i=>ready.push(i)});
  cache.request(10,100);await tick();cache.request(80,100);
  resolvers.get(10)({close(){}});await tick();
  assert.deepEqual(loads,[10,80]);assert.deepEqual(ready,[]);
  resolvers.get(80)({width:1,height:1,close(){}});await tick();
  assert.deepEqual(ready,[80]);assert.ok(cache.get(80));cache.dispose();
});

test('decoded cache stays bounded and releases images, including late completions after disposal',async()=>{
  const closed=[];
  const cache=new FrontFrameCache({limit:3,concurrency:1,load:async i=>({close:()=>closed.push(i)})});
  cache.request(6,15);for(let i=0;i<20;i++)await tick();
  assert.ok(cache.frames.size<=3);assert.ok(cache.frames.has(6));assert.ok(closed.length>0);
  cache.dispose();assert.equal(cache.frames.size,0);
  let resolve;
  const pending=new FrontFrameCache({concurrency:1,load:()=>new Promise(r=>{resolve=r;})});pending.request(0,1);await tick();pending.dispose();
  resolve({close:()=>closed.push('late')});await tick();assert.ok(closed.includes('late'));
});

test('linked view shares time span and vertical fraction across different panel widths and row counts',()=>{
  const view={c0:200,zx:2,r0:500,zy:0.8};
  const result=linkedCameraRange(view,{rows:2000,height:800,width:1000,period:0.0005,timeOrigin:12,otherWidth:400});
  assert.equal(result.t0,12.1);assert.equal(result.spp*400,0.25);
  assert.equal(result.r0,0.25);assert.equal(result.rv,0.5);
  // A 1000-row comparison uses rows 250..750 for the same 2000-row source region 500..1500.
  assert.equal(result.r0*1000,250);assert.equal(result.rv*1000,500);
});

test('three-camera roles preserve source identity and each camera clock without mutating earlier assets',()=>{
  const lineScans=['west','east','tower'].map((id,i)=>({id,label:id,png:id+'.png',meta:{rows:1000*(i+1),column_period_s:0.001/(i+1)},size:{width:900,height:1000*(i+1)}}));
  const original={lineScans,front:'front.mp4'};
  const selected=cameraAsset(original,{main:'east',comparison:'tower'});
  assert.equal(selected.mainCameraId,'east');assert.equal(selected.primaryMeta.rows,2000);assert.equal(selected.primaryMeta.column_period_s,0.0005);
  assert.equal(selected.comparisonCameraId,'tower');assert.equal(selected.backup,'tower.png');assert.equal(original.primary,undefined);
  const changed=cameraAsset(selected,{main:'tower',comparison:'tower'});
  assert.equal(changed.mainCameraId,'tower');assert.notEqual(changed.comparisonCameraId,'tower');assert.equal(selected.mainCameraId,'east');
});
