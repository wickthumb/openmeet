import {createScoreboardServerOutput} from './server-output.js';
import {SECTION_GROUPS,standardScoreboardField} from './fields.js';
import dgram from 'node:dgram';
import {performance} from 'node:perf_hooks';
import {scoreboardWireProtocol as protocol,meetDataProtocol} from '../integrations/index.js';
import {normalizeState} from './state.js';
import {interpolateCameraClock} from '../cameras/clock-sync.js';

const sections=['Initialization','TimeArmed','TimeRunning','TimePaused','TimeStopped','TimeGun','TimeBreak','TimeUpdate','Wind','TimeOfDay','StartListHeader','StartListTrailer','StartList','StartedHeader','StartedTrailer','Started','ResultsHeader','ResultsTrailer','Results','Image','ImageResultsHeader','ImageResultsTrailer','ImageResults','MessageHeader','MessageTrailer','Message'];
const units=text=>Array.from({length:String(text).length},(_,i)=>String(text).charCodeAt(i));
const positive=(v,max=2147483647)=>Number.isInteger(v)&&v>0&&v<=max;
const fail=(code,message=code)=>Object.assign(new Error(message),{code});
function fieldValue(object,field){
  let value=object;
  for(const key of field.split('.')){
    if(['__proto__','prototype','constructor'].includes(key)||!value||!Object.hasOwn(value,key))return null;value=value[key];
  }
  return value;
}
export function createScoreboardUdpOutput(config,{socketFactory=()=>dgram.createSocket('udp4')}={}){
  const {host,port,capacity=32767,chunkBytes=1400,writeTimeoutMs=1000}=config;
  if(typeof host!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(host)||host.split('.').some(x=>+x>255)||!positive(port,65535)||!positive(capacity,1048576)||!positive(chunkBytes,65507)||!positive(writeTimeoutMs))throw new TypeError('Explicit bounded UDP board profile required');
  let socket=null,closed=false,busy=false,pending=Buffer.alloc(0),cancellers=new Set();
  async function send(bytes){
    if(closed)throw fail('ERR_SCOREBOARD_CLOSED');
    if(!socket){socket=socketFactory();socket.on('error',error=>{for(const cancel of [...cancellers])cancel(error);});if(config.broadcast||config.localAddress){await new Promise((resolve,reject)=>{
      let done=false;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);socket.off('error',onError);socket.off('listening',ready);socket.off('close',onClose);cancellers.delete(finish);if(error)reject(error);else resolve();};
      const onError=error=>finish(error),onClose=()=>finish(fail('ERR_SCOREBOARD_CLOSED')),ready=()=>{try{if(config.broadcast)socket.setBroadcast(true);finish();}catch(error){finish(error);}},timer=setTimeout(()=>finish(fail('ERR_SCOREBOARD_WRITE_TIMEOUT')),writeTimeoutMs);
      cancellers.add(finish);socket.once('error',onError);socket.once('listening',ready);socket.once('close',onClose);try{socket.bind(0,config.localAddress??'0.0.0.0');}catch(error){finish(error);}
    });}}
    if(closed)throw fail('ERR_SCOREBOARD_CLOSED');
    if(socket.listenerCount('error')===0)socket.on('error',error=>{for(const cancel of [...cancellers])cancel(error);});
    await new Promise((resolve,reject)=>{
      const finish=error=>{clearTimeout(timer);cancellers.delete(finish);error?reject(error):resolve();};
      const timer=setTimeout(()=>finish(fail('ERR_SCOREBOARD_WRITE_TIMEOUT')),writeTimeoutMs);cancellers.add(finish);
      try{socket.send(bytes,port,host,finish);}catch(error){finish(error);}
    });
  }
  async function run(fn){if(busy)throw fail('ERR_SCOREBOARD_BUSY');if(closed)throw fail('ERR_SCOREBOARD_CLOSED');busy=true;try{return await fn();}finally{busy=false;}}
  async function text(input){const bytes=protocol.planner.encodeLow8(input);if(pending.length+bytes.length>capacity)throw fail('ERR_SCOREBOARD_BUFFER_FULL');pending=Buffer.concat([pending,bytes]);}
  async function flush(){const bytes=pending;pending=Buffer.alloc(0);for(let at=0;at<bytes.length;at+=chunkBytes)await send(bytes.subarray(at,at+chunkBytes));return {localCompletion:true,deliveryEstablished:false};}
  return {
    async connect(){if(closed)throw fail('ERR_SCOREBOARD_CLOSED');return {localCompletion:true,deliveryEstablished:false};},
    applyCalls(calls,{routeId}){return run(async()=>{for(const call of calls)if(call.routeId===routeId){if(call.op==='text')await text(call.units);else if(call.op==='flush')await flush();else throw new TypeError('Unknown board intent');}return {localCompletion:true,deliveryEstablished:false};});},
    snapshot:()=>({state:closed?'closed':'connected',pendingHex:pending.toString('hex'),deliveryEstablished:false}),
    close(){closed=true;for(const cancel of [...cancellers])cancel(fail('ERR_SCOREBOARD_CLOSED'));try{socket?.close();}catch{}pending=Buffer.alloc(0);},
  };
}

export function createWireScoreboardService({tcpFactory=protocol.createScoreboardTcpClient,udpFactory=createScoreboardUdpOutput,
  monotonicMs=()=>Math.floor(performance.now()),serverFactory=createScoreboardServerOutput,wallMs=()=>Date.now(),onEvent=()=>{},timers={setInterval,clearInterval}}={}){
  const routes=new Map();let closed=false,latest=normalizeState(),pendingGun=null,clockAnchor=null,ticker=null;
  const notify=(event,data)=>{try{onEvent(event,data);}catch{}};
  const get=id=>{const route=routes.get(id);if(!route)throw Error('Unknown wire scoreboard');return route;};
  const summary=route=>({id:route.id,connected:route.connected,section:route.config.section,
    mode:route.test?.mode??(route.paused?'paused':'live'),transport:route.client.snapshot(),error:route.error,revision:route.revision,deliveryEstablished:false});
  function timeText(seconds,config){
    if(seconds==null)return '';
    return meetDataProtocol.time.appendTime({tuple:{ticks:String(Math.round(seconds*80000)),quantum:'1',origin:'-1'},
      requestedPrecision:String(config.precisionTicks??800),H:'0',L:'0',callbackSelection:null,RoundMethod:String(config.roundMethod??2),prefix:'',
      characters:{minus:'-',day:':',hour:':',minute:':',fraction:'.'}}).text;
  }
  function clock(){
    if(clockAnchor){
      const time=interpolateCameraClock({...clockAnchor,nowMs:monotonicMs()});
      if(time.origin!==clockAnchor.start.origin)throw fail('ERR_SCOREBOARD_CLOCK_ORIGIN');
      return Number(time.ticks-BigInt(clockAnchor.start.ticks))/80000;
    }
    return latest.clock.running?Math.max(0,(wallMs()-latest.clock.startedAtMs)/1000*latest.clock.speed):latest.clock.frozenS;
  }
  function render(route,section,now,gun){
    const index=sections.indexOf(section==='Result'?'Results':section),definition=route.script.sections[index];
    if(!definition?.pages.length)return [];
    const page=definition.pages[Math.floor(Math.max(0,now-route.startedAt)/(route.config.pageIntervalMs??10000))%definition.pages.length];
    const state=route.test?normalizeState({heat:{name:'Diagnostic test',event:'TEST',round:1,heat:1,state:'running'},lanes:[{lane:4,id:route.test.pattern??'444',first:'Test',last:'Runner',affiliation:'OpenMeet',place:1,time:12.34}]}):latest;
    const rows=section.includes('Result')?state.results:section.includes('Start')?state.lanes:[null];
    const rowSections=['Results','StartList','Started','ImageResults'];
    const chosen=rowSections.includes(section)?rows.slice(route.config.rowOffset??0,(route.config.rowOffset??0)+(route.config.rowsPerPage??rows.length)):[null];
    const lines=[];let emitted=0;
    for(const [rowIndex,row]of chosen.entries()){
      const seconds=(route.test?route.test.mode==='clock'?Math.max(0,(now-route.test.startedAt)/1000):444:clock())+(route.config.offsetTicks??0)/80000;
      const context={state,row,rowIndex,meet:state.meet,heat:state.heat,wind:state.wind,
        clock:{seconds,text:route.test?.mode==='pattern'?route.test.pattern:timeText(seconds,route.config),pattern:route.test?.mode==='pattern'?route.test.pattern:null},gun,message:route.config.message??''};
      const result=protocol.formatter.renderLines(page.lines,{defaultGroup:route.config.defaultGroup??SECTION_GROUPS[index],registers:route.registers,
        timeContextPresent:section.startsWith('Time'),timeUnchangedSuppression:false,
        resolve(group,variable){
          const binding=route.config.bindings.find(item=>item.group===group&&item.variable===variable);
          if(!binding){if(route.config.bindingProfile==='standard')return standardScoreboardField(group,variable,context,(seconds,options={})=>timeText(seconds,{...route.config,...options}));throw fail('ERR_SCOREBOARD_BINDING',`No field binding for ${group}:${variable}`);}
          let value=fieldValue(context,binding.field);
          if(binding.format==='time')value=timeText(value,route.config);
          if(binding.kind==='binary32')return {kind:'binary32',value:value??0};
          return {kind:'text',value:units(value==null?'':value)};
        }});
      emitted+=result.lineUnits.reduce((n,line)=>n+line.length,0);if(emitted>1048576)throw new RangeError('Board output exceeds the per-cycle budget');route.registers=result.registers;lines.push(...result.lineUnits);
    }
    return lines;
  }
  function renderCycle(route,request,now){
    const lines=[];
    if(route.needsInitialization){lines.push(...render(route,'Initialization',now,request.gun));route.needsInitialization=false;}
    if(request.gun&&!route.test)lines.push(...render(route,'TimeGun',now,request.gun));
    const section=route.test?(route.test.mode==='results'?'Results':'TimeRunning'):route.config.section==='auto'?(latest.heat.state==='running'?'TimeRunning':latest.heat.state==='armed'?'TimeArmed':'TimeStopped'):route.config.section;
    if(['Results','StartList','Started','ImageResults'].includes(section))lines.push(...render(route,section+'Header',now,request.gun));
    lines.push(...render(route,section,now,request.gun));
    if(['Results','StartList','Started','ImageResults'].includes(section))lines.push(...render(route,section+'Trailer',now,request.gun));
    if(lines.reduce((n,line)=>n+line.length,0)>1048576)throw new RangeError('Board output exceeds the per-cycle budget');return lines;
  }
  async function cycle(route,request){
    const now=monotonicMs(),lines=renderCycle(route,request,now);
    const planned=protocol.planner.planCycle([{routeId:route.id,state:route.board,
      ready:{lock:true,transport:true,predicateA:true,predicateB:true},secondPhase:{lock:true,transport:true},
      minUpdateDelay:route.config.minUpdateDelayMs??0,updateHold:route.config.updateHoldMs??0,
      update:{work:true,force:request.force,lines,previousPageDeadline:route.board.pageDeadline}}],
      {now:now>>>0,optimize:route.config.optimize??2});
    route.board=planned.boards[0].state;
    const result=await route.client.applyCalls(planned.calls,{routeId:route.id});route.revision++;
    return {...result,revision:route.revision,deliveryEstablished:false};
  }
  async function run(route){
    if(route.running)return route.running;
    route.running=(async()=>{
      while(route.pending&&!closed&&route.connected&&!route.paused){const request=route.pending;route.pending=null;
        try{await cycle(route,request);route.error=null;}catch(error){route.error={code:error.code||'ERR_SCOREBOARD_OUTPUT',message:error.message};notify('scoreboard.wire.error',{id:route.id,...route.error});throw error;}}
      return summary(route);
    })().finally(()=>{route.running=null;});return route.running;
  }
  function publish(state,{force=false}={}){
    if(closed)return Promise.reject(fail('ERR_SCOREBOARD_CLOSED'));latest=normalizeState(state);
    const gun=pendingGun;pendingGun=null;
    const jobs=[];for(const route of routes.values())if(route.connected&&!route.paused){route.pending={force:force||Boolean(route.pending?.force),gun:route.pending?.gun??gun};jobs.push(run(route));}
    return Promise.allSettled(jobs);
  }
  return {
    configure({id,profile,script,bindings,section='auto',...config}){
      if(closed)throw fail('ERR_SCOREBOARD_CLOSED');section=section==='Result'?'Results':section;if(typeof id!=='string'||!id||routes.has(id))throw Error('Unique board id required');
      if(typeof script!=='string'||script.length>1048576||!Array.isArray(bindings)||!['auto',...sections,'Result'].includes(section))throw new TypeError('Explicit bounded script, bindings and section required');
      for(const b of bindings)if(!Number.isInteger(b.group)||b.group<16||b.group>24||!Number.isInteger(b.variable)||b.variable<1||typeof b.field!=='string'||b.field.length>128||b.kind&&!['text','binary32'].includes(b.kind))throw new TypeError('Invalid board field binding');
      for(const key of ['minUpdateDelayMs','updateHoldMs'])if(config[key]!=null&&(!Number.isInteger(config[key])||config[key]<0||config[key]>2147483647))throw new RangeError('Invalid board cadence');
      if(config.pageIntervalMs!=null&&!positive(config.pageIntervalMs))throw new RangeError('Invalid page interval');
      if(config.rowOffset!=null&&(!Number.isInteger(config.rowOffset)||config.rowOffset<0)||config.rowsPerPage!=null&&!positive(config.rowsPerPage,100000)||config.offsetTicks!=null&&!Number.isSafeInteger(config.offsetTicks)||config.precisionTicks!=null&&!positive(config.precisionTicks,80000)||config.optimize!=null&&![0,1,2].includes(config.optimize)||config.defaultGroup!=null&&(!Number.isInteger(config.defaultGroup)||config.defaultGroup<16||config.defaultGroup>24))throw new RangeError('Invalid board rows, precision, group or offset');
      const client=profile.kind==='udp'?udpFactory(profile):profile.kind==='tcp-server'?serverFactory(profile):tcpFactory(protocol.tcpProfile.parseTcpOutputProfile(profile),{
        routeId:id,localAddress:profile.localAddress,connectTimeoutMs:config.connectTimeoutMs??2000,writeTimeoutMs:config.writeTimeoutMs??2000});
      const now=monotonicMs(),route={id,client,config:{...structuredClone(config),section,bindings:structuredClone(bindings)},
        script:protocol.formatter.loadDecodedLines(script.replace(/\r\n?/g,'\n').split('\n').map(units)),
        board:protocol.planner.createBoardState({lastCommit:now>>>0}),registers:Array(10).fill(0),
        connected:false,paused:config.startPaused===true,test:null,needsInitialization:true,startedAt:now,pending:null,running:null,error:null,revision:0};
      routes.set(id,route);return summary(route);
    },
    async connect({id}){const route=get(id);await route.client.connect();if(closed)throw fail('ERR_SCOREBOARD_CLOSED');route.connected=true;if(!route.paused)route.pending={force:true,gun:null};
      if(!ticker){ticker=timers.setInterval(()=>{void publish(latest).catch(error=>notify('scoreboard.wire.error',{message:error.message}));},100);ticker.unref?.();}
      return run(route);},
    publish,
    preview({id,mode='pattern',pattern='444'}){
      const route=get(id);if(!['pattern','clock','results'].includes(mode)||typeof pattern!=='string'||!/^[0-9A-Z .:-]{1,24}$/.test(pattern))throw new TypeError('Invalid board preview');
      const now=monotonicMs(),copy={...route,registers:route.registers.slice(),test:{mode,pattern,startedAt:now}};
      const lines=renderCycle(copy,{gun:null},now),bytes=protocol.planner.encodeLow8(lines.flat());
      return {hex:bytes.toString('hex'),text:bytes.toString('latin1').replace(/[^\x20-\x7e\r\n]/g,c=>'<'+c.charCodeAt(0).toString(16).padStart(2,'0')+'>'),bytes:bytes.length,networkActivity:false};
    },
    async setMode({id,mode,pattern='444'}){
      const route=get(id);if(!route.connected)throw fail('ERR_SCOREBOARD_NOT_CONNECTED');
      if(!['paused','live','pattern','clock','results'].includes(mode)||typeof pattern!=='string'||!/^[0-9A-Z .:-]{1,24}$/.test(pattern))throw new TypeError('Invalid scoreboard diagnostic');
      if(route.running)await route.running;route.paused=mode==='paused';route.test=['pattern','clock','results'].includes(mode)?{mode,pattern,startedAt:monotonicMs()}:null;
      route.pending=route.paused?null:{force:true,gun:null};await run(route);return summary(route);
    },
    async reconnect({id}){const route=get(id);if(typeof route.client.reconnect!=='function')throw fail('ERR_SCOREBOARD_RECONNECT_UNSUPPORTED');route.connected=false;await route.client.reconnect();route.connected=true;route.needsInitialization=true;route.pending={force:true,gun:null};return run(route);},
    notifyGun({time,kind}){if(pendingGun)return {accepted:false,pending:true};pendingGun=structuredClone({time,kind});return {accepted:true,pending:true};},
    setClock(anchor){
      if(anchor==null){clockAnchor=null;return {configured:false};}
      const value=structuredClone(anchor);interpolateCameraClock({...value,nowMs:monotonicMs()});
      if(value.origin!==value.start?.origin)throw fail('ERR_SCOREBOARD_CLOCK_ORIGIN');clockAnchor=value;return {configured:true,origin:value.origin};
    },
    list:()=>[...routes.values()].map(summary),
    async close({id}){const route=get(id);route.connected=false;route.pending=null;route.client.close();try{await route.running;}catch{}routes.delete(id);if(!routes.size&&ticker){timers.clearInterval(ticker);ticker=null;}return {id,closed:true};},
    async closeAll(){closed=true;if(ticker){timers.clearInterval(ticker);ticker=null;}for(const route of routes.values()){route.connected=false;route.pending=null;route.client.close();}await Promise.allSettled([...routes.values()].map(r=>r.running));routes.clear();pendingGun=null;clockAnchor=null;},
  };
}
