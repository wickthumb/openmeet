'use strict';
const {encodeStreamStart,decodeControlReply,createStreamDecoder}=require('./index.cjs');
const {decodeStartStatus}=require('./start-status.cjs');
const {createRaceStartJournal}=require('./race-start.cjs');
const {inspectReceivedBlock}=require('./received-block.cjs');
const uint=v=>Number.isInteger(v)&&v>=0&&v<=0xffffffff;
const integer=(v,a,b)=>Number.isInteger(v)&&v>=a&&v<=b;
const str=v=>typeof v==='string'&&v.length>0;
const fail=(code,message=code)=>Object.assign(new Error(message),{code});
function hostOK(host){if(typeof host!=='string')return false;const p=host.split('.');return p.length===4&&p.every(x=>/^(0|[1-9][0-9]*)$/.test(x)&&+x<=255)&&+p[0]>0&&+p[0]<224&&+p[3]!==255&&(+p[0]!==127||host==='127.0.0.1');}
const specs={parameters:[5,19],reset:[6,6],start:[7,0],stop:[8,0],end:[24,0],status:[3,4],clockRead:[14,0],clockSet:[13,6],configuration:[18,0],identity:[26,1],blockFetch:[9,3],sampleRead:[15,2],samplePrepare:[16,2],sampleApply:[17,5]};
function encodeCameraCommand(o){
 if(!o||Object.keys(o).sort().join(',')!=='marker,operation,sequence,words'||!uint(o.marker)||!uint(o.sequence)||!Object.hasOwn(specs,o.operation))throw new TypeError('Explicit command fields required');
 const [selector,n]=specs[o.operation];if(!Array.isArray(o.words)||o.words.length!==n||!Array.from(o.words).every(uint))throw new TypeError('Invalid command words');
 if(o.operation==='clockSet'&&[1,2,4,5].some(i=>o.words[i]>0xffffff))throw new TypeError('Clock chunks must fit24');
 const b=Buffer.alloc(16+n*4);[o.marker,o.sequence,0x30000+selector,n,...o.words].forEach((x,i)=>b.writeUInt32LE(x,i*4));return b;
}
function createCameraSession(options){
 if(!options||!options.profile)throw new TypeError('Explicit options required');
 const {transport,nowMs,timeoutMs,clockMaxAgeMs,maxQueuedBlocks}=options,p=structuredClone(options.profile);
 if(!transport||!['exchange','openStream','close'].every(k=>typeof transport[k]==='function')||typeof nowMs!=='function'||!integer(timeoutMs,1,2147483647)||!integer(clockMaxAgeMs,1,60000)||!integer(maxQueuedBlocks,1,1024)||!uint(options.sequenceStart)||!uint(options.statusSubIdStart))throw new TypeError('Invalid session options');
 if(p.id!=='host13-ec8l'||!str(p.cameraKey)||!hostOK(p.address)||p.port!==41925||!uint(p.marker)||p.modelClass!==3||!integer(p.clockOrigin,1,2147483647)||!str(p.epochId)||typeof p.queueEpochTrusted!=='boolean'||!uint(p.expectedBlockIndex)||!uint(p.statusFlags)||!uint(p.displayState)||!['fresh','continue'].includes(p.history))throw new TypeError('Invalid profile');
 encodeCameraCommand({marker:p.marker,sequence:0,operation:'parameters',words:p.parameters});encodeCameraCommand({marker:p.marker,sequence:0,operation:'reset',words:p.reset});
 if(Boolean(p.reset[0]&2)!==(p.mode==='alignment')||((p.reset[0]>>>2)&63)<3||((p.reset[0]>>>2)&63)>7||((p.reset[0]&256)!==0)!==(p.history==='continue')||(p.history==='fresh'&&p.expectedBlockIndex!==1))throw new TypeError('Incompatible history/reset');
 // Reuse the decoder's configuration validation without admitting any evidence.
 decodeStartStatus(Buffer.alloc(0),{profile:'ec8l-status21',requestMarker:p.marker,sequence:0,statusSubId:0,cameraKey:p.cameraKey,clockOrigin:p.clockOrigin,tickScale:8,sources:p.sources,wired:p.wired,expectedAddress:p.address,expectedPort:p.port,peerAddress:p.address,peerPort:p.port});
 let sequence=options.sequenceStart,generation=options.statusSubIdStart,state='bound',busy=false,closed=false,invalid=false,frozen=false,live=false,initialized=false,clockReady=false,anchor=null,lastNow=-1,lastCurrent=null,pending=null,accepted=null,stream=null,nextIndex=p.expectedBlockIndex;
 let raceIds=new Set(),journal=createRaceStartJournal(),historicalJournal=null,queue=[],decoder=createStreamDecoder(),acks={},acquisitionObserved=false,issues=[],lastOutcome=null;
 let epoch=0;
 const guard=token=>{if(closed)throw Object.assign(fail('ERR_SESSION_CLOSED'),{contextRevoked:true});if(invalid||frozen||token!==epoch)throw Object.assign(fail('ERR_SESSION_INVALID'),{contextRevoked:true});};
 // Each completed operation releases its cancellation handler. A long-lived
 // unresolved Promise.race would retain one reaction for every status poll.
 const waiters=new Set();
 const wait=promise=>new Promise((resolve,reject)=>{const cancel=error=>{waiters.delete(cancel);reject(error);};waiters.add(cancel);Promise.resolve(promise).then(value=>{waiters.delete(cancel);resolve(value);},error=>{waiters.delete(cancel);reject(error);});});
 const disarm=()=>journal.disarm();
 const journalSnapshot=()=>({...journal.getHistory(),races:[...raceIds].map(id=>journal.getRace(id))});
 function invalidate(reason){epoch++;invalid=true;clockReady=false;live=false;disarm();issues.push(reason);}
 function now(){const n=nowMs();if(!Number.isFinite(n)||n<0||n<lastNow){invalidate('InvalidMonotonicClock');throw fail('ERR_SESSION_CLOCK');}lastNow=n;return n;}
 function remote(retry=false){if(closed||invalid||frozen)throw fail('ERR_SESSION_INVALID');if(pending&&!retry)throw fail('ERR_STATUS_PENDING');now();guard(epoch);}
 async function serial(fn){if(busy)throw fail('ERR_SESSION_BUSY');busy=true;try{return await fn();}finally{busy=false;}}
 function allocate(){if(sequence>0xffffffff)throw fail('ERR_SEQUENCE_EXHAUSTED');return sequence++;}
 async function exchange(operation,words,kind='mutation',subId){
  remote(kind==='status');const token=epoch,seq=allocate(),packet=encodeCameraCommand({marker:p.marker,sequence:seq,operation,words});
  const check=o=>{try{const r=decodeControlReply(o.bytes,{peerAddress:o.peerAddress,peerPort:o.peerPort,expectedAddress:p.address,expectedPort:p.port,requestMarker:p.marker,sequence:seq});if(r.decision!=='accepted')return null;if(kind==='status'&&(r.count!==21||r.payload[0]!==subId))return null;return r;}catch{return null;}};
  try{const observation=await wait(transport.exchange(packet,{timeoutMs,accept:o=>Boolean(check(o))}));const r=check(observation);if(!r)throw fail('ERR_REPLY_CORRELATION');const expected=kind==='status'?21:r.success?({clock:3,identity:8,sample:4}[kind]||0):0;if(r.count!==expected)throw fail('ERR_REPLY_SHAPE');lastOutcome={operation,outcome:'matchedReply',success:r.success};if(!r.success)throw Object.assign(fail('ERR_CAMERA_FAILURE'),{matched:true});const bytes=Buffer.from(observation.bytes);guard(token);return {reply:r,bytes,seq};}
  catch(e){if(!e.matched&&!e.contextRevoked){lastOutcome={operation,outcome:e.definitelyNotSent===true?'definitelyNotSent':'unknownAfterPossibleSend',error:e.code||e.message};if(kind==='mutation'&&!e.definitelyNotSent){frozen=true;invalidate('UnknownMutation');}}
   if(kind==='mutation'&&e.matched){frozen=true;invalidate(operation==='parameters'?'profileUnknown':'InitializationOrMutationFailure');}throw e;}
 }
 async function clock(){remote();const token=epoch,sent=now();guard(token);try{const {reply:r}=await exchange('clockRead',[],'clock');guard(token);const received=now();guard(token);const [origin,lo,hi]=r.payload,full=BigInt(lo)+(BigInt(hi)<<24n);if(received-sent>clockMaxAgeMs||origin!==p.clockOrigin||lo>0xffffff||hi>0xffffff||5n*full>=274877906944n||(anchor&&full<anchor.fullClock128k))throw fail('ERR_CLOCK_AMBIGUOUS');anchor={sent,fullClock128k:full,lower:Number((5n*full/64n)>0n?5n*full/64n-1n:0n)};clockReady=true;return structuredClone(anchor);}catch(e){invalidate('CounterEpochAmbiguous');throw e;}}
 function acceptBody(body){const inspection=inspectReceivedBlock(body,{expectedIndex:nextIndex});if(inspection.decision!=='matched-index')throw fail('ERR_BLOCK_INDEX');if(queue.length>=maxQueuedBlocks)throw fail('ERR_BLOCK_OVERFLOW');queue.push({body:Buffer.from(body),inspection});nextIndex=inspection.nextIndex;acquisitionObserved=true;if(inspection.wrapUnverified)throw fail('ERR_BLOCK_WRAP');}
 function onData(data){if(closed||invalid)return;try{for(const body of decoder.push(Buffer.from(data)))acceptBody(body);}catch(e){invalidate(e.code||'StreamFraming');}}
 function onEnd(){if(closed||invalid)return;try{decoder.finish();invalidate('TransportDisconnected');}catch(e){invalidate(e.code||'IncompleteFrame');}}
 async function status(retry=false){remote(retry);const token=epoch,priorPending=pending;if(!initialized||!clockReady)throw fail('ERR_SESSION_NOT_READY');
  let context;
  if(retry){context=pending||accepted;if(!context)throw fail('ERR_NO_STATUS_RETRY');}
  else{if(pending)throw fail('ERR_STATUS_PENDING');if(generation>0xffffffff)throw fail('ERR_STATUS_EXHAUSTED');if(!anchor||now()-anchor.sent>clockMaxAgeMs)await clock();guard(token);context={generation,sent:now(),anchor:structuredClone(anchor)};guard(token);}
  pending=context;
  let result;try{result=await exchange('status',[context.generation,0,p.statusFlags,p.displayState],'status',context.generation);}catch(e){if(e.definitelyNotSent===true&&!priorPending)pending=null;throw e;}
  guard(token);const admission=now();guard(token);const fingerprint=Buffer.concat([result.bytes.subarray(0,4),result.bytes.subarray(8)]).toString('hex');
  const stale=admission-context.sent>clockMaxAgeMs||admission-context.anchor.sent>clockMaxAgeMs;
  if(accepted&&context.generation===accepted.generation){pending=null;if(fingerprint!==accepted.fingerprint){invalidate('ConflictingStatusGeneration');throw fail('ERR_STATUS_CONFLICT');}if(stale)invalidate('ExpiredCachedStatus');return {decision:'replay',ambiguous:stale,generation:context.generation};}
  const decoded=decodeStartStatus(result.bytes,{profile:'ec8l-status21',requestMarker:p.marker,sequence:result.seq,statusSubId:context.generation,cameraKey:p.cameraKey,clockOrigin:p.clockOrigin,tickScale:8,sources:p.sources,wired:p.wired,expectedAddress:p.address,expectedPort:p.port,peerAddress:p.address,peerPort:p.port});
  const current=decoded.diagnostics.currentTimeRaw;
  const ambiguous=stale||current<context.anchor.lower||(lastCurrent!==null&&current<lastCurrent)||(decoded.candidate&&decoded.candidate.eventTimestampRaw>current);
  if(ambiguous)invalidate('CounterEpochAmbiguous');
  lastCurrent=current;accepted={...context,fingerprint,decoded:structuredClone(decoded)};pending=null;generation=context.generation+1;
  if(decoded.candidate){if(ambiguous||!p.queueEpochTrusted)disarm();decoded.receipt=journal.record(decoded.candidate);}
  return {...decoded,ambiguous:Boolean(ambiguous),fresh:true,currentTimeRaw:current,logicalSendMs:context.sent,anchorSendMs:context.anchor.sent};
 }
 async function mutation(op,allowed,target){remote();const token=epoch;if(state===target)return {decision:'already-acknowledged'};if(!allowed.includes(state)||!live||!clockReady)throw fail('ERR_SESSION_NOT_READY');await exchange(op,[]);acks[op]=true;guard(token);state=target;return {decision:'acknowledged',captureComplete:false};}
 async function raw(operation,words,accept){remote();const token=epoch,seq=allocate(),packet=encodeCameraCommand({marker:p.marker,sequence:seq,operation,words});const selected=o=>Boolean(o&&o.peerAddress===p.address&&o.peerPort===p.port&&o.bytes instanceof Uint8Array&&accept(Buffer.from(o.bytes),seq));const observation=await wait(transport.exchange(packet,{timeoutMs,accept:selected}));guard(token);if(!selected(observation))throw fail('ERR_REPLY_CORRELATION');return Buffer.from(observation.bytes);}
 async function fetchBlock(chunkBytes){remote();if(!initialized||!live||p.delivery!=='udp')throw fail('ERR_SESSION_NOT_READY');if(!integer(chunkBytes,8,16000)||chunkBytes%8)throw new TypeError('Chunk size must be an eight-byte multiple');if(queue.length>=maxQueuedBlocks)throw fail('ERR_BLOCK_OVERFLOW');const high=accepted?.decoded?.diagnostics?.highestPackagedBlock;if(high==null||high<nextIndex)return {decision:'unavailable',reason:'no-packaged-block'};const target=nextIndex,body=Buffer.alloc(16000);for(let offset=0;offset<16000;){const count=Math.min(chunkBytes,16000-offset);const reply=await raw('blockFetch',[target,offset,count],(bytes,seq)=>bytes.length===count+4&&bytes.readUInt32LE(0)===seq&&(offset+count!==16000||bytes.readUInt32LE(count-4)===target));reply.copy(body,offset,4);offset+=count;}try{acceptBody(body);}catch(e){invalidate(e.code||'BlockAdmission');throw e;}return {decision:'received',index:target,bytes:16000,captureComplete:false};}
 async function sendSample(operation,words){remote();const token=epoch;if(typeof transport.sendDatagram!=='function')throw fail('ERR_TRANSPORT_SEND_UNSUPPORTED');const seq=allocate(),packet=encodeCameraCommand({marker:p.marker,sequence:seq,operation,words});await wait(transport.sendDatagram(packet,{timeoutMs}));guard(token);return {localCompletion:true,applicationAcknowledged:false};}
 function snapshot(){return structuredClone({state,closed,busy,invalid,frozen,live,initialized,clockReady,clockAnchor:anchor,clockOrigin:p.clockOrigin,epochId:p.epochId,identity:'supplied-not-independently-observed',queueEpochTrusted:p.queueEpochTrusted,synchronization:'unconfirmed',delivery:p.delivery||'tcp',mode:p.mode||'capture',nextExpectedBlockIndex:nextIndex,nextSequence:sequence,nextStatusGeneration:generation,pendingStatus:pending,acceptedStatus:accepted,acknowledgments:acks,acquisitionObserved,captureComplete:false,queuedBlocks:queue.length,streamFraming:decoder.snapshot(),issues,lastOutcome,journal:journalSnapshot(),historicalJournal});}
 return {
 prepare:()=>serial(async()=>{remote();const token=epoch;if(state!=='bound')throw fail('ERR_SESSION_STATE');state='preparing';await clock();guard(token);await exchange('parameters',p.parameters);guard(token);await exchange('reset',p.reset);guard(token);initialized=true;if(p.delivery==='udp'){live=true;state='ready';return snapshot();}try{stream=await wait(Promise.resolve(transport.openStream({host:p.address,port:p.port,timeoutMs,onData,onEnd,onError:e=>invalidate(e.code||'TransportError')})).then(s=>{if(closed)s.close();return s;}));guard(token);await wait(stream.write(encodeStreamStart({marker:p.marker,blockIndex:nextIndex})));guard(token);live=true;state='ready';return snapshot();}catch(e){invalidate('StreamSetupFailed');throw e;}}),
 start:()=>serial(()=>mutation('start',['ready','stop-request-acknowledged'],'start-request-acknowledged')),
 stop:()=>serial(()=>mutation('stop',['ready','start-request-acknowledged'],'stop-request-acknowledged')),
 end:()=>serial(()=>mutation('end',['ready','start-request-acknowledged','stop-request-acknowledged'],'end-acknowledged')),
 readConfiguration:()=>serial(()=>raw('configuration',[],bytes=>bytes.length===1024)),
 readIdentity:()=>serial(async()=>{const {reply}=await exchange('identity',[1],'identity');return {words:reply.payload,identityConfirmed:false,runtimeConfirmed:false};}),
 fetchNextBlock:({chunkBytes=1024}={})=>serial(()=>fetchBlock(chunkBytes)),
 readSyncSample:({origin,generation}={})=>serial(async()=>{const {reply}=await exchange('sampleRead',[origin,generation],'sample');if(reply.payload[0]!==origin||reply.payload[1]!==generation||reply.payload[2]>0xffffff||reply.payload[3]>0xffffff)throw fail('ERR_REPLY_SHAPE');return {origin,generation,clock128k:BigInt(reply.payload[2])+(BigInt(reply.payload[3])<<24n),freshness:'unconfirmed'};}),
 prepareSyncSample:({origin,generation}={})=>serial(()=>sendSample('samplePrepare',[origin,generation])),
 applySyncSample:({origin,generation,clock128k,referenceDescriptor}={})=>serial(()=>{if(typeof clock128k!=='bigint'||clock128k<0n||clock128k>0xffffffffffffn)throw new TypeError('Explicit 48-bit sample required');return sendSample('sampleApply',[origin,generation,Number(clock128k&0xffffffn),Number(clock128k>>24n),referenceDescriptor]);}),
 pollStatus:()=>serial(()=>status()),retryStatus:()=>serial(()=>status(true)),refreshClock:()=>serial(()=>clock()),
 armRace:o=>serial(async()=>{remote();const token=epoch;disarm();if(!o||!str(o.raceId)||!str(o.sourceKey))throw new TypeError('Explicit race/source');if(!live||!clockReady||!p.queueEpochTrusted)throw fail('ERR_ARM_UNSUPPORTED');const r=await status();guard(token);if(!r.fresh||r.ambiguous||r.currentTimeRaw<=0||now()-r.logicalSendMs>clockMaxAgeMs||now()-r.anchorSendMs>clockMaxAgeMs){invalidate('ArmClockAmbiguous');throw fail('ERR_ARM_AMBIGUOUS');}guard(token);const boundary={ticks:BigInt(r.currentTimeRaw)*8n,quantum:8n,origin:p.clockOrigin};journal.arm({...o,cameraKey:p.cameraKey,origin:p.clockOrigin,clockBoundary:boundary});raceIds.add(o.raceId);return {boundary,queueEpochTrusted:'supplied'};}),
 elapsed:o=>{if(invalid||closed||pending||!live||!clockReady)return {decision:'unavailable',reason:'session-invalid'};const token=epoch,age=now()-anchor.sent;if(invalid||closed||token!==epoch)return {decision:'unavailable',reason:'session-invalid'};if(age>clockMaxAgeMs){disarm();return {decision:'unavailable',reason:'clock-stale'};}return journal.elapsed(o);},
 setClockRaw:words=>{encodeCameraCommand({marker:p.marker,sequence:0,operation:'clockSet',words});return serial(async()=>{remote();epoch++;const token=epoch;historicalJournal=journalSnapshot();journal=createRaceStartJournal();raceIds=new Set();disarm();clockReady=false;pending=null;accepted=null;try{await exchange('clockSet',words);acks.clockSet=true;guard(token);state='needs-explicit-clock-rebind';}finally{invalidate('ClockRebindRequired');}});},
 readBlocks:()=>{const delivered=queue.map(x=>({body:Buffer.from(x.body),inspection:structuredClone(x.inspection)}));queue=[];return delivered;},snapshot,
 close:async()=>{if(closed)return;closed=true;invalidate('Closed');state='closed';for(const cancel of [...waiters])cancel(fail('ERR_SESSION_CLOSED'));const results=await Promise.allSettled([Promise.resolve().then(()=>stream?.close()),Promise.resolve().then(()=>transport.close())]);return results;}
 };
}
module.exports={encodeCameraCommand,createCameraSession,hostOK};
