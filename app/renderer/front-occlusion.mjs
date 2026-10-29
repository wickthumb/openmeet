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

// One worker job and one replaceable snapshot; no worker ever owns timing data.
export class FrontOverlayOcclusion {
  constructor(onReady=()=>{}) {
    this.onReady=onReady;this.key=null;this.generation=0;this.reference=null;this.loading=false;this.failed=false;this.stamp=null;this.url=null;
    this.worker=null;this.inFlight=null;this.pending=null;this.requestedStamp=null;this.nextId=0;this.timer=null;
    this.playing=false;this.seeking=false;this.playbackGeneration=0;
    this.sample=document.createElement('canvas');this.context=this.sample.getContext('2d',{willReadFrequently:true});
  }
  clearUrl() {
    if(this.url)URL.revokeObjectURL(this.url);
    this.url=null;this.stamp=null;
  }
  reset() {
    this.generation++;this.worker?.terminate();this.worker=null;clearTimeout(this.timer);this.timer=null;
    this.inFlight=null;this.pending=null;this.requestedStamp=null;this.clearUrl();
    this.playing=false;this.seeking=false;this.playbackGeneration++;
    this.loading=false;this.failed=false;
  }
  configure(key) {
    if(this.key===key)return;
    this.key=key;this.reset();this.reference=null;
  }
  setReference(source) {
    const w=source.videoWidth||source.naturalWidth||source.width,h=source.videoHeight||source.naturalHeight||source.height;if(!w||!h)return false;
    // Keep precisely the previous sampling dimensions and canvas resampling path.
    const scale=Math.min(1,640/Math.max(w,h));this.sample.width=Math.max(1,Math.round(w*scale));this.sample.height=Math.max(1,Math.round(h*scale));
    this.context.drawImage(source,0,0,this.sample.width,this.sample.height);
    const reference=this.context.getImageData(0,0,this.sample.width,this.sample.height).data;
    // Also invalidate a loadReference still resolving for the same camera key.
    this.reset();this.reference=reference;this.onReady();return true;
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
  fail(worker) {
    if(worker&&worker!==this.worker)return;
    this.worker?.terminate();this.worker=null;clearTimeout(this.timer);this.timer=null;
    this.inFlight=null;this.pending=null;this.failed=true;this.clearUrl();this.onReady();
  }
  ensureWorker() {
    if(this.worker)return true;
    if(this.failed)return false;
    let worker;
    try{
      worker=new Worker(new URL('./front-occlusion-worker.mjs',import.meta.url),{type:'module'});this.worker=worker;
      worker.onmessage=event=>this.completed(worker,event.data);
      worker.onerror=event=>{event.preventDefault();this.fail(worker);};
      worker.onmessageerror=()=>this.fail(worker);
      // Transfer a copy: setReference's fixed reference stays intact on the UI side.
      const reference=this.reference.slice();
      worker.postMessage({type:'reference',generation:this.generation,width:this.sample.width,height:this.sample.height,reference:reference.buffer},[reference.buffer]);
      return true;
    }catch{this.fail(worker);return false;}
  }
  pump() {
    if(this.inFlight||!this.pending||!this.ensureWorker())return;
    const job=this.pending;this.pending=null;this.inFlight=job;
    try{
      this.worker.postMessage({type:'frame',id:job.id,generation:job.generation,stamp:job.stamp,pixels:job.pixels.buffer},[job.pixels.buffer]);
      // An unresponsive encoder cannot retain snapshots indefinitely.
      const worker=this.worker;this.timer=setTimeout(()=>this.fail(worker),10000);
    }catch{this.fail(this.worker);}
  }
  completed(worker,result) {
    if(worker!==this.worker||!this.inFlight||result.id!==this.inFlight.id||result.generation!==this.generation)return;
    const job=this.inFlight;this.inFlight=null;clearTimeout(this.timer);this.timer=null;
    if(result.error){this.fail(worker);return;}
    // A live result may trail the current video frame. Leaving continuous
    // playback invalidates that allowance, even if playback resumes immediately.
    const exact=job.stamp===this.requestedStamp;
    const continuous=this.playing&&job.playing&&job.playbackGeneration===this.playbackGeneration;
    if(!this.seeking&&(exact||continuous)&&result.stamp===job.stamp){
      try{this.clearUrl();this.url=URL.createObjectURL(result.blob);this.stamp=job.stamp;}catch{this.fail(worker);return;}
      this.onReady();
    }
    this.pump();
  }
  mask(source,stamp) {
    if(!this.reference||!source||this.failed)return null;
    const seeking=!!source.seeking,playing=!!(source.videoWidth&&!source.paused&&!seeking);
    if(playing!==this.playing||seeking!==this.seeking){
      this.playbackGeneration++;this.pending=null;
      if(!playing||seeking||this.seeking)this.clearUrl();
    }
    this.playing=playing;this.seeking=seeking;this.requestedStamp=stamp;
    if(seeking)return null;
    if(!playing&&stamp!==this.stamp)this.clearUrl();
    if(stamp===this.stamp&&this.url)return this.url;
    if(this.inFlight?.stamp===stamp){this.pending=null;return this.url;}
    if(this.pending?.stamp===stamp)return this.url;
    // A seek back to the in-flight frame replaces the queued frame without
    // capturing it again. Every other request replaces just one pending buffer.
    this.pending=null;
    try{
      const w=this.sample.width,h=this.sample.height;this.context.drawImage(source,0,0,w,h);
      this.pending={id:++this.nextId,generation:this.generation,stamp,playing,playbackGeneration:this.playbackGeneration,pixels:this.context.getImageData(0,0,w,h).data};
      this.pump();
    }catch{this.fail(this.worker);}
    return this.url;
  }
  dispose() {this.reset();this.reference=null;this.key=null;}
}
