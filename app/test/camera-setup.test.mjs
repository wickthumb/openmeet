import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CameraSetupConsole} from '../renderer/camera-setup.mjs';

// Minimal DOM for control identity, form interactions and RPC contract checks.
// Real rendering and engine integration are verified by the parent workspace.
class Element {
  constructor(tag,document){
    this.tagName=tag.toUpperCase();this.ownerDocument=document;this.children=[];this.parentNode=null;
    this.dataset={};this.attributes={};this.className='';this._value='';this._text='';this.hidden=false;this.disabled=false;
    this.classList={toggle:(name,on)=>{
      const classes=new Set(this.className.split(' ').filter(Boolean));
      if(on)classes.add(name);else classes.delete(name);this.className=[...classes].join(' ');
    }};
  }
  append(...nodes){for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const node of this.children)node.parentNode=null;this.children=[];this._text='';this.append(...nodes);if(this.tagName==='SELECT')this._value=nodes[0]?.value||'';}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null;}
  set textContent(value){this.replaceChildren();this._text=String(value);}
  get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
  set value(value){this._value=String(value);this.selectionStart=this._value.length;this.selectionEnd=this._value.length;}
  get value(){return this._value;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  focus(){this.ownerDocument.activeElement=this;}
}
const walk=node=>[node,...node.children.flatMap(walk)];
const clone=value=>structuredClone(value);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function initialConfig(){
  const setup=(cameraId,label,locationId='home',side='unspecified')=>({cameraId,revision:1,label,locationId,side,direction:'normal',effectiveAt:'2026-10-28T12:00:00.000Z'});
  const setups={a:setup('a','Finish inside','home','inside'),b:setup('b','Finish outside','home','outside'),c:setup('c','Far finish','far')};
  return {version:1,locations:[{id:'home',name:'Home'},{id:'far',name:'Far finish'},{id:'empty',name:'Empty finish'}],setups,history:clone(Object.values(setups)),heats:{h1:{locationId:'home',timingCameraId:'a'}}};
}

function fixture(t,{config=initialConfig(),context={},recorders={captureId:null,cameras:[]},handlers={}}={}){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'document');
  const document={createElement:tag=>new Element(tag,document),activeElement:null};globalThis.document=document;
  t.after(()=>{if(descriptor)Object.defineProperty(globalThis,'document',descriptor);else delete globalThis.document;});
  const body=document.createElement('div'),calls=[],published=[],toasts=[],views=[],alignments=[];
  const state={meetDir:'/fixture/meet',heatKey:'h1',heatName:'100 m · Heat 1',
    scans:['a','b','c'].map(id=>({id,label:'Device '+id,size:{width:1000,height:480},meta:{column_period_s:.00125}})),
    timingId:'a',viewId:'b',captureId:null,recording:false,preview:false,started:false,sourceType:'simulated',...context};
  const server={config:clone(config),recorders:clone(recorders)};
  const bridge={async call(method,params){
    calls.push({method,params:clone(params)});
    if(handlers[method])return handlers[method](params,server);
    if(method==='camera.config.get')return freeze(clone(server.config));
    if(method==='camera.recorders')return freeze(clone(server.recorders));
    if(method==='camera.setup.save'){
      const {meetDir,...setup}=params,revision=(server.config.setups[setup.cameraId]?.revision||0)+1;
      server.config.setups[setup.cameraId]={...setup,revision,effectiveAt:'2026-10-28T12:05:00.000Z'};
      server.config.history.push(clone(server.config.setups[setup.cameraId]));
    }else if(method==='camera.location.save')server.config.locations.push({id:'new-finish',name:params.name});
    else if(method==='camera.heat.assign')server.config.heats[params.heatKey]={locationId:params.locationId,timingCameraId:params.timingCameraId};
    else throw Error('Unexpected RPC '+method);
    return freeze(clone(server.config));
  }};
  const ui=new CameraSetupConsole({bridge,context:()=>state,changed:()=>{},toast:(...args)=>toasts.push(args),
    applyConfig:(config,reason)=>published.push({config,reason}),chooseView:id=>views.push(id),align:id=>alignments.push(id)});
  const get=id=>{const node=walk(body).find(node=>node.id===id);assert.ok(node,'Missing #'+id);return node;};
  const row=id=>{const node=walk(body).find(node=>node.dataset.cameraId===id);assert.ok(node,'Missing camera '+id);return node;};
  const input=(id,value)=>{const node=get(id);node.value=value;(node.oninput||node.onchange)?.();return node;};
  const click=id=>{const node=get(id);if(!node.disabled)return node.onclick?.();};
  const submit=id=>{const node=get(id);if(node.disabled)return;let form=node.parentNode;while(form&&form.tagName!=='FORM')form=form.parentNode;assert.ok(form);return form.onsubmit({preventDefault(){}});};
  ui.render(body);
  return {ui,body,state,server,calls,published,toasts,views,alignments,get,row,input,click,submit,loaded:ui.load()};
}

test('inventory combines all devices and never infers recorder state from the timing/view selection',async t=>{
  const pending=deferred(),config=initialConfig();
  config.setups.spare={cameraId:'spare',label:'Stored device',revision:1,locationId:'home',side:'unspecified',direction:'normal'};
  const f=fixture(t,{config,context:{recording:true,captureId:'cap'},handlers:{'camera.recorders':()=>pending.promise}});
  await tick();
  assert.ok(!f.row('a').textContent.includes('Recording'));
  assert.ok(!f.row('b').textContent.includes('Recording'));
  f.input('cameraName','Draft while status loads');
  assert.equal(f.get('cameraSave').disabled,false,'A slow recorder read must not block configuration edits');
  pending.resolve({captureId:'cap',cameras:[{id:'a',state:'recording',columns:200,rows:480,columnPeriod:.00125},{id:'front',label:'Front camera',state:'idle'}]});
  await f.loaded;
  assert.equal(f.get('cameraInventory').children.length,5);
  assert.match(f.row('a').textContent,/Finish insideHome · InsideRecording/);
  assert.match(f.row('b').textContent,/Not in this capture/);
  assert.match(f.row('front').textContent,/Front cameraHome · UnspecifiedIdle/);
  assert.match(f.row('spare').textContent,/Stored device/);
  assert.equal(f.get('cameraName').value,'Draft while status loads');
  assert.equal(f.get('cameraAlign').disabled,true);
  assert.deepEqual(f.published.map(p=>p.reason),['load']);
  assert.deepEqual(f.calls.map(c=>c.method).sort(),['camera.config.get','camera.recorders']);
});

test('selecting a row only edits setup; view and alignment callbacks require a displayed scan',async t=>{
  const f=fixture(t,{recorders:{captureId:null,cameras:[{id:'front',label:'Front camera',state:'idle'}]}});await f.loaded;
  f.row('b').onclick();
  assert.equal(f.get('cameraName').value,'Finish outside');assert.deepEqual(f.views,[]);
  await f.click('cameraView');assert.deepEqual(f.views,['b']);assert.equal(f.state.timingId,'a');
  await f.click('cameraAlign');assert.deepEqual(f.alignments,['b']);
  f.state.recording=true;f.ui.render(f.body);
  assert.ok(f.get('cameraAlign').disabled);assert.equal(f.get('heatCameraAssign').textContent,'Use for next capture');
  await f.get('cameraAlign').onclick();assert.deepEqual(f.alignments,['b']);
  f.state.recording=false;f.state.started=true;f.ui.render(f.body);
  assert.equal(f.get('heatCameraAssign').textContent,'Use for next capture');
  f.row('front').onclick();assert.ok(f.get('cameraView').disabled);assert.ok(f.get('cameraAlign').disabled);
  await f.get('cameraView').onclick();await f.get('cameraAlign').onclick();
  assert.deepEqual(f.views,['b']);assert.deepEqual(f.alignments,['b']);
});

test('recorder and parent updates preserve field nodes, focus, caret and all unsaved drafts',async t=>{
  const f=fixture(t);await f.loaded;
  const name=f.input('cameraName','Edited camera');name.focus();name.selectionStart=3;name.selectionEnd=7;
  f.input('cameraLocation','far');f.input('cameraSide','outside');f.input('cameraDirection','reverse');
  f.input('finishLocationName','New finish in progress');f.input('heatFinishLocation','far');f.input('heatTimingCamera','c');
  const heatTiming=f.get('heatTimingCamera'),choices=heatTiming.children;
  f.ui.updateRecorders({captureId:null,cameras:[{id:'a',label:'Recorder label',state:'recording',columns:999}]});
  f.ui.render(f.body);
  assert.equal(f.get('cameraName'),name);assert.equal(globalThis.document.activeElement,name);
  assert.equal(name.value,'Edited camera');assert.equal(name.selectionStart,3);assert.equal(name.selectionEnd,7);
  assert.equal(f.get('cameraLocation').value,'far');assert.equal(f.get('cameraSide').value,'outside');assert.equal(f.get('cameraDirection').value,'reverse');
  assert.equal(f.get('finishLocationName').value,'New finish in progress');assert.equal(heatTiming.value,'c');assert.equal(heatTiming.children,choices);
  f.row('b').onclick();f.input('cameraName','Other draft');f.row('a').onclick();assert.equal(name.value,'Edited camera');
  f.server.config.setups.a.label='External rename';await f.ui.refresh();assert.equal(name.value,'Edited camera');
  assert.equal(f.get('heatFinishLocation').value,'far');assert.equal(heatTiming.value,'c');
  assert.deepEqual(f.calls.filter(c=>c.method.endsWith('.save')||c.method.endsWith('.assign')),[]);
});

test('saving setup during capture appends a revision without selecting a view or changing capture timing',async t=>{
  const f=fixture(t,{context:{recording:true,captureId:'cap'},recorders:{captureId:'cap',cameras:[{id:'a',state:'recording',setup:initialConfig().setups.a}]}});await f.loaded;
  f.input('cameraName','  Moved camera  ');f.input('cameraLocation','far');f.input('cameraSide','outside');f.input('cameraDirection','reverse');
  assert.equal(f.get('cameraSave').disabled,false);
  await f.submit('cameraSave');
  assert.deepEqual(f.calls.find(c=>c.method==='camera.setup.save').params,{meetDir:'/fixture/meet',cameraId:'a',label:'Moved camera',locationId:'far',side:'outside',direction:'reverse'});
  assert.equal(f.ui.config.setups.a.revision,2);assert.equal(f.ui.config.history.filter(h=>h.cameraId==='a').length,2);
  assert.match(f.ui.revision.textContent,/Revision 2 · 1 earlier revision/);assert.equal(f.get('cameraName').value,'Moved camera');
  assert.ok(f.get('cameraSave').disabled);assert.ok(f.get('cameraAlign').disabled);
  assert.equal(f.state.timingId,'a');assert.deepEqual(f.views,[]);assert.deepEqual(f.published.map(p=>p.reason),['load','setup']);
  assert.ok(f.toasts.some(([text])=>/review this capture/.test(text)));
  assert.ok(f.calls.every(c=>c.method.startsWith('camera.')));
  const current=f.ui.config.setups.a;assert.equal(current.locationId,'far');assert.equal(f.ui.config.history[0].locationId,'home');
});

test('heat choices only include cameras at the chosen finish and assignment is explicit for the next capture',async t=>{
  const f=fixture(t,{context:{started:true}});await f.loaded;
  assert.deepEqual(f.get('heatTimingCamera').children.map(n=>n.value),['','a','b']);
  f.input('heatFinishLocation','empty');assert.deepEqual(f.get('heatTimingCamera').children.map(n=>n.value),['']);assert.ok(f.get('heatCameraAssign').disabled);
  assert.match(f.ui.heatEmpty.textContent,/Assign a camera/);
  f.input('heatFinishLocation','far');assert.equal(f.get('heatTimingCamera').value,'');
  assert.deepEqual(f.get('heatTimingCamera').children.map(n=>n.value),['','c']);
  f.input('heatTimingCamera','c');assert.equal(f.calls.filter(c=>c.method==='camera.heat.assign').length,0);
  await f.submit('heatCameraAssign');
  assert.deepEqual(f.calls.find(c=>c.method==='camera.heat.assign').params,{meetDir:'/fixture/meet',heatKey:'h1',locationId:'far',timingCameraId:'c'});
  assert.equal(f.state.timingId,'a');assert.deepEqual(f.views,[]);
  assert.match(f.ui.currentAssignment.textContent,/This capture: Finish inside/);
  assert.match(f.ui.savedAssignment.textContent,/Next capture: Far finish · Far finish/);
  assert.deepEqual(f.published.map(p=>p.reason),['load','heat']);
});

test('adding a named finish uses an inline form and keeps any newer text entered during the request',async t=>{
  const pending=deferred();
  const f=fixture(t,{handlers:{'camera.location.save':async(params,server)=>{
    await pending.promise;server.config.locations.push({id:'west',name:params.name});return clone(server.config);
  }}});await f.loaded;
  f.input('finishLocationName','  West finish  ');const saving=f.submit('finishLocationAdd');await tick();
  f.input('finishLocationName','Another finish');pending.resolve();await saving;
  assert.deepEqual(f.calls.find(c=>c.method==='camera.location.save').params,{meetDir:'/fixture/meet',name:'West finish'});
  assert.equal(f.get('finishLocationName').value,'Another finish');
  assert.ok(f.get('cameraLocation').children.some(n=>n.value==='west'&&n.textContent==='West finish'));
  assert.ok(f.get('heatFinishLocation').children.some(n=>n.value==='west'));
  assert.equal(f.get('cameraLocation').value,'home');assert.equal(f.ui.config.heats.h1.locationId,'home');
  assert.deepEqual(f.published.map(p=>p.reason),['load','location']);
});

test('failed writes keep the saved configuration and unsaved input, and recorder failures clear stale recording claims',async t=>{
  const f=fixture(t,{context:{captureId:'cap'},recorders:{captureId:'cap',cameras:[{id:'a',state:'recording'}]},handlers:{'camera.setup.save':()=>{throw Error('Cannot save now');}}});await f.loaded;
  const old=f.ui.config;f.input('cameraName','Keep this draft');await f.submit('cameraSave');
  assert.equal(f.ui.config,old);assert.equal(f.get('cameraName').value,'Keep this draft');assert.equal(f.get('cameraSave').disabled,false);
  assert.ok(f.toasts.some(([text,error])=>error&&text.includes('Cannot save now')));
  f.ui.bridge={call:async()=>{throw Error('Disconnected');}};
  await f.ui.refreshRecorders();assert.match(f.row('a').textContent,/Status unavailable/);assert.ok(!f.row('a').textContent.includes('Recording'));
  await f.ui.refreshRecorders();assert.equal(f.toasts.filter(([text])=>text.includes('Disconnected')).length,1);
  assert.equal(f.get('cameraName').value,'Keep this draft');assert.equal(f.ui.retry.hidden,false);
});

test('initial read errors have retry UI and can recover without dropping field drafts',async t=>{
  let fail=true;
  const f=fixture(t,{handlers:{'camera.config.get':(_,server)=>{if(fail)throw Error('Meet unavailable');return clone(server.config);}}});
  assert.ok(f.ui.loading);await f.loaded;
  assert.equal(f.ui.config,null);assert.match(f.ui.status.textContent,/could not load: Meet unavailable/);assert.equal(f.ui.retry.hidden,false);assert.equal(f.get('cameraName').disabled,true);
  fail=false;await f.ui.retry.onclick();assert.equal(f.ui.config.version,1);assert.equal(f.ui.retry.hidden,true);assert.equal(f.get('cameraName').disabled,false);
});

test('late responses from another meet or capture never replace current configuration or recorder state',async t=>{
  const old=deferred(),oldFacts=deferred();let reads=0;
  const f=fixture(t,{context:{captureId:'old'},handlers:{'camera.config.get':(_,server)=>++reads===1?old.promise:clone(server.config),
    'camera.recorders':params=>params.captureId==='old'?oldFacts.promise:{captureId:'new',cameras:[{id:'b',state:'idle'}]}}});
  await tick();f.state.meetDir='/fixture/other';f.state.captureId='new';f.ui.render(f.body);await f.ui.load();
  const current=f.ui.config;
  old.resolve({...initialConfig(),locations:[{id:'home',name:'OLD'}]});oldFacts.resolve({captureId:'old',cameras:[{id:'a',state:'recording'}]});await f.loaded;
  assert.equal(f.ui.config,current);assert.equal(f.published.length,1);assert.equal(f.ui.recorders.captureId,'new');
  assert.ok(!f.row('a').textContent.includes('Recording'));
  assert.equal(f.ui.updateRecorders({captureId:'old',cameras:[{id:'a',state:'recording'}]}),false);
  assert.equal(f.ui.recorders.captureId,'new');
});

test('new input during a setup save survives its completion; duplicate recorder reads coalesce',async t=>{
  const pending=deferred();
  const f=fixture(t,{handlers:{'camera.setup.save':async(params,server)=>{
    await pending.promise;const {meetDir,...setup}=params;server.config.setups[params.cameraId]={...setup,revision:2};return clone(server.config);
  }}});await f.loaded;
  f.input('cameraName','First edit');const saving=f.submit('cameraSave');await tick();
  f.input('cameraName','Newer edit');const name=f.get('cameraName');name.focus();name.selectionStart=2;
  const a=f.ui.refreshRecorders(),b=f.ui.refreshRecorders();assert.equal(a,b);await a;
  pending.resolve();await saving;
  assert.equal(f.ui.config.setups.a.label,'First edit');assert.equal(name.value,'Newer edit');assert.equal(name.selectionStart,2);assert.equal(f.get('cameraSave').disabled,false);
  assert.equal(f.calls.filter(c=>c.method==='camera.recorders').length,2);
  assert.equal(f.calls.filter(c=>c.method==='camera.setup.save').length,1);
});

test('empty inventory, unsaved devices, no heat, and offline setup have explicit usable states',async t=>{
  const config={version:1,locations:[{id:'home',name:'Home'}],setups:{},history:[],heats:{}};
  const f=fixture(t,{config,context:{scans:[],heatKey:null,timingId:null}});await f.loaded;
  assert.match(f.ui.empty.textContent,/No cameras available/);assert.equal(f.ui.editorForm.hidden,true);assert.ok(f.get('heatCameraAssign').disabled);
  assert.match(f.ui.heatEmpty.textContent,/Select a heat/);
  f.state.scans=[{id:'new',label:'New device'}];f.ui.render(f.body);assert.equal(f.get('cameraSave').disabled,false);
  await f.submit('cameraSave');assert.equal(f.ui.config.setups.new.revision,1);
  f.ui.bridge=null;f.ui.render(f.body);assert.match(f.ui.status.textContent,/Connect to the engine/);assert.ok(f.get('cameraSave').disabled);
});

test('async completion does not reclaim the parent body after another panel replaces it',async t=>{
  const pending=deferred(),f=fixture(t,{handlers:{'camera.config.get':()=>pending.promise}});await tick();
  const other=document.createElement('div');other.id='otherPanel';f.body.replaceChildren(other);
  pending.resolve(initialConfig());await f.loaded;assert.equal(f.body.children[0],other);
  f.ui.render(f.body);f.input('cameraName','Reopened draft');f.body.replaceChildren(other);f.ui.render(f.body);
  assert.equal(f.get('cameraName').value,'Reopened draft');
});

test('recorder replies from a prior capture are ignored within the same meet',async t=>{
  const old=deferred();
  const f=fixture(t,{context:{captureId:'first'},handlers:{'camera.recorders':params=>params.captureId==='first'?old.promise:{captureId:'second',cameras:[{id:'a',state:'stopped'}]}}});
  await tick();f.state.captureId='second';f.ui.render(f.body);await f.ui.refreshRecorders();
  old.resolve({captureId:'first',cameras:[{id:'a',state:'recording'}]});await f.loaded;
  assert.equal(f.ui.recorders.captureId,'second');assert.match(f.row('a').textContent,/Stopped/);
  assert.ok(!f.row('a').textContent.includes('Recording'));
  assert.deepEqual(f.calls.filter(c=>c.method==='camera.recorders').map(c=>c.params),[{captureId:'first'},{captureId:'second'}]);
});

test('malformed recorder replies show an error and empty names never produce writes',async t=>{
  const f=fixture(t,{handlers:{'camera.recorders':()=>({captureId:null})}});await f.loaded;
  assert.ok(f.toasts.some(([text,error])=>error&&text.includes('Invalid camera recorder response')));
  assert.match(f.row('a').textContent,/Status unavailable/);
  f.input('cameraName','  ');assert.ok(f.get('cameraSave').disabled);await f.ui.saveSetup();
  f.input('finishLocationName','  ');assert.ok(f.get('finishLocationAdd').disabled);await f.ui.addLocation();
  assert.equal(f.calls.filter(c=>c.method.endsWith('.save')).length,0);
});
