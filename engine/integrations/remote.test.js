import {test} from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {once} from 'node:events';
import {createTextRemoteSession,remoteLookup,remotePacket,createRemotePacketReader,createBinaryRemoteSession,remoteMicroseconds,countedRemoteString,readCountedRemoteString,remoteStem,createRemoteServerService,dispatchRemoteStart} from './remote.js';
test('remote packet framing is incremental, bounded and can recover a marker suffix',()=>{
  const packet=remotePacket(7,Buffer.from('0100030001000200','hex')),reader=createRemotePacketReader({capacity:4096});let result=[];
  for(const byte of packet)result.push(...reader.push(Buffer.of(byte)));assert.equal(result.length,1);assert.equal(result[0].type,7);assert.equal(result[0].payload.toString('hex'),'0100030001000200');assert.equal(reader.snapshot().pendingBytes,0);
  assert.equal(reader.push(Buffer.concat([Buffer.from([0,0,0]),packet])).length,1);
  const bad=Buffer.alloc(8);bad.writeUInt32LE(0x1f9b32f5);bad.writeUInt32LE(5000,4);assert.deepEqual(reader.push(bad),[]);assert.equal(reader.snapshot().pendingBytes,0);
});
test('remote lookup handles whole quoted pairs, comma components and first-wins keys',()=>{
  const request='Command=ImageExport;"File=a;b.png";Options=1,,3;COMMAND=Other;';
  assert.deepEqual(remoteLookup(request,'command'),{present:true,value:'ImageExport'});assert.equal(remoteLookup(request,'File').value,'a;b.png');assert.deepEqual(remoteLookup(request,'Options',1),{present:true,value:''});assert.equal(remoteLookup(request,'Options',4).present,false);
  assert.equal(remoteLookup(' Command=bad;','Command').present,false);assert.equal(remoteStem('C:\\Meet\\Alpha.evn'),'Alpha');assert.equal(remoteStem('Alpha.long'),'Alpha.long');
  const bytes=countedRemoteString('A\0\ud800');assert.equal(readCountedRemoteString(bytes).text,'A\0\ud800');assert.deepEqual(readCountedRemoteString(Buffer.from([4,0,65,0,1])),{text:'A',consumed:4});
});
test('text remote keeps newline detection, blank repeats and XOFF action semantics',async()=>{
  const requests=[],session=createTextRemoteSession({dispatch:request=>{requests.push(request);return [['Reply','Ok']];}});
  session.push(Buffer.from('A\rX\r\n'));assert.equal((await session.poll()).request,'A');assert.equal((await session.poll()).request,'X');assert.equal((await session.poll()).request,'X');assert.deepEqual(requests,['A','X','X']);
  const suppressed=createTextRemoteSession({dispatch:request=>{requests.push(request);return [['Reply','Ok']];}});suppressed.push(Buffer.from([19,66,10,17,10]));const a=await suppressed.poll();assert.equal(a.request,'B');assert.equal(a.output.length,0);const b=await suppressed.poll();assert.equal(b.request,'B');assert.ok(b.output.toString().endsWith('Reply=Ok;\r\n'));suppressed.reset();assert.equal(suppressed.snapshot().history,'');
});
test('remote start preserves raw primary/offset and separates trigger dispatch from pulse evidence',async()=>{
  let reads=0,record;const result=await dispatchRemoteStart('Command=StartCreate;Time=1.25;Offset=.5;Key= Test ;',{sourceTag:()=>++reads===1?7:9,append:value=>{record=value;},trigger:()=>false});
  assert.equal(result.reply,'Ok');assert.equal(reads,2);assert.equal(record.primary.ticks,'100000');assert.equal(record.primary.quantum,'800');assert.equal(record.primary.origin,'9');assert.equal(record.secondary.ticks,'40000');assert.equal(record.secondary.quantum,'1');assert.equal(record.key,'Test');
  const triggered=await dispatchRemoteStart('Command=StartCreate;Time=+1;',{sourceTag:()=>0,append:()=>assert.fail(),trigger:()=>false});assert.equal(triggered.reply,'Ok');assert.equal(triggered.triggerDispatched,false);assert.equal(triggered.physicalPulseConfirmed,false);
});
test('binary remote control applies complete prefixes and samples the requested retained columns',()=>{
  const pixels=Buffer.from([0,0,255,0,0,0,255,0,255,0,0,0,255,0,0,0,255,255,255,0,255,255,255,0]),session=createBinaryRemoteSession({capacity:4096,provider:()=>({image:{width:6,count:2,generation:1,pointerPresent:true,timeAt:index=>({ticks:String(index+1),quantum:'1'}),pixelsAt:()=>pixels}})});
  session.receive({type:7,payload:Buffer.from('0300030001000000','hex')});const status=session.pending();assert.equal(status.readUInt16LE(8),8);assert.equal(status.readUInt16LE(12),7);session.consume(status.length);
  session.receive({type:9,payload:Buffer.alloc(0)});const packet=session.pending();assert.equal(packet.readUInt16LE(8),10);assert.equal(packet.readBigInt64LE(12),12n);assert.equal(packet.readUInt16LE(26),3);assert.deepEqual([...packet.subarray(28)],[0,0,255,255,0,0,255,255,255]);
  session.consume(1);assert.equal(session.snapshot().queuedBytes,packet.length);session.consume(packet.length-1);assert.equal(session.snapshot().queuedBytes,0);
  session.receive({type:7,payload:Buffer.from([0,0,0xff])});assert.equal(session.snapshot().enabled,false);assert.equal(session.snapshot().format,3);
  assert.equal(remoteMicroseconds({ticks:'-1',quantum:'1'}),-13n);
});
test('binary remote preserves cursor advance on a missing pixel provider and headroom failure preserves it',()=>{
  const provider=()=>({image:{width:3,count:2,generation:1,timeAt:()=>({ticks:'80',quantum:'1'}),pixelsAt:()=>null}}),session=createBinaryRemoteSession({capacity:1028,provider});session.receive({type:9,payload:Buffer.alloc(0)});assert.equal(session.snapshot().cursor,-1,'image did not fit headroom');
  const larger=createBinaryRemoteSession({capacity:4096,provider});larger.receive({type:9,payload:Buffer.alloc(0)});assert.equal(larger.snapshot().cursor,0);assert.equal(larger.pending().length,0);
});
test('actual TCP remote listener dispatches one packet at a time and closes connected clients',async t=>{
  const service=createRemoteServerService({textDispatch:request=>[['Reply',request]],binaryProvider:()=>({provider:()=>null})});t.after(()=>service.closeAll());const opened=await service.listen({id:'local',port:0}),socket=connect(opened.address.port,'127.0.0.1');t.after(()=>socket.destroy());await once(socket,'connect');
  const received=[];socket.on('data',b=>received.push(b));socket.write('test\r\n');const deadline=Date.now()+2000;while(!Buffer.concat(received).includes(Buffer.from('Reply=test;\r\n'))){if(Date.now()>deadline)assert.fail('Remote reply timeout');await new Promise(resolve=>setTimeout(resolve,5));}
  const closed=once(socket,'close');await service.close({id:'local'});await closed;assert.deepEqual(service.list(),[]);
});
