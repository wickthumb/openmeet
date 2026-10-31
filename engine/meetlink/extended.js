import {meetDataProtocol} from '../integrations/index.js';
import {windHeader} from '../integrations/weather.js';
export function selectSplitSource({configured=0,lapOwnerUsable=false,totalLap={numerator:0,denominator:1},tableCount=0}={}){
  if(configured!==0)return [1,2,3].includes(configured)?configured:1;
  if(lapOwnerUsable&&BigInt(totalLap.denominator)>0n&&BigInt(totalLap.numerator)>0n)return 1;return tableCount>1?2:1;
}
export function projectSplits({mask,lap=[],multi=[],formatTime,subtract}={}){
  if(![1,2,3].includes(mask)||typeof formatTime!=='function'||typeof subtract!=='function')throw new TypeError('Resolved split mask and exact time providers required');
  const fields=[];
  if(mask&1)fields.push(lap.map(item=>item==null?'':`${formatTime(item.cumulative)} (${formatTime(item.interval)})`).join(','));
  if(mask&2){let previous=null;fields.push(multi.map(item=>{
    if(item==null||item.eligible===false)return '';const current=item.time,delta=previous==null||BigInt(previous.quantum)===0n?current:subtract(current,previous);previous=structuredClone(current);return `${formatTime(current)} (${formatTime(delta)})`;
  }).join(','));}return fields;
}
export function compatibilityFields(fields,{terminator='\n'}={}){
  if(!['\n','\r','\r\n',''].includes(terminator)||!fields.every(v=>typeof v==='string'))throw new TypeError('Logical text fields and explicit terminator required');
  return fields.map(value=>value.includes(',')?'"'+value+'"':value).join(',')+terminator;
}
export function projectExtendedResult({identity,time,license='',delta='',reaction='',splitFields,start='',user1='',user2='',user3='',delta2='',delta3='',speed='',pace='',extraFields=null}){
  if(!Array.isArray(identity)||identity.length!==6||!Array.isArray(splitFields)||![1,2].includes(splitFields.length))throw new TypeError('Six identity fields and resolved split fields required');
  const cutoff=extraFields==null||extraFields<0?12:Math.min(12,extraFields);if(!Number.isInteger(cutoff))throw new TypeError('Integer cutoff required');
  const concepts=[[time],[license],[delta],[reaction],splitFields,[start],[user1],[user2],[user3],[delta2],[delta3],[speed],[pace]];
  const fields=[...identity,...concepts.slice(0,cutoff+1).flat()];if(!fields.every(v=>typeof v==='string'))throw new TypeError('Explicit formatted result fields required');return fields;
}
export function projectExtendedHeader({identifiers,name,weather,weatherOptions={},contextRationalText='',firstStartText='',contextPresent=true}){
  if(!contextPresent)return null;if(!Array.isArray(identifiers)||identifiers.length!==3||!identifiers.every(v=>typeof v==='string'))throw new TypeError('Three identifiers required');
  const wind=windHeader(weather,weatherOptions);return [...(identifiers.every(Boolean)?identifiers:['0','0','0']),name,wind.wind,wind.description,'','','',contextRationalText,firstStartText];
}
// The arithmetic remains the exact tuple implementation, including its origin rules.
export function projectExtendedExchange({header=null,rows,formatOptions,terminator='\r\n'}){
  const formatTime=tuple=>meetDataProtocol.time.appendTime({...formatOptions,tuple}).text;
  const subtract=(left,right)=>meetDataProtocol.time.tupleSubtract({a:left,b:right}).tuple;
  const fields=rows.map(row=>projectExtendedResult({...row,splitFields:row.splitFields??projectSplits({...row.splits,formatTime,subtract})}));
  return {header:header?projectExtendedHeader(header):null,rows:fields,text:[...(header?[projectExtendedHeader(header)]:[]),...fields].filter(Boolean).map(row=>compatibilityFields(row,{terminator})).join('')};
}
