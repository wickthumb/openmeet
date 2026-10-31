import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {createBackendIntegrationService} from '../integrations/service.js';
import {decodeMeetText} from '../meetlink/text.js';
import {buildAlignmentReset} from '../cameras/control.js';
import {hardwareProfile,makeCameraConfiguration,CAMERA_MARKER} from './profiles.js';
import {scoreboardWireProtocol} from '../integrations/index.js';
import {SECTION_GROUPS} from '../scoreboard/fields.js';
const fail=(code,message=code)=>Object.assign(new Error(message),{code});
const errorInfo=error=>({code:error.code??'ERR_HARDWARE',message:error.message});
export function createHardwareService({root,cameras,boards,openCamera=options=>cameras.open(options),captureBusy=()=>false,networkInterfaces=os.networkInterfaces,onEvent=()=>{},timers={setInterval,clearInterval,setTimeout,clearTimeout}}){
  const storage=createBackendIntegrationService({root}),runtime=new Map(),working=new Map();let closed=false,interfaceError=null;
  const records=()=>storage.profiles({operation:'list'}).profiles.filter(p=>p.configuration?.version===1&&['camera','scoreboard'].includes(p.configuration.kind)&&p.name.startsWith('hardware-'));
  const get=id=>{const p=records().find(p=>p.name===id)?.configuration;if(!p)throw fail('ERR_HARDWARE_UNKNOWN','Unknown equipment profile');return p;};
  const persist=p=>{const exists=records().some(r=>r.name===p.id);storage.profiles({operation:exists?'save':'create',name:p.id,configuration:p});return p;};
  function interfaces(){let data;try{data=networkInterfaces();interfaceError=null;}catch(error){interfaceError=error.message;data={};}return Object.entries(data).flatMap(([name,list])=>(list??[]).filter(v=>v.family==='IPv4'||v.family===4).map(v=>({name,address:v.address,netmask:v.netmask,internal:!!v.internal,cidr:v.cidr??null})));}
  function checkInterface(p){if(p.localAddress&&!interfaces().some(i=>i.address===p.localAddress))throw fail('ERR_HARDWARE_INTERFACE','The selected local interface is no longer available');}
  function observed(p,key,value){p.observations={...p.observations,[key]:{...value,at:new Date().toISOString(),fingerprint:p.fingerprint}};persist(p);return p;}
  function live(p){const entry=runtime.get(p.id);if(!entry)return null;
    try{const status=p.kind==='camera'?cameras.snapshot({id:entry.sessionId}):boards.list().find(b=>b.id===entry.sessionId);if(!status)throw fail('ERR_HARDWARE_DISCONNECTED');return {...status,mode:entry.mode,error:entry.error??status.error,sessionId:entry.sessionId};}
    catch{if(entry.timer)timers.clearInterval(entry.timer);entry.timer=null;if(entry.stopTimer)(timers.clearTimeout??clearTimeout)(entry.stopTimer);runtime.delete(p.id);return null;}
  }
  const snapshot=p=>({...structuredClone(p),busy:working.has(p.id),runtime:live(p)});
  function exclusive(id,fn){if(closed)return Promise.reject(fail('ERR_HARDWARE_CLOSED'));if(working.has(id))return Promise.reject(fail('ERR_HARDWARE_BUSY','Wait for this equipment operation to finish'));
    const job=Promise.resolve().then(fn).finally(()=>working.delete(id));working.set(id,job);return job;
  }
  function stopPolling(entry){if(entry.timer)timers.clearInterval(entry.timer);entry.timer=null;return entry.polling??Promise.resolve();}
  function startPolling(p,entry){
    const poll=()=>{if(closed||entry.timer==null||entry.polling||working.has(p.id))return;
      entry.polling=(async()=>{try{await cameras.command({id:entry.sessionId,operation:'pollStatus'});
        if(entry.delivery==='udp')for(let i=0;i<64;i++){const response=await cameras.command({id:entry.sessionId,operation:'fetchNextBlock'});if(response.result.decision!=='received')break;}
        entry.error=null;
      }catch(error){entry.error=errorInfo(error);if(entry.timer)timers.clearInterval(entry.timer);entry.timer=null;onEvent('hardware.error',{id:p.id,...entry.error});}
      finally{entry.polling=null;}})();
    };
    entry.timer=timers.setInterval(poll,250);entry.timer.unref?.();
  }
  async function disconnect(p,{graceful=true}={}){
    const entry=runtime.get(p.id);if(!entry)return snapshot(get(p.id));if(entry.stopTimer)(timers.clearTimeout??clearTimeout)(entry.stopTimer);await stopPolling(entry);let result=null,drain=null,error=null;
    try{
      if(p.kind==='camera'){
        if(graceful&&entry.mode==='recording'){
          try{drain=await cameras.drain({id:entry.sessionId,timeoutMs:2000});await cameras.command({id:entry.sessionId,operation:'end'});}catch(e){error=errorInfo(e);}
        }else if(graceful&&entry.mode==='alignment')try{await cameras.command({id:entry.sessionId,operation:'end'});}catch(e){error=errorInfo(e);}
        result=await cameras.close({id:entry.sessionId});
      }else result=await boards.close({id:entry.sessionId});
    }finally{runtime.delete(p.id);}
    observed(get(p.id),'lastSession',{mode:entry.mode,recording:result?.recording??null,image:result?.image??null,drain,error,captureComplete:false});return snapshot(get(p.id));
  }
  function boardConfiguration(p,id){
    const profile=p.transport==='tcp-client'?{SerialPort:`-1,${p.address},${p.port}`,CharMode:0,PortBuffer:32767,KeepAlive:true,localAddress:p.localAddress}:p.transport==='tcp-server'?{kind:'tcp-server',host:p.localAddress,port:p.port,peerAddress:p.address}:{kind:'udp',host:p.address,port:p.port,broadcast:p.broadcast,localAddress:p.localAddress};
    return {id,profile,script:p.script,bindings:p.bindings,bindingProfile:'standard',section:p.section,startPaused:true};
  }
  return {
    list({kind}={}){return {profiles:records().map(r=>r.configuration).filter(p=>!kind||p.kind===kind).map(snapshot),interfaces:interfaces(),interfaceError};},
    save(input){return exclusive(input.id??'new',async()=>{const previous=input.id?get(input.id):null;if(previous&&live(previous))throw fail('ERR_HARDWARE_IN_USE','Disconnect equipment before editing its profile');
      if(!previous&&records().length>=64)throw fail('ERR_HARDWARE_LIMIT','Equipment profile limit reached');return snapshot(persist(hardwareProfile(input,previous)));});},
    remove({id}){return exclusive(id,async()=>{const p=get(id);if(live(p))throw fail('ERR_HARDWARE_IN_USE','Disconnect equipment before removing its profile');storage.profiles({operation:'delete',name:id});return {id,removed:true};});},
    async importFile({file,kind,id=null}){
      if(!['camera','scoreboard'].includes(kind)||typeof file!=='string')throw TypeError('Equipment type and local file required');
      const handle=await fs.open(file,'r');let bytes;try{const size=(await handle.stat()).size;if(size>1048576)throw RangeError('Equipment file exceeds 1 MiB');bytes=Buffer.alloc(size+1);let offset=0;while(offset<bytes.length){const r=await handle.read(bytes,offset,bytes.length-offset,offset);if(!r.bytesRead)break;offset+=r.bytesRead;}if(offset>size)throw Error('Equipment file changed during read');bytes=bytes.subarray(0,offset);}finally{await handle.close();}
      let text;
      if(bytes.length>=2&&((bytes[0]===255&&bytes[1]===254)||(bytes[0]===254&&bytes[1]===255))){if(bytes.length%2)throw TypeError('Incomplete UTF16 equipment file');text=new TextDecoder(bytes[0]===255?'utf-16le':'utf-16be',{fatal:true}).decode(bytes.subarray(2));}
      else if(path.extname(file).toLowerCase()==='.json'||bytes.toString('ascii').trimStart().startsWith('{'))text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');
      else text=decodeMeetText(bytes);
      const old=id?get(id):null,name=old?.name??path.basename(file,path.extname(file));
      if(kind==='scoreboard'&&!text.trimStart().startsWith('{'))return {draft:{...(old??{}),kind,name,address:old?.address??'127.0.0.1',port:old?.port??5000,transport:old?.transport??'tcp-client',script:text},source:path.basename(file)};
      const value=JSON.parse(text);if(value.kind)return {draft:{...value,id:old?.id??null,kind,observations:{}},source:path.basename(file)};
      if(kind==='camera'&&value.profile){const v=value.profile;return {draft:{kind,id:old?.id??null,name,address:v.address??old?.address??'192.168.0.6',localAddress:v.localAddress??null,transport:v.delivery??'tcp',configuration:value,settings:{height:value.imageProfile?.height??v.parameters?.[2]??640,rate:v.parameters?.[3]??800,depth:((v.reset?.[0]??20)>>>2)&63,queueEpochTrusted:v.queueEpochTrusted===true,alignmentWidth:128,alignmentRate:5}},source:path.basename(file)};}
      throw TypeError('Unrecognized equipment JSON');
    },
    inspect({id}){return exclusive(id,async()=>{const p=get(id);if(p.kind!=='camera')throw TypeError('Choose a camera');if(captureBusy())throw fail('ERR_HARDWARE_LIVE','Stop capture or preview before checking camera setup');if(live(p))throw fail('ERR_HARDWARE_IN_USE','Disconnect this camera before checking it');checkInterface(p);
      const result=await cameras.inspect({address:p.address,localAddress:p.localAddress,port:p.port,marker:p.configuration.profile?.marker??CAMERA_MARKER,family:3});
      observed(p,'inspection',{result});return snapshot(p);
    });},
    connect({id,mode='alignment',meetDir=null}){return exclusive(id,async()=>{const p=get(id);if(live(p))throw fail('ERR_HARDWARE_IN_USE','This equipment already has an active connection');if(runtime.size>=8)throw fail('ERR_HARDWARE_LIMIT','Active equipment limit reached');checkInterface(p);
      if(p.kind==='camera'){
        if(captureBusy())throw fail('ERR_HARDWARE_LIVE','Stop capture or preview before camera setup');if(!['alignment','recording'].includes(mode))throw TypeError('Choose alignment or sample recording');
        const checked=await cameras.inspect({address:p.address,localAddress:p.localAddress,port:p.port,marker:p.configuration.profile?.marker??CAMERA_MARKER,family:3});observed(p,'inspection',{result:checked});if(mode==='recording'&&p.transport==='tcp'&&checked.configuration.tcpSupported===false)throw fail('ERR_HARDWARE_TRANSPORT','Camera did not report TCP delivery support. Choose UDP or import a verified profile.');
        const config=makeCameraConfiguration(p,checked),entry={mode,sessionId:null,timer:null,polling:null,error:null,delivery:p.transport};
        if(mode==='alignment'){
          const reset=buildAlignmentReset({depth:p.settings.depth,dimensions:2,alignmentParameter:p.configuration.alignment?.alignmentParameter??0,width:p.settings.alignmentWidth,rate:p.settings.alignmentRate,indicatorRgb:[0,255,0],...p.configuration.alignment});
          config.profile={...config.profile,mode:'alignment',delivery:'udp',reset:reset.words};config.previewWidth=reset.effectiveWidth;entry.delivery='udp';
        }
        let opened;try{opened=await openCamera({...config,meetDir:null,diagnostic:true,recordingDir:path.join(root,'camera-sessions',randomUUID())});entry.sessionId=opened.id;runtime.set(id,entry);await cameras.command({id:opened.id,operation:'prepare'});if(mode==='recording')await cameras.command({id:opened.id,operation:'start'});startPolling(p,entry);if(mode==='recording'){entry.stopTimer=(timers.setTimeout??setTimeout)(async()=>{try{await working.get(id);if(runtime.get(id)===entry)await this.disconnect({id});}catch(error){onEvent('hardware.error',{id,...errorInfo(error)});}},10000);entry.stopTimer.unref?.();}observed(p,'sessionOpened',{mode,recording:opened.recording,deviceValidated:false});}
        catch(error){await stopPolling(entry);if(opened)await cameras.close({id:opened.id}).catch(()=>{});runtime.delete(id);throw error;}
      }else{
        const routeId='equipment-'+id;
        boards.configure(boardConfiguration(p,routeId));
        try{await boards.connect({id:routeId});runtime.set(id,{sessionId:routeId,mode:'paused'});}catch(error){await boards.close({id:routeId});throw error;}
      }return snapshot(get(id));
    });},
    status({id}){const p=get(id);return {id:p.id,busy:working.has(id),runtime:live(p),observations:structuredClone(p.observations)};},
    disconnect({id}){return exclusive(id,()=>disconnect(get(id)));},
    retryStatus({id}){return exclusive(id,async()=>{const p=get(id),entry=runtime.get(id);if(!entry||p.kind!=='camera')throw fail('ERR_HARDWARE_DISCONNECTED');await stopPolling(entry);await cameras.command({id:entry.sessionId,operation:'retryStatus'});entry.error=null;startPolling(p,entry);return snapshot(p);});},
    image({id,after=null}){
      const p=get(id),state=live(p),entry=runtime.get(id);if(!entry||p.kind!=='camera'||!state.image)return {ready:false};const revision=entry.mode==='alignment'?state.image.previewFrames:state.image.columns;
      if(after===revision)return {ready:false,revision};const rows=state.image.rows,count=state.image.columns,keep=Math.max(1,Math.min(512,Math.floor(4194304/(rows*3))));
      return {...cameras.image({id:entry.sessionId,preview:entry.mode==='alignment',from:Math.max(0,count-keep)}),revision};
    },
    scoreboardMode({id,mode,pattern='444'}){return exclusive(id,async()=>{const p=get(id),entry=runtime.get(id);if(p.kind!=='scoreboard'||!entry)throw fail('ERR_HARDWARE_DISCONNECTED');await boards.setMode({id:entry.sessionId,mode,pattern});entry.mode=mode;if(['pattern','clock','results'].includes(mode))observed(p,'lastTest',{mode,pattern,localCompletion:true,displayConfirmed:false});return snapshot(get(id));});},
    confirm({id,test,answer,notes=''}){return exclusive(id,async()=>{const p=get(id);if(!['yes','no','different'].includes(answer)||typeof notes!=='string'||notes.length>1000)throw TypeError('Choose an observed result');
      if(p.kind==='scoreboard'&&(!['pattern','clock','results'].includes(test)||p.observations.lastTest?.mode!==test||!live(p)||live(p).error))throw fail('ERR_HARDWARE_TEST','Run this diagnostic before confirming its display');
      if(p.kind==='camera'&&(test!=='alignment'||!(live(p)?.image?.previewFrames>=1)))throw fail('ERR_HARDWARE_TEST','Receive a complete alignment image first');
      observed(p,'confirmed-'+test,{answer,notes,operatorObserved:true,physicalTimingCalibrated:false});return snapshot(get(id));
    });},
    async scriptPreview({id,mode='pattern',pattern='444'}){const p=get(id);if(p.kind!=='scoreboard')throw TypeError('Choose a scoreboard');const loaded=scoreboardWireProtocol.formatter.loadDecodedLines(p.script.replace(/\r\n?/g,'\n').split('\n'));
      const fields=new Set();loaded.sections.forEach((section,i)=>section?.pages.forEach(page=>page.lines.forEach(line=>{const field=scoreboardWireProtocol.formatter.parseLine(line,SECTION_GROUPS[i]);if(field?.variable)fields.add(`${field.group}:${field.variable}`);})));
      let preview=null;if(typeof boards.preview==='function'){
        const existing=runtime.get(id),temporary='equipment-preview-'+randomUUID(),route=existing?.sessionId??temporary;
        if(!existing)boards.configure(boardConfiguration(p,route));
        try{preview=boards.preview({id:route,mode,pattern});}finally{if(!existing)await boards.close({id:route});}
      }
      return {sections:loaded.sections.filter(Boolean).length,fields:[...fields],deviceValidated:false,preview};
    },
    async closeAll(){closed=true;for(const entry of runtime.values())if(entry.timer)timers.clearInterval(entry.timer);await Promise.allSettled([...working.values()]);await Promise.allSettled([...runtime.keys()].map(id=>disconnect(get(id),{graceful:false})));},
  };
}
