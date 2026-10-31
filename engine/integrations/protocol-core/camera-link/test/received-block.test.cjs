'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {inspectReceivedBlock:inspect} = require('../src/received-block.cjs');
const release = join(__dirname,'../../requirements/CAMERA-BLOCK-v1');
const cases = JSON.parse(readFileSync(join(release,'AUTHORED-BLOCK-CASES-v1.json'))).cases;
const hash = b => createHash('sha256').update(b).digest('hex');
function generate(i) {
  const b = Buffer.alloc(i.length);
  for(let n=0;n<b.length;n++) b[n]=(i.pattern.multiplier*n+i.pattern.increment)%i.pattern.modulus;
  b.writeUInt32LE(i.metadata,b.length-12); b.writeUInt32LE(i.index,b.length-8); b.writeUInt32LE(i.inverse,b.length-4);
  return b;
}
test('reviewed release remains pinned',()=>{
 const manifest=JSON.parse(readFileSync(join(release,'MANIFEST.json'),'utf8').replace(/^\uFEFF/,''));
 assert.equal(cases.length,29);
 for(const f of manifest.files){const b=readFileSync(join(release,f.file));assert.equal(b.length,f.bytes);assert.equal(hash(b),f.sha256);}
});
for(const c of cases) test('authored '+c.id,()=>{
 const b=generate(c.input), before=Buffer.from(b);
 assert.equal(hash(b),c.input.sha256);if(c.input.hex!==undefined)assert.equal(b.toString('hex'),c.input.hex);
 const o=inspect(b,Object.freeze({expectedIndex:c.input.expectedIndex}));
 const expected={...c.expected};
 if(expected.normalizedSegmentsAbsent!==undefined){
   assert.equal(expected.normalizedSegmentsAbsent,true);
   assert.equal(Object.hasOwn(o,'knownSegments'),false);
   assert.equal(Object.hasOwn(o,'normalizedSegments'),false);
   delete expected.normalizedSegmentsAbsent;
   expected.reason='index';expected.captureCompleteNotEstablished=true;
 }
 if(expected.knownSegments){
   assert.equal(o.knownSegments.length,expected.knownSegments.length);
   for(let n=0;n<expected.knownSegments.length;n++){
     const s=o.knownSegments[n], e=expected.knownSegments[n];
     assert.deepEqual(Object.keys(s).sort(),['bytes','offset']);assert.equal(s.offset,e.offset);assert.equal(s.bytes.length,e.length);
     assert.equal(hash(s.bytes),e.sha256);if(e.hex!==undefined)assert.equal(s.bytes.toString('hex'),e.hex);
     if(n)assert.ok(o.knownSegments[n-1].offset+o.knownSegments[n-1].bytes.length<s.offset);
   }
   expected.knownSegments=o.knownSegments;
 }
 assert.deepEqual(o,{receivedLength:b.length,...expected});
 assert.deepEqual(b,before);
 const saved=(o.knownSegments||[]).map(s=>Buffer.from(s.bytes));b.fill(0xa5);
 (o.knownSegments||[]).forEach((s,n)=>assert.deepEqual(s.bytes,saved[n]));
});
test('invalid byte containers throw TypeError',()=>{
 for(const b of [undefined,null,[],{},'bytes',new ArrayBuffer(20),new DataView(new ArrayBuffer(20)),new Uint16Array(20),new Int8Array(20)])
 assert.throws(()=>inspect(b,{expectedIndex:0}),TypeError);
});
test('explicit unsigned32 option required even before length rejection',()=>{
 for(const opt of [undefined,null,[],0,'x',{}, {expectedIndex:undefined}, ...[-1,4294967296,1.5,NaN,Infinity,-Infinity,'7',null,true,7n].map(expectedIndex=>({expectedIndex}))])
 assert.throws(()=>inspect(Buffer.alloc(0),opt),TypeError);
});
test('length rejection includes no normalized data',()=>{
 for(const length of [0,1,12,19,16001,20000])assert.deepEqual(inspect(Buffer.alloc(length),{expectedIndex:0xffffffff}),{
 decision:'reject',reason:'length',receivedLength:length,expectedIndex:0xffffffff,captureCompleteNotEstablished:true});
});
test('offset views, independent calls and bidirectional detachment',()=>{
 for(const length of [20,15988,15996,15997,15998,15999,16000])for(const kind of ['buffer','uint8']){
 const spec={...cases[0].input,length};const b=generate(spec), backing=Buffer.alloc(length+23,0x55);b.copy(backing,9);
 const view=kind==='buffer'?backing.subarray(9,9+length):new Uint8Array(backing.buffer,backing.byteOffset+9,length);
 const before=Buffer.from(backing), opt=Object.freeze({expectedIndex:7});
 const a=inspect(view,opt), other=inspect(view,opt);assert.deepEqual(a,other);assert.deepEqual(backing,before);
 a.knownSegments.forEach(s=>s.bytes.fill(0x66));assert.deepEqual(backing,before);assert.deepEqual(inspect(view,opt),other);
 const saved=other.knownSegments.map(s=>Buffer.from(s.bytes));view.fill(0x88);
 other.knownSegments.forEach((s,n)=>assert.deepEqual(s.bytes,saved[n]));
 }
});
test('zero-write boundary and overlap preserve original trailer',()=>{
 for(const length of [15996,15997,15998,15999,16000]){
 const b=generate({...cases[0].input,length}), trailer=Buffer.from(b.subarray(length-12));
 const o=inspect(b,{expectedIndex:7}), normalized=o.knownSegments[0].bytes;
 assert.deepEqual(normalized.subarray(15988),trailer);
 assert.deepEqual(o.zeroWrite,length===15996?{offset:15984,length:4}:null);
 if(length===15996)assert.deepEqual(normalized.subarray(15984,15988),Buffer.alloc(4));
 else assert.deepEqual(normalized.subarray(0,15988),b.subarray(0,15988));
 }
});
test('arbitrary initial index is explicit; full unsigned equality',()=>{
 const b=generate({...cases[0].input,index:0xdeadbeef,inverse:0,metadata:0xffffffff});
 const o=inspect(b,{expectedIndex:0xdeadbeef});assert.equal(o.actualIndex,0xdeadbeef);assert.equal(o.producerMetadataRaw,0xffffffff);assert.equal(o.inverseMatches,false);
 assert.deepEqual(inspect(b,{expectedIndex:0x5eadbeef}),{decision:'reject',reason:'index',receivedLength:20,actualIndex:0xdeadbeef,expectedIndex:0x5eadbeef,captureCompleteNotEstablished:true});
});

