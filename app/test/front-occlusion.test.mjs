import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frontOverlayAlpha,FrontOverlayOcclusion} from '../renderer/front-occlusion.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';

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
  globalThis.Image=class {
    decode(){return Promise.resolve();}
    removeAttribute(key){delete this[key];}
  };
  globalThis.Worker=class {
    constructor(url,options){assert.match(url.href,/front-occlusion-worker\.mjs$/);assert.equal(options.type,'module');this.messages=[];workers.push(this);}
    postMessage(message,transfer){this.messages.push(structuredClone(message,{transfer}));}
    terminate(){this.terminated=true;}
    reply(job,extra={}){this.onmessage({data:{id:job.id,generation:job.generation,stamp:job.stamp,blob:new Blob(['mask'],{type:'image/png'}),...extra}});return new Promise(resolve=>setImmediate(resolve));}
  };
  URL.createObjectURL=blob=>{assert.equal(blob.type,'image/png');const url='blob:test-'+created.length;created.push(url);return url;};
  URL.revokeObjectURL=url=>revoked.push(url);
  const instances=[];
  try{await run({source,context,workers,created,revoked,make:(options)=>{const instance=new FrontOverlayOcclusion(()=>{},options);instances.push(instance);return instance;}});}
  finally{instances.forEach(o=>o.dispose());URL.createObjectURL=create;URL.revokeObjectURL=revoke;for(const [k,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,k,descriptor);else delete globalThis[k];}}
}

test('front worker bounds pending work and caches completed frames without displaying stale results',()=>withBrowser(async({make,source,workers,created,revoked,context})=>{
  const o=make();o.configure('camera');o.setReference(source());const reference=o.reference.slice();
  assert.equal(o.mask(source(110),'frame-a'),null);const worker=workers[0],first=worker.messages[1];
  assert.deepEqual(o.reference,reference,'Transferring the worker reference detached the UI reference');
  o.mask(source(120),'frame-b');o.mask(source(130),'frame-c');
  assert.equal(worker.messages.length,2);assert.equal(o.pending.stamp,'frame-c');assert.equal(o.inFlight.stamp,'frame-a');
  const draws=context.draws;o.mask(source(130),'frame-c');assert.equal(context.draws,draws,'Repeated frame was captured again');
  await worker.reply(first);assert.equal(o.url,null,'Stale in-flight result became visible');assert.ok(o.ready('frame-a'));
  assert.equal(worker.messages.length,3);const latest=worker.messages[2];assert.equal(latest.stamp,'frame-c');
  assert.equal(new Uint8ClampedArray(latest.pixels)[0],130,'Pending pixels were not snapshotted at request time');
  await worker.reply(latest);assert.equal(o.mask(source(130),'frame-c'),'blob:test-1');
  o.mask(source(140),'frame-d');assert.deepEqual(revoked,[]);assert.equal(o.url,null,'A seek reused the previous frame mask');
  const jobs=worker.messages.length,drawCount=context.draws;o.mask(source(110),'frame-a');await new Promise(r=>setImmediate(r));assert.equal(o.mask(source(110),'frame-a'),'blob:test-0');assert.equal(worker.messages.length,jobs);assert.equal(context.draws,drawCount,'Revisiting a completed frame ran subtraction again');
}));

test('seeking back to an in-flight frame cancels pending work without recapture',()=>withBrowser(async({make,source,workers,context})=>{
  const o=make();o.setReference(source());o.mask(source(110),'a');o.mask(source(120),'b');const draws=context.draws;
  o.mask(source(110),'a');assert.equal(o.pending,null);assert.equal(context.draws,draws);
  const worker=workers[0];await worker.reply(worker.messages[1]);assert.equal(o.mask(source(110),'a'),'blob:test-0');assert.equal(worker.messages.length,2);
}));

test('camera/reference changes terminate old work and revoke old object URLs',()=>withBrowser(async({make,source,workers,created,revoked})=>{
  const o=make();o.configure('a');o.setReference(source());o.mask(source(110),'same-stamp');const old=workers[0],job=old.messages[1];
  o.configure('b');assert.ok(old.terminated);await old.reply(job);assert.equal(o.reference,null);assert.deepEqual(created,[]);
  o.setReference(source(80));o.mask(source(100),'same-stamp');const next=workers[1];await next.reply(next.messages[1]);assert.equal(o.url,'blob:test-0');
  o.setReference(source(90));assert.ok(next.terminated);assert.deepEqual(revoked,['blob:test-0']);assert.equal(o.pending,null);assert.equal(o.inFlight,null);
  await next.reply(next.messages[1]);assert.equal(o.url,null);assert.equal(o.reference[0],90);
  o.setReference(source(100,960,540));assert.equal(o.sample.width,640);assert.equal(o.sample.height,360,'Working resolution changed');
}));

test('continuous video retains completed masks and accepts bounded results behind the newest frame',()=>withBrowser(async({make,source,workers,revoked})=>{
  const video=value=>({...source(value),videoWidth:w,videoHeight:h,paused:false,seeking:false});
  const o=make();o.setReference(source());o.mask(video(110),'a');const worker=workers[0];
  o.mask(video(120),'b');await worker.reply(worker.messages[1]);assert.equal(o.url,'blob:test-0','Live work starved behind the latest frame');
  assert.equal(o.mask(video(130),'c'),'blob:test-0','A new playing frame cleared the completed mask');
  assert.deepEqual(revoked,[]);await worker.reply(worker.messages[2]);assert.equal(o.url,'blob:test-1');
  assert.deepEqual(revoked,[]);assert.equal(o.inFlight.stamp,'c');
}));

test('seeks/pause reject old live completions, including after continuous playback resumes',()=>withBrowser(async({make,source,workers,created})=>{
  const video=(value,extra={})=>({...source(value),videoWidth:w,videoHeight:h,paused:false,seeking:false,...extra});
  const o=make();o.setReference(source());o.mask(video(110),'a');const worker=workers[0],old=worker.messages[1];
  o.mask(video(120),'b');assert.equal(o.mask(video(130,{seeking:true}),'seeking'),null);assert.equal(o.pending,null);
  o.mask(video(140),'after-seek');await worker.reply(old);assert.equal(o.url,null,'Pre-seek live completion crossed playback generations');assert.ok(o.ready('a'));
  const fresh=worker.messages[2];await worker.reply(fresh);assert.equal(o.url,'blob:test-1');
  assert.equal(o.mask(video(150,{paused:true}),'paused'),null);const paused=worker.messages[3];
  o.mask(source(160),'bitmap');await worker.reply(paused);assert.equal(o.url,null,'Paused mask replaced a different bitmap frame');
  await worker.reply(worker.messages[4]);assert.equal(o.mask(source(160),'bitmap'),'blob:test-3');
}));

test('an older asynchronous reference load cannot replace a manually updated background',()=>withBrowser(async({make,source})=>{
  let finish;globalThis.Image=class {constructor(){Object.assign(this,source(70));}decode(){return new Promise(resolve=>{finish=resolve;});}};
  const o=make();o.configure('camera');const loading=o.loadReference('background.png');assert.ok(o.loading);
  o.setReference(source(150));finish();await loading;
  assert.equal(o.reference[0],150);assert.equal(o.loading,false);assert.equal(o.failed,false);
}));

test('changing cameras cancels an unfinished image decode and releases its media source',()=>withBrowser(async({make,source})=>{
  let image;globalThis.Image=class{constructor(){image=this;Object.assign(this,source());}decode(){return new Promise(()=>{});}};
  const o=make();o.configure('old');let settled=false;
  const loading=o.loadReference('never-finishes.png').then(()=>{settled=true;});
  assert.equal(image.src,'never-finishes.png');o.configure('new');
  await new Promise(r=>setImmediate(r));assert.ok(settled,'Cancelled decode retained the old load until it completed');
  await loading;assert.equal(image.src,'');assert.equal(o.loading,false);assert.equal(o.failed,false);assert.equal(o.referenceLoad,null);
  o.setReference(source(150));assert.equal(o.reference[0],150);
}));

test('disposing a pending background video clears its timeout, decoder and event handlers',()=>withBrowser(async({make})=>{
  const create=document.createElement,schedule=globalThis.setTimeout,clear=globalThis.clearTimeout,active=new Set();let next=0,video;
  globalThis.setTimeout=()=>{const id=++next;active.add(id);return id;};globalThis.clearTimeout=id=>active.delete(id);
  document.createElement=kind=>kind!=='video'?create(kind):(video={loads:0,removeAttribute(key){delete this[key];},load(){this.loads++;}});
  try{
    const o=make();o.configure('old');let settled=false;
    const loading=o.loadReference(null,'never-finishes.mp4').then(()=>{settled=true;});
    assert.equal(active.size,1);assert.equal(video.src,'never-finishes.mp4');
    o.dispose();await new Promise(r=>setImmediate(r));await loading;
    assert.ok(settled);assert.equal(active.size,0);assert.equal(video.src,undefined);assert.equal(video.loads,1);
    assert.equal(video.onloadeddata,null);assert.equal(video.onerror,null);assert.equal(o.sample.width,0);assert.equal(o.sample.height,0);
  }finally{document.createElement=create;globalThis.setTimeout=schedule;globalThis.clearTimeout=clear;}
}));

test('a successful video reference is copied before its owned decoder is released',()=>withBrowser(async({make,source})=>{
  const create=document.createElement;let video;
  document.createElement=kind=>kind!=='video'?create(kind):(video={...source(125),loads:0,removeAttribute(key){delete this[key];},load(){this.loads++;}});
  try{
    const o=make();const loading=o.loadReference(null,'background.mp4');video.onloadeddata();await loading;
    assert.equal(o.reference[0],125);assert.equal(o.failed,false);assert.equal(o.loading,false);assert.equal(o.referenceLoad,null);
    assert.equal(video.loads,1);assert.equal(video.src,undefined);assert.equal(video.onloadeddata,null);assert.equal(video.onerror,null);
  }finally{document.createElement=create;}
}));

test('worker failure clears both bounded slots and does not fall back to synchronous alpha/PNG work',()=>withBrowser(async({make,source,workers})=>{
  const o=make();o.setReference(source());o.mask(source(110),'a');o.mask(source(120),'b');
  const worker=workers[0];await worker.reply(worker.messages[1],{error:'encoder failed'});
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

test('empty results share a clear sentinel without PNG URLs or repeat calculations',()=>withBrowser(async({make,source,workers,created,context})=>{
  const o=make();o.setReference(source());o.mask(source(),'empty');const worker=workers[0];
  await worker.reply(worker.messages[1],{clear:true});assert.ok(o.ready('empty'));assert.equal(o.cache.size,0);assert.equal(o.url,null);
  const draws=context.draws;
  for(let i=0;i<20;i++)assert.equal(o.mask(source(),'empty'),null);
  assert.equal(worker.messages.length,2);assert.equal(context.draws,draws);assert.deepEqual(created,[]);
}));

test('a live clear result remains accepted while the next video frame is being calculated',()=>withBrowser(async({make,source,workers,created})=>{
  const video=value=>({...source(value),videoWidth:w,videoHeight:h,paused:false,seeking:false});
  const o=make();o.setReference(source());o.mask(video(110),'a');
  await workers[0].reply(workers[0].messages[1],{clear:true});
  assert.ok(o.presentable('a'));assert.equal(o.stamp,'a');assert.equal(o.url,null);
  o.mask(video(120),'b');assert.equal(o.ready('b'),false);assert.equal(o.stamp,'a');
  assert.equal(o.url,null);assert.deepEqual(created,[]);
}));

test('precomputed foreground PNGs decode lazily before becoming presentable',()=>withBrowser(async({make,source,workers})=>{
  const images=[];
  globalThis.Image=class {
    constructor(){images.push(this);}
    decode(){return new Promise(resolve=>{this.finish=resolve;});}
    removeAttribute(key){delete this[key];}
  };
  const o=make();o.setReference(source());o.precompute(['a'],async()=>source(110));
  await new Promise(r=>setImmediate(r));const worker=workers[0];await worker.reply(worker.messages[1]);
  assert.ok(o.ready('a'));assert.equal(o.presentable('a'),false);assert.equal(images.length,0,'Unseen precomputed masks allocated decoders');
  const jobs=worker.messages.length;assert.equal(o.mask(source(110),'a'),null);
  await new Promise(r=>setImmediate(r));assert.equal(images.length,1);assert.equal(o.presentable('a'),false);
  images[0].finish();await new Promise(r=>setImmediate(r));
  assert.ok(o.presentable('a'));assert.equal(o.url,'blob:test-0');assert.equal(worker.messages.length,jobs);
}));

test('mask decoding bounds pending work, releases old decoded images, and reuses compressed results',()=>withBrowser(async({make,source,workers})=>{
  const images=[];
  globalThis.Image=class {
    constructor(){images.push(this);}
    decode(){return new Promise(resolve=>{this.finish=resolve;});}
    removeAttribute(key){delete this[key];}
  };
  const o=make();o.setReference(source());
  for(const [stamp,value]of [['a',110],['b',120],['c',130]]){
    o.mask(source(value),stamp);const worker=workers[0];await worker.reply(worker.messages.at(-1));
  }
  assert.equal(images.length,1);assert.equal(o.decodePending.job.stamp,'c');
  images[0].finish();await new Promise(r=>setImmediate(r));
  assert.equal(images.length,2);assert.equal(images[0].src,undefined);assert.equal(o.presentable('b'),false);
  images[1].finish();await new Promise(r=>setImmediate(r));assert.equal(o.stamp,'c');
  const jobs=workers[0].messages.length;o.mask(source(110),'a');await new Promise(r=>setImmediate(r));
  assert.equal(images.length,3);assert.equal(o.presentable('c'),true,'Displayed mask was released while its replacement was decoding');
  images[2].finish();await new Promise(r=>setImmediate(r));
  assert.equal(o.stamp,'a');assert.equal(images[1].src,undefined);assert.equal(workers[0].messages.length,jobs);
  assert.equal([...o.cache.values()].filter(entry=>entry.image).length,1);
}));

test('camera changes cancel mask decoding and reject late completions without retaining image resources',()=>withBrowser(async({make,source,workers,revoked})=>{
  let image;
  globalThis.Image=class {
    constructor(){image=this;}
    decode(){return new Promise(resolve=>{this.finish=resolve;});}
    removeAttribute(key){delete this[key];}
  };
  const o=make();o.configure('old');o.setReference(source());o.mask(source(110),'a');
  await workers[0].reply(workers[0].messages[1]);assert.equal(image.src,'blob:test-0');
  o.configure('new');assert.equal(image.src,undefined);assert.equal(o.decoding,null);assert.equal(o.decodePending,null);
  image.finish();await new Promise(r=>setImmediate(r));
  assert.equal(o.cache.size,0);assert.equal(o.url,null);assert.equal(o.stamp,null);assert.deepEqual(revoked,['blob:test-0']);
}));

test('a rejected PNG decode releases its resource and stops mask work cleanly',()=>withBrowser(async({make,source,workers})=>{
  let image;
  globalThis.Image=class {
    constructor(){image=this;}
    decode(){return Promise.reject(Error('bad PNG'));}
    removeAttribute(key){delete this[key];}
  };
  const o=make();o.setReference(source());o.mask(source(110),'a');await workers[0].reply(workers[0].messages[1]);
  assert.ok(o.failed);assert.ok(workers[0].terminated);assert.equal(image.src,undefined);assert.equal(o.decoding,null);
  assert.equal(o.mask(source(110),'a'),null);assert.equal(o.presentable('a'),false);
}));

test('an older live PNG decode cannot replace a newer clear result, while explicit revisits remain valid',()=>withBrowser(async({make,source,workers})=>{
  let image;
  globalThis.Image=class {
    constructor(){image=this;}
    decode(){return new Promise(resolve=>{this.finish=resolve;});}
    removeAttribute(key){delete this[key];}
  };
  const video=value=>({...source(value),videoWidth:w,videoHeight:h,paused:false,seeking:false});
  const o=make();o.setReference(source());o.mask(video(110),'a');const worker=workers[0];
  await worker.reply(worker.messages[1]);o.mask(video(120),'b');await worker.reply(worker.messages[2],{clear:true});
  assert.equal(o.stamp,'b');assert.equal(o.url,null);
  image.finish();await new Promise(r=>setImmediate(r));
  assert.equal(o.stamp,'b','An older PNG decode rewound continuous playback');assert.equal(o.url,null);
  o.mask(video(110),'a');assert.equal(o.stamp,'a');assert.equal(o.url,'blob:test-0');
}));

test('a requested clear prefetch also blocks an older live decode from rewinding presentation',()=>withBrowser(async({make,source,workers})=>{
  let image;
  globalThis.Image=class {
    constructor(){image=this;}
    decode(){return new Promise(resolve=>{this.finish=resolve;});}
    removeAttribute(key){delete this[key];}
  };
  const video=value=>({...source(value),videoWidth:w,videoHeight:h,paused:false,seeking:false});
  const o=make();o.setReference(source());o.mask(video(110),'a');const worker=workers[0];
  await worker.reply(worker.messages[1]);o.precompute(['b'],async()=>source(120));await new Promise(r=>setImmediate(r));
  o.mask(video(120),'b');await worker.reply(worker.messages[2],{clear:true});assert.equal(o.stamp,'b');
  image.finish();await new Promise(r=>setImmediate(r));assert.equal(o.stamp,'b');assert.equal(o.url,null);
}));

test('prefetch is lazy, yields to requested frames, and releases temporary decoded images',()=>withBrowser(async({make,source,workers})=>{
  const o=make();let loaded=[],released=[];
  o.precompute(['before-reference'],()=>{throw Error('No reference');});assert.equal(o.prefetchTasks.size,0);
  o.setReference(source());o.precompute(['a','b','c'],async stamp=>{loaded.push(stamp);return {source:source(110),release:()=>released.push(stamp)};});
  await new Promise(r=>setImmediate(r));const worker=workers[0];assert.deepEqual(loaded,['a']);assert.deepEqual(released,['a']);
  o.mask(source(140),'wanted');await worker.reply(worker.messages[1]);assert.equal(worker.messages[2].stamp,'wanted');
  await worker.reply(worker.messages[2]);await new Promise(r=>setImmediate(r));assert.equal(worker.messages[3].stamp,'b');
  o.suspendPrefetch();await worker.reply(worker.messages[3],{clear:true});await new Promise(r=>setImmediate(r));assert.deepEqual(loaded,['a','b']);
  assert.ok(o.ready('a')&&o.ready('b')&&o.ready('wanted'));assert.equal(o.prefetchTasks.size,0);
}));

test('foreground cache evicts old masks at its bound and invalidates on a new background',()=>withBrowser(async({make,source,workers,revoked})=>{
  const o=make({limit:2,maxBytes:100});o.setReference(source());
  for(const stamp of ['a','b','c']){o.mask(source(110),stamp);const worker=workers[0];await worker.reply(worker.messages.at(-1));}
  assert.equal(o.cache.size,2);assert.equal(o.ready('a'),false);assert.deepEqual(revoked,['blob:test-0']);
  o.setReference(source(150));assert.equal(o.cache.size,0);assert.equal(o.clearFrames.size,0);assert.equal(o.bytes,0);assert.equal(revoked.length,3);
}));

test('worker skips PNG encoding for an empty background and global exposure changes',async()=>{
  const reference=background(),messages=[];let encoded=0;
  const self={postMessage:result=>messages.push(result)};
  const code=readFileSync(new URL('../renderer/front-occlusion-worker.mjs',import.meta.url),'utf8').replace("import {frontOverlayAlpha} from './front-occlusion.mjs';",'');
  class OffscreenCanvas{constructor(){encoded++;throw Error('Empty masks need no canvas');}}
  vm.runInNewContext(code,{self,OffscreenCanvas,frontOverlayAlpha,Uint8ClampedArray});
  await self.onmessage({data:{type:'reference',generation:1,width:w,height:h,reference:reference.buffer}});
  for(const pixels of [reference.slice(),reference.map((v,i)=>i%4===3?v:v+12)])await self.onmessage({data:{type:'frame',generation:1,id:messages.length,stamp:'empty',pixels:pixels.buffer}});
  assert.equal(encoded,0);assert.equal(messages.length,2);assert.ok(messages.every(m=>m.clear===true&&!m.blob));
});


test('histogram exposure medians preserve every baseline alpha byte across noise, runners and sample boundaries',()=>{
  const vectors=JSON.parse(readFileSync(new URL('./fixtures/front-alpha-vectors.json',import.meta.url),'utf8'));
  for(const {width,height,seed,kind,sha256}of vectors.cases){
    const reference=new Uint8ClampedArray(width*height*4),frame=new Uint8ClampedArray(reference.length);let state=seed;
    const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<4;c++){
      const i=(y*width+x)*4+c;if(c===3){reference[i]=frame[i]=255;continue;}
      reference[i]=50+random()%140;frame[i]=kind==='random'?random()%256:reference[i]+12+(random()%9)-4;
      if(kind==='runner'&&x>width*.37&&x<width*.48&&y>height*.15&&y<height*.85)frame[i]=[20,155,195][c];
    }
    const alpha=frontOverlayAlpha(reference,frame,width,height);
    assert.equal(createHash('sha256').update(alpha).digest('hex'),sha256,`${width}x${height} ${kind}`);
  }
});

test('foreground hot paths preserve baseline alpha bytes for thin frames, shadows and density boundaries',()=>{
  const vectors=JSON.parse(readFileSync(new URL('./fixtures/front-alpha-hotpath-vectors.json',import.meta.url),'utf8'));
  for(const {width,height,seed,kind,sha256}of vectors.cases){
    const count=width*height,reference=new Uint8ClampedArray(count*4),frame=new Uint8ClampedArray(count*4);let state=seed>>>0;
    const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
      const p=(y*width+x)*4;
      for(let c=0;c<3;c++){
        const r=reference[p+c]=kind==='black-runner'?0:kind==='white-runner'?255:40+random()%170;
        frame[p+c]=kind==='random'?random()%256:kind==='unchanged'||kind.endsWith('-runner')?r:r+12+(random()%9)-4;
        if((kind==='runner'||kind.endsWith('-runner'))&&x>width*.37&&x<width*.48&&y>height*.15&&y<height*.85)frame[p+c]=[20,155,195][c];
        if(kind==='dark')frame[p+c]=Math.round(r*.75);
        if(kind==='bright')frame[p+c]=r+55;
        if(kind==='dense')frame[p+c]=255-r;
      }
      reference[p+3]=frame[p+3]=255;
    }
    if(kind.startsWith('threshold-')){
      reference.fill(100);frame.fill(100);
      let remaining=Math.max(0,Math.floor(count/8)+({low:-1,at:0,high:1}[kind.slice(10)]));
      for(let y=1;y<height-1&&remaining;y++)for(let x=1;x<width-1&&remaining;x++,remaining--)frame.set([20,190,200,100],(y*width+x)*4);
    }
    assert.equal(createHash('sha256').update(frontOverlayAlpha(reference,frame,width,height)).digest('hex'),sha256,`${width}x${height} ${kind} seed ${seed}`);
  }
});

test('worker RGBA packing preserves every alpha byte and respects image buffer offsets',async()=>{
  const width=17,height=17,count=width*height,alpha=Uint8ClampedArray.from({length:count},(_,i)=>i*37%256);
  const code=readFileSync(new URL('../renderer/front-occlusion-worker.mjs',import.meta.url),'utf8').replace("import {frontOverlayAlpha} from './front-occlusion.mjs';",'');
  for(const offset of [0,1,4]){
    let result,encoded,storage;
    const self={postMessage(value){result=value;}};
    class OffscreenCanvas{
      getContext(){return {
        createImageData(){storage=new Uint8ClampedArray(offset+count*4+7);storage.fill(73);return {data:new Uint8ClampedArray(storage.buffer,offset,count*4)};},
        putImageData(image){encoded=image.data.slice();}
      };}
      async convertToBlob(){return new Blob([encoded]);}
    }
    vm.runInNewContext(code,{self,OffscreenCanvas,frontOverlayAlpha:()=>alpha,Uint8ClampedArray});
    const reference=new Uint8ClampedArray(count*4),current=reference.slice();current[0]=1;
    await self.onmessage({data:{type:'reference',generation:2,width,height,reference:reference.buffer}});
    await self.onmessage({data:{type:'frame',generation:2,id:1,stamp:'frame',pixels:current.buffer}});
    assert.equal(result.error,undefined);
    const actual=new Uint8ClampedArray(await result.blob.arrayBuffer());
    for(let i=0;i<count;i++)assert.deepEqual([...actual.subarray(i*4,i*4+4)],[255,255,255,alpha[i]],`offset ${offset}, pixel ${i}`);
    assert.ok(storage.subarray(0,offset).every(v=>v===73));
    assert.ok(storage.subarray(offset+count*4).every(v=>v===73));
  }
});
