import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSocket} from 'node:dgram';
import {createServer} from 'node:net';
import {connect} from 'node:net';
import {once,EventEmitter} from 'node:events';
import {createWireScoreboardService,createScoreboardUdpOutput} from './wire-service.js';
import {SCOREBOARD_SCRIPT} from '../hardware/profiles.js';
import {createScoreboardServerOutput} from './server-output.js';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fakeTimers(){const jobs=new Set();return {jobs,setInterval(fn){jobs.add(fn);return {fn,unref(){}};},clearInterval(handle){jobs.delete(handle.fn);}};}
test('wire scoreboard renders scripts and pages through real UDP, cadence and owned shutdown',async t=>{
  const socket=createSocket('udp4'),messages=[];socket.on('message',b=>messages.push(b));await new Promise(resolve=>socket.bind(0,'127.0.0.1',resolve));t.after(()=>socket.close());
  let now=100;const timers=fakeTimers(),service=createWireScoreboardService({monotonicMs:()=>now,timers});t.after(()=>service.closeAll());
  service.configure({id:'board',profile:{kind:'udp',host:'127.0.0.1',port:socket.address().port},bindings:[],section:'Results',pageIntervalMs:10,script:';;Initialization\n0INIT\n;;Results[0]\n0FIRST\n;;Results[1]\n0SECOND'});
  assert.equal(timers.jobs.size,0);await service.publish({results:[{place:1,time:10}]});assert.equal(messages.length,0);
  await service.connect({id:'board'});now=111;await service.publish({results:[{place:1,time:10}]},{force:true});for(let i=0;i<100&&messages.length<2;i++)await sleep(2);
  assert.equal(messages.length,2);assert.equal(messages[0].toString(),'INITFIRST');assert.equal(messages[1].toString(),'SECOND');assert.equal(service.list()[0].deliveryEstablished,false);
  await assert.rejects(service.reconnect({id:'board'}),{code:'ERR_SCOREBOARD_RECONNECT_UNSUPPORTED'});await service.close({id:'board'});assert.equal(timers.jobs.size,0);
});
test('wire scoreboard TCP route writes the planned bytes and releases the socket',async t=>{
  const sockets=new Set(),chunks=[],server=createServer(socket=>{sockets.add(socket);socket.on('data',b=>chunks.push(b));socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));});
  const service=createWireScoreboardService({timers:fakeTimers()});t.after(()=>service.closeAll());service.configure({id:'tcp',profile:{SerialPort:`-1,127.0.0.1,${server.address().port}`,CharMode:0,PortBuffer:1024,KeepAlive:true},script:';;TimeRunning\n0RUN',bindings:[],section:'TimeRunning'});
  await service.connect({id:'tcp'});for(let i=0;i<100&&!chunks.length;i++)await sleep(2);assert.equal(Buffer.concat(chunks).toString(),'RUN');await service.closeAll();
});
test('physical output validates row/offset configuration before allocating a client',()=>{
  let allocations=0;const service=createWireScoreboardService({tcpFactory(){allocations++;throw Error('should not allocate');}});
  for(const config of [{rowOffset:-1},{rowsPerPage:0},{offsetTicks:Infinity},{precisionTicks:0},{defaultGroup:15}])assert.throws(()=>service.configure({id:'x',profile:{},script:'',bindings:[],...config}),RangeError);assert.equal(allocations,0);
});
test('standard script diagnostics stay route-local, preserve live state and pause without transmission',async t=>{
  const socket=createSocket('udp4'),messages=[];socket.on('message',b=>messages.push(b.toString()));await new Promise(resolve=>socket.bind(0,'127.0.0.1',resolve));t.after(()=>socket.close());
  let now=1000;const service=createWireScoreboardService({monotonicMs:()=>now,timers:fakeTimers()});t.after(()=>service.closeAll());
  service.configure({id:'test',profile:{kind:'udp',host:'127.0.0.1',port:socket.address().port},script:SCOREBOARD_SCRIPT,bindings:[],bindingProfile:'standard',startPaused:true});
  await service.publish({heat:{name:'Actual heat',state:'running'},clock:{frozenS:99},results:[{place:1,time:7,last:'Actual',first:'Athlete'}]});await service.connect({id:'test'});await sleep(10);assert.equal(messages.length,0);
  await service.setMode({id:'test',mode:'pattern',pattern:'444'});await service.publish({heat:{state:'running'},clock:{frozenS:100}},{force:true});
  await service.setMode({id:'test',mode:'results'});await sleep(10);assert.deepEqual(messages.slice(0,2),['444\r\n','444\r\n']);assert.match(messages[2],/Runner, Test 12.34/);
  await service.setMode({id:'test',mode:'paused'});const count=messages.length;await service.publish({clock:{frozenS:42}},{force:true});await sleep(10);assert.equal(messages.length,count);
  await service.setMode({id:'test',mode:'clock'});now+=1000;await service.publish({clock:{frozenS:42}},{force:true});await sleep(10);assert.ok(messages.at(-1).includes('1.00'));
  await service.setMode({id:'test',mode:'live'});await sleep(10);assert.ok(messages.at(-1).includes('42.00'));
});
test('TCP listen output waits for the board, writes diagnostics and releases the listener',async t=>{
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const service=createWireScoreboardService({timers:fakeTimers()});t.after(()=>service.closeAll());service.configure({id:'listen',profile:{kind:'tcp-server',host:'127.0.0.1',peerAddress:'127.0.0.1',port},script:SCOREBOARD_SCRIPT,bindings:[],bindingProfile:'standard',startPaused:true});
  await service.connect({id:'listen'});assert.equal(service.list()[0].transport.state,'listening');await assert.rejects(service.setMode({id:'listen',mode:'pattern'}),{code:'ERR_SCOREBOARD_WAITING_FOR_PEER'});
  const peer=connect(port,'127.0.0.1');peer.on('error',()=>{});t.after(()=>peer.destroy());await once(peer,'connect');const received=once(peer,'data');await service.setMode({id:'listen',mode:'pattern'});assert.equal((await received)[0].toString(),'444\r\n');
  const closed=once(peer,'close');await service.closeAll();await closed;assert.deepEqual(service.list(),[]);
});
test('UDP broadcast bind is cancelled when its owner closes',async()=>{
  class Socket extends EventEmitter{bind(){}close(){this.emit('close');}setBroadcast(){}send(){assert.fail('must not send before bind');}}
  const client=createScoreboardUdpOutput({host:'192.0.2.255',port:5000,broadcast:true,writeTimeoutMs:1000},{socketFactory:()=>new Socket()});
  const pending=client.applyCalls([{routeId:'A',op:'text',units:[65]},{routeId:'A',op:'flush'}],{routeId:'A'});await sleep(0);client.close();await assert.rejects(pending,{code:'ERR_SCOREBOARD_CLOSED'});
});
test('closing a TCP listener during startup rejects its pending open',async()=>{
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const output=createScoreboardServerOutput({host:'127.0.0.1',peerAddress:'127.0.0.1',port});const opening=output.connect();output.close();await assert.rejects(opening,{code:'ERR_SCOREBOARD_CLOSED'});assert.equal(output.snapshot().state,'closed');
});
