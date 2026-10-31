export function createCaptureColumnMap(originalWidth){
  if(!Number.isSafeInteger(originalWidth)||originalWidth<0)throw new RangeError('Nonnegative capture width required');
  let segments=originalWidth?[[0,originalWidth]]:[];
  const width=()=>segments.reduce((n,[a,b])=>n+b-a,0);
  return {
    width,
    visibleToOriginal(column){
      if(!Number.isInteger(column)||column<0||column>=width())throw new RangeError('Visible column outside capture');
      let base=0;for(const [start,end]of segments){if(column<base+end-start)return start+column-base;base+=end-start;}
    },
    originalToVisible(column){
      if(!Number.isInteger(column)||column<0||column>=originalWidth||!width())throw new RangeError('Original column outside capture');
      let base=0;
      for(const [start,end]of segments){if(column<start)return Math.max(0,base-1);if(column<end)return base+column-start;base+=end-start;}
      return width()-1;
    },
    remove(first,last){
      if(!Number.isInteger(first)||!Number.isInteger(last)||first<0||last<first||last>=width())throw new RangeError('Invalid inclusive visible removal');
      const kept=[];let base=0;
      for(const [start,end]of segments){const length=end-start,left=Math.max(0,first-base),right=Math.min(length,last+1-base);
        if(right<=0||left>=length||left>=right)kept.push([start,end]);
        else{if(left>0)kept.push([start,start+left]);if(right<length)kept.push([start+right,end]);}base+=length;}
      segments=kept;return this.snapshot();
    },
    snapshot:()=>({originalWidth,width:width(),segments:segments.map(s=>s.slice())}),
  };
}

// Column-major four-lane input; filtering rounds horizontally before vertically.
export function renderCaptureTile({width,height,data,x=0,y=0,tileWidth,tileHeight,xNumerator=1,xDenominator=1,
  yNumerator=1,yDenominator=1,filter=false,reverseHorizontal=false,background=[0,0,0,0],destination=null}){
  for(const n of [width,height,tileWidth,tileHeight,xNumerator,xDenominator,yNumerator,yDenominator])if(!Number.isSafeInteger(n)||n<1)throw new RangeError('Positive bounded render dimensions/ratios required');
  if(data.length!==width*height*4||tileWidth*tileHeight>16*1024*1024||!Number.isInteger(x)||!Number.isInteger(y))throw new RangeError('Render input size mismatch');
  const scaledWidth=Math.floor((width-1)*xDenominator/xNumerator)+1,scaledHeight=Math.floor((height-1)*yDenominator/yNumerator)+1;
  const out=destination?Buffer.from(destination):Buffer.alloc(tileWidth*tileHeight*4);
  if(out.length!==tileWidth*tileHeight*4)throw new RangeError('Render destination extent differs');
  const filtered=filter&&!(xNumerator%xDenominator===0&&yNumerator%yDenominator===0);
  const pixel=(column,row,lane)=>data[(Math.max(0,Math.min(width-1,column))*height+Math.max(0,Math.min(height-1,row)))*4+lane];
  const blend=(a,b,r,d)=>Math.floor((a*(d-r)+b*r+Math.floor(d/2))/d);
  for(let row=0;row<tileHeight;row++)for(let col=0;col<tileWidth;col++){
    const ox=x+col,oy=y+row,at=(row*tileWidth+col)*4;
    if(ox<0||oy<0||ox>=scaledWidth||oy>=scaledHeight){out.set(background,at);continue;}
    const mirrored=reverseHorizontal?scaledWidth-1-ox:ox,xx=mirrored*xNumerator,yy=oy*yNumerator;
    if(filtered&&Math.floor(xx/xDenominator)+1<width){
      const a=Math.floor(xx/xDenominator),b=Math.floor(yy/yDenominator),rx=xx%xDenominator,ry=yy%yDenominator;
      for(let lane=0;lane<3;lane++)out[at+lane]=blend(blend(pixel(a,b,lane),pixel(a+1,b,lane),rx,xDenominator),blend(pixel(a,b+1,lane),pixel(a+1,b+1,lane),rx,xDenominator),ry,yDenominator);
    }else{
      const column=Math.ceil(xx/xDenominator),base=Math.floor(yy/yDenominator),remainder=yy%yDenominator;
      const sourceRow=base+(remainder>Math.floor(yDenominator/2)?1:0);
      for(let lane=0;lane<4;lane++)out[at+lane]=pixel(column,sourceRow,lane);
    }
  }
  return {width:tileWidth,height:tileHeight,channels:4,data:out,scaledWidth,scaledHeight,filtered};
}
