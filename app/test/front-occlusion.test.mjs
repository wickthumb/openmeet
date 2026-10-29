import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frontOverlayAlpha,FrontOverlayOcclusion} from '../renderer/front-occlusion.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const w=80,h=50;
const background=()=>{const data=new Uint8ClampedArray(w*h*4);for(let i=0;i<w*h;i++)data.set([100,70,50,255],i*4);return data;};
test('unchanged background and global exposure drift leave the overlay visible',()=>{
  const ref=background(),lit=ref.map((v,i)=>i%4===3?v:v+12);
  assert.ok(frontOverlayAlpha(ref,ref,w,h).every(a=>a===255));
  assert.ok(frontOverlayAlpha(ref,lit,w,h).every(a=>a===255));
});
test('a stationary foreground object stays in front while unrelated noise and background recover',()=>{
  const ref=background(),current=ref.slice();
  for(let y=15;y<40;y++)for(let x=30;x<44;x++)current.set([20,140,180,255],(y*w+x)*4);
  current.set([255,255,255,255],(4*w+4)*4);
  const alpha=frontOverlayAlpha(ref,current,w,h);
  assert.equal(alpha[25*w+35],0);assert.equal(alpha[4*w+4],255);assert.equal(alpha[5*w+65],255);
  assert.deepEqual(frontOverlayAlpha(ref,current,w,h),alpha,'Repeated stationary frames were learned into the reference');
  assert.ok(frontOverlayAlpha(ref,ref,w,h).every(a=>a===255));
  assert.equal(ref[25*w*4+35*4],100,'The reference was modified');
});

async function withBrowser(run) {
  const saved=Object.fromEntries(['document','Worker','Image'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const create=URL.createObjectURL,revoke=URL.revokeObjectURL,workers=[],created=[],revoked=[];
  const source=(value=100,width=w,height=h)=>({width,height,pixels:new Uint8ClampedArray(w*h*4).fill(value)});
  const context={draws:0,drawImage(image){this.draws++;this.pixels=image.pixels;},getImageData(){return {data:this.pixels.slice()};}};
  globalThis.document={createElement(kind){assert.equal(kind,'canvas');return {width:0,height:0,getContext(){return context;}};}};
  globalThis.Worker=class {
    constructor(url,options){assert.match(url.href,/front-occlusion-worker\.mjs$/);assert.equal(options.type,'module');this.messages=[];workers.push(this);}
    postMessage(message,transfer){this.messages.push(structuredClone(message,{transfer}));}
    terminate(){this.terminated=true;}
    reply(job,extra={}){this.onmessage({data:{id:job.id,generation:job.generation,stamp:job.stamp,blob:new Blob(['mask'],{type:'image/png'}),...extra}});}
  };
  URL.createObjectURL=blob=>{assert.equal(blob.type,'image/png');const url='blob:test-'+created.length;created.push(url);return url;};
  URL.revokeObjectURL=url=>revoked.push(url);
  const instances=[];
  try{await run({source,context,workers,created,revoked,make:()=>{const instance=new FrontOverlayOcclusion();instances.push(instance);return instance;}});}
  finally{instances.forEach(o=>o.dispose());URL.createObjectURL=create;URL.revokeObjectURL=revoke;for(const [k,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];}}
}

test('front worker bounds requests to one in flight plus the latest snapshot; stale frames never create URLs',()=>withBrowser(({make,source,workers,created,revoked,context})=>{
  const o=make();o.configure('camera');o.setReference(source());const reference=o.reference.slice();
  assert.equal(o.mask(source(110),'frame-a'),null);const worker=workers[0],first=worker.messages[1];
  assert.deepEqual(o.reference,reference,'Transferring the worker reference detached the UI reference');
  o.mask(source(120),'frame-b');o.mask(source(130),'frame-c');
  assert.equal(worker.messages.length,2);assert.equal(o.pending.stamp,'frame-c');assert.equal(o.inFlight.stamp,'frame-a');
  const draws=context.draws;o.mask(source(130),'frame-c');assert.equal(context.draws,draws,'Repeated frame was captured again');
  worker.reply(first);assert.deepEqual(created,[],'Stale in-flight result became visible');
  assert.equal(worker.messages.length,3);const latest=worker.messages[2];assert.equal(latest.stamp,'frame-c');
  assert.equal(new Uint8ClampedArray(latest.pixels)[0],130,'Pending pixels were not snapshotted at request time');
  worker.reply(latest);assert.equal(o.mask(source(130),'frame-c'),'blob:test-0');
  o.mask(source(140),'frame-d');assert.deepEqual(revoked,['blob:test-0']);assert.equal(o.url,null,'A seek reused the previous frame mask');
}));

test('seeking back to an in-flight frame cancels pending work without recapture',()=>withBrowser(({make,source,workers,context})=>{
  const o=make();o.setReference(source());o.mask(source(110),'a');o.mask(source(120),'b');const draws=context.draws;
  o.mask(source(110),'a');assert.equal(o.pending,null);assert.equal(context.draws,draws);
  const worker=workers[0];worker.reply(worker.messages[1]);assert.equal(o.mask(source(110),'a'),'blob:test-0');assert.equal(worker.messages.length,2);
}));

test('camera/reference changes terminate old work and revoke old object URLs',()=>withBrowser(({make,source,workers,created,revoked})=>{
  const o=make();o.configure('a');o.setReference(source());o.mask(source(110),'same-stamp');const old=workers[0],job=old.messages[1];
  o.configure('b');assert.ok(old.terminated);old.reply(job);assert.equal(o.reference,null);assert.deepEqual(created,[]);
  o.setReference(source(80));o.mask(source(100),'same-stamp');const next=workers[1];next.reply(next.messages[1]);assert.equal(o.url,'blob:test-0');
  o.setReference(source(90));assert.ok(next.terminated);assert.deepEqual(revoked,['blob:test-0']);assert.equal(o.pending,null);assert.equal(o.inFlight,null);
  next.reply(next.messages[1]);assert.equal(o.url,null);assert.equal(o.reference[0],90);
  o.setReference(source(100,960,540));assert.equal(o.sample.width,640);assert.equal(o.sample.height,360,'Working resolution changed');
}));

test('continuous video retains completed masks and accepts bounded results behind the newest frame',()=>withBrowser(({make,source,workers,revoked})=>{
  const video=value=>({...source(value),videoWidth:w,videoHeight:h,paused:false,seeking:false});
  const o=make();o.setReference(source());o.mask(video(110),'a');const worker=workers[0];
  o.mask(video(120),'b');worker.reply(worker.messages[1]);assert.equal(o.url,'blob:test-0','Live work starved behind the latest frame');
  assert.equal(o.mask(video(130),'c'),'blob:test-0','A new playing frame cleared the completed mask');
  assert.deepEqual(revoked,[]);worker.reply(worker.messages[2]);assert.equal(o.url,'blob:test-1');
  assert.deepEqual(revoked,['blob:test-0']);assert.equal(o.inFlight.stamp,'c');
}));

test('seeks/pause reject old live completions, including after continuous playback resumes',()=>withBrowser(({make,source,workers,created})=>{
  const video=(value,extra={})=>({...source(value),videoWidth:w,videoHeight:h,paused:false,seeking:false,...extra});
  const o=make();o.setReference(source());o.mask(video(110),'a');const worker=workers[0],old=worker.messages[1];
  o.mask(video(120),'b');assert.equal(o.mask(video(130,{seeking:true}),'seeking'),null);assert.equal(o.pending,null);
  o.mask(video(140),'after-seek');worker.reply(old);assert.deepEqual(created,[],'Pre-seek live completion crossed playback generations');
  const fresh=worker.messages[2];worker.reply(fresh);assert.equal(o.url,'blob:test-0');
  assert.equal(o.mask(video(150,{paused:true}),'paused'),null);const paused=worker.messages[3];
  o.mask(source(160),'bitmap');worker.reply(paused);assert.equal(o.url,null,'Paused mask replaced a different bitmap frame');
  worker.reply(worker.messages[4]);assert.equal(o.mask(source(160),'bitmap'),'blob:test-1');
}));

test('an older asynchronous reference load cannot replace a manually updated background',()=>withBrowser(async({make,source})=>{
  let finish;globalThis.Image=class {constructor(){Object.assign(this,source(70));}decode(){return new Promise(resolve=>{finish=resolve;});}};
  const o=make();o.configure('camera');const loading=o.loadReference('background.png');assert.ok(o.loading);
  o.setReference(source(150));finish();await loading;
  assert.equal(o.reference[0],150);assert.equal(o.loading,false);assert.equal(o.failed,false);
}));

test('worker failure clears both bounded slots and does not fall back to synchronous alpha/PNG work',()=>withBrowser(({make,source,workers})=>{
  const o=make();o.setReference(source());o.mask(source(110),'a');o.mask(source(120),'b');
  const worker=workers[0];worker.reply(worker.messages[1],{error:'encoder failed'});
  assert.ok(o.failed);assert.ok(worker.terminated);assert.equal(o.inFlight,null);assert.equal(o.pending,null);assert.equal(o.mask(source(130),'c'),null);
}));

test('worker output RGBA matches the unchanged public alpha algorithm pixel for pixel',async()=>{
  const ref=background(),current=ref.slice();for(let y=15;y<40;y++)for(let x=30;x<44;x++)current.set([20,140,180,255],(y*w+x)*4);
  let result,encoded;
  const self={postMessage(value){result=value;}};
  class OffscreenCanvas {
    constructor(width,height){assert.equal(width,w);assert.equal(height,h);}
    getContext(){return {createImageData(width,height){return {data:new Uint8ClampedArray(width*height*4)};},putImageData(image){encoded=image.data;}};}
    async convertToBlob(options){assert.equal(options.type,'image/png');return new Blob([encoded],options);}
  }
  const code=readFileSync(new URL('../renderer/front-occlusion-worker.mjs',import.meta.url),'utf8').replace("import {frontOverlayAlpha} from './front-occlusion.mjs';",'');
  vm.runInNewContext(code,{self,OffscreenCanvas,frontOverlayAlpha,Uint8ClampedArray});
  await self.onmessage({data:{type:'reference',generation:3,width:w,height:h,reference:ref.buffer}});
  await self.onmessage({data:{type:'frame',generation:3,id:42,stamp:'frame',pixels:current.buffer}});
  assert.equal(result.id,42);assert.equal(result.generation,3);assert.equal(result.stamp,'frame');
  const actual=new Uint8ClampedArray(await result.blob.arrayBuffer()),alpha=frontOverlayAlpha(ref,current,w,h);
  assert.equal(actual.length,w*h*4);for(let i=0;i<alpha.length;i++)assert.deepEqual([...actual.subarray(i*4,i*4+4)],[255,255,255,alpha[i]]);
});
