import dgram from 'node:dgram';
import { networkCameraProtocol as wire } from '../integrations/index.js';

const fail=(code,message=code)=>Object.assign(new Error(message),{code});
const unsigned=v=>Number.isInteger(v)&&v>=0&&v<=0xffffffff;
const nonnegative=value=>{const n=BigInt(value);if(n<0n)throw new RangeError('Nonnegative clock quantity required');return n;};
export const microsecondsToCameraClock=value=>(nonnegative(value)*10000n+39062n)/78125n;
export const cameraClockToMicroseconds=value=>(nonnegative(value)*78125n+5000n)/10000n;
export function interpolateCameraClock({ticks,origin,baseMs,nowMs,offsetMs=0}){
  if(!Number.isInteger(origin)||origin<=0||![baseMs,nowMs,offsetMs].every(Number.isSafeInteger))throw new TypeError('Exact clock anchor and millisecond domain required');
  const delta=(nowMs-baseMs)|0,answer=BigInt(ticks)+BigInt(delta+offsetMs)*80n;
  if(answer<-(1n<<47n)||answer>=(1n<<47n))throw new RangeError('Clock interpolation exceeds signed48');
  return {ticks:answer,quantum:80n,origin};
}

export function broadcastAddress(address,mask){
  const parse=v=>{if(typeof v!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(v))throw new TypeError('Dotted IPv4 required');const p=v.split('.').map(Number);if(p.some(x=>x>255))throw new RangeError('IPv4 octet');return p.reduce((n,x)=>((n<<8)|x)>>>0,0);};
  const a=parse(address),m=parse(mask),inverse=(~m)>>>0;
  if(!wire.hostOK(address)||((inverse+1)&inverse)!==0||inverse===0||m===0)throw new RangeError('Explicit interface address and contiguous subnet mask required');
  const b=(a|inverse)>>>0;return [24,16,8,0].map(shift=>(b>>>shift)&255).join('.');
}

export function createClockGroupSender({interfaceAddress,subnetMask,marker,timeoutMs=1000}, {socketFactory=()=>dgram.createSocket('udp4')}={}){
  const destination=broadcastAddress(interfaceAddress,subnetMask);
  wire.encodeCameraCommand({marker,sequence:0,operation:'samplePrepare',words:[1,0]});
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw new RangeError('Invalid group send deadline');
  let socket=null,ready=null,closed=false,pending=new Set();
  async function bind(){
    if(closed)throw fail('ERR_CLOCK_GROUP_CLOSED');
    if(!ready)ready=new Promise((resolve,reject)=>{
      socket=socketFactory();
      const deadline=setTimeout(()=>{reject(fail('ERR_CLOCK_GROUP_TIMEOUT'));try{socket.close();}catch{}},timeoutMs);
      const finish=error=>{clearTimeout(deadline);error?reject(error):resolve();};
      socket.on('error',error=>{finish(error);for(const cancel of [...pending])cancel(error);});
      socket.on('close',()=>{finish(fail('ERR_CLOCK_GROUP_CLOSED'));for(const cancel of [...pending])cancel(fail('ERR_CLOCK_GROUP_CLOSED'));});
      try{socket.bind(0,interfaceAddress,()=>{try{socket.setBroadcast(true);finish();}catch(error){finish(error);}});}catch(error){finish(error);}
    });
    await ready;
  }
  return {
    async send(operation,words){
      const packet=wire.encodeCameraCommand({marker,sequence:0,operation,words});
      await bind();if(closed)throw fail('ERR_CLOCK_GROUP_CLOSED');
      await new Promise((resolve,reject)=>{
        const finish=error=>{clearTimeout(deadline);pending.delete(finish);error?reject(error):resolve();};
        const deadline=setTimeout(()=>finish(fail('ERR_CLOCK_GROUP_TIMEOUT')),timeoutMs);pending.add(finish);
        try{socket.send(packet,41925,destination,finish);}catch(error){finish(error);}
      });
      return {localCompletion:true,applicationAcknowledged:false,destination};
    },
    close(){closed=true;for(const cancel of [...pending])cancel(fail('ERR_CLOCK_GROUP_CLOSED'));try{socket?.close();}catch{}},
  };
}

export async function synchronizeCameraGroup({origin,generation,members,prepare,query,apply}){
  if(!unsigned(origin)||origin===0||!unsigned(generation)||!Array.isArray(members)||members.length<2||
      ![prepare,query,apply].every(fn=>typeof fn==='function'))throw new TypeError('Explicit origin/generation, members and transport callbacks required');
  const eligible=members.filter(member=>member.clockCapable===true);
  const preferred=eligible.find(member=>member.externalSyncEnabled===true),candidates=preferred?[preferred]:eligible;
  if(!candidates.length)throw fail('ERR_CLOCK_NO_REFERENCE');
  const observations=[];
  await prepare({origin,generation});
  let failures=0,reference=null,sample=null;
  for(const member of candidates){
    do{
      try{
        sample=await query(member,{origin,generation});
        if(sample.origin!==origin||sample.generation!==generation||BigInt(sample.clock128k)<0n||BigInt(sample.clock128k)>0xffffffffffffn)throw fail('ERR_CLOCK_SAMPLE');
        reference=member;break;
      }catch(error){observations.push({id:member.id,error:error.code||error.message});failures++;}
    }while(failures<3);
    if(reference)break;
  }
  if(!reference)throw Object.assign(fail('ERR_CLOCK_REFERENCE_FAILED'),{observations});
  if(!unsigned(reference.referenceDescriptor))throw new TypeError('Reference descriptor required');
  const delivery=await apply({origin,generation,clock128k:BigInt(sample.clock128k),referenceDescriptor:reference.referenceDescriptor});
  return {origin,generation,referenceId:reference.id,referenceReason:preferred?'external-sync-first':'first-accepted-in-order',
    clock128k:String(sample.clock128k),observations,delivery,physicalAgreementConfirmed:false,
    memberApplicationConfirmed:false,sampleFreshnessConfirmed:false};
}
