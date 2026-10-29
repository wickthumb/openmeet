// Public fixed-background display mask only. No capture bytes, clocks, or models.
import {frontOverlayAlpha} from './front-occlusion.mjs';

let reference=null,generation=null,width=0,height=0,canvas=null,context=null;
self.onmessage=async({data})=>{
  if(data.type==='reference'){
    generation=data.generation;width=data.width;height=data.height;
    reference=new Uint8ClampedArray(data.reference);
    canvas=new OffscreenCanvas(width,height);context=canvas.getContext('2d');
    return;
  }
  if(data.type!=='frame')return;
  const {id,stamp}=data;
  try{
    if(data.generation!==generation||!reference)throw Error('Front mask reference changed');
    const current=new Uint8ClampedArray(data.pixels);
    if(current.length!==reference.length||current.length!==width*height*4)throw Error('Front mask geometry changed');
    const alpha=frontOverlayAlpha(reference,current,width,height),image=context.createImageData(width,height);
    for(let i=0;i<alpha.length;i++){image.data[i*4]=image.data[i*4+1]=image.data[i*4+2]=255;image.data[i*4+3]=alpha[i];}
    context.putImageData(image,0,0);
    const blob=await canvas.convertToBlob({type:'image/png'});
    self.postMessage({id,generation:data.generation,stamp,blob});
  }catch(error){self.postMessage({id,generation:data.generation,stamp,error:error.message||String(error)});}
};
