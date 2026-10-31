// Public fixed-background display mask only. No capture bytes, clocks, or models.
import {frontOverlayAlpha} from './front-occlusion.mjs';

const littleEndian=new Uint8Array(Uint32Array.of(1).buffer)[0]===1;
let reference=null,generation=null,width=0,height=0,canvas=null,context=null;
self.onmessage=async({data})=>{
  if(data.type==='reference'){
    generation=data.generation;width=data.width;height=data.height;
    reference=new Uint8ClampedArray(data.reference);
    canvas=null;context=null;
    return;
  }
  if(data.type!=='frame')return;
  const {id,stamp}=data;
  try{
    if(data.generation!==generation||!reference)throw Error('Front mask reference changed');
    const current=new Uint8ClampedArray(data.pixels);
    if(current.length!==reference.length||current.length!==width*height*4)throw Error('Front mask geometry changed');
    let identical=true;
    for(let i=0;i<current.length;i++)if(current[i]!==reference[i]){identical=false;break;}
    const alpha=identical?null:frontOverlayAlpha(reference,current,width,height);
    let clear=true;
    if(alpha)for(let i=0;i<alpha.length;i++)if(alpha[i]!==255){clear=false;break;}
    if(clear){
      self.postMessage({id,generation:data.generation,stamp,clear:true});return;
    }
    if(!canvas){canvas=new OffscreenCanvas(width,height);context=canvas.getContext('2d');}
    const image=context.createImageData(width,height);
    if(image.data.byteOffset%4===0){
      const rgba=new Uint32Array(image.data.buffer,image.data.byteOffset,alpha.length);
      if(littleEndian)for(let i=0;i<alpha.length;i++)rgba[i]=0xffffff|(alpha[i]<<24);
      else for(let i=0;i<alpha.length;i++)rgba[i]=0xffffff00|alpha[i];
    }else{
      for(let i=0;i<alpha.length;i++){image.data[i*4]=image.data[i*4+1]=image.data[i*4+2]=255;image.data[i*4+3]=alpha[i];}
    }
    context.putImageData(image,0,0);
    const blob=await canvas.convertToBlob({type:'image/png'});
    self.postMessage({id,generation:data.generation,stamp,blob});
  }catch(error){self.postMessage({id,generation:data.generation,stamp,error:error.message||String(error)});}
};
