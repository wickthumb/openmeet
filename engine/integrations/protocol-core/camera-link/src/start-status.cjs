'use strict';
const {decodeControlReply}=require('./index.cjs');
const int=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
const u=v=>int(v,0,0xffffffff);
const s=v=>int(v,-2147483648,2147483647);
const str=v=>typeof v==='string'&&v.length>0;
function decodeStartStatus(input,o){
 if(!o||o.profile!=='ec8l-status21'||!u(o.requestMarker)||!u(o.sequence)||!u(o.statusSubId)||!str(o.cameraKey)||!s(o.clockOrigin)||o.clockOrigin<=0||o.tickScale!==8||!Array.isArray(o.sources))throw new TypeError('Explicit status options required');
 const ids=new Set();
 for(const r of o.sources){if(!r||!int(r.id,0,2047)||ids.has(r.id)||typeof r.enabled!=='boolean'||!['start','photoeye','none'].includes(r.mode)||!s(r.offsetMs))throw new TypeError('Invalid source');ids.add(r.id);}
 if(!o.wired||typeof o.wired.enabled!=='boolean'||!s(o.wired.offsetMs))throw new TypeError('Invalid wired configuration');
 const reply=decodeControlReply(input,o);
 if(reply.decision!=='accepted')return reply;
 if(!reply.success)return {decision:'failure',reason:'camera-failure'};
 if(reply.count!==21)return {decision:'reject',reason:'status-shape'};
 const p=reply.payload;
 if(p[0]!==o.statusSubId)return {decision:'ignore',reason:'status-sub-id'};
 const d=p[3],family=d>>>28,subtype=(d>>>24)&15;
 const diagnostics={statusSubId:p[0],identityRaw:p[1],currentTimeRaw:p[2],descriptorRaw:d,eventTimestampRaw:p[4],highestPackagedBlock:p[5],statusFlags:p[6],blocksAvailable:p[7],eventAuxRaw:p[6]>>>24,moreBlocks:Boolean(p[6]&1),family,subtype};
 if(family===1)Object.assign(diagnostics,{sourceId:d&2047,number:(d>>>12)&1023,auxiliaryTypeBits:(d>>>22)&3});
 const result=(decision,reason)=>({decision,reason,diagnostics});
 if(d===0)return result('none','no-event');
 let config,kind,sourceKey,number=0;
 if(d===1){config=o.wired;if(!config.enabled)return result('event','wired-disabled');kind=0;sourceKey='wired';}
 else if(family===1&&subtype===1){const id=d&2047;config=o.sources.find(r=>r.id===id);if(!config)return result('event','unknown-source');if(!config.enabled)return result('event','source-disabled');if(config.mode!=='start')return result('event','not-start-mode');kind=2;sourceKey='radio:'+id;number=(d>>>12)&1023;}
 else return result('event','non-start');
 return {...result('candidate','start'),candidate:{cameraKey:o.cameraKey,sourceKey,kind,number,key:number?String(number):'',eventTimestampRaw:p[4],descriptorRaw:d,eventAuxRaw:p[6]>>>24,statusSubId:p[0],primary:{ticks:BigInt(p[4])*8n,quantum:8n,origin:o.clockOrigin},secondary:{ticks:BigInt(config.offsetMs)*80n,quantum:1n,origin:-1},provenance:'supplied/caller-mapped'}};
}
module.exports={decodeStartStatus};
