// One wordmark geometry for the application header and virtual LED billboards.
const GLYPH = {
  O: ['.#####.', '#######', '##...##', '##...##', '##...##', '##...##', '#######', '.#####.'],
  P: ['######.', '#######', '##...##', '#######', '######.', '##.....', '##.....', '##.....'],
  E: ['#######', '#######', '##.....', '######.', '######.', '##.....', '#######', '#######'],
  N: ['##...##', '###..##', '####.##', '#######', '##.####', '##..###', '##...##', '##...##'],
  M: ['##...##', '###.###', '#######', '##.#.##', '##...##', '##...##', '##...##', '##...##'],
  T: ['#######', '#######', '..###..', '..###..', '..###..', '..###..', '..###..', '..###..'],
};
export const LOGO_WIDTH=63,LOGO_HEIGHT=8;
export const logoPixels=[...'OPENMEET'].flatMap((ch,i)=>GLYPH[ch].flatMap((row,y)=>[...row].flatMap((px,x)=>px==='#'?[{x:i*8+x,y,part:i<4?0:1}]:[])));
export function logoMarkup(){return logoPixels.map(p=>`<rect x="${p.x}" y="${p.y}" width="1" height="1" fill="${p.part?'var(--mint)':'var(--logo)'}"/>`).join('');}
export function drawOpenMeetLogo(ctx,x,y,width){
  const scale=width/LOGO_WIDTH;ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);
  for(const p of logoPixels){ctx.fillStyle=p.part?'#45e0b0':'#9de5f6';ctx.fillRect(p.x,p.y,1,1);}ctx.restore();
}
