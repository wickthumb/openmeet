import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SourceImageCache} from '../renderer/source-image-cache.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('simultaneous camera reads share one decoded image and preserve its output',async()=>{
  const cache=new SourceImageCache(),read=deferred();let reads=0,decodes=0;
  const load=()=>cache.load('camera',()=>{reads++;return read.promise;},pixels=>{decodes++;return {pixels};});
  const first=load(),second=load();read.resolve([1,2,3]);
  assert.strictEqual(await first,await second);assert.deepEqual((await first).pixels,[1,2,3]);
  assert.equal(reads,1);assert.equal(decodes,1);assert.strictEqual(await load(),await first);
});

test('changing meets discards a late camera response before allocating its canvas or mask',async()=>{
  const cache=new SourceImageCache(),read=deferred();let decodes=0;
  const old=cache.load('camera',()=>read.promise,()=>{decodes++;return {largeCanvas:true};});
  cache.clear();read.resolve([1,2,3]);assert.equal(await old,null);assert.equal(decodes,0);assert.equal(cache.get('camera'),undefined);
});

test('an old request cannot remove or replace a new request for the same path after reopening',async()=>{
  const cache=new SourceImageCache(),oldRead=deferred(),newRead=deferred();
  const old=cache.load('same-path',()=>oldRead.promise,x=>x);cache.clear();
  const fresh=cache.load('same-path',()=>newRead.promise,x=>x);oldRead.resolve('old');assert.equal(await old,null);
  const joined=cache.load('same-path',()=>{throw Error('Duplicate disk read');},x=>x);
  newRead.resolve('new');assert.equal(await fresh,'new');assert.equal(await joined,'new');assert.equal(cache.get('same-path'),'new');
});

test('failed camera reads release their pending entry and remain retryable',async()=>{
  const cache=new SourceImageCache();await assert.rejects(cache.load('camera',()=>{throw Error('read failed');},x=>x),/read failed/);
  assert.equal(await cache.load('camera',()=>42,x=>x),42);
});
