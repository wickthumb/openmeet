import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
// Exercise the actual controller without painting UI or starting a camera.
const consoleSource=readFileSync(new URL('../renderer/console.js',import.meta.url),'utf8');
const start=consoleSource.indexOf('function requestProposals(h) {'),end=consoleSource.indexOf('// Camera setup preview',start);
assert.ok(start>=0&&end>start);
const source=consoleSource.slice(start,end);
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function controller({simulated=false}={}) {
  let resolve,reject;const response=new Promise((yes,no)=>{resolve=yes;reject=no;});
  const applied=[],timers=[],context={S:{apiOnline:true,atInfo:{stub:false}},OM:simulated?null:{call:()=>response},SPEED:1,performance,
    renderUI(){},predictParams:h=>({captureId:h.captureId}),toProps:res=>res.predictions,
    applyProposals:(...args)=>applied.push(args),makeProposals:()=>[{lane:2,col:10}],setTimeout:callback=>timers.push(callback)};
  const request=vm.runInNewContext(source+'\nrequestProposals;',context);
  return {request,resolve,reject,applied,timers};
}
const heat=()=>({asset:{},captureId:'first',runVersion:1,req:'idle'});

test('late final predictions from a recalled/refired capture cannot change the current race',async()=>{
  const c=controller(),h=heat();c.request(h);h.runVersion++;h.captureId='second';h.req='idle';
  c.resolve({predictions:[{lane:2,col:500}]});await flush();assert.equal(c.applied.length,0);assert.equal(h.req,'idle');
});
test('a stale prediction failure cannot replace a newer race state with an old error',async()=>{
  const c=controller(),h=heat();c.request(h);h.runVersion++;h.req='live';
  c.reject(Error('old service failure'));await flush();assert.equal(h.req,'live');assert.equal(h.reqErr,undefined);
});
test('valid same-capture predictions and errors retain their existing behavior',async()=>{
  const c=controller(),h=heat();c.request(h);c.resolve({predictions:[{lane:2,col:30},{lane:1,col:10}]});await flush();
  assert.equal(c.applied.length,1);assert.strictEqual(c.applied[0][0],h);assert.deepEqual(c.applied[0][1].map(p=>p.col),[10,30]);
  const bad=controller(),other=heat();bad.request(other);bad.reject(Error('service failure'));await flush();assert.equal(other.req,'error');assert.equal(other.reqErr,'service failure');
});
test('a delayed simulator result also belongs to its original capture attempt',()=>{
  const c=controller({simulated:true}),h={runVersion:1};c.request(h);h.runVersion++;c.timers[0]();assert.equal(c.applied.length,0);
});
