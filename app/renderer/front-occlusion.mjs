// Display-only background subtraction for a fixed frame camera. Never timing evidence.
export function frontOverlayAlpha(reference,current,width,height) {
  const count=width*height,weak=new Uint8Array(count),strong=new Uint8Array(count),foreground=new Uint8Array(count),queue=new Int32Array(count);
  const drift=[];
  for(let c=0;c<3;c++){
    const values=[];for(let i=0;i<count;i+=17)values.push(current[i*4+c]-reference[i*4+c]);
    values.sort((a,b)=>a-b);drift[c]=values[values.length>>1]||0;
  }
  for(let i=0;i<count;i++){
    const p=i*4,R=reference[p],G=reference[p+1],B=reference[p+2],r=current[p]-drift[0],g=current[p+1]-drift[1],b=current[p+2]-drift[2];
    const delta=Math.max(Math.abs(r-R),Math.abs(g-G),Math.abs(b-B));
    const norm=R*R+G*G+B*B,gain=norm?(r*R+g*G+b*B)/norm:1;
    const shadow=gain>=.55&&gain<1&&Math.max(Math.abs(r-gain*R),Math.abs(g-gain*G),Math.abs(b-gain*B))<8;
    weak[i]=delta>10;strong[i]=delta>24&&!shadow;
  }
  let end=0;
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;if(strong[i]&&strong[i-1]+strong[i+1]+strong[i-width]+strong[i+width]>=2){foreground[i]=1;queue[end++]=i;}
  }
  // Grow only through changed pixels attached to coherent foreground; fixed reference
  // keeps a slow or stationary runner from being learned into the background.
  for(let start=0;start<end;start++){
    const i=queue[start],x=i%width,y=Math.floor(i/width);
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      if(x+dx<0||x+dx>=width||y+dy<0||y+dy>=height)continue;
      const j=i+dy*width+dx;if(weak[j]&&!foreground[j]){foreground[j]=1;queue[end++]=j;}
    }
  }
  const alpha=new Uint8ClampedArray(count);alpha.fill(255);
  // One sample of padding protects anti-aliased runner edges at reduced resolution.
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(foreground[y*width+x]){
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height)alpha[(y+dy)*width+x+dx]=0;
  }
  return alpha;
}

export class FrontOverlayOcclusion {
  constructor(onReady=()=>{}) {
    this.onReady=onReady;this.key=null;this.generation=0;this.reference=null;this.loading=false;this.failed=false;this.stamp=null;this.url=null;
    this.sample=document.createElement('canvas');this.output=document.createElement('canvas');
    this.context=this.sample.getContext('2d',{willReadFrequently:true});this.out=this.output.getContext('2d');
  }
  configure(key) {
    if(this.key===key)return;
    this.key=key;this.generation++;this.reference=null;this.loading=false;this.failed=false;this.stamp=null;this.url=null;
  }
  setReference(source) {
    const w=source.videoWidth||source.naturalWidth||source.width,h=source.videoHeight||source.naturalHeight||source.height;if(!w||!h)return false;
    const scale=Math.min(1,640/Math.max(w,h));this.sample.width=Math.max(1,Math.round(w*scale));this.sample.height=Math.max(1,Math.round(h*scale));
    this.output.width=this.sample.width;this.output.height=this.sample.height;
    this.context.drawImage(source,0,0,this.sample.width,this.sample.height);
    this.reference=this.context.getImageData(0,0,this.sample.width,this.sample.height).data;
    this.stamp=null;this.url=null;this.failed=false;this.onReady();return true;
  }
  async loadReference(frameUrl,videoUrl) {
    if(this.reference||this.loading||this.failed)return;this.loading=true;const generation=this.generation;
    let video=null;
    try{
      let source;
      if(frameUrl){source=new Image();source.crossOrigin='anonymous';source.src=frameUrl;await source.decode();}
      else{
        video=document.createElement('video');video.muted=true;video.preload='auto';video.crossOrigin='anonymous';
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No background frame')),10000);video.onloadeddata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(Error('No background frame'));};video.src=videoUrl;});source=video;
      }
      if(generation===this.generation)this.setReference(source);
    }catch{if(generation===this.generation)this.failed=true;}
    finally{if(video){video.removeAttribute('src');video.load();}if(generation===this.generation){this.loading=false;this.onReady();}}
  }
  mask(source,stamp) {
    if(!this.reference||!source)return null;
    if(stamp===this.stamp&&this.url)return this.url;
    const w=this.sample.width,h=this.sample.height;this.context.drawImage(source,0,0,w,h);
    const alpha=frontOverlayAlpha(this.reference,this.context.getImageData(0,0,w,h).data,w,h),image=this.out.createImageData(w,h);
    for(let i=0;i<alpha.length;i++){image.data[i*4]=image.data[i*4+1]=image.data[i*4+2]=255;image.data[i*4+3]=alpha[i];}
    this.out.putImageData(image,0,0);this.stamp=stamp;this.url=this.output.toDataURL();return this.url;
  }
}
