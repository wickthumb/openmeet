import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSocket} from 'node:dgram';
import {createServer} from 'node:net';
import {createWireScoreboardService} from './wire-service.js';
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
