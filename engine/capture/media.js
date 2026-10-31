// Media algorithms operate on owned bytes; codecs are supplied explicitly.
export function mediaExportPlan({sourceCodec,codec=0,recompress=1,start=0,end,frameCount,sourceRate,speed=100,
  sourceQuality=75,quality=75,preRoll=0,spatialSelection=false,overlayCount=0,annotation=false,scale=100,adjustment=false}){
  if(![1,2].includes(sourceCodec)||![0,1,2].includes(recompress)||!Number.isInteger(frameCount)||frameCount<0||!Number.isInteger(start)||!Number.isInteger(end)||!Number.isInteger(speed)||!Number.isInteger(sourceRate)||sourceRate<1)throw new TypeError('Explicit bounded movie inputs required');
  let output=[1,2].includes(codec)?codec:sourceCodec,encode=recompress===2;
  if(output!==sourceCodec){if(recompress===0)output=sourceCodec;else encode=true;}
  if(sourceCodec===2){if(speed<0){if(recompress===0)speed=-speed;else encode=true;}if(start>0){if(recompress===1)encode=true;else if(recompress===0){if(!Number.isInteger(preRoll)||preRoll<0)throw new RangeError('Resolved pre-roll required');start-=preRoll;}}}
  if(sourceCodec===1&&output===1&&recompress===1&&quality<sourceQuality)encode=true;
  if(recompress===1&&(spatialSelection||overlayCount>0||annotation||scale!==100||adjustment))encode=true;
  if(start<0||end>=frameCount||start>end)return {empty:true,count:0};const count=end-start+1;
  if(speed<0)[start,end]=[end,start];const rate=Math.max(1,Math.floor((sourceRate*Math.abs(speed)+50)/100));
  if(!Number.isSafeInteger(rate)||rate>0xffffffff)throw new RangeError('Movie rate overflow');
  return {empty:false,start,end,count,step:speed<0?-1:1,rate,codec:output,container:output===1?'avi':'mp4',reencode:encode,scale:scale>=1&&scale<=99?Math.max(2,scale):100};
}
function adaptJpeg(input,strip){
  // Marker inspection is confined to the first 1024-byte read buffer.
  const original=Buffer.from(input),head=Buffer.from(original.subarray(0,1024));let buffer=head,at=0;
  while(at+2<=buffer.length){if(buffer[at]!==255)break;const marker=buffer[at+1];if(marker===0xd8){at+=2;continue;}if(at+4>buffer.length)break;const size=buffer.readUInt16BE(at+2),end=at+2+size;if(size<2||end>buffer.length)break;
    if(marker===0xe0&&size>=6&&buffer.subarray(at+4,at+8).equals(Buffer.from('JFIF'))){buffer.write('AVI1',at+4,'ascii');buffer.fill(0,at+8,end);}
    if(marker===0xc4&&strip){buffer=Buffer.concat([buffer.subarray(0,at),buffer.subarray(end)]);continue;}at=end;
  }
  return Buffer.concat([buffer,original.subarray(head.length)]);
}
export function buildAvi({width,height,rate,plannedCount,frames,quality=75,codec=1,stripTables=true,maxBytes=64*1024*1024}){
  for(const v of [width,height,rate,plannedCount])if(!Number.isInteger(v)||v<0||v>0x7fffffff)throw new RangeError('Invalid AVI dimensions/count/rate');
  if(!width||!height||!rate||width*height*rate*3>0xffffffff||!Array.isArray(frames)||frames.length>plannedCount||![1,2].includes(codec)||!Number.isInteger(maxBytes)||maxBytes<240||maxBytes>256*1024*1024)throw new RangeError('Invalid bounded AVI plan');
  const header=Buffer.alloc(232),four=(s,at)=>header.write(s,at,4,'ascii'),u=(v,at)=>header.writeUInt32LE(v>>>0,at),compression=codec===1?'MJPG':'H264';
  four('RIFF',0);four('AVI ',8);four('LIST',12);u(200,16);four('hdrl',20);four('avih',24);u(56,28);
  [rate>1?Math.floor(1000000/rate):1000000,width*height*rate*3,0,16,frames.length,0,1,0,width,height,0,0,0,0].forEach((v,i)=>u(v,32+i*4));
  four('LIST',88);u(124,92);four('strl',96);four('strh',100);u(64,104);four('vids',108);four(compression,112);
  [0,0,0,1,rate,0,frames.length,0,quality,0,0,0,width,height].forEach((v,i)=>u(v,116+i*4));
  four('strf',172);u(40,176);u(40,180);u(width,184);u(height,188);header.writeUInt16LE(1,192);header.writeUInt16LE(24,194);four(compression,196);u(width*height*3,200);four('LIST',220);four('movi',228);
  let position=232;const pieces=[header],index=Buffer.alloc(8+frames.length*16);index.write('idx1');index.writeUInt32LE(frames.length*16,4);
  frames.forEach((frame,i)=>{
    if(position>2100000000)throw new RangeError('AVI pre-append limit');const bytes=codec===1?adaptJpeg(frame.data,stripTables):Buffer.from(frame.data),size=Math.ceil(bytes.length/4)*4;
    if(position+8+size+index.length>maxBytes)throw new RangeError('AVI exceeds output memory budget');const chunk=Buffer.alloc(8+size,codec===1?255:0);chunk.write('00dc');chunk.writeUInt32LE(size,4);bytes.copy(chunk,8);
    index.write('00dc',8+i*16);index.writeUInt32LE(frame.dependency>0?0:16,12+i*16);index.writeUInt32LE(position-228,16+i*16);index.writeUInt32LE(size,20+i*16);pieces.push(chunk);position+=chunk.length;
  });
  header.writeUInt32LE(position-228,224);header.writeUInt32LE(position+index.length-8,4);pieces.push(index);return Buffer.concat(pieces,position+index.length);
}

let tables=null;
export function convertPlanar420({width,height,y,u,v,yStride=width,chromaStride=width/2,context='extended64'}){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<2||height<2||width%2||height%2||!Number.isInteger(yStride)||!Number.isInteger(chromaStride)||yStride<width||chromaStride<width/2||width*height*3>64*1024*1024)throw new RangeError('Even bounded planar image and valid strides required');
  if(y.length<yStride*height||u.length<chromaStride*height/2||v.length<chromaStride*height/2)throw new RangeError('Truncated planar image');
  if(!['extended64','binary64-nearest'].includes(context))throw new TypeError('Explicit color arithmetic context required');
  if(!tables){const r=new Int16Array(256),b=new Int16Array(256),g=new Int16Array(65536);for(let i=0;i<256;i++){r[i]=Number(BigInt(i-128)*6314046677573435n/4503599627370496n);b[i]=Number(BigInt(i-128)*7980378539700519n/4503599627370496n);for(let j=0;j<256;j++)g[i*256+j]=Number((BigInt(i-128)*6199475103053130n+BigInt(j-128)*12864802551561464n)/18014398509481984n);}tables={r,b,g};}
  const clamp=n=>Math.max(0,Math.min(255,n)),out=Buffer.alloc(width*height*3);
  for(let row=0;row<height;row++)for(let col=0;col<width;col++){const l=y[row*yStride+col],a=u[Math.floor(row/2)*chromaStride+Math.floor(col/2)],c=v[Math.floor(row/2)*chromaStride+Math.floor(col/2)],at=(row*width+col)*3;
    let green=tables.g[a*256+c];if(context==='binary64-nearest'){if(a===28&&c===228)green=37;if(a===228&&c===28)green=-37;}
    out[at]=clamp(l+tables.b[a]);out[at+1]=clamp(l-green);out[at+2]=clamp(l+tables.r[c]);}
  return {width,height,channels:3,order:'BGR',data:out,context,calibrationConfirmed:false};
}
export function prepareMediaSegments({target,lastCompleted=-1,hasContext=true,resolveFrame,resolveBlock}){
  const exact=f=>{const r=resolveFrame(f);if(!r||r.residual!==0||r.span!==1)throw new Error('Media frame needs an exact single-record boundary');return r;};
  let record=exact(target),p=record.preRoll,count=1,start=target;
  if(hasContext&&p>0){if(target-p<=lastCompleted&&lastCompleted<target)p=target-lastCompleted-1;if(p>0){start=target-p;count=p+1;record=exact(start);}}
  if(record.segmentIndex!==record.finalSegmentIndex)throw new Error('Frame lookup must identify its final segment');
  let blockCursor=record.blockIndex-record.finalSegmentIndex-1,segment=-1,lastSegment=record.finalSegmentIndex,frame=start,remaining=count,pending=Buffer.alloc(0),prefix=false;
  return {
    count,mode:record.format+1,start,
    read(requested,{discard=false}={}){
      if(!Number.isInteger(requested)||requested<0||requested>12582912)throw new RangeError('Invalid media read extent');const pieces=[];let consumed=0,boundary=false;
      while(consumed<requested){
        if(!pending.length){blockCursor++;segment++;
          if(segment>lastSegment){if(remaining>1){remaining--;frame++;blockCursor--;segment=-1;lastSegment=2147483647;}boundary=true;break;}
          const r=resolveBlock(blockCursor,frame);if(!r||r.residual!==0||r.span!==1)throw Error('Missing media segment boundary');if(lastSegment===2147483647)lastSegment=r.finalSegmentIndex;
          const edge=r.firstColumn+r.columnCount;if(r.segmentIndex!==segment||r.finalSegmentIndex!==lastSegment||(segment<lastSegment?edge!==frame:edge<=frame)||!r.data?.length)throw Error('Contradictory media segment');
          pending=Buffer.from(r.data);if(segment===0&&pending[0]!==255&&!prefix&&r.format===0){prefix=true;blockCursor--;segment--;pending=Buffer.of(255,216,255,224,0);}
        }
        const n=Math.min(requested-consumed,pending.length);if(!discard)pieces.push(pending.subarray(0,n));pending=pending.subarray(n);consumed+=n;
      }return {data:discard?null:Buffer.concat(pieces,consumed),consumed,boundary,code:boundary?3004:null};
    },snapshot:()=>({blockCursor,segment,lastSegment,frame,remaining,pendingBytes:pending.length,prefixInjected:prefix}),
  };
}
export function createMediaFrameCache({maximumBytes=25000000}={}){
  if(!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>256*1024*1024)throw new RangeError('Explicit bounded cache budget required');let width=0,height=0,capacity=0,base=0,entries=[];
  return {
    configure(w,h){if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1)throw new RangeError('Positive media dimensions required');if(w===width&&h===height)return capacity;const bytes=4*Math.ceil(3*w/4)*h,n=Math.floor(maximumBytes/(bytes+72));entries=[];width=height=capacity=base=0;if(n<1)return 0;width=w;height=h;capacity=n;entries=Array.from({length:n},()=>({flags:0,data:null}));return n;},
    relocate(frame){if(!Number.isInteger(frame)||frame<0)throw new RangeError('Nonnegative frame required');const next=Math.max(0,frame);const old=new Map(entries.map((e,i)=>[base+i,e]));entries=Array.from({length:capacity},(_,i)=>old.get(next+i)??{flags:0,data:null});base=next;},
    async feed({target,count,stream,decode}){if(!capacity||!Number.isInteger(count)||count<1)throw new RangeError('Configured cache and dependency count required');if(target<base)this.relocate(target);else if(target>=base+capacity)this.relocate(target-(capacity-1));
      for(let index=target-count+1;index<=target;index++){const entry=index>=base&&index<base+capacity?entries[index-base]:null,destination=entry&&!(entry.flags&2)?entry:null;if(destination)destination.flags=1;const result=stream.read(12582912);if(!result.boundary||result.consumed<=0||result.consumed>=12582912)return false;const decoded=await decode(result.data,{index,width,height,destination:Boolean(destination)});if(!decoded.accepted)return false;if(destination){if(decoded.data)destination.data=Buffer.from(decoded.data);destination.flags|=2;}}return true;
    },get(frame){const e=entries[frame-base];return e?{flags:e.flags,data:e.data&&Buffer.from(e.data)}:null;},clear(){entries=[];capacity=width=height=base=0;},snapshot:()=>({width,height,capacity,base,flags:entries.map(e=>e.flags),maximumBytes}),
  };
}
