import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEvt } from '../../engine/meetlink/parse.js';
import { openCaptureStore } from '../../engine/index.js';
import { columnsOf } from '../../engine/sim/replay.js';
import { simulationCatalog, sourceId, readReplayFolder, publicReplay, recordedResults } from '../simulation-sources.mjs';
import { sourceChoices, replayCameras, replayHeatKey, replayStartList, replayReferenceTiming } from '../renderer/replay-sources.mjs';

import { replayFixture } from './support/replay-fixture.mjs';

const readMeet = async dir => ({ dir, files: { 'lynx.evt': { text: await readFile(path.join(dir, 'lynx.evt'), 'utf8') } }, parsed: { events: parseEvt(await readFile(path.join(dir, 'lynx.evt'), 'utf8')) } });

test('catalog preserves legacy demo selection, named real folders and manual imports', () => {
  const legacy = simulationCatalog({ demoDir: '/tmp/ttp' });
  assert.equal(legacy.selectedId, sourceId('/tmp/ttp'));
  assert.equal(legacy.sources[1].type, 'ttp');
  assert.deepEqual(sourceChoices().map(x => x.value), ['builtin', 'import:ttp', 'import:real']);
  const catalog = simulationCatalog({ simulationSources: [{ id:'real-a',type:'real',name:'Meet A',path:'/tmp/a' },{ type:'real',name:'Meet B',path:'/tmp/b' }], simulationSourceId:'real-a' });
  assert.equal(catalog.selectedId, 'real-a');
  assert.equal(sourceChoices(catalog).filter(x => x.label.startsWith('REAL MEET REPLAY')).length, 2);
  assert.deepEqual(simulationCatalog({ simulationSources: {} }).sources.length, 1);
});

test('recorded practice references keep exact local columns and full-stitch provenance without jitter or drops',()=>{
  const sidecar={column_period_s:.00125,first_column_race_time_s:10,truth:[
    {lane:1,time_s:10.125625,image_column:100,source_column:5100,official_seconds:10.13},
    {lane:2,time_s:10.126875,image_column:101,source_column:5101,official_seconds:10.13}]};
  const input={sidecar,firstRaceTime:0,period:.00125,columns:9000,startList:[{lane:1},{lane:2},{lane:3}],sourceColumns:200};
  const predictions=recordedResults(input);
  assert.deepEqual(predictions.map(p=>p.column),[8100,8101]);
  assert.deepEqual(predictions.map(p=>p.source_column),[5100,5101]);
  for(let i=0;i<8;i++)assert.deepEqual(recordedResults(input),predictions);
  assert.deepEqual(recordedResults({...input,columns:8100}),[],'future reference points must stay hidden during live replay');
  assert.deepEqual(recordedResults({...input,firstRaceTime:10,columns:200}).map(p=>p.column),[100,101]);
});

test('manifest imports the exact EVT heat, nominal timing, source label and absent camera inventory', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'openmeet-source-test-'));t.after(() => rm(root,{recursive:true,force:true}));
  const {dir,meta}=await replayFixture(root);
  const replay=await readReplayFolder(dir,readMeet,'ttp'),h=publicReplay(replay).heats[0];
  assert.equal(replay.type,'real');assert.equal(replay.name,'Recorded test fixture');
  assert.equal(replayHeatKey(h),'5|1|1');
  assert.equal(replay.meet.parsed.events[0].entries[0].first,'Ada');
  assert.equal(h.primaryMeta.first_column_race_time_s,meta.first_column_race_time_s);
  assert.equal(h.primaryMeta.column_period_s,meta.column_period_s);
  assert.equal(h.primaryMeta.provenance,meta.provenance);
  assert.equal(h.primaryMeta.truth,undefined);assert.equal(h.lineScans[0].sidecar,undefined);
  assert.equal(replayReferenceTiming({asset:h}),true);
  assert.deepEqual(replayStartList(replay.meet.parsed.events[0].entries),[{lane:2,id:0},{lane:4,id:0}]);
  assert.equal(replay.meet.parsed.events[0].entries[1].status,null);
  assert.deepEqual(replayCameras({asset:h,replaySourceType:'real'}),{folder:true,primary:true,comparison:false,front:false});
  assert.deepEqual(replayCameras({replaySourceType:'real'}),{folder:true,primary:false,comparison:false,front:false});
  await writeFile(path.join(dir,'heat-1/primary.json'),JSON.stringify({...meta,column_period_s:0}));
  await assert.rejects(readReplayFolder(dir,readMeet),/column_period_s/);
});

test('legacy TTP layout retains both scans and front recording; manifest keys and paths are validated', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'openmeet-source-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {dir}=await replayFixture(root,'ttp-simulator');
  await rm(path.join(dir,'openmeet-replay.json'));
  await writeFile(path.join(dir,'heat-1/backup.png'),await readFile(path.join(dir,'heat-1/primary.png')));
  await writeFile(path.join(dir,'heat-1/backup.json'),await readFile(path.join(dir,'heat-1/primary.json')));
  await writeFile(path.join(dir,'heat-1/front.mp4'),'test placeholder');
  const h=(await readReplayFolder(dir,readMeet)).heats[0];
  assert.equal(replayHeatKey(h),'5|1|1');assert.equal(h.sourceType,'ttp');
  assert.deepEqual(replayCameras({asset:h}),{folder:true,primary:true,comparison:true,front:true});
  for(const entry of [{folder:'../outside',event:'5',round:1,heat:1},{folder:'heat-1',event:'missing',round:1,heat:1}]){
    await writeFile(path.join(dir,'openmeet-replay.json'),JSON.stringify({version:1,heats:[entry]}));
    await assert.rejects(readReplayFolder(dir,readMeet),/leaves the imported folder|does not match/);
  }
});

function host(userData) {
  const child=fork(new URL('./support/engine-process.mjs',import.meta.url),[userData],{stdio:['ignore','pipe','pipe','ipc'],serialization:'advanced'});
  let id=0;const pending=new Map(),events=[];
  child.on('message',m=>{if(m.event)events.push(m);else{const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error)):p.resolve(m.result);}}});
  return { child,events,call(method,params={}){return new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(Error('Engine call timed out: '+method)),5000);pending.set(key,{resolve,reject,timer});child.send({id:key,method,params});});} };
}

test('real host persists selection, preserves literal pixels/times, holds open, and rejects source changes during capture', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'openmeet-source-host-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const fixture=await replayFixture(root),engine=host(path.join(root,'settings'));
  t.after(()=>engine.child.kill());
  assert.equal((await engine.call('ping')).core,true);
  const source=await engine.call('demo.import',{dir:fixture.dir,type:'ttp'});
  assert.equal(source.type,'real');
  const replay=await engine.call('demo.load',{id:source.id});
  assert.equal(replay.meet.parsed.events[0].entries[0].id,null);
  assert.equal(replay.heats[0].front,null);assert.equal(replay.heats[0].backup,null);
  const h=replay.heats[0],cap=await engine.call('capture.start',{key:'5-1-1',png:h.primary,sidecar:h.primaryMeta,meetDir:replay.meet.dir});
  assert.equal(cap.front,null);
  for(const [method,params]of [['demo.load',{id:'builtin'}],['demo.import',{dir:fixture.dir,type:'real'}],['meet.open',{dir:replay.meet.dir}],['settings.set',{patch:{simulationSourceId:'builtin'}}]]){
    await assert.rejects(engine.call(method,params),/Stop capture/);
  }
  await engine.call('settings.set',{patch:{unrelatedSetting:true}});
  await delay(400);
  assert.equal(engine.events.filter(e=>e.event==='capture.end').length,0,'source end must not stop manual capture');
  await engine.call('capture.stop');
  for(let i=0;i<50&&!engine.events.some(e=>e.event==='capture.end');i++)await delay(10);
  assert.ok(engine.events.some(e=>e.event==='capture.end'));
  const store=openCaptureStore(cap.dir,{readOnly:true});
  try{
    const nPre=Math.round(fixture.meta.first_column_race_time_s/fixture.meta.column_period_s);
    assert.ok(store.columnCount()>nPre+fixture.img.width,'holdOpen tail was not captured');
    assert.deepEqual(store.readColumns(nPre,nPre+fixture.img.width),columnsOf(fixture.img,0,fixture.img.width));
    for(const x of [0,63,95])assert.ok(Math.abs(store.raceTimeOf(nPre+x)-(fixture.meta.first_column_race_time_s+x*fixture.meta.column_period_s))<1e-9);
    for(const x of [nPre+fixture.img.width,store.columnCount()-1])assert.deepEqual(store.readColumns(x,x+1),columnsOf(fixture.img,95,1));
    assert.equal(store.meta().model,'real-recorded-replay');
  }finally{store.close();}
  assert.equal(JSON.parse(await readFile(path.join(cap.dir,'source.json'),'utf8')).source,'real-recorded');
  const timing=await engine.call('autotiming.predict',{captureId:cap.id,heat:{event:'5',round:1,heat:1},startList:[{id:0,lane:2},{id:0,lane:4}]});
  assert.equal(timing.stub,true);assert.deepEqual(timing.predictions.map(p=>p.lane),[2],'untimed lanes must stay unresolved');
  assert.equal(timing.reference,true);assert.equal(timing.sourceRef.kind,'recorded-results');
  assert.equal(timing.predictions[0].column,Math.round(fixture.meta.first_column_race_time_s/fixture.meta.column_period_s)+55);
  assert.equal(timing.predictions[0].source_column,155);
  for(let i=0;i<4;i++)assert.deepEqual((await engine.call('autotiming.predict',{captureId:cap.id,heat:{event:'5',round:1,heat:1},startList:[{id:0,lane:2}]})).predictions,timing.predictions);
  const settings=await engine.call('settings.get');assert.equal(settings.simulationSourceId,source.id);assert.equal(settings.unrelatedSetting,true);
  assert.equal((await engine.call('demo.catalog')).selectedId,source.id);
  const {truth,...noReferences}=fixture.meta;
  await writeFile(path.join(fixture.dir,'heat-1/primary.json'),JSON.stringify(noReferences));
  await engine.call('demo.load',{dir:fixture.dir});
  assert.equal((await engine.call('demo.catalog')).selectedId,source.id);
  const noRefCap=await engine.call('capture.start',{key:'manual',png:h.primary,sidecar:h.primaryMeta,meetDir:replay.meet.dir});
  await delay(150);await engine.call('capture.stop');
  for(let i=0;i<50&&!engine.events.some(e=>e.event==='capture.end'&&e.data.id===noRefCap.id);i++)await delay(10);
  await assert.rejects(engine.call('autotiming.predict',{captureId:noRefCap.id,heat:{event:'5',round:1,heat:1},startList:[{id:0,lane:2}]}),/no reference timing points/);
  const starting=engine.call('capture.start',{key:'stop-during-start',png:h.primary,sidecar:h.primaryMeta,meetDir:replay.meet.dir});
  await engine.call('capture.stop');const stoppedAtStart=await starting;
  for(let i=0;i<50&&!engine.events.some(e=>e.event==='capture.end'&&e.data.id===stoppedAtStart.id);i++)await delay(10);
  assert.ok(engine.events.some(e=>e.event==='capture.end'&&e.data.id===stoppedAtStart.id),'manual stop during async startup must not leave a hidden recording');
  await engine.call('preview.start',{png:h.primary,sidecar:h.primaryMeta});
  await assert.rejects(engine.call('demo.load',{id:'builtin'}),/Stop capture or preview/);
  await engine.call('preview.stop');
  await writeFile(path.join(fixture.dir,'heat-1/primary.json'),'{}');
  await assert.rejects(engine.call('demo.load',{id:source.id}),/column_period_s/);
  assert.equal((await engine.call('demo.catalog')).selectedId,source.id,'failed loads must preserve current selection');
  await engine.call('demo.load',{id:'builtin'});
  const final=await engine.call('settings.get');assert.equal(final.demoDir,null);assert.equal(final.simulationSourceId,'builtin');
});
