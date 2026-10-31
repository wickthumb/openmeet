'use strict';
const MIN=-140737488355328n,MAX=140737488355327n;
const clone=v=>structuredClone(v);
const str=v=>typeof v==='string'&&v.length>0;
const int=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
function bounded(v){if(v<MIN||v>MAX)throw new RangeError('signed48 arithmetic overflow');return v;}
function time(t){if(!t||typeof t.ticks!=='bigint'||t.ticks<MIN||t.ticks>MAX||typeof t.quantum!=='bigint'||t.quantum<=0n||t.quantum>MAX||!int(t.origin,-2147483648,2147483647))throw new TypeError('Invalid TIME');}
function candidate(c){
 if(!c||!str(c.cameraKey)||!str(c.sourceKey)||![0,2].includes(c.kind)||!int(c.number,0,1023)||typeof c.key!=='string'||!int(c.eventTimestampRaw,0,0xffffffff)||!int(c.descriptorRaw,0,0xffffffff)||!int(c.eventAuxRaw,0,255)||!int(c.statusSubId,0,0xffffffff))throw new TypeError('Invalid candidate');
 time(c.primary);time(c.secondary);
 if(c.primary.origin<=0||c.primary.quantum!==8n||c.primary.ticks!==BigInt(c.eventTimestampRaw)*8n||c.secondary.quantum!==1n||c.secondary.origin!==-1||c.secondary.ticks%80n!==0n||c.secondary.ticks/80n < -2147483648n||c.secondary.ticks/80n>2147483647n)throw new TypeError('Invalid candidate time mapping');
 const d=c.descriptorRaw;
 if(c.kind===0?(d!==1||c.sourceKey!=='wired'||c.number!==0||c.key!==''):((d>>>28)!==1||((d>>>24)&15)!==1||c.sourceKey!=='radio:'+(d&2047)||c.number!==((d>>>12)&1023)||c.key!==(c.number?String(c.number):'')))throw new TypeError('Invalid candidate descriptor');
}
function createRaceStartJournal({historyLimit=125}={}){
 if(!int(historyLimit,1,125))throw new TypeError('Invalid historyLimit');
 const races=new Map(),history=[];let armed=null,nextOrdinal=0;
 function getRace(id){if(!str(id))throw new TypeError('Invalid raceId');const r=races.get(id);return r?clone({...r,armed:armed===id}):null;}
 return {
 arm(o){if(!o||!str(o.raceId)||!str(o.cameraKey)||!str(o.sourceKey)||!int(o.origin,1,2147483647))throw new TypeError('Invalid arm');if(o.clockBoundary!=null){time(o.clockBoundary);if(o.clockBoundary.origin!==o.origin)throw new TypeError('Boundary origin mismatch');}
 const pending={cameraKey:o.cameraKey,sourceKey:o.sourceKey,origin:o.origin,clockBoundary:o.clockBoundary==null?null:clone(o.clockBoundary),tailOrdinal:nextOrdinal};
 const old=races.get(o.raceId);races.set(o.raceId,{raceId:o.raceId,start:old?old.start:null,pending});armed=o.raceId;return getRace(o.raceId);},
 disarm(){armed=null;},getRace,
 getHistory(){return clone({records:history,nextOrdinal,oldestRetainedOrdinal:history.length?history[0].ordinal:nextOrdinal});},
 record(c){candidate(c);if(nextOrdinal>=Number.MAX_SAFE_INTEGER)throw new RangeError('Ordinal exhausted');const copy=clone(c),ordinal=nextOrdinal;let reason='unarmed',boundRaceId=null;
 const r=armed===null?null:races.get(armed);
 if(r){const p=r.pending;if(ordinal<p.tailOrdinal)reason='before-arm-tail';else if(c.cameraKey!==p.cameraKey)reason='camera-mismatch';else if(c.sourceKey!==p.sourceKey)reason='source-mismatch';else if(c.primary.origin!==p.origin)reason='origin-mismatch';else if(!p.clockBoundary)reason='arm-clock-boundary-unavailable';else if(c.primary.ticks<p.clockBoundary.ticks)reason='pre-arm-event';else if(c.primary.ticks===p.clockBoundary.ticks)reason='arm-boundary-ambiguous';else {reason='bound';boundRaceId=armed;}}
 const receipt={ordinal,boundRaceId,reason};
 if(boundRaceId!==null){r.start={primary:clone(copy.primary),secondary:clone(copy.secondary),cameraKey:copy.cameraKey,sourceKey:copy.sourceKey,key:copy.key,kind:copy.kind,ordinal};armed=null;}
 history.push({ordinal,candidate:copy,...receipt});nextOrdinal++;if(history.length>historyLimit)history.shift();return {...receipt};},
 elapsed(o){if(!o||!str(o.raceId))throw new TypeError('Invalid elapsed options');time(o.measurement);const g=o.groupOffsetTicks===undefined?0n:o.groupOffsetTicks;if(typeof g!=='bigint')throw new TypeError('Invalid group offset');bounded(g);const r=races.get(o.raceId);if(!r||!r.start)return {decision:'unavailable',reason:'no-start'};const s=r.start,m=o.measurement;if(m.origin!==s.primary.origin)return {decision:'unavailable',reason:'origin-mismatch'};return {decision:'elapsed',time:{ticks:bounded(m.ticks-s.primary.ticks+s.secondary.ticks+g),quantum:m.quantum>s.primary.quantum?m.quantum:s.primary.quantum,origin:m.origin}};}
 };
}
module.exports={createRaceStartJournal};
