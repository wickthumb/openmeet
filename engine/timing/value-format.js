import {meetDataProtocol} from '../integrations/index.js';
const api=meetDataProtocol.time;
export function parseTimePrefix(text,{origin='-1',minus='-',separator=':',fraction='.'}={}){
  if(typeof text!=='string'||/[^\x00-\x7f]/.test(text)||[minus,separator,fraction].some(c=>typeof c!=='string'||c.length!==1))throw new TypeError('ASCII time and resolved punctuation required');
  let at=0,negative=false,components=[],digits='';const invalid=()=>({valid:false,tuple:{ticks:'0',quantum:'0',origin:String(origin)},cursor:at,remaining:text.slice(at)});
  if(text[at]===minus){negative=true;at++;}
  if(text[at]!==fraction){for(let i=0;i<4;i++){const match=/^-?\d+/.exec(text.slice(at));if(!match)return invalid();components.push(BigInt(match[0]));at+=match[0].length;if(i===3||text[at]!==separator)break;at++;}}
  if(text[at]===fraction){at++;const match=/^\d*/.exec(text.slice(at))[0];digits=match.slice(0,4);at+=match.length;}
  if(!components.length&&!digits.length)return invalid();
  const weights=[80000n,4800000n,288000000n,6912000000n];let ticks=BigInt(digits.padEnd(4,'0'))*8n;components.reverse().forEach((n,i)=>ticks+=n*weights[i]);if(negative)ticks=-ticks;
  if(ticks<-(1n<<47n)||ticks>=(1n<<47n))throw new RangeError('Time prefix exceeds signed48');let quantum=80000n/10n**BigInt(digits.length);
  if(text[at]?.toLowerCase()==='a'){quantum=80n;at++;}else if(text[at]?.toLowerCase()==='m'){quantum=8000n;at++;}
  return {valid:true,tuple:{ticks:String(ticks),quantum:String(quantum),origin:String(origin)},cursor:at,remaining:text.slice(at)};
}
const rational=value=>{if(!value)return 0;const d=Number(value.denominator),n=Number(value.numerator);if(!Number.isInteger(d)||d<1||d>2147483647||!Number.isInteger(n)||n<-2147483648||n>2147483647)throw new RangeError('Bounded rational required');return n/d;};
function milliseconds(time,roundMethod){if(!time||BigInt(time.quantum)<=0n)return null;const q=BigInt(time.quantum)>80n?BigInt(time.quantum):80n,m=BigInt(api.quantize({ticks:time.ticks,quantum:String(q),mode:roundMethod}))/80n;if(m<-2147483648n||m>2147483647n)throw new RangeError('Millisecond conversion exceeds signed32');return Number(m);}
export function speedValue({distance,mode=0,direct=null,selected=null,total=null,covered=null,unit=0,roundMethod='Up'}){
  const d=rational(distance);if(d<=0)return null;let value=0,m=mode===0?milliseconds(direct,roundMethod):null;
  if(m!=null){const elapsed=m*.001;if(elapsed>0)value=d/elapsed;}
  else if([0,1,2].includes(mode)&&rational(total)>0){m=milliseconds(selected,roundMethod);if(m!=null&&m*.001>0){const a=rational(covered)*d;value=(a/rational(total))/(m*.001);}}
  if(!(value>0))return null;if(unit===3||unit===0&&value<.1)value*=3600;else if(unit===2)value*=60;return {value,arithmetic:'binary64',nativeRoundingEquivalent:false};
}
export function paceValue({distance,target,total,covered,direct=null,cumulative=null,roundMethod='Up'}){
  let d=rational(distance),a=rational(target);const n=rational(total);if(!(d>0&&a>0)){if(n<=0)return null;d=n;a=1;}
  let m=milliseconds(direct,roundMethod),value;
  if(m!=null){const p=a*m;value=p/d;}
  else{m=milliseconds(cumulative,roundMethod);if(m==null||n<=0)return null;const p=rational(covered)*d,extent=p/n;if(!(extent>0))return null;value=a*m/extent;}
  if(!(value>0))return null;const z=Math.trunc(value);if(z>2147483647)throw new RangeError('Pace conversion exceeds signed32');return {tuple:{ticks:String(80*z),quantum:'80',origin:'-1'},arithmetic:'binary64',nativeRoundingEquivalent:false};
}
export function deltaValue({main,reference=null,precision='800',representation=0,unitTicks='80000',digits=1,roundMethod='Up',formatOptions={}}){
  if(!main||BigInt(main.quantum)<=0n||reference&&BigInt(reference.quantum)<=0n)return '';
  if(representation===0){const p=BigInt(precision);if(p<=0n)throw new RangeError('Positive row precision required');const q=t=>BigInt(api.quantize({ticks:t.ticks,quantum:String(BigInt(t.quantum)>p?BigInt(t.quantum):p),mode:roundMethod}));
    const ticks=q(main)-(reference?q(reference):0n);return api.appendTime({prefix:'',characters:{minus:'-',day:':',hour:':',minute:':',fraction:'.'},H:'0',L:'0',callbackSelection:null,RoundMethod:roundMethod==='Down'?'1':roundMethod==='Round'?'2':'0',...formatOptions,requestedPrecision:String(p),tuple:{ticks:String(ticks),quantum:String(p),origin:'-1'}}).text;}
  if(!reference)return '';const gap=BigInt(main.ticks)-BigInt(reference.ticks),u=BigInt(unitTicks);if(u<=0n)throw new RangeError('Positive unit scale required');
  if(representation===1){const y=gap+u/8n,a=y/u,b=4n*(y-a*u)/u;return (a>0n?String(a):'')+(a>0n&&b>0n?' ':'')+(b>0n?(b===2n?'1/2':b+'/4'):'');}
  if(representation===2){const count=[0,1,2,3].includes(digits)?digits:1,d=10n**BigInt(count),y=gap+u/(2n*d),a=y/u,b=(y-a*u)*d/u;const fraction=String(b);return String(a)+(count?'.'+(b<0n?'-'+fraction.slice(1).padStart(Math.max(0,count-1),'0'):fraction.padStart(count,'0')):'');}return '';
}
