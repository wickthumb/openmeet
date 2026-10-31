import {Worker,isMarkedAsUntransferable} from 'node:worker_threads';
import {loadModel} from './model.mjs';
let busy=false;
export async function nativeCropInfo() {
  try{const model=await loadModel();return {configured:true,ready:true,provider:'native',contract:'autocrop-ranges-v2',model:{id:model.id,sha256:model.weights_sha256}};}
  catch{return {configured:true,ready:false,provider:'native',contract:'autocrop-ranges-v2'};}
}
export function nativeCrop(image,{transfer=false}={}) {
  if(busy)return Promise.reject(Error('Empty-span analysis is already running'));
  busy=true;
  return new Promise((resolve,reject)=>{
    let worker,timer,finished=false;
    const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);busy=false;worker?.terminate();error?reject(error):resolve(result);};
    try {
      // The host may surrender its fresh, private image allocation. Ordinary
      // callers and views into shared/pooled allocations keep snapshot semantics.
      const pixels=image?.data,buffer=pixels?.buffer;
      const transferList=transfer&&ArrayBuffer.isView(pixels)&&buffer instanceof ArrayBuffer&&
        pixels.byteOffset===0&&pixels.byteLength===buffer.byteLength&&!isMarkedAsUntransferable(buffer)?[buffer]:[];
      worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{image},transferList});
      timer=setTimeout(()=>finish(Error('Empty-span analysis timed out')),120000);
      worker.once('message',message=>message.error?finish(Error(message.error)):finish(null,message));
      worker.once('error',error=>finish(error));worker.once('exit',code=>{if(!finished)finish(Error('Empty-span analysis stopped before returning a result'));});
    }catch(error){finish(error);}
  });
}
