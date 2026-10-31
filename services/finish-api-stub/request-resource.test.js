import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./server.js',import.meta.url),'utf8');
// Exercise the actual HTTP body reader with a small equivalent limit so the
// oversized-upload ownership regression does not need a 64 MiB allocation.
const start=source.indexOf('async function readJson(req) {'),end=source.indexOf('\nfunction validateTruth',start);
const StubError=class extends Error{constructor(status,code,message){super(message);Object.assign(this,{status,code});}};
const readJson=vm.runInNewContext(source.slice(start,end)+'\nreadJson;',{MAX_BODY_BYTES:32,Buffer,StubError,invalid:()=>new StubError(400,'bad_request','Invalid finish API request.')});
function request(){const req=new EventEmitter();req.headers={'content-type':'application/json'};req.resume=()=>{req.draining=true;};return req;}
const bodyListeners=req=>['data','end','error','aborted'].map(name=>req.listenerCount(name));

test('completed JSON uploads release every body-reading listener',async()=>{
  const req=request(),result=readJson(req);req.emit('data',Buffer.from('{"answer":42}'));req.emit('end');
  assert.equal((await result).answer,42);assert.deepEqual(bodyListeners(req),[0,0,0,0]);
});
test('oversized and aborted uploads release chunk listeners while safely draining',async()=>{
  for(const kind of ['oversized','aborted']) {
    const req=request(),result=readJson(req);req.emit('data',Buffer.alloc(24));
    if(kind==='oversized')req.emit('data',Buffer.alloc(24));else req.emit('aborted');
    await assert.rejects(result,error=>error.status===(kind==='oversized'?413:400));
    assert.equal(req.listenerCount('data'),0);assert.equal(req.listenerCount('end'),0);assert.ok(req.draining);
    req.emit('error',Error('late socket error'));req.emit('close');assert.deepEqual(bodyListeners(req),[0,0,0,0]);
  }
});
