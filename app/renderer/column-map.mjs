// A display projection only. Every coordinate is still an original camera column.
export function validateCropResult(result,width,mode='storage-display') {
  if(result?.schema!=='autocrop-ranges-v2'||result.original_width!==width||result.approved!==true)throw Error('Cropper result does not match this approved image');
  const value=result.modes?.[mode],padding=mode==='storage-display'?8:160,gap=mode==='storage-display'?0:320;
  if(value?.mode!==mode||value.padding!==padding||value.merge_gap_lt!==gap||!Array.isArray(value.ranges)||!Array.isArray(value.cropped_to_original))throw Error('Invalid cropper mode');
  let previous=0,index=0;
  for(const range of value.ranges){
    if(!Array.isArray(range)||range.length!==2)throw Error('Invalid kept range');
    const [start,end]=range;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<previous||start<0||end<=start||end>width)throw Error('Invalid or overlapping kept ranges');
    for(let c=start;c<end;c++)if(value.cropped_to_original[index++]!==c)throw Error('Column map does not match the kept ranges');
    previous=end;
  }
  if(index!==value.cropped_to_original.length)throw Error('Column map contains extra entries');
  return value.ranges.map(([start,end])=>[start,end]);
}
export function columnProjection(ranges,width) {
  let length=0,previous=0;
  const spans=ranges.map(([start,end])=>{
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<previous||start<0||end<=start||end>width)throw Error('Invalid display range');
    const span={start,end,displayStart:length,displayEnd:length+end-start};length=span.displayEnd;previous=end;return span;
  });
  return {width,length,spans};
}
export function displayCoordinate(map,original) {
  for(const s of map.spans)if(original>=s.start-1e-7&&original<=s.end+1e-7)return s.displayStart+Math.max(s.start,Math.min(s.end,original))-s.start;
  if(original===map.width&&map.spans.at(-1)?.end===map.width)return map.length;
  return null;
}
export function originalCoordinate(map,display) {
  if(!map.length)return null;
  const point=Math.max(0,Math.min(map.length-1e-7,display));
  const span=map.spans.find(s=>point<s.displayEnd);
  return span.start+point-span.displayStart;
}
export function visibleColumnPieces(map,start,end,width=map?.width) {
  if(!map)return end>start?[{start,end,displayStart:start,displayEnd:end}]:[];
  return map.spans.flatMap(s=>{
    const a=Math.max(start,s.displayStart),b=Math.min(end,s.displayEnd);
    return b>a?[{start:s.start+a-s.displayStart,end:s.start+b-s.displayStart,displayStart:a,displayEnd:b}]:[];
  });
}
