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

test('review focus centers the same calibrated torso across different perspectives and resolutions',()=>{
  const mainLanes=[{lane:3,top_row:430,bottom_row:470,standing_head_row_1p80m:300}];
  const otherLanes=[{lane:3,top_row:230,bottom_row:270,standing_head_row_1p80m:50}];
  const result=linkedCameraRange({c0:250,zx:2,r0:337.5,zy:5,focusLane:3},{rows:1000,height:300,width:1000,period:0.001,timeOrigin:10,otherWidth:400,otherRows:2000,mainLanes,otherLanes});
  assert.equal(result.t0,10.25);assert.equal(result.spp*400,0.5);
  assert.ok(Math.abs((result.r0+result.rv/2)*2000-140)<1e-9);
  assert.ok(Math.abs(result.rv*2000-80)<1e-9);
  // The old percentage mapping centered at row 735, far away from this runner.
  assert.ok(Math.abs((result.r0+result.rv/2)*2000-735)>500);
});

test('a crop containing two review runners follows their lanes when comparison order reverses',()=>{
  const mainLanes=[{lane:7,top:560,bottom:600,head:380},{lane:8,top:610,bottom:650,head:430}];
  const otherLanes=[{lane:7,top:240,bottom:280,head:40},{lane:8,top:170,bottom:210,head:10}];
  const result=linkedCameraRange({c0:0,zx:1,r0:445,zy:3},{rows:1000,height:300,width:1000,period:0.001,timeOrigin:0,otherWidth:300,otherRows:640,mainLanes,otherLanes,finishLanes:[7,8]});
  const top=result.r0*640,bottom=(result.r0+result.rv)*640;
  assert.ok(top<91&&bottom>139,JSON.stringify({top,bottom}));
  assert.ok(Math.abs((top+bottom)/2-115)<1e-9);
});

test('edge padding preserves the calibrated center, while full-frame and missing calibration stay usable',()=>{
  const mainLanes=[{lane:1,top:380,bottom:420,head:300}],otherLanes=[{lane:1,top:30,bottom:50,head:0}];
  const options={rows:1000,height:300,width:1000,period:0.001,timeOrigin:0,otherWidth:300,otherRows:2000,mainLanes,otherLanes};
  const result=linkedCameraRange({c0:0,zx:1,r0:245,zy:1.5,focusLane:1},options);
  assert.ok(result.r0<0);assert.ok(Math.abs((result.r0+result.rv/2)*2000-18)<1e-9);
  assert.deepEqual(linkedCameraRange({c0:0,zx:1,r0:0,zy:0.3},options),{t0:0,spp:1/300,r0:0,rv:1});
  const fallback=linkedCameraRange({c0:0,zx:1,r0:250,zy:1.5},{...options,otherLanes:[]});
  assert.equal(fallback.r0,0.25);assert.equal(fallback.rv,0.2);
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
