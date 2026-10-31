import{columnProjection}from'../../renderer/column-map.mjs';
export function* billboardPieceInputs(){
 let seed=4813;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(const count of [0,1,2,8,32,128])for(const mode of ['original','gaps','abutting']){
  const ranges=[];let position=0;
  for(let i=0;i<count;i++){const end=position+1+Math.floor(random()*80);ranges.push([position,end]);position=end+(mode==='abutting'?0:1+Math.floor(random()*100));}
  const map=mode==='original'?undefined:columnProjection(ranges,position+10),sourceWidth=position+10;
  for(let i=0;i<300;i++){
   const view={period:i%71===0?0:.0005+random()*.02,timeOrigin:random()*30,count:sourceWidth,width:100+random()*2000,height:100+random()*1000,c0:random()*sourceWidth*.8-20,zx:i%79===0?0:.01+random()*10,r0:random()*200-30,zy:.2+random()*5,rows:1000,flip:i%2===0,map};
   if(i%3===0)view.last=random()*sourceWidth;
   const b={enabled:i%11!==0,time:random()*sourceWidth*view.period,duration:i%17===0?-1:random()*10,row:random()*1000-100,height:i%19===0?0:random()*500};
   if(i%43===0)b.time=NaN;
   if(i%47===0)b.row=Infinity;
   yield [b,view];
  }
 }
}
