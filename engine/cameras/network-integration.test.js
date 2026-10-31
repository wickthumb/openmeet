import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {networkFixture,cameraReply} from './testing/network-fixture.js';
import {createNetworkCameraService} from './network.js';
import {decodeCameraRecording} from './replay-recording.js';
import {openCaptureStore} from '../capture/store.js';
import {createClockGroupSender} from './clock-sync.js';
const vectors=JSON.parse(fs.readFileSync(new URL('./testing/handoff-vectors.json',import.meta.url),'utf8'));
function setup(t,delivery='tcp'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'openmeet-protocol-')),f=networkFixture(),body=Buffer.from(vectors.images.find(v=>v.name==='nonzero-mode1').bodyHex,'hex'),index=1;body.writeUInt32LE(index,body.length-8);body.writeUInt32LE((~index)>>>0,body.length-4);
  const profile={...f.config.profile,delivery,expectedBlockIndex:index};
  f.exchangeHook=async(packet,options)=>{
    const op=packet.readUInt16LE(8);let response;
    if(op===18)response={bytes:Buffer.from(vectors.configuration.find(v=>v.valid).hex,'hex'),peerAddress:profile.address,peerPort:profile.port};
    else if(op===9){const offset=packet.readUInt32LE(20),count=packet.readUInt32LE(24),bytes=Buffer.alloc(count+4);bytes.writeUInt32LE(packet.readUInt32LE(4));body.copy(bytes,4,offset,offset+count);response={bytes,peerAddress:profile.address,peerPort:profile.port};}
    else{let payload=[];if(op===14)payload=[7,1280,0];if(op===26)payload=Array(8).fill(1);if(op===3){payload=Array(21).fill(0);payload[0]=packet.readUInt32LE(16);payload[2]=200;payload[5]=index;}
      response=cameraReply(packet,payload);}
    assert.equal(options.accept(response),true,'response correlation');return response;
  };
  const service=createNetworkCameraService(f.options),config={...f.config,profile,recordingDir:path.join(root,'raw'),imageProfile:{family:3,height:32,tickScale:8,columnPeriod:.0001}};
  t.after(async()=>{await service.closeAll();fs.rmSync(root,{recursive:true,force:true});});return {root,f,body,index,service,config};
}
test('UDP retrieval, decoded native capture, manual start binding, PNG and offline replay form one path',async t=>{
  const {root,f,body,service,config}=setup(t,'udp'),opened=service.open(config),id=opened.id;
  await service.command({id,operation:'prepare'});assert.equal(f.streams.length,0);await service.command({id,operation:'start'});
  await assert.rejects(service.command({id,operation:'applySyncSample',params:{origin:7,generation:1,clock128k:'1280',referenceDescriptor:0}}),{code:'ERR_CLOCK_INITIALIZATION_ONLY'});
  await service.command({id,operation:'pollStatus'});const result=await service.command({id,operation:'fetchNextBlock'});assert.equal(result.result.decision,'received');assert.equal(result.image.columns,1);
  assert.equal(service.image({id}).png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.throws(()=>service.bindStart({id,clockId:'wrong',timeS:0}),{code:'ERR_CAMERA_START_CONTEXT'});service.bindStart({id,clockId:opened.clockId,timeS:.001});
  const drained=await service.drain({id,timeoutMs:100});assert.equal(drained.transportDrained,true);assert.equal(drained.captureComplete,false);
  await service.close({id});
  const decoded=decodeCameraRecording({recordingDir:config.recordingDir,outputDir:path.join(root,'decoded')});assert.equal(decoded.recordingDecoded,true);assert.equal(decoded.columns,1);
  const store=openCaptureStore(path.join(root,'decoded'),{readOnly:true});try{assert.equal(store.startHwTime(),.001);assert.equal(store.timesOf(0,1)[0],Number(body.readUInt32LE(12))*8/80000);}finally{store.close();}
});
test('TCP drain waits for a partial stream frame and cancels on session close',async t=>{
  const {f,body,service,config}=setup(t),{id}=service.open(config);await service.command({id,operation:'prepare'});await service.command({id,operation:'start'});
  const frame=Buffer.alloc(body.length+4);frame.set([241,4]);frame.writeUInt16LE(body.length,2);body.copy(frame,4);f.streams[0].onData(frame.subarray(0,20));
  const pending=service.drain({id,timeoutMs:200,intervalMs:10});await new Promise(resolve=>setTimeout(resolve,20));f.streams[0].onData(frame.subarray(20));assert.equal((await pending).transportDrained,true);
  const p=service.drain({id,timeoutMs:5000,requestStop:false});await service.close({id});await assert.rejects(p);
});
test('raw integrity failure produces a bounded decoded prefix and preserves original bytes',async t=>{
  const {root,service,config}=setup(t,'udp'),{id}=service.open(config);await service.command({id,operation:'prepare'});await service.command({id,operation:'start'});await service.command({id,operation:'pollStatus'});await service.command({id,operation:'fetchNextBlock'});await service.close({id});
  const file=path.join(config.recordingDir,'blocks.dat'),bytes=fs.readFileSync(file);bytes[100]^=1;fs.writeFileSync(file,bytes);
  const result=decodeCameraRecording({recordingDir:config.recordingDir,outputDir:path.join(root,'decode')});assert.equal(result.recordingDecoded,false);assert.equal(result.errors[0].code,'ERR_CAMERA_RECORDING_HASH');assert.deepEqual(fs.readFileSync(file),bytes);
});
test('broadcast sender releases bind waiters and deadlines on close and synchronous bind failure',async()=>{
  class Socket extends EventEmitter{bind(){ }setBroadcast(){}close(){this.emit('close');}}
  let socket;const sender=createClockGroupSender({interfaceAddress:'192.168.2.4',subnetMask:'255.255.255.0',marker:1,timeoutMs:100},{socketFactory:()=>socket=new Socket()});
  const pending=sender.send('samplePrepare',[7,1]);sender.close();await assert.rejects(pending,{code:'ERR_CLOCK_GROUP_CLOSED'});
  const failed=createClockGroupSender({interfaceAddress:'192.168.2.4',subnetMask:'255.255.255.0',marker:1,timeoutMs:100},{socketFactory:()=>{const s=new Socket();s.bind=()=>{throw Error('bind denied');};return s;}});await assert.rejects(failed.send('samplePrepare',[7,1]),/bind denied/);failed.close();
});
