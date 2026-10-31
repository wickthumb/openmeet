'use strict';
const net=require('node:net');
const {validateProfile,units}=require('./tcp-profile.cjs');
const fault=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
function route(s){if(typeof s!=='string'||!s.length)throw new TypeError('Explicit routeId required');return s;}
function createScoreboardTcpClient(profile,options={}){
 const p=validateProfile(profile),routeId=route(options.routeId);
 const first=+p.host.split('.')[0];if(first===0||first>=224||p.host==='255.255.255.255')throw new RangeError('Explicit unicast IPv4 required');
 for(const k of ['connectTimeoutMs','writeTimeoutMs'])if(!Number.isInteger(options[k])||options[k]<1||options[k]>2147483647)throw new RangeError('Positive bounded '+k+' required');
 const connectTimeout=options.connectTimeoutMs,writeTimeout=options.writeTimeoutMs;
 const factory=options.socketFactory??(()=>new net.Socket());if(typeof factory!=='function')throw new TypeError('socketFactory required');
 const timers=options.timers??{setTimeout,clearTimeout};if(typeof timers.setTimeout!=='function'||typeof timers.clearTimeout!=='function')throw new TypeError('Timers required');
 const setTimer=timers.setTimeout.bind(timers),clearTimer=timers.clearTimeout.bind(timers);
 let socket=null,status='disconnected',busy=false,terminal=false,pending=Buffer.alloc(0),lastError=null,cancel=null,generation=0,release=null;
 const summary=()=>({deliveryEstablished:false});
 function snapshot(){return {routeId,profile:{...p},state:status,connected:status==='connected',busy,pending:Buffer.from(pending),pendingHex:pending.toString('hex'),error:lastError?{...lastError}:null,deliveryEstablished:false};}
 function revoke(){const old=socket;socket=null;generation++;if(release){release();release=null;}if(old){try{old.destroy();}catch{}}}
 function remember(e){lastError={code:e.code??'ERR_SCOREBOARD_NETWORK',message:e.message,...(e.attemptHex!==undefined?{attemptHex:e.attemptHex,outcomeUnknown:true}:{}),...(e.droppedPendingHex!==undefined?{droppedPendingHex:e.droppedPendingHex}:{} )};}
 function run(fn){if(busy)return Promise.reject(fault('ERR_SCOREBOARD_BUSY','Operation already pending'));if(terminal)return Promise.reject(fault('ERR_SCOREBOARD_CLOSED','Client closed'));busy=true;return (async()=>{try{return await fn();}finally{busy=false;}})();}
 function connected(){if(status!=='connected'||!socket)throw fault('ERR_SCOREBOARD_NOT_CONNECTED','Explicit connect required');}
 function open(){status='connecting';return new Promise((resolve,reject)=>{
  let s,done=false,timer;const epoch=++generation;
  const cleanup=()=>{if(timer!==undefined)clearTimer(timer);if(s)s.removeListener('connect',onConnect);if(cancel===abort)cancel=null;};
  const fail=e=>{if(done)return;done=true;cleanup();remember(e);status=terminal?'closed':'disconnected';revoke();reject(e);};
  const abort=()=>fail(fault('ERR_SCOREBOARD_CLOSED','Client closed'));
  const onConnect=()=>{if(done||epoch!==generation||terminal)return;done=true;cleanup();status='connected';resolve(summary());};
  const network=e=>{if(epoch!==generation||s!==socket)return;if(!done){fail(e);return;}if(cancel){cancel(e);return;}remember(e);status=terminal?'closed':'disconnected';revoke();};
  cancel=abort;
  try{s=factory();socket=s;const onEnd=()=>network(fault('ERR_SCOREBOARD_END','Peer ended')),onClose=()=>network(fault('ERR_SCOREBOARD_CLOSE','Socket closed')),onData=()=>{};s.on('error',network);s.on('end',onEnd);s.on('close',onClose);s.on('data',onData);s.on('connect',onConnect);release=()=>{s.removeListener('error',network);s.on('error',()=>{});s.removeListener('end',onEnd);s.removeListener('close',onClose);s.removeListener('data',onData);s.removeListener('connect',onConnect);};timer=setTimer(()=>fail(fault('ERR_SCOREBOARD_CONNECT_TIMEOUT','Connect timeout')),connectTimeout);s.setKeepAlive(p.keepAlive);s.connect({host:p.host,port:p.port});}catch(e){fail(e);}
 });}
 async function write(){connected();if(!pending.length)return summary();const b=Buffer.from(pending);pending=Buffer.alloc(0);const s=socket,epoch=generation;
 return new Promise((resolve,reject)=>{let done=false,returned=false,callbackDone=false,drained=false,needsDrain=false,timer;
  const cleanup=()=>{if(timer!==undefined)clearTimer(timer);s.removeListener('drain',onDrain);if(cancel===fail)cancel=null;};
  const fail=reason=>{if(done)return;done=true;cleanup();const e=fault(reason?.code??'ERR_SCOREBOARD_WRITE',reason?.message??'Write failed',{attemptHex:b.toString('hex'),outcomeUnknown:true,deliveryEstablished:false});remember(e);if(epoch===generation){status=terminal?'closed':'disconnected';revoke();}reject(e);};
  const finish=()=>{if(done||!returned||!callbackDone||(needsDrain&&!drained))return;done=true;cleanup();resolve({...summary(),attemptHex:b.toString('hex'),localCompletion:true});};
  function onDrain(){drained=true;finish();}
  cancel=fail;s.on('drain',onDrain);timer=setTimer(()=>fail(fault('ERR_SCOREBOARD_WRITE_TIMEOUT','Write timeout')),writeTimeout);
  try{const ok=s.write(Buffer.from(b),e=>{if(done||epoch!==generation)return;if(e){fail(e);return;}callbackDone=true;finish();});needsDrain=ok===false;returned=true;finish();}catch(e){fail(e);}
 });}
 async function append(a){connected();let processedUnits=0;try{while(processedUnits<a.length){if(pending.length===p.capacity)await write();connected();const count=Math.min(p.capacity-pending.length,a.length-processedUnits);pending=Buffer.concat([pending,Buffer.from(a.slice(processedUnits,processedUnits+count).map(n=>n&255))]);processedUnits+=count;}return {...summary(),processedUnits};}catch(e){e.processedUnits=processedUnits;throw e;}}
 function connect(){return run(async()=>{if(status==='connected')return summary();return open();});}
 function text(input){return run(()=>append(units(input)));}
 function flush(){return run(()=>write());}
 function applyCalls(calls,selection={}){return run(async()=>{if(route(selection.routeId)!==routeId)throw new TypeError('Route differs from bound routeId');if(!Array.isArray(calls))throw new TypeError('Ordered calls required');let budget=0;const plan=Array.from(calls,c=>{if(!c||!['text','flush'].includes(c.op))throw new TypeError('Invalid intent');const id=route(c.routeId),a=c.op==='text'?units(c.units):[];budget+=a.length;if(budget>1048576)throw new RangeError('Shared unit budget exceeded');return {routeId:id,op:c.op,units:a};});connected();const executed=[];for(const c of plan){if(c.routeId!==routeId)continue;const out=c.op==='text'?await append(c.units):await write();executed.push({routeId,op:c.op,...out});}return {...summary(),executed};});}
 function reconnect(){return run(async()=>{const droppedPendingHex=pending.toString('hex');pending=Buffer.alloc(0);revoke();status='disconnected';if(droppedPendingHex)lastError={code:'ERR_SCOREBOARD_PENDING_DROPPED',message:'Explicit reconnect discarded unsent pending',droppedPendingHex};try{const out=await open();return {...out,droppedPendingHex};}catch(e){e.droppedPendingHex=droppedPendingHex;remember(e);throw e;}});}
 function close(){if(terminal)return snapshot();terminal=true;status='closed';const droppedPendingHex=pending.toString('hex');pending=Buffer.alloc(0);if(cancel)cancel(fault('ERR_SCOREBOARD_CLOSED','Client closed'));revoke();if(droppedPendingHex)lastError={...(lastError??{}),droppedPendingHex};return snapshot();}
 return Object.freeze({connect,text,flush,applyCalls,reconnect,snapshot,close});
}
module.exports=Object.freeze({createScoreboardTcpClient});
