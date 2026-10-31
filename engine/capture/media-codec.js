import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';
// Optional open codec process. No shell, downloaded binary, or implicit provider search.
export function runMediaCodec({executable,args,input=Buffer.alloc(0),maximumBytes=64*1024*1024,timeoutMs=30000,signal}){
  if(typeof executable!=='string'||!isAbsolute(executable)||!Array.isArray(args)||!args.every(v=>typeof v==='string')||!Number.isInteger(maximumBytes)||maximumBytes<1||maximumBytes>256*1024*1024||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new TypeError('Explicit codec executable and bounded process policy required');
  if(signal?.aborted)return Promise.reject(signal.reason??Error('Codec cancelled'));
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{stdio:['pipe','pipe','pipe']}),pieces=[];let length=0,diagnostic='',failure=null;
    const abort=()=>{failure??=signal?.reason??Error('Codec cancelled');child.kill('SIGKILL');},timer=setTimeout(()=>{failure=Error('Codec deadline exceeded');child.kill('SIGKILL');},timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    child.on('error',error=>{failure=error;});child.stdin.on('error',error=>{if(error.code!=='EPIPE')failure??=error;});
    child.stdout.on('data',bytes=>{length+=bytes.length;if(length>maximumBytes){failure=Error('Codec output exceeds budget');child.kill('SIGKILL');}else pieces.push(bytes);});
    child.stderr.on('data',bytes=>{if(diagnostic.length<8192)diagnostic+=bytes.toString('utf8').slice(0,8192-diagnostic.length);});
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failure)reject(failure);else if(code!==0)reject(Error('Codec failed: '+diagnostic));else resolve(Buffer.concat(pieces,length));});
    child.stdin.end(Buffer.from(input));
  });
}
export async function decodeCompressedMedia({executable,codec,frames,width,height,signal}){
  if(!['mjpeg','h264'].includes(codec)||!Array.isArray(frames)||frames.length<1||frames.length>1000||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height*3>64*1024*1024)throw new RangeError('Explicit codec and bounded image geometry required');
  let bytes=0;for(const frame of frames){if(!(frame instanceof Uint8Array))throw new TypeError('Compressed frame bytes required');bytes+=frame.length;if(bytes>64*1024*1024)throw new RangeError('Compressed media exceeds input budget');}
  const input=Buffer.concat(frames,bytes);
  const output=await runMediaCodec({executable,args:['-v','error','-f',codec,'-i','pipe:0','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],input,signal});
  const size=width*height*3;if(output.length%size||!output.length)throw Error('Decoded media dimensions do not match the explicit profile');return {width,height,channels:3,frames:Array.from({length:output.length/size},(_,i)=>Buffer.from(output.subarray(i*size,(i+1)*size))),codecProvider:'external',nativeCodecEquivalent:false};
}
export async function encodeCompressedMedia({executable,codec='mjpeg',frames,width,height,rate=25,quality=75,signal}){
  if(!['mjpeg','h264','mp4'].includes(codec)||!Array.isArray(frames)||!frames.length||!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1||!Number.isInteger(rate)||rate<1||rate>20000||!Number.isInteger(quality)||quality<1||quality>100)throw new RangeError('Explicit bounded encoder inputs required');
  const size=width*height*3;if(size*frames.length>64*1024*1024||frames.some(frame=>frame.length!==size))throw new RangeError('RGB frame geometry exceeds encoder budget');
  if(codec!=='mjpeg'&&(width%2||height%2))throw new RangeError('Video encoder requires even dimensions');
  const encoder=codec==='mjpeg'?['-c:v','mjpeg','-q:v',String(Math.max(2,Math.round(31-quality*29/100))),'-f','mjpeg']:
    ['-c:v','libx264','-pix_fmt','yuv420p','-crf',String(Math.round(51-quality*.51)),...(codec==='mp4'?['-movflags','frag_keyframe+empty_moov','-f','mp4']:['-f','h264'])];
  const data=await runMediaCodec({executable,args:['-v','error','-f','rawvideo','-pixel_format','rgb24','-video_size',`${width}x${height}`,'-framerate',String(rate),'-i','pipe:0','-an',...encoder,'pipe:1'],input:Buffer.concat(frames.map(value=>Buffer.from(value))),signal});
  return {data,width,height,rate,frames:frames.length,codec,codecProvider:'external',nativeCodecEquivalent:false};
}
