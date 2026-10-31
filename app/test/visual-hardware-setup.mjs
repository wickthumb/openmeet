// Actual Electron UI + local camera/board emulators; no physical equipment used.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createSocket} from 'node:dgram';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {cameraReply} from '../../engine/cameras/testing/network-fixture.js';
const app=path.resolve(process.argv[2]??new URL('..',import.meta.url).pathname),root=await mkdtemp(path.join(tmpdir(),'openmeet-hardware-ui-'));
console.log('Hardware UI evidence:',root);
const vectors=JSON.parse(await readFile(new URL('../../engine/cameras/testing/handoff-vectors.json',import.meta.url),'utf8'));
const config=Buffer.from(vectors.configuration.find(v=>v.valid).hex,'hex'),offsets=[0,1,3,4,6,7,9,10];
function word16(record,value){offsets.forEach((offset,i)=>{config[record*16+offset]=(((value>>>(2*i))&1)?0:16)|(((value>>>(2*i+1))&1)?0:1);});}
word16(2,0x0280);word16(3,0x002c);word16(7,16);word16(8,2560);word16(9,1);word16(10,20000);word16(15,1024);
let crc=0;for(let r=0;r<64;r++){for(let w=0;w<3;w++){crc=(crc+config.readUInt32LE(r*16+w*4))>>>0;switch(crc&3){case 0:crc=(crc|0x25893562)>>>0;break;case 1:crc=(crc<<13)>>>0;break;case 2:crc=(crc^0x14f39865)>>>0;break;case 3:crc=(crc&0x765935be)>>>0;}}config.writeUInt32LE(crc,r*16+12);}
const body=Buffer.alloc(16000);body.writeUInt32LE(parseInt(vectors.alignment.frame.blockHeaderHex,16));for(let col=0;col<16;col++){const at=8+col*44;body.writeUInt32LE(parseInt(vectors.alignment.pixelColumn.recordHeaderHex,16),at);body.writeUInt32LE(100+col,at+4);Buffer.from(vectors.alignment.pixelColumn.payloadHexPadded,'hex').copy(body,at+12);}body.writeUInt32LE(1,15992);body.writeUInt32LE(0xfffffffe,15996);
const frame=Buffer.alloc(16004);frame.set([241,4]);frame.writeUInt16LE(16000,2);body.copy(frame,4);
const udp=createSocket('udp4'),peers=new Set();let stream=null;const selectors=[];
const tcp=createServer(socket=>{stream=socket;peers.add(socket);socket.on('error',()=>{});socket.on('data',()=>{});socket.on('close',()=>peers.delete(socket));});
udp.on('message',(packet,peer)=>{const op=packet.readUInt16LE(8);selectors.push(op);let bytes;
  if(op===18)bytes=config;else if(op===9){const offset=packet.readUInt32LE(20),length=packet.readUInt32LE(24);bytes=Buffer.alloc(length+4);bytes.writeUInt32LE(packet.readUInt32LE(4));body.copy(bytes,4,offset,offset+length);}
  else{let payload=[];if(op===14)payload=[7,1280,0];if(op===26)payload=[1234,64,1,0x11223344,0x1234,800,1320,3];if(op===3){payload=Array(21).fill(0);payload[0]=packet.readUInt32LE(16);payload[2]=200;payload[5]=1;}bytes=cameraReply(packet,payload).bytes;}
  udp.send(bytes,peer.port,peer.address);if(op===7)stream?.write(frame);
});
await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind(41925,'127.0.0.1',resolve);});await new Promise(resolve=>tcp.listen(41925,'127.0.0.1',resolve));
const board=createSocket('udp4'),boardMessages=[];board.on('message',b=>boardMessages.push(b.toString()));await new Promise(resolve=>board.bind(0,'127.0.0.1',resolve));
const reserved=createServer();await new Promise(resolve=>reserved.listen(0,'127.0.0.1',resolve));const debugPort=reserved.address().port;await new Promise(resolve=>reserved.close(resolve));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(/^OPENMEET_(OCCLUSION|CROP)_/.test(key))delete env[key];
const child=spawn(path.join(app,'node_modules/electron/dist/electron'),[app,'--no-sandbox','--ozone-platform=headless',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${path.join(root,'settings')}`],{env,detached:true,stdio:['ignore','pipe','pipe']});
let logs='',ws,serial=0;const pending=new Map(),errors=[];child.on('error',error=>{logs+=error.message;});child.stdout.on('data',b=>logs=(logs+b).slice(-16000));child.stderr.on('data',b=>logs=(logs+b).slice(-16000));
async function poll(fn,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(errors.length)throw Error(errors.join('\n'));const value=await fn();if(value)return value;await delay(70);}throw Error('Timed out: '+label);}
const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??JSON.stringify(r.exceptionDetails));return r.result.value;};
const click=async selector=>{await poll(()=>ev(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`),'enabled '+selector);return ev(`document.querySelector(${JSON.stringify(selector)}).click()`);};
const input=(selector,value)=>ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Missing input '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
const tab=label=>ev(`(()=>{const e=[...document.querySelectorAll('#tabs button')].find(e=>e.textContent===${JSON.stringify(label)});e.click();})()`);
const ready=prefix=>poll(()=>ev(`document.querySelector('#${prefix}-save')&&!document.querySelector('#${prefix}-save').disabled`),'equipment form');
async function shot(name){const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(root,name+'.png'),Buffer.from(screenshot.data,'base64'));}
try{
  const page=await poll(async()=>{try{return(await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(p=>p.type==='page'&&p.url.endsWith('/renderer/index.html'));}catch{return null;}},'renderer',30000);
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});ws.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description??JSON.stringify(m.params));});
  await send('Runtime.enable');await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1500,height:1100,deviceScaleFactor:1,mobile:false});await poll(()=>ev(`!!document.querySelector('#ctl .go')`),'app ready');
  await tab('Camera setup');await ready('hardware-camera');
  await input('#hardware-camera-name','Local camera emulator');await input('#hardware-camera-address','127.0.0.1');await input('#hardware-camera-local','127.0.0.1');await input('#hardware-camera-height','16');await input('#hardware-camera-width','16');
  await click('#hardware-camera-save');await poll(()=>ev(`!document.querySelector('#hardware-camera-check').disabled`),'profile saved');assert.equal(selectors.length,0,'saving contacted the camera');
  await click('#hardware-camera-check');await poll(()=>ev(`document.querySelector('#hardware-camera .hardware-facts').textContent.includes('Camera replied')`),'read-only runtime check');assert.deepEqual(selectors,[14,26,18]);
  await click('#hardware-camera-align');await poll(()=>ev(`document.querySelector('#hardware-camera img').naturalWidth===16`),'complete alignment frame');assert.ok(selectors.includes(9));await shot('camera-alignment');await click('#hardware-camera-yes');
  await click('#hardware-camera-disconnect');await poll(()=>ev(`!document.querySelector('#hardware-camera-record').disabled`),'camera disconnected');
  await click('#hardware-camera-record');await poll(()=>ev(`document.querySelector('#hardware-camera .hardware-facts').textContent.includes('16 columns')`),'native sample columns');await click('#hardware-camera-disconnect');await poll(()=>ev(`!document.querySelector('#hardware-camera-check').disabled`),'sample closed');
  const profiles=await ev(`window.openmeet.call('hardware.list',{kind:'camera'})`),recording=profiles.profiles[0].observations.lastSession.recording.dir;assert.ok((await readdir(recording)).includes('blocks.dat'));assert.equal(profiles.profiles[0].observations['confirmed-alignment'].physicalTimingCalibrated,false);
  await tab('Scoreboard');await ready('hardware-scoreboard');await input('#hardware-scoreboard-name','Local UDP scoreboard');await input('#hardware-scoreboard-address','127.0.0.1');await input('#hardware-scoreboard-transport','udp');await input('#hardware-scoreboard-port',String(board.address().port));await click('#hardware-scoreboard-save');
  await poll(()=>ev(`!document.querySelector('#hardware-scoreboard-connect').disabled`),'board profile saved');await click('#hardware-scoreboard-preview');await poll(()=>ev(`document.querySelector('.hardware-wire-preview').textContent.includes('444')`),'local byte preview');assert.equal(boardMessages.length,0);await click('#hardware-scoreboard-connect');await poll(()=>ev(`!document.querySelector('#hardware-scoreboard-patternTest').disabled`),'board connected paused');await delay(200);assert.equal(boardMessages.length,0,'connection sent live data before an explicit test');
  await input('#hardware-scoreboard-pattern','888');await click('#hardware-scoreboard-patternTest');await poll(()=>boardMessages.some(m=>m==='888\r\n'),'test pattern');await input('#hardware-scoreboard-notes','Digits visible');await click('#hardware-scoreboard-yes');
  await click('#hardware-scoreboard-clockTest');await poll(()=>boardMessages.some(m=>/^0\.\d+\r\n$/.test(m)),'clock test');await click('#hardware-scoreboard-resultsTest');await poll(()=>boardMessages.some(m=>m.includes('Runner, Test 12.34')),'results test');await shot('physical-scoreboard');
  await click('#hardware-scoreboard-live');await poll(()=>ev(`document.querySelector('#hardware-scoreboard .hardware-facts').textContent.includes('live')`),'live relay');await click('#hardware-scoreboard-disconnect');await poll(()=>ev(`!document.querySelector('#hardware-scoreboard-connect').disabled`),'board closed');
  await input('#hardware-scoreboard-notes','Unsaved observation');await click('#hardware-scoreboard-new');assert.equal(await ev(`document.querySelector('#hardware-scoreboard-name').value`),'Local UDP scoreboard');assert.equal(await ev(`document.querySelector('#hardware-scoreboard-notes').value`),'Unsaved observation');await click('#hardware-scoreboard-discard');
  // Polling must not replace focused fields or erase unsaved edits.
  await input('#hardware-scoreboard-name','Unsaved name');await ev(`document.querySelector('#hardware-scoreboard-name').focus()`);await delay(1200);assert.equal(await ev(`document.activeElement.id`),'hardware-scoreboard-name');assert.equal(await ev(`document.querySelector('#hardware-scoreboard-name').value`),'Unsaved name');await click('#hardware-scoreboard-discard');
  assert.deepEqual(errors,[]);await writeFile(path.join(root,'report.json'),JSON.stringify({passed:true,readOnlySelectors:[14,26,18],cameraRecording:recording,boardPackets:boardMessages.length,operatorObservationConfirmed:true,screenshots:['camera-alignment.png','physical-scoreboard.png']},null,2));console.log('PASS: equipment UI, camera preview/recording, isolated board diagnostics, observation and stable forms');
}catch(error){console.error(error);console.error(logs);process.exitCode=1;try{if(ws)await shot('failure');}catch{}}
finally{
  ws?.close();for(const p of pending.values())clearTimeout(p.timer);try{process.kill(-child.pid,'SIGTERM');}catch{child.kill();}
  for(const p of peers)p.destroy();await new Promise(resolve=>tcp.close(resolve));udp.close();board.close();
}
