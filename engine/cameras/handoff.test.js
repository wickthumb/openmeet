import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateCameraConfiguration, decodeCameraConfiguration, deriveCameraDefaults, classifyCamera } from './configuration.js';
import { packCameraParameters, normalizeCameraGeometry } from './parameters.js';
import { decodePredictorPixels, decodePackedPixels } from './pixels.js';
import { createCameraImageDecoder, createAlignmentFrameAssembler, cameraColumnTime, repairCameraColumnTime } from './image-stream.js';
import { buildAlignmentReset, inspectNetworkCamera } from './control.js';
import { microsecondsToCameraClock, cameraClockToMicroseconds, broadcastAddress, synchronizeCameraGroup } from './clock-sync.js';
import { networkFixture, cameraReply } from './testing/network-fixture.js';
const vectors=JSON.parse(fs.readFileSync(new URL('./testing/handoff-vectors.json',import.meta.url),'utf8'));
const image=(name)=>Buffer.from(vectors.images.find(x=>x.name===name).bodyHex,'hex');
const imageProfile=(body,height=32)=>({family:3,height,clockOrigin:7,tickScale:8,expectedBlockIndex:body.readUInt32LE(body.length-8)});

for(const v of vectors.configuration)test('configuration checksum/decode: '+v.name,()=>{
  const bytes=Buffer.from(v.hex,'hex'),before=Buffer.from(bytes);
  assert.equal(validateCameraConfiguration(bytes).valid,v.valid);
  if(v.valid){const decoded=decodeCameraConfiguration(bytes,{family:3});assert.equal(decoded.capabilityWord,v.capabilityWord);assert.equal(decoded.featureWord,v.featureWord);}
  else assert.throws(()=>decodeCameraConfiguration(bytes,{family:3}),{code:'ERR_CAMERA_CONFIGURATION'});
  assert.deepEqual(bytes,before);
});
test('capability classification and ordered bounds are independent admission checks',()=>{
  for(const [family,capabilityWord,expected]of[[1,0,1],[2,0,2],[2,0x60001,4],[3,0x2c0080,12],[3,0x82c0080,13],[3,0x102c0080,14],[4,1,15],[4,0,0]]){
    assert.equal(classifyCamera({family,capabilityWord}),expected);
  }
  const config=decodeCameraConfiguration(Buffer.from(vectors.unorderedConfiguration,'hex'),{family:3});
  assert.equal(config.internalType,12);assert.equal(config.orderedBounds,false);
  assert.throws(()=>deriveCameraDefaults(config),{code:'ERR_CAMERA_BOUNDS'});
});
for(const v of vectors.parameters)test('all 19 parameter words: '+v.id,()=>{
  const input=structuredClone(v.input),result=packCameraParameters(input);
  assert.equal(result.bytes.toString('hex'),v.expectedHex);assert.equal(result.currentTdi,v.expectedCurrentTdi);assert.deepEqual(input,v.input);
});
test('geometry normalization keeps actual encoded rows separate from nominal settings',()=>{
  assert.deepEqual(normalizeCameraGeometry({mode:4,height:641,offset:19,rate:10000,minimumHeight:16,maximumHeight:2560,minimumRate:1,maximumRate:20000,doubled:true}),
    {mode:4,height:328,offset:8,rate:5000});
});
test('modern raw image matches independent nonzero expanded bytes and exact times',()=>{
  const body=image('nonzero-mode1'),decoder=createCameraImageDecoder(imageProfile(body));
  const decoded=decoder.decode(body),actual=Buffer.concat(decoded.columns.map(c=>c.working));
  const expected=Buffer.from(vectors.expectedNonzeroHex,'hex');
  assert.equal(actual.length,expected.length);
  for(let i=0;i<actual.length;i++)if(i%4!==3)assert.equal(actual[i],expected[i],`byte ${i}`);
  assert.equal(decoded.columns.length,1);assert.equal(decoder.snapshot().columnsDecoded,1);
});
for(const [name,expected]of[['coarse-monotonic',808n],['coarse-outlier',812n],['neighbor-promotes-precision',808n]])test('column timing/repair: '+name,()=>{
  const body=image(name),decoded=createCameraImageDecoder(imageProfile(body)).decode(body);
  const times=decoded.columns.map(c=>c.time),answer=repairCameraColumnTime({left:times[0],current:times[1],right:times[2]});
  assert.equal(answer.ticks,expected);assert.equal(answer.valid,true);
  if(name==='neighbor-promotes-precision')assert.equal(answer.quantum,1n);
});
test('zero timestamps stay invalid and a full payload needs no extra terminator',()=>{
  const zero=image('zero-time-is-rejected'),decoded=createCameraImageDecoder(imageProfile(zero)).decode(zero);
  assert.equal(decoded.columns[1].time.valid,false);
  const full=image('exact-full-zero-mode1'),result=createCameraImageDecoder(imageProfile(full,24)).decode(full);
  assert.equal(result.columns.length,235);assert.equal(result.records.at(-1).offset+result.records.at(-1).lengthWords*4,15988);
});
test('failed image validation does not consume block history',()=>{
  const body=image('nonzero-mode1'),decoder=createCameraImageDecoder(imageProfile(body)),bad=Buffer.from(body);
  bad.writeUInt16LE(65535,8);assert.throws(()=>decoder.decode(bad));
  assert.equal(decoder.snapshot().nextExpectedBlockIndex,body.readUInt32LE(15992));
  assert.equal(decoder.decode(body).columns.length,1);
});
test('provisional predictor mode0 supports small/large/repeat and four active channels',()=>{
  const repeat=decodePredictorPixels(Buffer.from([255,0,0,0]),{height:8,depth:5,scans:2,mode:0,channels:4});
  assert.equal(repeat.meaningfulBits,8);assert.ok(repeat.columns.every(c=>c.every(x=>x===0)));
  const bits=[];for(let channel=0;channel<3;channel++)bits.push(0,0,0,0,1,1,1,1,1,1,1,1);
  const payload=Buffer.alloc(8);bits.forEach((bit,i)=>payload[i>>3]|=bit<<(i&7));
  const small=decodePredictorPixels(payload,{height:8,depth:5,scans:1,mode:0,channels:3});
  assert.equal(small.meaningfulBits,36);
  for(let row=0;row<8;row++)assert.deepEqual([...small.columns[0].subarray(row*4,row*4+3)],[8,8,8]);
});
test('legacy raw and temporal packed color preserve significant bits and dependencies',()=>{
  const raw=Buffer.alloc(32);for(let row=0;row<16;row++)raw.writeUInt16LE((31<<10)|(4<<5)|1,row*2);
  const first=decodePackedPixels(raw,{height:16,format:0,mode:1,scans:1});
  assert.deepEqual([...first.columns[0].subarray(0,4)],[8,33,255,0]);
  const repeated=decodePackedPixels(Buffer.alloc(4),{height:16,format:0,mode:2,scans:2,previousCodes:first.codes[0]});
  assert.deepEqual(repeated.columns[0],first.columns[0]);assert.deepEqual(repeated.columns[1],first.columns[0]);
  assert.throws(()=>decodePackedPixels(Buffer.alloc(4),{height:16,format:0,mode:2,scans:2}),{code:'ERR_CAMERA_PIXEL_DEPENDENCY'});
});
test('fine and repeated-column arithmetic preserve the inherited precision state',()=>{
  const a=cameraColumnTime({first:100,second:101,companion:0,secondCompanion:0x800000|(50<<16),remainder:1,tickScale:8,fine:true});
  const b=cameraColumnTime({first:100,second:101,companion:0,secondCompanion:0x800000|(50<<16),remainder:1,tickScale:8,fine:true,inheritedFine:true});
  assert.equal(a.ticks,804n);assert.equal(b.ticks,806n);
});
test('alignment payload and assembled raster match the authored independent vector',()=>{
  const v=vectors.alignment,body=Buffer.alloc(16000),record=v.pixelColumn;
  body.writeUInt32LE(parseInt(v.frame.blockHeaderHex,16));
  for(let col=0;col<16;col++){
    const at=8+col*44;body.writeUInt32LE(parseInt(record.recordHeaderHex,16),at);
    Buffer.from(record.payloadHexPadded,'hex').copy(body,at+12);
  }
  body.writeUInt32LE(1,15992);body.writeUInt32LE(0xfffffffe,15996);
  const decoded=createCameraImageDecoder(imageProfile(body,16)).decode(body);
  for(const expected of record.expectedPixels)assert.deepEqual([...decoded.columns[0].data.subarray(expected.row*3,expected.row*3+3)],expected.RGB8);
  const assembler=createAlignmentFrameAssembler({width:16,height:16,epochId:'preview'}),frame=assembler.append(decoded,'preview');
  assert.equal(frame.width,16);assert.deepEqual([...frame.data.subarray(0,3)],[8,16,24]);
  assert.throws(()=>assembler.append(decoded,'other'),{code:'ERR_CAMERA_FRAME_EPOCH'});
  const reset=buildAlignmentReset({depth:5,dimensions:2,alignmentParameter:1,width:16,rate:5,indicatorRgb:[0,255,0]});
  assert.equal(reset.words[0],0x216);assert.equal(reset.words[2],0x100005);assert.equal(reset.words[0]&1,0);
});
test('read-only inspection serializes clock/identity/raw configuration and closes the socket',async()=>{
  const fixture=networkFixture(),config=Buffer.from(vectors.configuration.find(x=>x.valid).hex,'hex');
  fixture.exchangeHook=packet=>{
    const op=packet.readUInt16LE(8);
    return op===18?{bytes:config,peerAddress:'127.0.0.1',peerPort:41925}:cameraReply(packet,op===14?[7,1280,0]:[1,64,1,0x11223344,0x211,800,1320,3]);
  };
  const result=await inspectNetworkCamera({address:'127.0.0.1',marker:0x11223344,family:3},{transportFactory:fixture.transportFactory});
  assert.equal(result.clock128k,'1280');assert.equal(result.identity.macAddress,'02:11:11:22:33:44');
  assert.deepEqual(fixture.sent.map(x=>x.readUInt16LE(8)),[14,26,18]);assert.ok(fixture.transports[0].closed);
});
test('clock conversions, subnet broadcast and reference election retain uncertainty',async()=>{
  assert.equal(microsecondsToCameraClock(10000000n),1280000n);assert.equal(cameraClockToMicroseconds(1280000n),10000000n);
  assert.equal(broadcastAddress('192.0.2.10','255.255.255.0'),'192.0.2.255');
  const calls=[];
  const result=await synchronizeCameraGroup({origin:7,generation:11,members:[{id:'a',clockCapable:true,referenceDescriptor:1},{id:'b',clockCapable:true,externalSyncEnabled:true,referenceDescriptor:2}],
    prepare:async()=>calls.push('prepare'),query:async m=>{calls.push(m.id);return {origin:7,generation:11,clock128k:1280000n};},apply:async()=>({localCompletion:true})});
  assert.deepEqual(calls,['prepare','b']);assert.equal(result.referenceId,'b');assert.equal(result.physicalAgreementConfirmed,false);
});
