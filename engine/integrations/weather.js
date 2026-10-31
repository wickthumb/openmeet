import {readEventArchive,writeEventArchive} from './archive.js';
export const MISSING_WEATHER=-2147483648;
const integer=value=>{if(!Number.isInteger(value)||value<-2147483648||value>2147483647)throw new RangeError('Signed weather integer required');return value;};
const accepted=unit=>[0,1,2].includes(unit);
export function createWeather({millisecondsOfDay=0,mode=0,delay=0,duration=10000}={}){
  if(!Number.isInteger(millisecondsOfDay)||millisecondsOfDay<0||millisecondsOfDay>=86400000)throw new RangeError('Local milliseconds of day required');
  if(![0,1,2,3,4,5].includes(mode)){mode=0;delay=0;duration=10000;}
  else if([2,3].includes(mode)){duration=10000;if(mode===2)delay=0;}
  else if([4,5].includes(mode)){duration=13000;delay=0;}else if(mode===0)delay=0;
  return {primary:0,secondary:MISSING_WEATHER,unit:-1,time:{version:0x20001,ticks:String(millisecondsOfDay*80),quantum:'80',origin:-1},mode,delay:integer(delay),duration:integer(duration),weather:Array(14).fill(MISSING_WEATHER)};
}
export function resetWeather(state){return {...structuredClone(state),secondary:MISSING_WEATHER,unit:-1};}
export function copyWeather(target,source){return {...structuredClone(target),...Object.fromEntries(['primary','secondary','unit','time','weather'].map(k=>[k,structuredClone(source[k])]))};}
export function formatWind(state){
  if(!accepted(state.unit))return '';integer(state.primary);const q=Math.ceil(state.primary/10),a=Math.abs(q);return `${q<0?'-':'+'}${Math.floor(a/10)}.${a%10}`;
}
export function windDescription(state,{units=['MPH','F/S','M/S'],directionMode=0,directions=[]}={}){
  if(!accepted(state.unit))return '';let text=units[state.unit];if(typeof text!=='string')throw new TypeError('Resolved wind unit required');
  const d=state.weather[10];if(d===MISSING_WEATHER||!directionMode)return text;
  if(!Number.isInteger(d)||d<0||d>359)throw new RangeError('Direction outside ordinary profile');
  if(directionMode===360)return text+' '+d;
  const index=directionMode===16?Math.floor(2*((d+11)%360)/45):directionMode===4?4*Math.floor(((d+45)%360)/90):directionMode===2?8*Math.floor(((d+90)%360)/180):2*Math.floor(((d+22)%360)/45);
  if(typeof directions[index]==='string')text+=' '+directions[index];return text;
}
export function windHeader(state,{flags=0,suffix='',weatherMask=0,...resources}={}){
  let text=formatWind(state);if((flags&16)&&suffix)text+=' '+suffix;
  if(state.weather.some(v=>v!==MISSING_WEATHER))for(let i=0;i<14;i++)if((weatherMask>>>i)&1)text+=','+(state.weather[i]===MISSING_WEATHER?'':integer(state.weather[i]));
  return {wind:text,description:windDescription(state,resources)};
}
export function parseWind(text,{unit=-1,units=['MPH','F/S','M/S'],cursor=0}={}){
  if(typeof text!=='string'||/[^\x00-\x7f]/.test(text))throw new TypeError('ASCII wind input required');
  let at=cursor,outer=1,whole=0,fraction=0,success=false;
  if(text[at]==='-'){outer=-1;at++;}
  const match=/^[+-]?\d+/.exec(text.slice(at));if(match){whole=Number(match[0]);at+=match[0].length;success=true;}
  if(text[at]==='.'){at++;const digits=/^\d*/.exec(text.slice(at))[0];fraction=Number(digits.slice(0,2).padEnd(2,'0'));at+=digits.length;success=true;}
  if(!success)return {accepted:false,cursor:at,remaining:text.slice(at)};
  const primary=integer(outer*(100*whole+fraction));
  if(!accepted(unit)){while(/[\t-\r ]/.test(text[at]??'\0'))at++;unit=units.findIndex(value=>text.slice(at).toLowerCase()===value.toLowerCase());if(unit<0)return {accepted:false,cursor:at,remaining:text.slice(at)};at+=units[unit].length;}
  return {accepted:true,primary,unit,cursor:at,remaining:text.slice(at),notifications:[5,6]};
}
export function weatherDirection(state,{atan2}={}){
  if(!accepted(state.unit)||state.secondary===MISSING_WEATHER)return MISSING_WEATHER;
  if(typeof atan2!=='function')throw Object.assign(new Error('Explicit angular arithmetic provider required'),{code:'ERR_WEATHER_ANGLE_PROVIDER'});
  const x=integer(state.primary)*0.01,y=integer(state.secondary)*0.01;if(x===0&&y===0)return 0;
  const angle=atan2(y,x);if(!Number.isFinite(angle)||Math.abs(angle)>Math.PI)throw new RangeError('Invalid angular provider result');
  const q=Math.trunc(angle*(8063664102005665*2**-47)),n=-q;return n>=0?Math.min(n,180):Math.max(n+360,180);
}
export function decodeWeatherPacket(input,{millisecondsOfDay=0}={}){
  const b=Buffer.from(input);if(b.length!==39)throw new RangeError('Resolved weather payload must be 39 bytes');const state=createWeather({millisecondsOfDay});
  const mapping=[[2,'i16',32767,v=>v],[5,'i16',32767,v=>v],[11,'u8',255,v=>10*(v-90)],[12,'u8',255,v=>10*(v-90)],[4,'u8',255,v=>v],[26,'u8',255,v=>v],[27,'u8',255,v=>v],[28,'u8',255,v=>v],[7,'u8',255,v=>100*v],[8,'u8',255,v=>100*v],[9,'i16',32767,v=>v],[0,'u16',0,v=>v],[36,'u8',255,v=>v],[37,'i16',32767,v=>v]];
  state.weather=mapping.map(([at,type,missing,convert])=>{const value=type==='i16'?b.readInt16LE(at):type==='u16'?b.readUInt16LE(at):b[at];return value===missing?MISSING_WEATHER:convert(value);});state.primary=100*b[7];state.unit=0;return state;
}
function swapWeatherBytes(input){const b=Buffer.from(input);for(let at=0;at<b.length;){const n=at>=16&&at<28?2:4;b.subarray(at,at+n).reverse();at+=n;}return b;}
export function serializeWeather(state,{version=0x20005,swap=false}={}){
  if(!Number.isInteger(version)||version<0x20002||version>0x20005)throw new RangeError('Unsupported weather version');
  const b=Buffer.alloc(version===0x20002?12:version===0x20003?44:version===0x20004?100:104);let at=0;
  const word=v=>{b.writeInt32LE(integer(v),at);at+=4;};word(version);word(state.primary);word(state.unit);
  if(version>=0x20003){writeEventArchive(state.time,{family:'TIME'}).copy(b,at);at+=20;word(state.mode);word(state.delay);word(state.duration);}
  if(version>=0x20004){if(state.weather.length!==14)throw new RangeError('Fourteen weather slots required');for(const v of state.weather)word(v);}if(version===0x20005)word(state.secondary);return swap?swapWeatherBytes(b):b;
}
export function deserializeWeather(input,previous=createWeather(),{swap=false}={}){
  const b=swap?swapWeatherBytes(input):Buffer.from(input);if(b.length<4)throw new RangeError('Truncated weather');const v=b.readUInt32LE(0),size={131074:12,131075:44,131076:100,131077:104}[v];if(!size||b.length!==size)throw new RangeError('Unsupported weather extent');
  const state=structuredClone(previous);state.primary=b.readInt32LE(4);state.unit=b.readInt32LE(8);
  if(v>=0x20003){state.time=readEventArchive(b.subarray(12,32),{family:'TIME'});state.mode=b.readInt32LE(32);state.delay=b.readInt32LE(36);state.duration=b.readInt32LE(40);}if(v>=0x20004)state.weather=Array.from({length:14},(_,i)=>b.readInt32LE(44+4*i));if(v===0x20005)state.secondary=b.readInt32LE(100);return state;
}
export function createWeatherAcquisition({clock=()=>Date.now(),atan2,historyLimit=110}={}){
  if(!Number.isInteger(historyLimit)||historyLimit<1||historyLimit>110)throw new RangeError('Invalid weather history limit');
  let staged={delay:-1,duration:-1,pending:false},start=-1,command=-1,stop=-1,duration=0,count=-1,sumX=0,sumY=0;const history=[];
  return {
    stage({delay,duration}){staged={delay:integer(delay),duration:integer(duration),pending:false};},signal(){staged.pending=true;},
    request({delay,duration:requested,ready,type=9,lockout=0}){if(!ready||stop!==-1&&lockout!==0&&!(lockout===1&&[1,4,6,9].includes(type)))return false;duration=Math.max(0,Math.min(99000,integer(requested)));start=clock()+integer(delay);command=stop=-1;return true;},
    sample({primary,secondary=null}){if(stop===-1||count<0||primary==null)return false;sumX=integer(sumX+integer(primary));if(secondary!=null)sumY=integer(sumY+integer(secondary));count++;return true;},
    poll({ready=true,type=9,lockout=0,millisecondsOfDay=0}={}){
      if(staged.pending){if(staged.delay!==-1&&staged.duration!==-1)this.request({...staged,ready,type,lockout});staged={delay:-1,duration:-1,pending:false};}
      const now=clock();if(start!==-1&&now>=start){start=-1;command=now;return {phase:'start-due'};}
      if(command!==-1&&now>=command){command=-1;count=0;sumX=sumY=0;stop=now+Math.max(duration,2000);return {phase:'sampling',stop};}
      if(stop!==-1&&now>=stop){stop=-1;let reading=null;if(count>0){reading=createWeather({millisecondsOfDay});reading.primary=Math.trunc(sumX/count);reading.secondary=Math.trunc(sumY/count);reading.unit=2;reading.weather[10]=weatherDirection(reading,{atan2});history.push(reading);if(history.length>historyLimit)history.shift();}count=-1;return {phase:'complete',reading:structuredClone(reading)};}return {phase:'waiting'};
    },
    cancel(){start=command=stop=-1;count=-1;},snapshot:()=>({staged:{...staged},start,command,stop,count,sumX,sumY,history:structuredClone(history)}),
  };
}
