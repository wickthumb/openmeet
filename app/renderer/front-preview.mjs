// Bounded decoded-frame cache. Only the most recent requested frame may notify the view.
export function containedImageRect(width,height,imageWidth,imageHeight) {
  if(!width||!height||!imageWidth||!imageHeight)return {x:0,y:0,width:width||0,height:height||0};
  const scale=Math.min(width/imageWidth,height/imageHeight),w=imageWidth*scale,h=imageHeight*scale;
  return {x:(width-w)/2,y:(height-h)/2,width:w,height:h};
}

export class FrontFrameCache {
  constructor({load,onReady=()=>{},limit=48,concurrency=3}) {
    this.load=load;this.onReady=onReady;this.limit=limit;this.concurrency=concurrency;
    this.frames=new Map();this.pending=new Set();this.failed=new Set();this.queue=[];this.target=null;this.disposed=false;
    this.pinned=null;
  }
  get(index) {
    const value=this.frames.get(index);
    if(value){this.frames.delete(index);this.frames.set(index,value);}
    return value;
  }
  request(index,count) {
    if(this.disposed)return;
    this.target=index;
    this.queue=[index];
    for(let n=1;n<=8;n++)this.queue.push(index+n,index-n);
    this.queue=this.queue.filter(i=>i>=0&&i<count&&!this.frames.has(i)&&!this.pending.has(i)&&!this.failed.has(i));
    this.pump();
  }
  pump() {
    while(!this.disposed&&this.pending.size<this.concurrency&&this.queue.length) {
      const index=this.queue.shift();this.pending.add(index);
      Promise.resolve().then(()=>this.load(index)).then(value=>{
        if(this.disposed){value.close?.();return;}
        this.frames.set(index,value);
        while(this.frames.size>this.limit){
          let key;
          for(const candidate of this.frames.keys())if(candidate!==this.target&&candidate!==this.pinned){key=candidate;break;}
          if(key==null)break;this.frames.get(key)?.close?.();this.frames.delete(key);
        }
        if(index===this.target)this.onReady(index);
      }).catch(()=>{if(!this.disposed){this.failed.add(index);if(index===this.target)this.onReady(index);}}).finally(()=>{this.pending.delete(index);this.pump();});
    }
  }
  dispose() {
    this.disposed=true;this.queue=[];
    for(const frame of this.frames.values())frame.close?.();
    this.frames.clear();
  }
}

export function cameraLaneBody(bands,lane) {
  const band=bands?.find(b=>b.lane===lane);if(!band)return null;
  const head=band.standing_head_row_1p80m??band.head;
  const feet=((band.top_row??band.top)+(band.bottom_row??band.bottom))/2;
  if(!Number.isFinite(head)||!Number.isFinite(feet)||feet-head<2)return null;
  return {lane,head,feet,height:feet-head,center:head+(feet-head)*0.45};
}

// Race time is common; vertical percentages alone do not match opposite camera perspectives.
export function linkedCameraRange(view,{rows,height,width,period,timeOrigin,otherWidth,otherRows=rows,mainLanes,otherLanes,finishLanes}) {
  const span=height/view.zy,top=view.r0,center=top+span/2;
  const result={t0:timeOrigin+view.c0*period,spp:width*period/(view.zx*Math.max(1,otherWidth)),
    r0:Math.max(0,Math.min(1,top/rows)),rv:Math.min(1,span/rows)};
  if(span>=rows-0.5)return result;
  const pairs=[];
  const lanes=mainLanes||[];
  for(let i=0;i<lanes.length;i++){
    if(!(i in lanes))continue;
    const b=lanes[i],main=cameraLaneBody(mainLanes,b.lane),other=cameraLaneBody(otherLanes,b.lane);
    if(main&&other)pairs.push({main,other});
  }
  if(!pairs.length)return result;
  const focused=pairs.find(p=>p.main.lane===view.focusLane&&p.main.feet>=top&&p.main.head<=top+span);
  let visible=pairs.filter(p=>(!finishLanes?.length||finishLanes.includes(p.main.lane))&&p.main.center>=top&&p.main.center<=top+span);
  if(focused)visible=[focused];
  if(!visible.length)visible=[pairs.reduce((best,p)=>Math.abs(p.main.center-center)<Math.abs(best.main.center-center)?p:best)];
  const scales=visible.map(p=>p.other.height/p.main.height).sort((a,b)=>a-b),scale=scales[scales.length>>1];
  let targetCenter,targetSpan=span*scale;
  if(visible.length===1) {
    const p=visible[0];targetCenter=p.other.head+(center-p.main.head)*scale;
  } else {
    visible.sort((a,b)=>a.main.center-b.main.center);
    const mainCenter=(visible[0].main.center+visible.at(-1).main.center)/2;
    const positions=visible.map(p=>p.other.center),lo=Math.min(...positions),hi=Math.max(...positions);
    const direction=Math.sign(visible.at(-1).other.center-visible[0].other.center)||1;
    targetCenter=(lo+hi)/2+(center-mainCenter)*scale*direction;
    // Keep every reviewed runner in the crop even when lane order or perspective reverses.
    targetSpan=Math.max(targetSpan,2*Math.max(Math.abs(lo-targetCenter),Math.abs(hi-targetCenter))+targetSpan*0.15);
  }
  if(targetSpan>=otherRows)return {...result,r0:0,rv:1};
  // Padding outside the sensor keeps an edge runner centered instead of silently shifting the crop.
  return {...result,r0:(targetCenter-targetSpan/2)/otherRows,rv:targetSpan/otherRows};
}

export function cameraAsset(asset,roles) {
  const base=asset.cameraBase||asset,scans=base.lineScans;
  if(!scans?.length)return asset;
  const main=scans.find(s=>s.id===roles.main)||scans[0];
  const other=scans.find(s=>s.id===roles.comparison&&s.id!==main.id)||scans.find(s=>s.id!==main.id);
  return {...base,cameraBase:base,mainCameraId:main.id,mainCameraLabel:main.label,comparisonCameraId:other?.id,comparisonCameraLabel:other?.label,
    primary:main.png,primaryMeta:main.meta,primarySize:main.size,backup:other?.png||null,backupMeta:other?.meta||null};
}
