import net from 'node:net';
import {scoreboardWireProtocol} from '../integrations/index.js';
const fail=code=>Object.assign(new Error(code),{code});
export function createScoreboardServerOutput({host,port,peerAddress,capacity=32767,writeTimeoutMs=2000}){
  if(net.isIP(host)!==4||net.isIP(peerAddress)!==4||!Number.isInteger(port)||port<1||port>65535||!Number.isInteger(capacity)||capacity<1||capacity>1048576||!Number.isInteger(writeTimeoutMs)||writeTimeoutMs<1||writeTimeoutMs>60000)throw new TypeError('Explicit bounded board listener required');
  let server=null,peer=null,closed=false,busy=false,pending=Buffer.alloc(0),lastError=null,openCancel=null;const writes=new Set();
  function write(bytes){
    if(!peer||peer.destroyed)return Promise.reject(fail('ERR_SCOREBOARD_WAITING_FOR_PEER'));
    const socket=peer;
    return new Promise((resolve,reject)=>{
      let done=false,callback=false,drained=false;
      const finish=error=>{if(done)return;if(!error&&(!callback||!drained))return;done=true;clearTimeout(timer);socket.off('drain',onDrain);socket.off('close',onClose);writes.delete(cancel);if(error){lastError=error.code||error.message;socket.destroy();reject(error);}else resolve();};
      const onDrain=()=>{drained=true;finish();},onClose=()=>finish(fail('ERR_SCOREBOARD_PEER_CLOSED')),cancel=error=>finish(error),timer=setTimeout(()=>finish(fail('ERR_SCOREBOARD_WRITE_TIMEOUT')),writeTimeoutMs);
      writes.add(cancel);socket.on('drain',onDrain);socket.once('close',onClose);
      try{drained=socket.write(bytes,error=>{callback=true;if(error)finish(error);else queueMicrotask(()=>finish());});queueMicrotask(()=>finish());}catch(error){finish(error);}
    });
  }
  return {
    async connect(){if(closed)throw fail('ERR_SCOREBOARD_CLOSED');if(server?.listening)return;
      server=net.createServer(socket=>{socket.on('error',()=>{});if(closed||peer||socket.remoteAddress!==peerAddress){socket.destroy();return;}peer=socket;socket.on('close',()=>{if(peer===socket)peer=null;});});
      server.on('error',error=>{lastError=error.code||error.message;for(const cancel of [...writes])cancel(error);});
      await new Promise((resolve,reject)=>{const onError=error=>{openCancel=null;server.off('error',onError);server.off('listening',onReady);reject(error);},onReady=()=>{openCancel=null;server.off('error',onError);resolve();};openCancel=onError;server.once('error',onError);server.once('listening',onReady);server.listen(port,host);});
      if(closed)throw fail('ERR_SCOREBOARD_CLOSED');return {localCompletion:true,deliveryEstablished:false};
    },
    async applyCalls(calls,{routeId}){if(closed||busy)throw fail(closed?'ERR_SCOREBOARD_CLOSED':'ERR_SCOREBOARD_BUSY');busy=true;
      try{for(const call of calls)if(call.routeId===routeId){if(call.op==='text'){const bytes=scoreboardWireProtocol.planner.encodeLow8(call.units);if(pending.length+bytes.length>capacity)throw fail('ERR_SCOREBOARD_BUFFER_FULL');pending=Buffer.concat([pending,bytes]);}
        else if(call.op==='flush'){const bytes=pending;pending=Buffer.alloc(0);if(bytes.length)await write(bytes);}else throw TypeError('Unknown board output operation');}return {localCompletion:true,deliveryEstablished:false};}finally{busy=false;}
    },
    snapshot:()=>({state:closed?'closed':peer?'connected':server?.listening?'listening':'disconnected',pendingHex:pending.toString('hex'),error:lastError,deliveryEstablished:false}),
    close(){if(closed)return;closed=true;openCancel?.(fail('ERR_SCOREBOARD_CLOSED'));openCancel=null;for(const cancel of [...writes])cancel(fail('ERR_SCOREBOARD_CLOSED'));peer?.destroy();peer=null;try{server?.close();}catch{}pending=Buffer.alloc(0);},
  };
}
