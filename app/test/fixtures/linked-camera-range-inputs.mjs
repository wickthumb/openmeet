// Deterministic inputs cover reversed perspectives, legacy fields, duplicated
// lanes, missing/invalid calibration, focus and finish-lane subsets.
export function* linkedCameraRangeInputs() {
  let seed=18731;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
  for(const count of [0,1,2,8,16,32])for(const layout of ['normal','reversed','partial','duplicates','invalid']){
    const mainLanes=Array.from({length:count},(_,i)=>({lane:i+1,head:20+i*25,top:80+i*25,bottom:100+i*25}));
    const otherLanes=mainLanes.map((b,i)=>{const offset=(layout==='reversed'?count-1-i:i)*31;return {lane:b.lane,standing_head_row_1p80m:5+offset,top_row:95+offset,bottom_row:125+offset};});
    if(layout==='partial')otherLanes.splice(0,Math.ceil(count/2));
    if(layout==='duplicates'&&count){mainLanes.push({...mainLanes[0],head:-100});otherLanes.push({...otherLanes[0],standing_head_row_1p80m:-50});}
    if(layout==='invalid'&&count){mainLanes[0].head=Infinity;otherLanes.at(-1).standing_head_row_1p80m=otherLanes.at(-1).top_row;}
    for(let i=0;i<240;i++){
      const rows=600+Math.floor(random()*1200),height=100+random()*1000;
      const view={c0:random()*5000-100,zx:0.2+random()*5,r0:random()*rows*1.4-rows*.2,zy:i%9===0?0.1:0.5+random()*10};
      if(i%3===0)view.focusLane=Math.floor(random()*(count+2));
      const options={rows,height,width:100+random()*2000,period:random()*.004,timeOrigin:random()*100,otherWidth:i%17===0?0:100+random()*1500,otherRows:200+random()*2000,mainLanes,otherLanes};
      if(i%4===0)options.finishLanes=mainLanes.filter((_,j)=>j%2===0).map(b=>b.lane);
      if(i%19===0)options.otherLanes=undefined;
      yield [view,options];
    }
  }
  // flatMap skips holes. Keep that behavior when there is no lane calibration.
  yield [{c0:0,zx:1,r0:0,zy:5},{rows:1000,height:300,width:500,period:0.001,timeOrigin:0,otherWidth:200,mainLanes:Array(8),otherLanes:[]}];
}
