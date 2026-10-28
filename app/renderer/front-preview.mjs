// Bounded decoded-frame cache. Only the most recent requested frame may notify the view.
export class FrontFrameCache {
  constructor({load,onReady=()=>{},limit=48,concurrency=3}) {
    this.load=load;this.onReady=onReady;this.limit=limit;this.concurrency=concurrency;
    this.frames=new Map();this.pending=new Set();this.failed=new Set();this.queue=[];this.target=null;this.disposed=false;
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
        while(this.frames.size>this.limit){const key=[...this.frames.keys()].find(k=>k!==this.target);this.frames.get(key)?.close?.();this.frames.delete(key);}
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

// Each camera keeps its own row count and scan period; link the visible fractions and race-time span.
export function linkedCameraRange(view,{rows,height,width,period,timeOrigin,otherWidth}) {
  return {t0:timeOrigin+view.c0*period,spp:width*period/(view.zx*Math.max(1,otherWidth)),
    r0:Math.max(0,Math.min(1,view.r0/rows)),rv:Math.min(1,height/(view.zy*rows))};
}

export function cameraAsset(asset,roles) {
  const base=asset.cameraBase||asset,scans=base.lineScans;
  if(!scans?.length)return asset;
  const main=scans.find(s=>s.id===roles.main)||scans[0];
  const other=scans.find(s=>s.id===roles.comparison&&s.id!==main.id)||scans.find(s=>s.id!==main.id);
  return {...base,cameraBase:base,mainCameraId:main.id,mainCameraLabel:main.label,comparisonCameraId:other?.id,comparisonCameraLabel:other?.label,
    primary:main.png,primaryMeta:main.meta,primarySize:main.size,backup:other?.png||null,backupMeta:other?.meta||null};
}
