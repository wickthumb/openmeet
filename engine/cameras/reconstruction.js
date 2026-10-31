const average=(a,b)=>Math.floor((a+b)/2);
const valid=(bytes,rows)=>bytes instanceof Uint8Array&&bytes.length>=rows*4;
export function reconstructedHeight({height,nominalHeight=height,type,subtype}){
  if(type===9&&[4,5].includes(subtype))return subtype===4?Math.floor((3*height-1)/2):3*height-2;
  if(type>=12&&type<=14&&subtype===4)return 2*Math.ceil(nominalHeight/2);
  return nominalHeight;
}
export function reconstructCameraColumn(current,{height=current.length/4,nominalHeight=height,type=0,subtype=0,
  mode=0,subdivision=0,next=null,reverseHorizontal=false,destination=null}={}){
  if(!Number.isInteger(height)||height<1||height>2560||!valid(current,height))throw new RangeError('Invalid reconstruction source');
  const outputHeight=reconstructedHeight({height,nominalHeight,type,subtype});
  const out=destination?Buffer.from(destination):Buffer.alloc(outputHeight*4);
  if(out.length!==outputHeight*4)throw new RangeError('Reconstruction destination extent differs');
  if(type===9&&[4,5].includes(subtype)){
    const a=subtype===4?2:1;
    for(let row=0;row<outputHeight;row++){
      for(let lane=0;lane<3;lane++){
        const coordinate=a*row+lane-1,index=Math.floor(coordinate/3),remainder=((coordinate%3)+3)%3;
        const low=Math.max(0,Math.min(height-1,index)),high=Math.max(0,Math.min(height-1,index+1));
        out[row*4+lane]=Math.floor((current[low*4+lane]*(3-remainder)+current[high*4+lane]*remainder)/3);
      }
      out[row*4+3]=current[Math.min(height-1,Math.floor((a*row+1)/3))*4+3];
    }
    return out;
  }
  if(type>=12&&type<=14){
    const n=subtype===4?Math.ceil(nominalHeight/2):nominalHeight;
    if(!valid(current,n)||next&&!valid(next,n))throw new RangeError('Source rows do not cover nominal geometry');
    const source=Buffer.from(current.subarray(0,n*4));
    if(subdivision===1&&next)for(let j=0;j<n;j++){source[j*4+1]=next[j*4+1];source[j*4+2]=next[j*4+2];}
    if(subtype!==4){for(let j=0;j<n;j++){source.copy(out,j*4,j*4,j*4+4);out[j*4+1]=average(source[j*4+1],source[j*4+3]);}return out;}
    for(let j=0;j<n;j++){
      const at=j*4,e=j*8,o=e+4;
      if(j===0||j===n-1){source.copy(out,e,at,at+4);source.copy(out,o,at,at+4);out[o+1]=source[at+3];continue;}
      const previous=at-4,after=at+4;
      if(mode===6){source.copy(out,e,at,at+4);source.copy(out,o,at,at+4);out[o]=source[after];out[o+1]=source[at+3];continue;}
      out[e]=source[at];out[e+1]=average(source[at+1],source[at+3]);out[e+2]=average(source[previous+2],source[at+2]);
      out[o]=average(source[at],source[after]);out[o+1]=average(source[at+3],source[after+1]);out[o+2]=source[at+2];
      if(mode!==4)out[e+3]=out[o+3]=source[at+3];
      if(mode===1){out[e+2]=source[at+2];out[o]=source[after];}
      if(mode===2)out[o+1]=source[at+3];
      if(mode===3){out[e+1]=Math.floor((2*source[at+1]+source[previous+3]+source[at+3])/4);out[o+1]=Math.floor((2*source[at+3]+source[at+1]+source[after+1])/4);}
      if(mode===4){out[e]=average(source[at],source[after]);out[o+2]=average(source[at+2],source[after+2]);}
    }
    return out;
  }
  if(type===11&&subtype===4){
    if(nominalHeight<4||nominalHeight%2||!valid(current,nominalHeight)||next&&!valid(next,nominalHeight))throw new RangeError('Type 11 requires even bounded rows');
    out.fill(0,0,8);out.fill(0,(nominalHeight-2)*4);
    for(let j=2;j<=nominalHeight-4;j+=2)for(let r=j;r<=j+1;r++){
      const at=r*4;
      if(subdivision===1&&next){
        out[at]=(reverseHorizontal?next:current)[j*4];out[at+2]=(reverseHorizontal?current:next)[at+2];
        out[at+1]=reverseHorizontal?average(current[j*4+1],next[(r===j?j-1:j+1)*4+1]):average(current[(r===j?j-1:j+1)*4+1],next[j*4+1]);
      }else{Buffer.from(current).copy(out,at,at,at+4);out[at+1]=average(current[at+1],current[at-3]);}
    }
    return out;
  }
  if(!valid(current,outputHeight))throw new RangeError('Nominal rows exceed the source');
  Buffer.from(current).copy(out,0,0,outputHeight*4);return out;
}

export function createIntensityLookup({kind=3,brightness=0,contrast=0,gamma=1,gain=0,baseTable}){
  const maximum=({1:255,2:93,3:765})[kind];
  if(!maximum||!Array.isArray(baseTable)||baseTable.length!==maximum+1||baseTable.some(x=>!Number.isFinite(x)))throw new TypeError('Explicit intensity table required');
  brightness=Math.max(-1,Math.min(1,brightness));contrast=Math.max(-1,Math.min(1,contrast));gamma=Math.max(.25,Math.min(1.75,gamma));
  const table=[];
  for(let i=0;i<=maximum;i++){
    let y=Math.max(0,Math.min(1,Math.pow(i/maximum,gamma)+brightness));
    if(contrast>0)y=y<=contrast/2?0:y>=1-contrast/2?1:(y-.5)/(1-contrast)+.5;
    else y=(y-.5)*(1-Math.abs(contrast))+.5;
    const target=baseTable[Math.trunc(maximum*Math.max(0,Math.min(1,y)))];
    const signedBase=kind===2?((Math.trunc(target)&65535)<<16)>>16:target;
    table.push(kind===1?target:kind===2?(i?Math.min(992,Math.trunc(signedBase*32/i))&65535:32):(i?Math.min(65280,Math.floor(target*256/i)):256));
  }
  return {kind,table,brightness,contrast,gamma,gain,arithmetic:'binary64',calibrationConfirmed:false};
}
export function enhanceIntensityBase(working){
  if(!(working instanceof Uint8Array)||working.length%4||working.length<4||working.length/4>=2**22)throw new RangeError('Bounded four-lane image required');
  const histogram=new Uint32Array(766);for(let at=0;at<working.length;at+=4)histogram[working[at]+working[at+1]+working[at+2]]++;
  const count=working.length/4,base=Array.from({length:766},(_,i)=>i);let cumulative=0;
  for(let i=1;i<765;i++){cumulative+=histogram[i];base[i]=Math.floor((765*cumulative+Math.floor(count/2))/count);}return base;
}
function profileBoundary(profile,height){
  if(!Number.isInteger(profile.numerator)||!Number.isInteger(profile.denominator)||profile.denominator<=0||!Number.isInteger(height)||height<1||!Number.isSafeInteger(profile.numerator*height))throw new RangeError('Explicit bounded profile boundary required');
  return height===profile.denominator?profile.numerator:Math.trunc(profile.numerator*height/profile.denominator);
}
export function applyRecordGain(working,{rawGain=256,channels=3,profiles=[]}={}){
  if(!Number.isInteger(rawGain)||rawGain<0||rawGain>65535||![1,3,4].includes(channels)||working.length%4)throw new RangeError('Invalid record gain');
  const out=Buffer.from(working),height=out.length/4;if(rawGain<=256)return out;let row=0;
  const region=(limit,factor)=>{limit=Math.max(row,Math.min(height,limit));if(factor>256)for(let y=row;y<limit;y++)for(let c=0;c<channels;c++)out[y*4+c]=Math.min(255,Math.floor(out[y*4+c]*factor/256));row=limit;};
  for(const profile of profiles){const gain=profile.gain??0;if(!Number.isInteger(gain)||gain<-10000||gain>100000)throw new RangeError('Stored profile gain out of range');region(profileBoundary(profile,height),256+Math.trunc((rawGain-256)*(1+gain/10000)));}region(height,rawGain);return out;
}
export function applyDisplayProfiles(working,{width=1,height=working.length/4,top=0,referenceHeight=height,profiles=[]}={}){
  if(!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1||working.length!==width*height*4)throw new RangeError('Invalid profile image');
  const active=p=>(p.flags&1)||(p.brightness??0)!==0||(p.contrast??0)!==0||(p.gamma??10000)!==10000;
  const out=Buffer.from(working);if(!profiles.some(active))return out;let row=top;
  for(const profile of profiles){const boundary=profileBoundary(profile,referenceHeight);if(boundary<row)continue;
    if(active(profile)&&profile.lookup){for(let y=row;y<=Math.min(boundary,top+height-1);y++)for(let x=0;x<width;x++){
      const at=((y-top)*width+x)*4,factor=profile.lookup.table[out[at]+out[at+1]+out[at+2]];
      if(!Number.isInteger(factor)||factor<0||factor>65280)throw new RangeError('Invalid display coefficient');if(factor!==256)for(let c=0;c<3;c++)out[at+c]=Math.min(255,Math.floor((out[at+c]*factor+128)/256));
    }}row=boundary+1;if(row>=top+height)break;
  }return out;
}
export function applyIntensityLookup(working,lookup){
  const out=Buffer.from(working);if(lookup.kind!==3)throw new RangeError('Color output requires a shared kind-3 coefficient table');
  for(let at=0;at<out.length;at+=4){const factor=lookup.table[out[at]+out[at+1]+out[at+2]];
    if(factor!==256)for(let k=0;k<3;k++)out[at+k]=Math.min(255,Math.floor((out[at+k]*factor+128)/256));}
  return out;
}
