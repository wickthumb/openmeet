import fs from 'node:fs';
import path from 'node:path';
// Direct bounded reads avoid loading a growing capture's full timestamp vector per poll.
export function createCaptureRemoteProvider({dir,event=null,clockOrigin,quantum='1',invalidColumns=new Set(),extendedStatus=null}){
  if(!Number.isInteger(clockOrigin)||clockOrigin<=0||BigInt(quantum)<=0n)throw new TypeError('Explicit capture clock required');
  const metadata=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8')),rows=metadata.rows,channels=metadata.channels;
  if(!Number.isInteger(rows)||rows<1||rows>65535||![1,3,4].includes(channels))throw new RangeError('Unsupported remote capture shape');
  const columns=fs.openSync(path.join(dir,'columns.bin'),'r');let times;try{times=fs.openSync(path.join(dir,'times.f64'),'r');}catch(error){fs.closeSync(columns);throw error;}
  let closed=false;
  const count=()=>Math.min(Math.floor(fs.fstatSync(columns).size/(rows*channels)),Math.floor(fs.fstatSync(times).size/8));
  const timeAt=index=>{if(!Number.isInteger(index)||index<0||index>=count())throw new RangeError('Remote time index out of range');const b=Buffer.alloc(8);if(fs.readSync(times,b,0,8,index*8)!==8)throw Error('Capture timestamp was truncated');return {ticks:String(Math.round(b.readDoubleLE()*80000)),quantum:invalidColumns.has(index)?'0':String(quantum),origin:String(clockOrigin)};};
  return {
    provider(){if(closed)throw Error('Remote capture closed');const n=count();return {event:structuredClone(event),extendedStatus:extendedStatus&&{...extendedStatus,count:n},image:{width:rows,count:n,generation:0,pointerPresent:true,ownerText:'',text:metadata.model??'',
      timeAt,pixelsAt(index){if(index>=count())return null;const source=Buffer.alloc(rows*channels);if(fs.readSync(columns,source,0,source.length,index*source.length)!==source.length)return null;const out=Buffer.alloc(rows*4);for(let y=0;y<rows;y++){out[y*4]=source[y*channels+(channels===1?0:2)];out[y*4+1]=source[y*channels+(channels===1?0:1)];out[y*4+2]=source[y*channels];}return out;}}};},
    // Explicit replacement policy: first column at or after the requested time.
    seek(value){const target=value.microseconds!=null?BigInt(value.microseconds)*2n/25n:BigInt(value.ticks);let lo=0,hi=count();while(lo<hi){const mid=Math.floor((lo+hi)/2);if(BigInt(timeAt(mid).ticks)<target)lo=mid+1;else hi=mid;}return lo<count()?lo:-1;},
    close(){if(closed)return;closed=true;fs.closeSync(columns);fs.closeSync(times);},
  };
}
