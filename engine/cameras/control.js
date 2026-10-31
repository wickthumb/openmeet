import { networkCameraProtocol as wire } from '../integrations/index.js';
import { decodeCameraConfiguration } from './configuration.js';

const fail = (code, message = code) => Object.assign(new Error(message), { code });
export async function inspectNetworkCamera({ address, port = 41925, marker, sequence = 0,
  timeoutMs = 1000, family, localAddress = null, identity = true, configuration = true },
{ transportFactory = wire.createNodeCameraTransport, signal } = {}) {
  if (!wire.hostOK(address) || port !== 41925 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new TypeError('Explicit camera peer and deadline required');
  wire.encodeCameraCommand({ marker, sequence, operation:'clockRead', words:[] });
  const transport=transportFactory({ host:address, port,localAddress }), packets=[];
  const abort=()=>transport.close(); signal?.addEventListener('abort',abort,{once:true});
  try {
    async function read(operation, words, raw = false) {
      if(signal?.aborted)throw fail('ERR_CAMERA_ABORTED');
      if(sequence>0xffffffff)throw fail('ERR_SEQUENCE_EXHAUSTED');
      const current=sequence++,packet=wire.encodeCameraCommand({marker,sequence:current,operation,words});
      const options={expectedAddress:address,expectedPort:port,requestMarker:marker,sequence:current};
      function accept(observation) {
        if(!observation||observation.peerAddress!==address||observation.peerPort!==port)return false;
        if(raw)return observation.bytes?.length===1024;
        try{return wire.decodeControlReply(observation.bytes,{...options,peerAddress:observation.peerAddress,peerPort:observation.peerPort}).decision==='accepted';}catch{return false;}
      }
      const observation=await transport.exchange(packet,{timeoutMs,accept});
      if(signal?.aborted)throw fail('ERR_CAMERA_ABORTED');
      if(!accept(observation))throw fail('ERR_REPLY_CORRELATION');
      const bytes=Buffer.from(observation.bytes);packets.push({operation,requestHex:packet.toString('hex'),responseHex:bytes.toString('hex')});
      if(raw)return bytes;
      const reply=wire.decodeControlReply(bytes,{...options,peerAddress:address,peerPort:port});
      if(!reply.success)throw fail('ERR_CAMERA_FAILURE');return reply.payload;
    }
    const clock=await read('clockRead',[]);
    if(clock.length!==3||clock.slice(1).some(x=>x>0xffffff))throw fail('ERR_REPLY_SHAPE');
    const result={address,port,clockOrigin:clock[0],clock128k:String(BigInt(clock[1])+(BigInt(clock[2])<<24n)),
      runtimeConfirmed:false,deviceIdentityConfirmed:false};
    if(identity){
      const p=await read('identity',[1]);
      if(p.length!==8||p[4]>65535)throw fail('ERR_REPLY_SHAPE');
      result.identity={serialNumberRaw:p[0],memoryStatusRaw:p[1],capabilityWord:p[2],
        macAddress:[p[4]>>>8,p[4]&255,p[3]>>>24,(p[3]>>>16)&255,(p[3]>>>8)&255,p[3]&255].map(x=>x.toString(16).padStart(2,'0')).join(':'),
        cpuSpeedRaw:p[5],romVersionRaw:p[6],cpuTypeRaw:p[7]};
    }
    if(configuration)result.configuration=decodeCameraConfiguration(await read('configuration',[],true),{family});
    return {...result,nextSequence:sequence,packets};
  } finally {signal?.removeEventListener('abort',abort);await transport.close();}
}

export function buildAlignmentReset({depth,dimensions,alignmentParameter,width,rate,indicatorRgb,
  aec=false,minimumGain=0,maximumGain=0,runtime='ec8l'}) {
  if(!Number.isInteger(depth)||depth<3||depth>7||![1,2].includes(dimensions)||
      !Number.isInteger(alignmentParameter)||alignmentParameter<0||alignmentParameter>0xffffffff||
      ![width,rate].every(x=>Number.isInteger(x)&&x>=0&&x<=65535)||
      !Array.isArray(indicatorRgb)||indicatorRgb.length!==3||!indicatorRgb.every(x=>Number.isInteger(x)&&x>=0&&x<=255)||
      ![minimumGain,maximumGain].every(x=>Number.isInteger(x)&&x>=0&&x<=255)||typeof aec!=='boolean')throw new TypeError('Explicit alignment fields required');
  if(!['ec6l','ec7l','ec8l'].includes(runtime)||aec&&(dimensions!==2||minimumGain>maximumGain))throw new RangeError('Unsupported alignment runtime/gain range');
  const effectiveWidth=Math.max(runtime==='ec8l'?16:4,Math.min(width,runtime==='ec8l'?512:241));
  const effectiveRate=Math.max(1,Math.min(rate,30)),[r,g,b]=indicatorRgb;
  const words=[(depth<<2)|2|(dimensions===2?512:0)|(aec?1024:0),alignmentParameter,
    dimensions===2?(rate|(width<<16))>>>0:0,0,dimensions===2?(b|(g<<8)|(r<<16))>>>0:0,
    aec?minimumGain|(maximumGain<<8):0];
  return {words,effectiveWidth:dimensions===2?effectiveWidth:1,effectiveRate,
    nominalSpacingMs:Math.trunc(1000/(effectiveRate+1)),physicalAlignmentConfirmed:false};
}
