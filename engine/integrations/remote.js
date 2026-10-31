import net from 'node:net';
import {parseTimePrefix} from '../timing/value-format.js';
export const REMOTE_MARKER=0x1f9b32f5;
const bounded=(n,max)=>Number.isInteger(n)&&n>=0&&n<=max;
export function remotePacket(type,payload=Buffer.alloc(0),auxiliary=0){
  payload=Buffer.from(payload);if(!bounded(type,65535)||!bounded(auxiliary,65535)||payload.length>16*1024*1024)throw new RangeError('Invalid remote packet');
  const b=Buffer.alloc(12+payload.length);b.writeUInt32LE(REMOTE_MARKER);b.writeUInt32LE(b.length,4);b.writeUInt16LE(type,8);b.writeUInt16LE(auxiliary,10);payload.copy(b,12);return b;
}
export function createRemotePacketReader({capacity=1024*1024}={}){
  if(!bounded(capacity,16*1024*1024)||capacity<12)throw new RangeError('Invalid receive capacity');const buffer=Buffer.alloc(capacity);let used=0,target=8;
  return {push(input){const packets=[];let offset=0;while(offset<input.length){
    const n=Math.min(target-used,input.length-offset);Buffer.from(input.buffer,input.byteOffset+offset,n).copy(buffer,used);used+=n;offset+=n;
    if(used<target)continue;
    if(target===8){const size=buffer.readUInt32LE(4);
      if(buffer.readUInt32LE(0)!==REMOTE_MARKER||size<12||size>capacity){const first=buffer.subarray(0,used).indexOf(0xf5,1),length=first<0?0:used-first;if(length>0&&length<=7)buffer.copy(buffer,0,first,used);used=length<=7?length:0;target=8;continue;}target=size;
    }
    if(used===target){packets.push({type:buffer.readUInt16LE(8),auxiliary:buffer.readUInt16LE(10),payload:Buffer.from(buffer.subarray(12,used))});used=0;target=8;}
  }return packets;},snapshot:()=>({pendingBytes:used}),reset(){used=0;target=8;}};
}

export function countedRemoteString(text){
  if(typeof text!=='string'||text.length>65535)throw new RangeError('Bounded UTF16 string required');const b=Buffer.alloc(2+text.length*2);b.writeUInt16LE(text.length);for(let i=0;i<text.length;i++)b.writeUInt16LE(text.charCodeAt(i),2+2*i);return b;
}
export function readCountedRemoteString(input,offset=0){
  const b=Buffer.from(input);if(offset+2>b.length)return {text:'',consumed:0};const n=Math.min(b.readUInt16LE(offset),Math.floor((b.length-offset-2)/2));let text='';for(let i=0;i<n;i++)text+=String.fromCharCode(b.readUInt16LE(offset+2+2*i));return {text,consumed:2+2*n};
}
export function remoteStem(text){const leaf=text.slice(text.lastIndexOf('\\')+1),dot=leaf.lastIndexOf('.');return dot>=0&&leaf.length-dot-1<=3?leaf.slice(0,dot):leaf;}
export function remoteMicroseconds(time){if(!time||BigInt(time.quantum)<=0n)return 0n;const v=BigInt(time.ticks);if(v<-(1n<<47n)||v>=(1n<<47n))throw new RangeError('Signed48 time required');return (v*25n)>>1n;}
export function createBinaryRemoteSession({capacity=1024*1024,identity='OpenMeet',provider=()=>null,seek=null,onResponse=()=>{}}={}){
  if(!bounded(capacity,16*1024*1024)||capacity<1028)throw new RangeError('Bounded send capacity required');
  let enabled=false,format=3,sampleSkip=0,frameSkip=0,cursor=-1,time=null,generation=null,queued=Buffer.alloc(0),sent=0;
  const queue=packet=>{if(queued.length+packet.length>capacity)return false;queued=Buffer.concat([queued,packet]);return true;};
  const state=()=>({enabled,format,sampleSkip,frameSkip,cursor,time:structuredClone(time),generation,queuedBytes:queued.length,sentBytes:sent});
  function image(){
    const p=provider();if(!p?.image)return false;const im=p.image,count=im.disabled?0:im.count;
    if(!bounded(count,0x7fffffff)||!bounded(im.width,65535))throw new RangeError('Invalid remote image geometry');
    if(generation!==im.generation){if(time&&BigInt(time.quantum)>0n&&seek){const index=seek(time,p);if(bounded(index,count-1))cursor=index;}generation=im.generation;}
    if(cursor>=count)cursor=count-1;const next=cursor+frameSkip+1;if(next>=count)return false;
    const width=Math.floor(im.width/(sampleSkip+1)),total=28+width*format;if(total>capacity-queued.length-1000)return false;
    cursor=next;time=structuredClone(im.timeAt(next));const payload=Buffer.alloc(total-12);payload.writeBigInt64LE(remoteMicroseconds(time));payload.writeUInt16LE(format,8);payload.writeUInt16LE(sampleSkip,10);payload.writeUInt16LE(frameSkip,12);payload.writeUInt16LE(width,14);
    if(width){const pixels=im.pixelsAt(next);if(!pixels)return false;if(pixels.length<im.width*4)throw new RangeError('Remote column too short');
      let at=16;for(let x=sampleSkip;x<im.width;x+=sampleSkip+1){const b=pixels[x*4],g=pixels[x*4+1],r=pixels[x*4+2];
        if(format===1)payload[at++]=Math.floor((b+g+r)/3);else if(format===2){payload.writeUInt16LE((b>>3)|((g>>3)<<5)|((r>>3)<<10),at);at+=2;}else{payload[at++]=b;payload[at++]=g;payload[at++]=r;if(format===4)payload[at++]=0;}}
    }return queue(remotePacket(10,payload));
  }
  return {
    receive({type,payload}){
      payload=Buffer.from(payload);const p=provider();
      if([2,4,6,8,10,12].includes(type)){onResponse({type,payload});return;}
      if(type===1&&payload.length>=2&&payload.readUInt16LE(0)!==0)queue(remotePacket(2,Buffer.concat([Buffer.of(1,0),countedRemoteString(identity)])));
      else if(type===3){const fields=p?.event?[(p.event.stem??remoteStem(p.event.path??'')),...p.event.identifiers,p.event.description,p.image?.ownerText??'',p.image?.text??'']:[];if(fields.length&&fields.length!==7)throw new TypeError('Seven event metadata strings required');queue(remotePacket(4,Buffer.concat(fields.map(countedRemoteString))));}
      else if(type===5){const b=Buffer.alloc(8);b.writeBigInt64LE(remoteMicroseconds(p?.event?.primaryStart));queue(remotePacket(6,b));}
      else if(type===7){
        let flags=0;if(payload.length>=2){flags=payload.readUInt16LE(0);enabled=Boolean(flags&1);if(flags&2){cursor=-1;time=null;}}
        if(payload.length>=4){const f=payload.readUInt16LE(2)&15;if(f>=1&&f<=4)format=f;}if(payload.length>=6)sampleSkip=payload.readUInt16LE(4);if(payload.length>=8)frameSkip=payload.readUInt16LE(6);
        if((flags&8)&&payload.length>=16&&p?.image){if(!seek)throw new Error('Explicit remote seek provider required');const index=seek({microseconds:String(payload.readBigInt64LE(8))},p);if(bounded(index,p.image.count-1)){cursor=index-1;time=index===0?null:structuredClone(p.image.timeAt(index-1));}}
        const b=Buffer.alloc(8);b.writeUInt16LE((enabled?1:0)|(cursor===-1?2:0)|(p?.image?.pointerPresent?4:0));b.writeUInt16LE(format,2);b.writeUInt16LE(sampleSkip,4);b.writeUInt16LE(frameSkip,6);queue(remotePacket(8,b));
      }else if(type===9)image();
      else if(type===11){const b=Buffer.alloc(16),s=p?.extendedStatus;if(p?.event&&!s)throw new Error('Explicit extended status attributes required');b.writeUInt16LE(s?.flags??0);b.writeUInt16LE(s?.imageAttribute??0,2);b.writeInt32LE(p?.event?cursor:-1,4);b.writeInt32LE(s?.count??0,8);b.writeUInt32LE(s?.lastAttribute??0,12);queue(remotePacket(12,b));}
    },
    poll({budget=100}={}){if(!bounded(budget,1000))throw new RangeError('Invalid image budget');let produced=0;if(enabled)while(produced<budget&&image())produced++;return {produced,...state()};},
    pending:()=>Buffer.from(queued.subarray(sent)),
    consume(n){if(!bounded(n,queued.length-sent))throw new RangeError('Invalid sent byte count');sent+=n;if(sent===queued.length){queued=Buffer.alloc(0);sent=0;}return state();},
    reset({rebind=false}={}){cursor=-1;time=null;generation=null;if(rebind){queued=Buffer.alloc(0);sent=0;}},snapshot:state,
  };
}

const whitespace=c=>/[\t-\r \u00a0\u2000-\u200b\u2028\u2029\u3000\ufeff]/.test(c);
export function remoteFields(text,delimiter=';'){
  const fields=[];let start=0;
  while(start<=text.length){let end=text.indexOf(delimiter,start);if(end<0)end=text.length;
    let open=start;while(open<text.length&&whitespace(text[open]))open++;let quoted=false;
    if(text[open]==='"'){let close=text.indexOf('"',open+1);while(close>=0){let after=close+1;while(after<text.length&&whitespace(text[after]))after++;if(after===text.length||text[after]===delimiter){fields.push(text.slice(open+1,close));end=after;quoted=true;break;}close=text.indexOf('"',close+1);}}
    if(!quoted)fields.push(text.slice(start,end));if(end===text.length)break;start=end+1;
  }return fields;
}

export function remoteLookup(text,name,component=-1){
  for(const field of remoteFields(text)){if(field.slice(0,name.length).toLowerCase()===name.toLowerCase()&&field[name.length]==='='){
    const value=field.slice(name.length+1);if(component<0)return {present:true,value};const values=remoteFields(value,',');return component<values.length?{present:true,value:values[component]}:{present:false};
  }}return {present:false};
}
export function remoteReply(pairs){return pairs.map(([name,value])=>{const p=name+'='+value;return (String(value).includes(';')?'"'+p+'"':p)+';';}).join('')+'\r\n';}
export async function dispatchRemoteStart(request,{sourceTag,append,trigger,auxiliary=null,alreadyReplied=false}){
  if(alreadyReplied)return {handled:false,reason:'already-replied'};
  const parsed=name=>{const field=remoteLookup(request,name,0);return field.present?parseTimePrefix(field.value):{valid:false};};
  const time=parsed('Time'),offset=parsed('Offset'),key=remoteLookup(request,'Key').value?.trim()||null;
  const secondary=offset.valid?{...offset.tuple,quantum:'1'}:null;
  if(time.valid){
    const first=await sourceTag();if(!Number.isInteger(first)||first<=0)return {handled:true,reply:'Error',appended:false};
    const second=await sourceTag();if(!Number.isInteger(second)||second<-2147483648||second>2147483647)throw new RangeError('Signed source origin required');
    await append({primary:{...time.tuple,origin:String(second)},secondary:secondary??{ticks:'0',quantum:'1',origin:'-1'},kind:6,key});
    return {handled:true,reply:'Ok',appended:true,physicalPulseConfirmed:false};
  }
  const dispatched=await trigger({offset:secondary,key});if(auxiliary)await auxiliary({offset:secondary});
  return {handled:true,reply:'Ok',appended:false,triggerDispatched:Boolean(dispatched),physicalPulseConfirmed:false};
}
export function createTextRemoteSession({dispatch=()=>[],capacity=65536}={}){
  if(!bounded(capacity,16*1024*1024)||capacity<1)throw new RangeError('Invalid text remote capacity');
  let current='',history='',transmit=true,primary=null,pendingComplement=null,paired=false,busy=false,input=Buffer.alloc(0),inputAt=0;
  function normalize(byte){
    if(pendingComplement!=null){const pending=pendingComplement;pendingComplement=null;if(byte===pending){paired=true;return null;}}
    if(primary==null&&(byte===13||byte===10)){primary=byte;pendingComplement=byte===13?10:13;return 10;}
    if(byte===primary){if(paired)pendingComplement=byte===13?10:13;return 10;}return byte;
  }
  return {push(bytes){if(input.length-inputAt+bytes.length>capacity)throw new RangeError('Remote input capacity exhausted');input=Buffer.concat([input.subarray(inputAt),Buffer.from(bytes)]);inputAt=0;},
    async poll(){if(busy)return {busy:true};busy=true;let echo='';try{
      while(inputAt<input.length){const unit=normalize(input[inputAt++]);if(unit==null)continue;if(unit===19){transmit=false;continue;}if(unit===17){transmit=true;continue;}
        if(transmit)echo+=unit===10?'\r\n':String.fromCharCode(unit);
        if(unit!==10){if(current.length>=capacity)throw new RangeError('Remote request capacity exhausted');current+=String.fromCharCode(unit);continue;}
        const request=current||history;const pairs=await dispatch(request,remoteLookup);const reply=remoteReply(pairs?.length?pairs:[['Reply','Unknown']]);history=request;current='';return {completed:true,request,output:Buffer.from(echo+(transmit?reply:''),'latin1'),deliveryEstablished:false};
      }return {completed:false,output:Buffer.from(echo,'latin1')};
    }finally{busy=false;if(inputAt){input=Buffer.from(input.subarray(inputAt));inputAt=0;}}},reset(){current=history='';input=Buffer.alloc(0);inputAt=0;},snapshot:()=>({current,history,transmit,queuedBytes:input.length-inputAt})};
}

// Servers are inert until explicitly opened; each connection owns its parser/state.
export function createRemoteServerService({textDispatch,binaryProvider,binarySeek,onEvent=()=>{}}={}){
  const servers=new Map();let closed=false;
  return {
    async listen({id,host='127.0.0.1',port=0,kind='text',capacity=1048576,maxClients=4,context={}}){
      if(!bounded(capacity,16*1024*1024)||capacity<1028)throw new RangeError('Invalid remote listener capacity');
      if(closed||servers.has(id)||typeof id!=='string'||!id||!net.isIP(host)||!bounded(port,65535)||!['text','binary'].includes(kind)||!bounded(maxClients,16)||maxClients<1)throw new TypeError('Explicit remote listener profile required');
      const clients=new Set(),server=net.createServer(socket=>{
        if(clients.size>=maxClients){socket.destroy();return;}clients.add(socket);let dead=false,chain=Promise.resolve(),timer=null,ticking=false;
        let owned;try{owned=kind==='binary'?binaryProvider(context):null;}catch(error){onEvent('remote.error',{id,message:error.message});clients.delete(socket);socket.destroy();return;}
        const session=kind==='text'?createTextRemoteSession({dispatch:request=>textDispatch(request,context),capacity}):createBinaryRemoteSession({capacity,provider:owned?.provider??(()=>null),seek:owned?.seek??binarySeek});
        const parser=kind==='binary'?createRemotePacketReader({capacity}):null;
        const write=bytes=>new Promise((resolve,reject)=>{if(!bytes.length)return resolve();let done=false;const finish=error=>{if(done)return;done=true;clearTimeout(deadline);socket.off('close',cancel);error?reject(error):resolve();},cancel=()=>finish(Error('Remote connection closed')),deadline=setTimeout(()=>{finish(Error('Remote write timeout'));socket.destroy();},2000);socket.once('close',cancel);socket.write(bytes,finish);});
        const run=fn=>{chain=chain.then(async()=>{if(dead)return;await fn();}).catch(error=>{onEvent('remote.error',{id,message:error.message});socket.destroy();});};
        socket.on('data',bytes=>{if(dead)return;socket.pause();run(async()=>{if(kind==='text'){session.push(bytes);while(session.snapshot().queuedBytes){const result=await session.poll();await write(result.output);if(!result.completed)break;}}else{for(const packet of parser.push(bytes))session.receive(packet);const output=session.pending();await write(output);session.consume(output.length);}if(!dead)socket.resume();});});
        if(kind==='binary'){timer=setInterval(()=>{if(ticking)return;ticking=true;run(async()=>{try{session.poll({budget:10});const output=session.pending();await write(output);session.consume(output.length);}finally{ticking=false;}});},100);timer.unref();}
        socket.on('error',()=>{});socket.on('close',()=>{dead=true;clearInterval(timer);owned?.close?.();clients.delete(socket);});
      });
      const entry={server,clients,kind,host,port};servers.set(id,entry);
      server.on('error',error=>onEvent('remote.error',{id,message:error.message}));
      try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});if(closed||!servers.has(id))throw Error('Remote listener closed');return {id,kind,address:server.address()};}catch(error){servers.delete(id);try{server.close();}catch{}throw error;}
    },
    list:()=>[...servers].map(([id,e])=>({id,kind:e.kind,address:e.server.address(),clients:e.clients.size})),
    async close({id}){const e=servers.get(id);if(!e)return {id,closed:true};servers.delete(id);for(const socket of e.clients)socket.destroy();await new Promise(resolve=>e.server.close(resolve));return {id,closed:true};},
    async closeAll(){closed=true;await Promise.allSettled([...servers.keys()].map(id=>this.close({id})));},
  };
}
