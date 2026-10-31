'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeIdentityPair: decode } = require('../src/passive-identity.cjs');
// Independent authored wire bytes, not generated through production code.
function pair() {
  return { request: { bytes: Buffer.from('6b72694b2a0000001a0003000100000001000000','hex'),
    sourceAddress:'192.0.2.5', sourcePort:53000, destinationAddress:'192.0.2.6', destinationPort:41925 },
  response: { bytes:Buffer.from('948d96b42a00000001000080080000007856341240000000010000005544332211020000200300002805000003000000','hex'),
    sourceAddress:'192.0.2.6', sourcePort:41925, destinationAddress:'192.0.2.5', destinationPort:53000 } };
}
function reject(p,reason) { assert.deepEqual(decode(p),{decision:'not-matched',reason}); }
test('fixed authored pair has exact interpretation and canonical negative claims',()=>{
 assert.deepEqual(decode(pair()),{decision:'matched',reason:'supported-pair',sequence:42,
 payload:[305419896,64,1,573785173,529,800,1320,3],serialNumberRaw:305419896,
 memoryStatusRaw:64,capabilityWord:1,macAddress:'02:11:22:33:44:55',cpuSpeedRaw:800,
 romVersionRaw:1320,cpuTypeRaw:3,observedTimerSyncWord:1,modelConfirmed:false,runtimeConfirmed:false});
});
test('high bits remain unsigned and uninterpreted',()=>{
 const p=pair();p.request.bytes.writeUInt32LE(0xffffffff,4);p.response.bytes.writeUInt32LE(0xffffffff,4);
 p.request.bytes.writeUInt32LE(0xfedcba98,16);
 for(const i of [0,1,2,3,5,6,7])p.response.bytes.writeUInt32LE(0xffffffff,16+i*4);
 p.response.bytes.writeUInt32LE(0xffff,32);const o=decode(p);
 assert.equal(o.sequence,4294967295);assert.equal(o.observedTimerSyncWord,4275878552);
 for(const k of ['serialNumberRaw','memoryStatusRaw','capabilityWord','cpuSpeedRaw','romVersionRaw','cpuTypeRaw'])assert.equal(o[k],4294967295);
 assert.equal(o.macAddress,'ff:ff:ff:ff:ff:ff');assert.equal(o.runtimeConfirmed,false);assert.equal(o.modelConfirmed,false);
});
test('required observations and invalid API values throw TypeError',()=>{
 for(const v of [undefined,null,{},[],{response:pair().response},{request:pair().request}])assert.throws(()=>decode(v),TypeError);
 for(const side of ['request','response']){
  for(const v of [undefined,null,[],new DataView(new ArrayBuffer(20)),new Uint16Array(20),'bytes']){const p=pair();p[side].bytes=v;assert.throws(()=>decode(p),TypeError);}
  for(const key of ['sourceAddress','destinationAddress'])for(const v of ['',null,1,undefined]){const p=pair();p[side][key]=v;assert.throws(()=>decode(p),TypeError);}
  for(const key of ['sourcePort','destinationPort'])for(const v of [0,-1,65536,1.5,NaN,Infinity,'41925',null,undefined]){const p=pair();p[side][key]=v;assert.throws(()=>decode(p),TypeError);}
 }
});
test('endpoint reversal and camera port gates compare literally',()=>{
 for(const [side,key,v] of [['request','destinationPort',41924],['response','sourcePort',41924],['request','sourcePort',53001],['response','destinationPort',53001],['request','destinationAddress','192.0.2.06'],['response','sourceAddress','other'],['request','sourceAddress','other'],['response','destinationAddress','other']]){const p=pair();p[side][key]=v;reject(p,'endpoints');}
 const p=pair();p.request.sourceAddress=p.response.destinationAddress=' ';assert.equal(decode(p).decision,'matched');
});
for(const [side,offset,value,reason] of [
 ['request',0,0,'request-marker'],['request',8,0x0003001b,'request-command'],['request',8,0x0002001a,'request-command'],['request',12,0,'request-count'],['request',12,2,'request-count'],
 ['response',0,0,'response-marker'],['response',4,43,'sequence'],['response',8,0x80000002,'failure'],['response',8,0,'response-status'],['response',12,7,'response-count'],['response',12,9,'response-count'],['response',24,0,'capability'],['response',24,0xfffffffe,'capability'],['response',32,65536,'mac-fragment']])
 test(`${reason}: ${side} offset ${offset} value ${value}`,()=>{const p=pair();p[side].bytes.writeUInt32LE(value,offset);reject(p,reason);});
test('exact lengths reject short, empty, long and trailing bytes',()=>{
 for(const side of ['request','response'])for(const size of [0,1,15,16,19,21,47,49,100]){const p=pair();if(size===p[side].bytes.length)continue;const b=Buffer.alloc(size);p[side].bytes.copy(b);p[side].bytes=b;reject(p,side+'-length');}
});
test('gate order prevents interpretation of uncorrelated or invalid pairs',()=>{
 const p=pair();p.request.destinationPort=1;p.request.bytes=Buffer.alloc(0);reject(p,'endpoints');
 const q=pair();q.request.bytes.writeUInt32LE(0,8);q.response.bytes=Buffer.alloc(0);reject(q,'request-command');
 const r=pair();r.response.bytes.writeUInt32LE(0,4);r.response.bytes.writeUInt32LE(0x80000002,8);reject(r,'sequence');
 const s=pair();s.response.bytes.writeUInt32LE(0,24);s.response.bytes.writeUInt32LE(0x10000,32);reject(s,'capability');
});
test('Buffer and Uint8Array offsets, frozen metadata, and no aliases or mutations',()=>{
 for(const kind of ['buffer','uint8']){
 const p=pair();for(const side of ['request','response']){const original=p[side].bytes;const storage=Buffer.alloc(original.length+13,0xaa);original.copy(storage,7);p[side].bytes=kind==='buffer'?storage.subarray(7,7+original.length):new Uint8Array(storage.buffer,storage.byteOffset+7,original.length);Object.freeze(p[side]);}
 Object.freeze(p);const before=[Buffer.from(p.request.bytes),Buffer.from(p.response.bytes)];const o=decode(p);
 assert.deepEqual(Buffer.from(p.request.bytes),before[0]);assert.deepEqual(Buffer.from(p.response.bytes),before[1]);
 o.payload[0]=0;assert.deepEqual(decode(p).payload[0],305419896);p.response.bytes.fill(0);assert.equal(o.serialNumberRaw,305419896);assert.equal(o.payload[1],64);
 }
});
test('paired-only command correlation cannot be supplied by a lone response',()=>{
 const p=pair();assert.throws(()=>decode(p.response),TypeError);
 p.request.bytes.writeUInt32LE(0x00030009,8);reject(p,'request-command');
});
