// Display-only background subtraction for a fixed frame camera. Never timing evidence.
export function frontOverlayAlpha(reference,current,width,height) {
  const count=width*height,weak=new Uint8Array(count),strong=new Uint8Array(count);
  let hasStrong=false;
  const drift=[],histogram=count>=4096?new Uint32Array(511):null;
  for(let c=0;c<3;c++){
    if(histogram){
      // Byte residuals have only 511 possible values. Their exact upper median
      // needs one fixed histogram instead of sorting thousands of RGB samples.
      histogram.fill(0);for(let i=0;i<count;i+=17)histogram[current[i*4+c]-reference[i*4+c]+255]++;
      const middle=Math.ceil(count/17)>>1;let seen=0;
      for(let value=0;value<511;value++){seen+=histogram[value];if(seen>middle){drift[c]=value-255;break;}}
    }else{
      const values=[];for(let i=0;i<count;i+=17)values.push(current[i*4+c]-reference[i*4+c]);
      values.sort((a,b)=>a-b);drift[c]=values[values.length>>1]||0;
    }
  }
  for(let i=0;i<count;i++){
    const p=i*4,R=reference[p],G=reference[p+1],B=reference[p+2],r=current[p]-drift[0],g=current[p+1]-drift[1],b=current[p+2]-drift[2];
    const delta=Math.max(Math.abs(r-R),Math.abs(g-G),Math.abs(b-B));
    weak[i]=delta>10;
    // Shadow rejection cannot affect a pixel below the strong-change threshold.
    if(delta>24){
      const norm=R*R+G*G+B*B,gain=norm?(r*R+g*G+b*B)/norm:1;
      strong[i]=!(gain>=.55&&gain<1&&Math.max(Math.abs(r-gain*R),Math.abs(g-gain*G),Math.abs(b-gain*B))<8);
      hasStrong ||= !!strong[i];
    }
  }
  const alpha=new Uint8ClampedArray(count);alpha.fill(255);
  // With no strong seed there is no connected foreground to grow or pad.
  if(!hasStrong)return alpha;
  const foreground=new Uint8Array(count),queue=new Int32Array(count);
  let end=0;
  for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
    const i=y*width+x;if(strong[i]&&strong[i-1]+strong[i+1]+strong[i-width]+strong[i+width]>=2){foreground[i]=1;queue[end++]=i;}
  }
  // Grow only through changed pixels attached to coherent foreground; fixed reference
  // keeps a slow or stationary runner from being learned into the background.
  for(let start=0;start<end;start++){
    const i=queue[start],x=i%width,y=Math.floor(i/width);
    const left=Math.max(0,x-1),right=Math.min(width-1,x+1),top=Math.max(0,y-1),bottom=Math.min(height-1,y+1);
    for(let row=top;row<=bottom;row++)for(let j=row*width+left,last=row*width+right;j<=last;j++){
      if(weak[j]&&!foreground[j]){foreground[j]=1;queue[end++]=j;}
    }
  }
  // Dense foreground uses the same 3x3 dilation in two separable passes.
  if(end>count/8){
    // The weak buffer is no longer needed after flood growth; reuse its storage.
    for(let first=0;first<count;first+=width)for(let i=first,last=first+width;i<last;i++)weak[i]=foreground[i]||(i>first&&foreground[i-1])||(i+1<last&&foreground[i+1]);
    for(let i=0;i<count;i++)alpha[i]=weak[i]||(i>=width&&weak[i-width])||(i+width<count&&weak[i+width])?0:255;
    return alpha;
  }
  // One sample of padding protects anti-aliased runner edges at reduced resolution.

  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(foreground[y*width+x]){
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<width&&y+dy>=0&&y+dy<height)alpha[(y+dy)*width+x+dx]=0;
  }
  return alpha;
}

// Completed foreground masks are cached by source-frame stamp. Empty masks share
// a clear result; PNGs and object URLs are allocated only for actual occlusion.
export class FrontOverlayOcclusion {
  constructor(onReady=()=>{}, {limit=256,maxBytes=16*1024*1024}={}) {
    Object.assign(this,{onReady,limit,maxBytes,key:null,generation:0,reference:null,loading:false,failed:false,stamp:null,url:null,
      worker:null,inFlight:null,pending:null,backgroundPending:null,requestedStamp:null,nextId:0,timer:null,
      playing:false,seeking:false,playbackGeneration:0,bytes:0,warming:null,warmEpoch:0,waitingStamp:null,referenceLoad:null,
      decoding:null,decodePending:null,presented:null,prepared:null,requestOrder:0,publishedOrder:0});
    this.cache=new Map();this.clearFrames=new Set();this.prefetchTasks=new Map();
    this.sample=document.createElement('canvas');this.context=this.sample.getContext('2d',{willReadFrequently:true});
  }
  clearUrl(){this.url=null;this.stamp=null;}
  ready(stamp){return this.cache.has(stamp)||this.clearFrames.has(stamp);}
  presentable(stamp){return this.clearFrames.has(stamp)||!!this.cache.get(stamp)?.image;}
  releaseImage(entry){if(entry?.image){entry.image.removeAttribute('src');entry.image=null;}}
  cached(stamp){
    const entry=this.cache.get(stamp);
    if(entry){this.cache.delete(stamp);this.cache.set(stamp,entry);return entry.url;}
    if(this.clearFrames.has(stamp)){this.clearFrames.delete(stamp);this.clearFrames.add(stamp);}
    return null;
  }
  reset(){
    this.referenceLoad?.cancel();this.referenceLoad=null;
    this.decoding?.cancel();this.decoding=null;this.decodePending=null;
    this.generation++;this.warmEpoch++;this.worker?.terminate();this.worker=null;clearTimeout(this.timer);this.timer=null;
    this.inFlight=null;this.pending=null;this.backgroundPending=null;this.requestedStamp=null;this.waitingStamp=null;this.warming=null;this.prefetchTasks.clear();
    for(const entry of this.cache.values()){this.releaseImage(entry);URL.revokeObjectURL(entry.url);}
    this.presented=this.prepared=null;
    this.requestOrder=this.publishedOrder=0;
    this.cache.clear();this.clearFrames.clear();this.bytes=0;this.clearUrl();
    this.playing=false;this.seeking=false;this.playbackGeneration++;this.loading=false;this.failed=false;
  }
  configure(key){if(this.key!==key){this.key=key;this.reset();this.reference=null;}}
  setReference(source){
    const w=source.videoWidth||source.naturalWidth||source.width,h=source.videoHeight||source.naturalHeight||source.height;if(!w||!h)return false;
    const scale=Math.min(1,640/Math.max(w,h));this.sample.width=Math.max(1,Math.round(w*scale));this.sample.height=Math.max(1,Math.round(h*scale));
    this.context.drawImage(source,0,0,this.sample.width,this.sample.height);
    const reference=this.context.getImageData(0,0,this.sample.width,this.sample.height).data;
    this.reset();this.reference=reference;this.onReady();return true;
  }
  async loadReference(frameUrl,videoUrl){
    if(this.reference||this.loading||this.failed)return;this.loading=true;const generation=this.generation;let source=null,timer=null,cleaned=false;
    const cleanup=()=>{if(cleaned)return;cleaned=true;clearTimeout(timer);if(source){source.onloadeddata=source.onerror=null;if(source.removeAttribute)source.removeAttribute('src');else source.src='';if(source.load)source.load();}};
    let cancel;const cancelled=new Promise((_resolve,reject)=>{cancel=()=>{cleanup();reject(Error('Background load cancelled'));};});
    const loading=this.referenceLoad={cancel};
    try{
      if(frameUrl){source=new Image();source.crossOrigin='anonymous';source.src=frameUrl;await Promise.race([source.decode(),cancelled]);}
      else{
        source=document.createElement('video');source.muted=true;source.preload='auto';source.crossOrigin='anonymous';
        const decoded=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('No background frame')),10000);source.onloadeddata=resolve;source.onerror=()=>reject(Error('No background frame'));source.src=videoUrl;});
        await Promise.race([decoded,cancelled]);
      }
      if(generation===this.generation)this.setReference(source);
    }catch{if(generation===this.generation)this.failed=true;}
    finally{cleanup();if(this.referenceLoad===loading)this.referenceLoad=null;if(generation===this.generation){this.loading=false;this.onReady();}}
  }
  fail(worker){
    if(worker&&worker!==this.worker)return;
    this.worker?.terminate();this.worker=null;clearTimeout(this.timer);this.timer=null;
    this.decoding?.cancel();this.decoding=null;this.decodePending=null;
    for(const entry of this.cache.values())this.releaseImage(entry);
    this.presented=this.prepared=null;
    this.inFlight=null;this.pending=null;this.backgroundPending=null;this.suspendPrefetch();this.failed=true;this.clearUrl();this.onReady();
  }
  publish(job){
    // PNG decoding may finish after a newer clear result. Continuous playback
    // must never replace that result with older work; explicit revisits are valid.
    const exact=job.stamp===this.requestedStamp,continuous=this.playing&&job.playing&&job.playbackGeneration===this.playbackGeneration&&job.order>=this.publishedOrder;
    if(!this.seeking&&(exact||continuous)&&this.presentable(job.stamp)){
      const entry=this.cache.get(job.stamp),url=entry?.url||null,changed=this.stamp!==job.stamp||this.url!==url;
      if(!entry&&this.prepared===this.presented)this.prepared=null;
      if(this.presented!==entry)this.releaseImage(this.presented);
      this.presented=entry||null;this.url=this.cached(job.stamp);this.stamp=job.stamp;
      this.publishedOrder=Math.max(this.publishedOrder,exact?this.requestOrder:job.order);
      if(changed)this.onReady();
    }else if(job.stamp===this.waitingStamp)this.onReady();
  }
  prepareMask(job,entry){
    if(entry.image){this.publish(job);return;}
    if(this.decoding?.entry===entry)return;
    if(this.decoding){this.decodePending={job,entry};return;}
    if(this.prepared!==entry&&this.prepared!==this.presented){this.releaseImage(this.prepared);this.prepared=null;}
    // Decode only masks that will be displayed. Precomputation keeps compressed
    // PNGs, while at most the displayed image and its next replacement stay decoded.
    const generation=this.generation,image=new Image();let cancel,timer;
    const cancelled=new Promise((_resolve,reject)=>{
      cancel=()=>{clearTimeout(timer);image.removeAttribute('src');reject(Error('Front mask decode cancelled'));};
      timer=setTimeout(()=>reject(Error('Front mask decode timed out')),10000);
    });
    const task=this.decoding={entry,cancel};image.src=entry.url;
    Promise.race([Promise.resolve().then(()=>image.decode()),cancelled]).then(()=>{
      if(this.decoding!==task||generation!==this.generation||this.cache.get(job.stamp)!==entry)return;
      if(this.prepared!==entry&&this.prepared!==this.presented)this.releaseImage(this.prepared);
      this.prepared=entry;entry.image=image;
      this.publish(job);
    }).catch(()=>{if(this.decoding===task&&generation===this.generation)this.fail(this.worker);}).finally(()=>{
      clearTimeout(timer);
      if(entry.image!==image)image.removeAttribute('src');
      if(this.decoding!==task)return;
      this.decoding=null;const pending=this.decodePending;this.decodePending=null;
      if(pending&&this.cache.get(pending.job.stamp)===pending.entry)this.prepareMask(pending.job,pending.entry);
      this.trimCache();
    });
  }
  trimCache(){
    while(this.cache.size>this.limit||this.bytes>this.maxBytes){
      let key;
      for(const [stamp,entry]of this.cache)if(stamp!==this.stamp&&stamp!==this.requestedStamp&&stamp!==this.waitingStamp&&entry!==this.presented&&entry!==this.prepared&&entry!==this.decoding?.entry&&entry!==this.decodePending?.entry){key=stamp;break;}
      if(key==null)break;
      const entry=this.cache.get(key);this.releaseImage(entry);URL.revokeObjectURL(entry.url);this.bytes-=entry.bytes;this.cache.delete(key);
    }
  }
  ensureWorker(){
    if(this.worker)return true;if(this.failed||!this.reference)return false;
    let worker;
    try{
      worker=new Worker(new URL('./front-occlusion-worker.mjs',import.meta.url),{type:'module'});this.worker=worker;
      worker.onmessage=event=>this.completed(worker,event.data);worker.onerror=event=>{event.preventDefault();this.fail(worker);};worker.onmessageerror=()=>this.fail(worker);
      const reference=this.reference.slice();worker.postMessage({type:'reference',generation:this.generation,width:this.sample.width,height:this.sample.height,reference:reference.buffer},[reference.buffer]);return true;
    }catch{this.fail(worker);return false;}
  }
  snapshot(source,stamp,playing=false){
    const w=this.sample.width,h=this.sample.height;this.context.drawImage(source,0,0,w,h);
    return {id:++this.nextId,generation:this.generation,stamp,playing,playbackGeneration:this.playbackGeneration,order:stamp===this.requestedStamp?this.requestOrder:0,pixels:this.context.getImageData(0,0,w,h).data};
  }
  precompute(stamps,load){
    if(!this.reference||this.failed)return;
    for(const stamp of stamps.slice(0,this.limit)){
      if(this.ready(stamp)||this.inFlight?.stamp===stamp||this.pending?.stamp===stamp||this.backgroundPending?.stamp===stamp||this.warming?.stamp===stamp)continue;
      this.prefetchTasks.set(stamp,()=>load(stamp));
    }
    while(this.prefetchTasks.size>this.limit)this.prefetchTasks.delete(this.prefetchTasks.keys().next().value);
    this.pump();
  }
  suspendPrefetch(){this.warmEpoch++;this.prefetchTasks.clear();this.backgroundPending=null;}
  warmNext(){
    if(this.warming||!this.prefetchTasks.size||this.failed)return;
    const [stamp,load]=this.prefetchTasks.entries().next().value;this.prefetchTasks.delete(stamp);
    if(this.ready(stamp)){queueMicrotask(()=>this.pump());return;}
    const task=this.warming={stamp,generation:this.generation,epoch:this.warmEpoch};
    Promise.resolve().then(load).then(entry=>{
      try{if(this.warming===task&&task.generation===this.generation&&task.epoch===this.warmEpoch&&!this.ready(stamp)&&this.pending?.stamp!==stamp&&this.inFlight?.stamp!==stamp)this.backgroundPending=this.snapshot(entry.source||entry,stamp);}
      finally{entry.release?.();}
    }).catch(()=>{}).finally(()=>{if(this.warming===task)this.warming=null;this.pump();});
  }
  pump(){
    if(this.inFlight||this.failed)return;
    let job=this.pending||this.backgroundPending;
    if(!job){this.warmNext();return;}
    if(this.pending===job)this.pending=null;else this.backgroundPending=null;
    if(this.ready(job.stamp)){queueMicrotask(()=>this.pump());return;}
    if(!this.ensureWorker())return;this.inFlight=job;
    try{this.worker.postMessage({type:'frame',id:job.id,generation:job.generation,stamp:job.stamp,pixels:job.pixels.buffer},[job.pixels.buffer]);const worker=this.worker;this.timer=setTimeout(()=>this.fail(worker),10000);}
    catch{this.fail(this.worker);}
  }
  completed(worker,result){
    if(worker!==this.worker||!this.inFlight||result.id!==this.inFlight.id||result.generation!==this.generation)return;
    const job=this.inFlight;this.inFlight=null;clearTimeout(this.timer);this.timer=null;
    if(result.error||result.stamp!==job.stamp){this.fail(worker);return;}
    try{
      if(result.clear===true){this.clearFrames.add(job.stamp);while(this.clearFrames.size>2048)this.clearFrames.delete(this.clearFrames.values().next().value);}
      else{
        if(!(result.blob instanceof Blob))throw Error('Missing front mask');
        const entry={url:URL.createObjectURL(result.blob),bytes:result.blob.size};this.cache.set(job.stamp,entry);this.bytes+=entry.bytes;
      }
      const wanted=job.stamp===this.requestedStamp||job.stamp===this.waitingStamp||(this.playing&&job.playing&&job.playbackGeneration===this.playbackGeneration);
      if(result.clear===true)this.publish(job);
      else if(wanted)this.prepareMask(job,this.cache.get(job.stamp));
      this.trimCache();
    }catch{this.fail(worker);return;}
    this.pump();
  }
  mask(source,stamp){
    if(!this.reference||!source)return null;
    const seeking=!!source.seeking,playing=!!(source.videoWidth&&!source.paused&&!seeking);
    if(stamp!==this.requestedStamp||playing!==this.playing||seeking!==this.seeking)this.requestOrder++;
    if(playing!==this.playing||seeking!==this.seeking){this.playbackGeneration++;this.pending=null;if(!playing||seeking||this.seeking)this.clearUrl();}
    this.playing=playing;this.seeking=seeking;this.requestedStamp=stamp;
    if(seeking)return null;
    if(this.failed)return null;
    if(this.ready(stamp)){
      if(!playing&&stamp!==this.stamp)this.clearUrl();
      const job={stamp,playing,playbackGeneration:this.playbackGeneration,order:this.requestOrder},entry=this.cache.get(stamp);
      if(entry)this.prepareMask(job,entry);else this.publish(job);
      return this.url;
    }
    if(!playing&&stamp!==this.stamp)this.clearUrl();
    if(this.inFlight?.stamp===stamp){this.pending=null;return this.url;}
    if(this.pending?.stamp===stamp)return this.url;
    this.prefetchTasks.delete(stamp);
    if(this.backgroundPending?.stamp===stamp){this.pending=this.backgroundPending;this.backgroundPending=null;}
    else try{this.pending=this.snapshot(source,stamp,playing);}catch{this.fail(this.worker);return null;}
    this.pump();return this.url;
  }
  dispose(){this.reset();this.reference=null;this.key=null;this.sample.width=this.sample.height=0;}
}
