// Optional presentation preprocessing for a model request. Never edit the capture buffer.
export function renderLaneGuides(image, guides) {
  if (!guides?.enabled) return image;
  const {width,height,channels}=image;
  if(![1,2,3,4].includes(channels)||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||image.data.length!==width*height*channels)throw new Error('Invalid native strip');
  if(!Array.isArray(guides.rows)||guides.rows.some(r=>!Number.isFinite(r))||!/^#[0-9a-f]{6}$/i.test(guides.color||''))throw new Error('Invalid lane guides');
  const thickness=Math.max(1,Math.min(12,Math.round(guides.thickness)||1));
  const rgb=[1,3,5].map(i=>parseInt(guides.color.slice(i,i+2),16)),gray=Math.round(rgb[0]*0.299+rgb[1]*0.587+rgb[2]*0.114);
  const data=new Uint8Array(image.data);
  for(const row of new Set(guides.rows.map(Math.round))) {
    const lo=Math.max(0,row-Math.floor(thickness/2)),hi=Math.min(height,row-Math.floor(thickness/2)+thickness);
    for(let y=lo;y<hi;y++)for(let x=0;x<width;x++){
      const i=(y*width+x)*channels;
      if(channels<=2)data[i]=gray;else for(let c=0;c<3;c++)data[i+c]=rgb[c];
    }
  }
  return {...image,data};
}
