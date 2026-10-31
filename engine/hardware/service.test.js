import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHardwareService} from './service.js';
import {hardwareProfile,makeCameraConfiguration,SCOREBOARD_SCRIPT} from './profiles.js';
const inspection=address=>({address,clockOrigin:7,deviceIdentityConfirmed:false,configuration:{height:{min:16,max:2560},rate:{min:1,max:20000},internalType:12,capabilityWord:0x2c0280,maxTdi:4,orderedBounds:true}});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'openmeet-equipment-')),calls=[],sessions=new Map(),intervals=new Set(),timeouts=new Set();let next=0,busy=false;
  const timers={setInterval(fn){intervals.add(fn);return fn;},clearInterval(fn){intervals.delete(fn);},setTimeout(fn){timeouts.add(fn);return fn;},clearTimeout(fn){timeouts.delete(fn);}};
  const cameras={async inspect(p){calls.push(['inspect',p]);return inspection(p.address);},open(p){calls.push(['open',p]);const id='session-'+ ++next,s={id,session:{state:'bound'},recording:{dir:path.join(root,id)},image:{columns:0,rows:p.imageProfile.height,previewFrames:0}};sessions.set(id,s);return structuredClone(s);},async command(p){calls.push([p.operation,p]);const s=sessions.get(p.id);s.session.state=p.operation==='prepare'?'ready':s.session.state;return {result:{decision:'unavailable'}};},snapshot({id}){if(!sessions.has(id))throw Error('closed');return structuredClone(sessions.get(id));},image(){return {ready:true,png:Buffer.of(1),width:16,height:16};},async drain(){calls.push(['drain']);return {transportDrained:true,captureComplete:false};},async close({id}){calls.push(['close',id]);const value=sessions.get(id);sessions.delete(id);return value;}};
  const boards={configured:[],states:[],configure(p){this.configured.push(p);this.states.push({id:p.id,transport:{state:'connected'},mode:'paused'});},async connect(){},list(){return this.states;},async setMode({id,mode}){this.states.find(s=>s.id===id).mode=mode;},async close({id}){this.states=this.states.filter(s=>s.id!==id);}};
  const service=createHardwareService({root,cameras,boards,timers,captureBusy:()=>busy,networkInterfaces:()=>({test:[{family:'IPv4',address:'127.0.0.1',netmask:'255.0.0.0',internal:true}]})});
  t.after(async()=>{await service.closeAll();fs.rmSync(root,{recursive:true,force:true});});return {service,root,calls,cameras,boards,sessions,intervals,timeouts,setBusy:v=>busy=v};
}
const camera={kind:'camera',name:'Test camera',address:'127.0.0.1',localAddress:'127.0.0.1',transport:'tcp',settings:{height:16,rate:800,depth:5,alignmentWidth:16,alignmentRate:5,queueEpochTrusted:false}};
test('equipment saves are inert, survive reopening, and reject stale local interfaces',async t=>{
  const f=fixture(t),p=await f.service.save(camera);assert.equal(f.calls.length,0);assert.equal(f.service.list().profiles.length,1);assert.ok(p.assumptions.length);
  const other=createHardwareService({root:f.root,cameras:f.cameras,boards:f.boards});assert.equal(other.list().profiles[0].id,p.id);await other.closeAll();
  const invalid=await f.service.save({...camera,name:'Absent interface',localAddress:'192.0.2.1'});await assert.rejects(f.service.inspect({id:invalid.id}),{code:'ERR_HARDWARE_INTERFACE'});assert.equal(f.calls.length,0);
});
test('camera checks remain read-only; profile edits invalidate their observations',async t=>{
  const f=fixture(t),p=await f.service.save(camera),checked=await f.service.inspect({id:p.id});assert.deepEqual(f.calls.map(c=>c[0]),['inspect']);assert.equal(checked.observations.inspection.result.clockOrigin,7);
  const changed=await f.service.save({...checked,address:'127.0.0.2'});assert.deepEqual(changed.observations,{});f.setBusy(true);await assert.rejects(f.service.inspect({id:p.id}),{code:'ERR_HARDWARE_LIVE'});
});
test('alignment owns one poller, requires an actual complete frame for confirmation and releases resources',async t=>{
  const f=fixture(t),p=await f.service.save(camera),started=await f.service.connect({id:p.id,mode:'alignment',meetDir:'/official-meet'}),entry=f.sessions.get(started.runtime.sessionId);
  const opened=f.calls.find(c=>c[0]==='open')[1];assert.equal(opened.meetDir,null);assert.equal(opened.diagnostic,true);assert.equal(opened.profile.delivery,'udp');assert.ok(opened.profile.reset[0]&2);assert.equal(f.intervals.size,1);
  await assert.rejects(f.service.confirm({id:p.id,test:'alignment',answer:'yes'}),{code:'ERR_HARDWARE_TEST'});const image=entry.image;delete entry.image;
  await assert.rejects(f.service.confirm({id:p.id,test:'alignment',answer:'yes'}),{code:'ERR_HARDWARE_TEST'});entry.image=image;entry.image.previewFrames=1;
  const confirmed=await f.service.confirm({id:p.id,test:'alignment',answer:'yes'});assert.equal(confirmed.observations['confirmed-alignment'].physicalTimingCalibrated,false);
  await assert.rejects(f.service.save({...camera,id:p.id}),{code:'ERR_HARDWARE_IN_USE'});assert.equal(f.service.image({id:p.id,after:1}).ready,false);
  const stopped=await f.service.disconnect({id:p.id});assert.equal(stopped.runtime,null);assert.equal(f.intervals.size,0);assert.equal(f.sessions.size,0);
});
test('sample recording automatically stops, drains and preserves its unverified completeness',async t=>{
  const f=fixture(t),p=await f.service.save(camera);await f.service.connect({id:p.id,mode:'recording'});assert.ok(f.calls.some(c=>c[0]==='start'));assert.equal(f.timeouts.size,1);
  await [...f.timeouts][0]();assert.equal(f.service.status({id:p.id}).runtime,null);assert.ok(f.calls.some(c=>c[0]==='drain'));assert.equal(f.service.status({id:p.id}).observations.lastSession.captureComplete,false);assert.equal(f.timeouts.size,0);
});
test('a camera session removed by its owner releases setup timers',async t=>{
  const f=fixture(t),p=await f.service.save(camera),started=await f.service.connect({id:p.id,mode:'recording'});assert.equal(f.intervals.size,1);assert.equal(f.timeouts.size,1);
  f.sessions.delete(started.runtime.sessionId);assert.equal(f.service.status({id:p.id}).runtime,null);assert.equal(f.intervals.size,0);assert.equal(f.timeouts.size,0);
});
test('physical board connection stays paused; tests and operator confirmations are separate',async t=>{
  const f=fixture(t),p=await f.service.save({kind:'scoreboard',name:'Board',address:'127.0.0.1',port:5000});await f.service.connect({id:p.id});assert.equal(f.boards.configured[0].startPaused,true);assert.equal(f.boards.configured[0].bindingProfile,'standard');
  await assert.rejects(f.service.confirm({id:p.id,test:'pattern',answer:'yes'}),{code:'ERR_HARDWARE_TEST'});await f.service.scoreboardMode({id:p.id,mode:'pattern',pattern:'444'});
  const checked=await f.service.confirm({id:p.id,test:'pattern',answer:'different',notes:'shows 44'});assert.equal(checked.observations['confirmed-pattern'].answer,'different');assert.equal(checked.observations.lastTest.displayConfirmed,false);
  const preview=await f.service.scriptPreview({id:p.id});assert.ok(preview.fields.includes('17:1'));assert.ok(preview.fields.includes('20:6'));await f.service.disconnect({id:p.id});assert.equal(f.boards.states.length,0);
});
test('imported script and camera files produce reviewable drafts without a connection',async t=>{
  const f=fixture(t),script=path.join(f.root,'board.lss');fs.writeFileSync(script,SCOREBOARD_SCRIPT);const draft=await f.service.importFile({file:script,kind:'scoreboard'});assert.equal(draft.draft.script,SCOREBOARD_SCRIPT);assert.equal(f.calls.length,0);
  const file=path.join(f.root,'camera.json');fs.writeFileSync(file,JSON.stringify({profile:{address:'127.0.0.1',parameters:Array(19).fill(0),reset:[20,0,0,0,0,0]},imageProfile:{height:16}}));const imported=await f.service.importFile({file,kind:'camera'});assert.equal(imported.draft.configuration.imageProfile.height,16);
  fs.writeFileSync(script,Buffer.concat([Buffer.from([255,254]),Buffer.from(SCOREBOARD_SCRIPT,'utf16le')]));assert.equal((await f.service.importFile({file:script,kind:'scoreboard'})).draft.script,SCOREBOARD_SCRIPT);
});
test('experimental camera configuration obeys capability bounds and never trusts the start queue implicitly',()=>{
  const saved=hardwareProfile(camera),config=makeCameraConfiguration(saved,inspection(saved.address));assert.equal(config.profile.queueEpochTrusted,false);assert.equal(config.profile.parameters.length,19);assert.equal(config.profile.parameters[2],16);assert.equal(config.imageProfile.columnPeriod,1/800);
  assert.throws(()=>makeCameraConfiguration({...saved,settings:{...saved.settings,height:3000}},inspection(saved.address)),/limits/);
  assert.throws(()=>hardwareProfile({...camera,address:'255.255.255.255'}));
});
