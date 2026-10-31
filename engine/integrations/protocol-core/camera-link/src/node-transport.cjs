'use strict';
const {hostOK}=require('./session.cjs');
const error=code=>Object.assign(new Error(code),{code});
function createNodeCameraTransport(o){
 if(!o||!hostOK(o.host)||o.port!==41925||o.localAddress!=null&&!hostOK(o.localAddress))throw new TypeError('Explicit IPv4 unicast and port41925 required');
 const {host,port,localAddress}=o,uf=o.udpSocketFactory||(()=>require('node:dgram').createSocket('udp4')),tf=o.tcpSocketFactory||(()=>new (require('node:net').Socket)()),timers=o.timers||{setTimeout,clearTimeout};
 if(typeof uf!=='function'||typeof tf!=='function'||typeof timers.setTimeout!=='function'||typeof timers.clearTimeout!=='function')throw new TypeError('Invalid factories/timers');
 let closed=false,udp=null,pending=null;const resources=new Set();
 function validate(timeoutMs){if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw new TypeError('Invalid deadline');if(closed)throw error('ERR_TRANSPORT_CLOSED');}
 function socket(){if(udp)return udp;udp=uf();udp.on('message',(bytes,rinfo)=>{if(!pending)return;let observation;try{observation={bytes:Buffer.from(bytes),peerAddress:rinfo.address,peerPort:rinfo.port};if(!pending.accept(observation))return;}catch{return;}pending.finish(null,observation);});udp.on('error',e=>{if(pending)pending.finish(e);});udp.on('close',()=>{if(pending)pending.finish(error('ERR_UDP_CLOSED'));});if(localAddress)udp.bind(0,localAddress);return udp;}
 return {
 sendDatagram(packet,{timeoutMs}={}){validate(timeoutMs);if(!(packet instanceof Uint8Array))throw new TypeError('Packet bytes required');if(pending)return Promise.reject(error('ERR_TRANSPORT_BUSY'));return new Promise((resolve,reject)=>{let deadline;const entry={finish(e){if(pending!==entry)return;pending=null;timers.clearTimeout(deadline);e?reject(e):resolve({localCompletion:true,applicationAcknowledged:false});}};pending=entry;deadline=timers.setTimeout(()=>entry.finish(error('ERR_TRANSPORT_TIMEOUT')),timeoutMs);try{socket().send(Buffer.from(packet),port,host,e=>entry.finish(e));}catch(e){entry.finish(e);}});},
 exchange(packet,{timeoutMs,accept}={}){validate(timeoutMs);if(typeof accept!=='function'||!(packet instanceof Uint8Array))throw new TypeError('Explicit packet and accept required');if(pending)return Promise.reject(error('ERR_TRANSPORT_BUSY'));const copied=Buffer.from(packet);return new Promise((resolve,reject)=>{let deadline;const entry={accept,finish(e,v){if(pending!==entry)return;pending=null;timers.clearTimeout(deadline);e?reject(e):resolve(v);}};pending=entry;deadline=timers.setTimeout(()=>entry.finish(error('ERR_TRANSPORT_TIMEOUT')),timeoutMs);try{socket().send(copied,port,host,e=>{if(e)entry.finish(e);});}catch(e){entry.finish(e);}});},
 openStream({host:target,port:targetPort,timeoutMs,onData,onEnd,onError}={}){validate(timeoutMs);if(target!==host||targetPort!==port||![onData,onEnd,onError].every(f=>typeof f==='function'))throw new TypeError('Explicit matching stream peer and callbacks required');return new Promise((resolve,reject)=>{
  let s,deadline,connected=false,finished=false,notified=false;const writes=new Set();
  const entry={close(){terminate(error('ERR_TCP_CLOSED'));}};resources.add(entry);
  function notify(e){if(notified)return;notified=true;try{e?onError(e):onEnd();}catch{}}
  function terminate(e,cleanEnd=false){if(finished)return;finished=true;timers.clearTimeout(deadline);resources.delete(entry);if(!connected)reject(e||error('ERR_TCP_CLOSED'));for(const w of [...writes])w(e||error('ERR_TCP_CLOSED'));notify(cleanEnd?null:e||error('ERR_TCP_CLOSED'));if(s)s.destroy();}
  try{s=tf();s.on('data',b=>{if(!finished)onData(Buffer.from(b));});s.on('end',()=>terminate(null,true));s.on('error',e=>terminate(e));s.on('close',()=>terminate(error('ERR_TCP_CLOSED')));s.on('connect',()=>{if(finished)return;connected=true;timers.clearTimeout(deadline);resolve({write(bytes){if(!(bytes instanceof Uint8Array))return Promise.reject(new TypeError('Buffer required'));if(finished||closed)return Promise.reject(error('ERR_TCP_CLOSED'));const copied=Buffer.from(bytes);return new Promise((res,rej)=>{let done=false;const complete=e=>{if(done)return;done=true;writes.delete(complete);if(e){rej(e);terminate(e);}else res();};writes.add(complete);try{s.write(copied,complete);}catch(e){complete(e);}});},close:()=>entry.close()});});deadline=timers.setTimeout(()=>terminate(error('ERR_CONNECT_TIMEOUT')),timeoutMs);if(localAddress)s.connect({port,host,localAddress});else s.connect(port,host);}catch(e){terminate(e);}
 });},
 close(){if(closed)return;closed=true;if(pending)pending.finish(error('ERR_TRANSPORT_CLOSED'));for(const r of [...resources])r.close();if(udp){try{udp.close();}catch{}}}
 };
}
module.exports={createNodeCameraTransport};
