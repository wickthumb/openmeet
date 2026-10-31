// CPU implementation of the frozen TTP empty-column network. Display only.
// Preserve Pillow BOX row pooling, per-row median centering, and float16 inputs.
const ROWS=32,COEFFICIENT_SCALE=2**22;
const normalized=Float32Array.from({length:256},(_,i)=>i/255);
const f32=new Float32Array(1),u32=new Uint32Array(f32.buffer);
function halfRounded(value) {
  f32[0]=value;
  const bits=u32[0],sign=bits>>>31?-1:1,exponent=(bits>>>23&255)-127;
  if(exponent < -25)return 0;
  const scale=exponent < -14?2**24:2**(10-exponent),number=Math.abs(f32[0])*scale,low=Math.floor(number),fraction=number-low;
  return sign*(low+(fraction>.5||fraction===.5&&(low&1)?1:0))/scale;
}

export function descriptor({width,height,channels,data}) {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||![1,3,4].includes(channels)||data.length!==width*height*channels)throw Error('Invalid cropper image geometry');
  const output=new Float32Array(ROWS*3*width),scale=height/ROWS,filterScale=Math.max(1,scale);
  const pooled=new Uint8Array(width*3),histogram=new Uint32Array(256);
  // Reuse the histogram backing store after finding the median. Only values
  // present in this channel need float16 rounding, regardless of image width.
  const rounded=width>=256?new Float32Array(histogram.buffer):null;
  for(let row=0;row<ROWS;row++) {
    const center=(row+.5)*scale,support=filterScale/2,first=Math.max(0,Math.trunc(center-support+.5)),end=Math.min(height,Math.trunc(center+support+.5)),selected=[];
    for(let y=first;y<end;y++){const distance=(y-center+.5)/filterScale;if(distance>-.5&&distance<=.5)selected.push(y);}
    const weight=Math.floor(COEFFICIENT_SCALE/selected.length+.5);
    if(channels===1) {
      for(let x=0;x<width;x++) {
        let sum=0;for(const y of selected)sum+=data[y*width+x];
        const value=Math.min(255,Math.floor((sum*weight+COEFFICIENT_SCALE/2)/COEFFICIENT_SCALE)),target=x*3;
        pooled[target]=pooled[target+1]=pooled[target+2]=value;
      }
    } else {
      for(let x=0;x<width;x++) {
        let red=0,green=0,blue=0;
        for(const y of selected){const i=(y*width+x)*channels;red+=data[i];green+=data[i+1];blue+=data[i+2];}
        const target=x*3;
        pooled[target]=Math.min(255,Math.floor((red*weight+COEFFICIENT_SCALE/2)/COEFFICIENT_SCALE));
        pooled[target+1]=Math.min(255,Math.floor((green*weight+COEFFICIENT_SCALE/2)/COEFFICIENT_SCALE));
        pooled[target+2]=Math.min(255,Math.floor((blue*weight+COEFFICIENT_SCALE/2)/COEFFICIENT_SCALE));
      }
    }
    for(let c=0;c<3;c++) {
      histogram.fill(0);for(let x=0;x<width;x++)histogram[pooled[x*3+c]]++;
      const middleLow=Math.floor((width-1)/2),middleHigh=Math.floor(width/2);let count=0,low=-1,high=0;
      for(let v=0;v<256;v++){count+=histogram[v];if(low<0&&count>middleLow)low=v;if(count>middleHigh){high=v;break;}}
      const median=Math.fround(Math.fround(normalized[low]+normalized[high])/2),offset=(row*3+c)*width;
      if(rounded) {
        for(let value=0;value<256;value++)if(histogram[value])rounded[value]=halfRounded(Math.fround(normalized[value]-median));
        for(let x=0;x<width;x++)output[offset+x]=rounded[pooled[x*3+c]];
      } else {
        for(let x=0;x<width;x++)output[offset+x]=halfRounded(Math.fround(normalized[pooled[x*3+c]]-median));
      }
    }
  }
  return output;
}

export function probabilities(input,width,{layers,weights}) {
  if(input.length!==96*width)throw Error('Invalid cropper descriptor');
  let current=input;
  for(const layer of layers) {
    const [outChannels,inChannels,kernel]=layer.shape,dilation=layer.dilation,padding=(kernel-1)*dilation/2;
    const next=new Float32Array(outChannels*width);
    for(let out=0;out<outChannels;out++) {
      const offset=out*width;next.fill(weights[layer.bias_offset+out],offset,offset+width);
      for(let inputChannel=0;inputChannel<inChannels;inputChannel++)for(let k=0;k<kernel;k++) {
        const shift=k*dilation-padding,weight=weights[layer.offset+(out*inChannels+inputChannel)*kernel+k],sourceOffset=inputChannel*width+shift;
        const start=Math.max(0,-shift),end=Math.min(width,width-shift);
        for(let x=start;x<end;x++)next[offset+x]+=current[sourceOffset+x]*weight;
      }
      if(layer.relu)for(let x=offset;x<offset+width;x++)if(next[x]<0)next[x]=0;
    }
    current=next;
  }
  const result=new Float32Array(width);
  for(let i=0;i<width;i++)result[i]=1/(1+Math.exp(-current[i]));
  return result;
}

export function modeOutput(scores,threshold,mode) {
  if(!['storage-display','inference-safe'].includes(mode))throw Error('Invalid cropper mode');
  const padding=mode==='storage-display'?8:160,gap=mode==='storage-display'?0:320,ranges=[];
  let previous=null;
  for(let x=0;x<scores.length;x++) {
    if(!Number.isFinite(scores[x]))throw Error('Invalid cropper probability');
    if(!(scores[x]>=threshold))continue;
    const start=Math.max(0,x-padding),end=Math.min(scores.length,x+padding+1);
    // Padded hits are ordered; union adjacent coverage before applying the
    // mode's strict gap policy, without allocating a full-width difference map.
    if(previous&&(start<=previous[1]||start-previous[1]<gap))previous[1]=end;
    else {previous=[start,end];ranges.push(previous);}
  }
  const map=[];for(const [a,b]of ranges)for(let x=a;x<b;x++)map.push(x);
  return {mode,padding,merge_gap_lt:gap,ranges,cropped_to_original:map};
}

export function cropImage(image,model) {
  if(model.approved!==true)throw Error('Bundled cropper is not an approved release');
  const scores=probabilities(descriptor(image),image.width,model);
  return {schema:'autocrop-ranges-v2',original_width:image.width,approved:true,policy:'release_guard',
    modes:Object.fromEntries(['storage-display','inference-safe'].map(mode=>[mode,modeOutput(scores,model.threshold,mode)]))};
}
