import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {descriptor,probabilities,modeOutput,cropImage} from '../autocrop/network.mjs';
import {loadModel,MODEL_SHA256} from '../autocrop/model.mjs';
import {nativeCrop,nativeCropInfo} from '../autocrop/index.mjs';
import {replayFixture} from './support/replay-fixture.mjs';
import {encodePng} from '../../engine/sim/png-encode.js';

const image=(width=768,height=96)=>{
  const data=Buffer.alloc(width*height*3,90);
  for(let y=Math.floor(height/3);y<height-Math.floor(height/8);y++)for(let x=Math.floor(width/3);x<Math.floor(width/3)+Math.max(2,Math.floor(width/12));x++)data.set([20,190,200],(y*width+x)*3);
  return {width,height,channels:3,data};
};
test('bundled release matches original Python preprocessing, probabilities and both range policies',async()=>{
  const vectors=JSON.parse(await readFile(new URL('./fixtures/autocrop-vectors.json',import.meta.url))),model=await loadModel();
  assert.equal(model.approved,true);assert.equal(model.weights_sha256,MODEL_SHA256);
  for(const reference of vectors.cases) {
    const input=image(reference.width,reference.height),pixels=input.data.slice(),x=descriptor(input),bytes=Buffer.alloc(x.length*4);
    for(let i=0;i<x.length;i++)bytes.writeFloatLE(x[i],i*4);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),reference.descriptor_sha256,'Preprocessing differs from the frozen Python release');
    const scores=probabilities(x,input.width,model);
    for(const sample of reference.probability_samples)assert.ok(Math.abs(scores[sample.column]-sample.value)<2e-6,'Native network differs from the original model');
    for(const mode of ['storage-display','inference-safe'])assert.deepEqual(modeOutput(scores,model.threshold,mode).ranges,reference.ranges[mode]);
    assert.deepEqual(input.data,pixels,'Display analysis changed the source image');
  }
  assert.throws(()=>cropImage(image(),{...model,approved:false}),/not an approved release/);
});

test('pooled descriptors preserve every baseline float at channel, row and rounding-table boundaries',async()=>{
  const vectors=JSON.parse(await readFile(new URL('./fixtures/autocrop-descriptor-vectors.json',import.meta.url)));
  for(const {width,height,channels,sha256}of vectors.cases) {
    const data=Buffer.alloc(width*height*channels);for(let i=0;i<data.length;i++)data[i]=(i*17+29+(i>>3))&255;
    const x=descriptor({width,height,channels,data}),bytes=Buffer.alloc(x.length*4);
    for(let i=0;i<x.length;i++)bytes.writeFloatLE(x[i],i*4);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),sha256,`${width}x${height}, ${channels} channels`);
  }
});

test('direct range construction preserves frozen sparse, dense, empty and exact-gap policies',async()=>{
  const vectors=JSON.parse(await readFile(new URL('./fixtures/autocrop-policy-vectors.json',import.meta.url)));
  for(const {width,pattern,hashes}of vectors.cases) {
    let seed=521;
    const scores=Float32Array.from({length:width},(_,x)=>{
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      return pattern==='all'?1:pattern==='edges'?(x===0||x===width-1?1:0):pattern==='sparse'?(x%180===0?1:0):pattern==='bursts'?(x%500<20?1:0):pattern==='gap320'?([200,841].includes(x)?1:0):pattern==='random'?(seed>>>24)/255:0;
    });
    for(const mode of ['storage-display','inference-safe'])assert.equal(createHash('sha256').update(JSON.stringify(modeOutput(scores,.05,mode))).digest('hex'),hashes[mode]);
  }
  assert.deepEqual(modeOutput(Float32Array.of(.1),NaN,'storage-display').ranges,[]);
  for(const value of [NaN,Infinity,-Infinity])assert.throws(()=>modeOutput(Float32Array.of(value),.05,'storage-display'),/Invalid cropper probability/);
});

test('mode padding clips to bounds, preserves empty output, and merges gaps strictly below 320',()=>{
  const scores=new Float32Array(1500);assert.deepEqual(modeOutput(scores,.05,'storage-display').ranges,[]);
  scores[200]=1;scores[841]=1;
  assert.deepEqual(modeOutput(scores,.05,'inference-safe').ranges,[[40,361],[681,1002]]);
  scores[841]=0;scores[840]=1;assert.deepEqual(modeOutput(scores,.05,'inference-safe').ranges,[[40,1001]]);
  scores.fill(0);scores[0]=scores[scores.length-1]=1;
  const mode=modeOutput(scores,.05,'storage-display');assert.deepEqual(mode.ranges,[[0,9],[1491,1500]]);
  assert.deepEqual(mode.cropped_to_original,[0,1,2,3,4,5,6,7,8,1491,1492,1493,1494,1495,1496,1497,1498,1499]);
});

test('local worker needs no service and keeps analysis off the caller event loop',async()=>{
  const info=await nativeCropInfo();assert.equal(info.provider,'native');assert.equal(info.ready,true);
  let ticked=false;const tick=setTimeout(()=>{ticked=true;},0),input=image(4096,65),before=input.data.slice(),job=nativeCrop(input);
  await assert.rejects(nativeCrop(input),/already running/);const output=await job;clearTimeout(tick);
  assert.ok(ticked);assert.equal(output.runtime,'native-cpu');assert.equal(output.result.original_width,input.width);
  assert.deepEqual(input.data,before,'Ordinary callers lost ownership of their input');
  assert.deepEqual(output.result,cropImage(input,await loadModel()));
});

test('owned native images can transfer without a second pixel allocation, while partial allocations remain untouched',async()=>{
  const model=await loadModel(),input=image(),expected=cropImage(input,model),buffer=input.data.buffer;
  const job=nativeCrop(input,{transfer:true});
  assert.equal(buffer.byteLength,0,'The private image was copied instead of transferred');
  assert.deepEqual((await job).result,expected);
  const shared=image(),allocation=Buffer.alloc(shared.data.length+16);shared.data.copy(allocation,8);
  shared.data=allocation.subarray(8,allocation.length-8);const before=allocation.slice();
  const result=await nativeCrop(shared,{transfer:true});
  assert.deepEqual(allocation,before,'Transferring an image detached unrelated bytes in its allocation');
  assert.deepEqual(result.result,expected);
});

test('engine hides empty spans locally with no crop configuration and retains capture bytes and times',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'openmeet-native-crop-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const {dir,meta}=await replayFixture(root),hd=path.join(dir,'heat-1');
  const input=image();await writeFile(path.join(hd,'primary.png'),encodePng(input));
  await writeFile(path.join(hd,'primary.json'),JSON.stringify({...meta,first_column_race_time_s:0,truth:[]}));
  const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('OPENMEET_CROP_'))delete env[k];
  const child=fork(new URL('./support/engine-process.mjs',import.meta.url),[path.join(root,'settings')],{env,stdio:['ignore','pipe','pipe','ipc'],serialization:'advanced'});t.after(()=>child.kill());
  let id=0;const pending=new Map();child.on('message',m=>{const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error)):p.resolve(m.result);}});
  const call=(method,params={})=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(Error('Engine timeout: '+method)),10000);pending.set(key,{resolve,reject,timer});child.send({id:key,method,params});});
  assert.equal((await call('autocrop.info')).provider,'native');
  const source=await call('demo.import',{dir,type:'real'}),replay=await call('demo.load',{id:source.id});
  const cap=await call('capture.start',{key:'5-1-1',png:replay.heats[0].primary,meetDir:replay.meet.dir,speed:100});
  await assert.rejects(call('autocrop.run',{captureId:cap.id}),/Stop capture/);
  await delay(60);await call('capture.stop');
  const hash=async name=>createHash('sha256').update(await readFile(path.join(cap.dir,name))).digest('hex');
  const before=await Promise.all(['columns.bin','times.f64'].map(hash));
  const result=await call('autocrop.run',{captureId:cap.id});
  assert.equal(result.runtime,'native-cpu');assert.equal(result.model.sha256,MODEL_SHA256);assert.equal(result.result.approved,true);
  assert.ok(result.result.modes['storage-display'].cropped_to_original.length<result.result.original_width);
  assert.deepEqual(JSON.parse(await readFile(path.join(cap.dir,'autocrop.json'),'utf8')),result);
  assert.deepEqual(await Promise.all(['columns.bin','times.f64'].map(hash)),before);
});
