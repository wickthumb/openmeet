import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as candidate from '../renderer/scan-overlays.mjs';
const {scanBackground,writeForegroundMask}=candidate;
const W=320,H=160;
function reference(channels=3,width=W,height=H){
 const data=new Uint8Array(width*height*channels);
 for(let x=0;x<width;x++)for(let y=0;y<height;y++){
  const base=95+(y*7%35);
  for(let c=0;c<channels;c++)data[(x*height+y)*channels+c]=c===3?255:channels===1?base:base+[0,24,39][c];
 }
 return {data,width,height,channels};
}
function copy(im){return {...im,data:im.data.slice()};}
function rows(im){const data=new Uint8Array(im.data.length);for(let x=0;x<im.width;x++)for(let y=0;y<im.height;y++)for(let c=0;c<im.channels;c++)data[(y*im.width+x)*im.channels+c]=im.data[(x*im.height+y)*im.channels+c];return {...im,data,layout:'rows'};}
function chunk(im,start,width){
 if(im.layout!=='rows')return {...im,width,data:im.data.subarray(start*im.height*im.channels,(start+width)*im.height*im.channels)};
 const data=new Uint8Array(width*im.height*im.channels);for(let y=0;y<im.height;y++)data.set(im.data.subarray((y*im.width+start)*im.channels,(y*im.width+start+width)*im.channels),y*width*im.channels);
 return {...im,width,data};
}
function mask(im,ref=reference(im.channels,im.width,im.height),api=candidate){const out=new Uint8Array(Math.ceil(im.width*im.height/8));api.writeForegroundMask(out,0,im,api.scanBackground(ref));return out;}
function get(m,x,y,h=H){const b=x*h+y;return (m[b>>3]>>(b&7))&1;}
function count(m,w=W,h=H){let n=0;for(let x=0;x<w;x++)for(let y=0;y<h;y++)n+=get(m,x,y,h);return n;}
function stats(m,truth,w=W,h=H){let tp=0,fp=0,n=0;for(let x=0;x<w;x++)for(let y=0;y<h;y++){const t=truth[x*h+y],v=get(m,x,y,h);n+=!!t;tp+=!!t&&!!v;fp+=!t&&!!v;}return {recall:tp/n,precision:tp/(tp+fp),fp,tp,n};}
function marginErrors(m,truth,radius=2){let outside=0,fp=0;for(let x=0;x<W;x++)for(let y=0;y<H;y++)if(get(m,x,y)&&!truth[x*H+y]){fp++;let near=false;for(let a=Math.max(0,x-radius);a<=Math.min(W-1,x+radius);a++)for(let b=Math.max(0,y-radius);b<=Math.min(H-1,y+radius);b++)near ||= !!truth[a*H+b];outside+=!near;}return {fp,outside};}
function rng(seed=4517){let a=seed;return ()=>{a=(1664525*a+1013904223)>>>0;return (a+.5)/4294967296;};}
function noisy(im,sd=7){const random=rng();for(let i=0;i<im.data.length;i++){if(im.channels===4&&i%4===3)continue;const n=Math.sqrt(-2*Math.log(random()))*Math.cos(2*Math.PI*random())*sd;im.data[i]=Math.max(0,Math.min(255,Math.round(im.data[i]+n)));}return im;}
function scene(channels=3){
 const ref=reference(channels),im=copy(ref),truth=new Uint8Array(W*H),thin=new Uint8Array(W*H),clothing=new Uint8Array(W*H);
 const put=(x,y,color,kind)=>{if(x<0||x>=W||y<0||y>=H)return;truth[x*H+y]=1;if(kind)kind[x*H+y]=1;for(let c=0;c<channels;c++)if(c!==3)im.data[(x*H+y)*channels+c]=color[c%color.length];};
 const rect=(x0,x1,y0,y1,color,kind)=>{for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++)put(x,y,color,kind);};
 const line=(x0,y0,x1,y1,color,kind,radius=0)=>{const n=Math.max(Math.abs(x1-x0),Math.abs(y1-y0));for(let i=0;i<=n;i++){const x=Math.round(x0+(x1-x0)*i/n),y=Math.round(y0+(y1-y0)*i/n);rect(x-radius,x+radius,y-radius,y+radius,color,kind);}};
 // Head, torso and articulated legs. One-pixel arms/legs have no 3x3 area.
 rect(106,124,42,59,[211,158,91]);rect(103,128,60,90,[32,45,207]);
 line(105,62,83,72,[211,158,91],thin);line(83,72,67,57,[211,158,91],thin);
 line(124,65,145,77,[211,158,91],thin);line(145,77,163,65,[211,158,91],thin);
 line(109,91,91,112,[211,158,91],thin,1);line(91,112,72,125,[211,158,91],thin);
 line(123,91,138,113,[211,158,91],thin,1);line(138,113,159,122,[211,158,91],thin);
 // Clothing only 14 levels away, connected vertically to a visible head.
 rect(201,221,42,59,[211,158,91]);
 for(let x=201;x<=221;x++)for(let y=60;y<=88;y++){
  const at=(x*H+y)*channels;const color=channels===1?[ref.data[at]+14]:[ref.data[at]+14,ref.data[at+1]+2,ref.data[at+2]-5];put(x,y,color,clothing);
 }
 line(204,89,192,116,[211,158,91],thin);line(218,89,235,118,[211,158,91],thin);
 // A second athlete overlaps the first torso and arm; union is known exactly.
 rect(119,137,68,96,[192,38,44]);line(132,97,149,116,[211,158,91],thin);
 return {ref,im,truth,thin,clothing};
}

test('isolated RGB spikes are rejected even with identical pre-roll',()=>{
 const ref=reference(),im=copy(ref);for(let x=35;x<300;x+=11)im.data[(x*H+(x*13%H))*3]=255;
 const before=im.data.slice();assert.equal(count(mask(im,ref)),0);assert.deepEqual(im.data,before);
});
test('moderate independent sensor noise is suppressed without a noisy reference',()=>{
 const ref=reference(),im=noisy(copy(ref));const now=count(mask(im,ref));
 assert.ok(now/(W*H)<.001);
});
test('uniform colour shifts and gradual per-column lighting do not erase guides',()=>{
 const ref=reference();for(const gradual of [false,true]){
  const im=copy(ref);for(let x=0;x<W;x++)for(let y=0;y<H;y++)for(let c=0;c<3;c++)im.data[(x*H+y)*3+c]+=Math.round((gradual?x/(W-1):1)*[33,24,19][c]);
  assert.equal(count(mask(im,ref)),0);
 }
});
test('uniform gain plus offset also preserves textured empty track',()=>{
 const ref=reference();for(const gain of [.75,1.25]){const im=copy(ref);for(let i=0;i<im.data.length;i++)im.data[i]=Math.round(im.data[i]*gain+8);assert.equal(count(mask(im,ref)),0);}
});
test('local neutral cast shadow on textured track is not a foreground seed',()=>{
 const ref=reference(),im=copy(ref);for(let x=40;x<280;x++)for(let y=93;y<148;y++){
  const d=Math.max(0,1-((x-160)/120)**2-((y-120)/28)**2),gain=1-.35*d;
  for(let c=0;c<3;c++)im.data[(x*H+y)*3+c]=Math.round(im.data[(x*H+y)*3+c]*gain);
 }
 assert.equal(count(mask(im,ref)),0);
});
test('connected runners, one-pixel limbs, low contrast clothing, overlaps stay visible with a tight contour',()=>{
 const {im,ref,truth,thin,clothing}=scene();const before=im.data.slice(),m=mask(im,ref);
 for(const [label,t,min] of [['union',truth,.97],['thin limbs',thin,.94],['clothing',clothing,.98]]){const s=stats(m,t);assert.ok(s.recall>=min,`${label}: ${JSON.stringify(s)}`);}
 console.log('clean silhouette',JSON.stringify({union:stats(m,truth),thinRecall:stats(m,thin).recall,clothingRecall:stats(m,clothing).recall,margin:marginErrors(m,truth)}));assert.ok(stats(m,truth).precision>.995,JSON.stringify(stats(m,truth)));assert.deepEqual(im.data,before);
});
test('visible runners survive moderate noise and lighting while empty distant track stays clear',()=>{
 const {im,ref,truth,thin,clothing}=scene();noisy(im,5);
 for(let x=0;x<W;x++)for(let y=0;y<H;y++)for(let c=0;c<3;c++)im.data[(x*H+y)*3+c]+=Math.round(x/W*24);
 const m=mask(im,ref),s=stats(m,truth),visible=truth.map((v,i)=>v&&!clothing[i]?1:0),margin=marginErrors(m,truth);
 console.log('noisy lit silhouette',JSON.stringify({union:s,thinRecall:stats(m,thin).recall,clothingRecall:stats(m,clothing).recall,visibleRecall:stats(m,visible).recall,margin}));
 assert.ok(s.recall>.94,JSON.stringify(s));assert.ok(stats(m,visible).recall>.98);
 assert.ok(stats(m,thin).recall>.98);assert.ok(stats(m,clothing).recall>.70);
 assert.ok(margin.outside<60,JSON.stringify(margin));

});
test('whole image, 64-column chunks, separate tiles, row-major and partial-bit offsets agree exactly',()=>{
 for(const channels of [1,3,4]){
  const {im,ref}=scene(channels);const baseline=mask(im,ref);assert.deepEqual(mask(rows(im),rows(ref)),baseline);
  const h=im.height,offset=3,joined=new Uint8Array(Math.ceil((W+offset)*h/8)).fill(255),bg=scanBackground(chunk(ref,0,24));
  for(let x=0;x<W;x+=64)writeForegroundMask(joined,offset+x,chunk(im,x,Math.min(64,W-x)),bg);
  for(let x=0;x<W;x++)for(let y=0;y<h;y++)assert.equal(get(joined,x+offset,y,h),get(baseline,x,y,h));
  for(let x=0;x<offset;x++)for(let y=0;y<h;y++)assert.equal(get(joined,x,y,h),1);
  const tiles=[],background=scanBackground(ref);
  for(let x=0;x<W;x+=64){const n=Math.min(64,W-x),m=new Uint8Array(Math.ceil(n*h/8));tiles.push(m);writeForegroundMask(m,0,chunk(rows(im),x,n),background);}
  for(let x=0;x<W;x++)for(let y=0;y<h;y++)assert.equal(get(tiles[x>>6],x%64,y,h),get(baseline,x,y,h),`${channels} at ${x},${y}`);
 }
 // Height not divisible by eight exercises neighbouring columns sharing bytes.
 const ref=reference(3,139,37),im=copy(ref);for(let x=61;x<68;x++)for(let y=4;y<13;y++)im.data[(x*37+y)*3]=240;
 const expected=mask(im,ref),out=new Uint8Array(expected.length),bg=scanBackground(ref);
 for(let x=0;x<139;x+=64)writeForegroundMask(out,x,chunk(im,x,Math.min(64,139-x)),bg);
 assert.deepEqual(out,expected);
});
test('RGB, RGBA (ignored alpha), grayscale and continuous one-column input work',()=>{
 for(const channels of [1,3,4]){
  const {im,ref,truth}=scene(channels);if(channels===4)for(let i=3;i<im.data.length;i+=4)im.data[i]=i%256;
  const expected=mask(im,ref),out=new Uint8Array(expected.length),bg=scanBackground(ref);
  for(let x=0;x<W;x++)writeForegroundMask(out,x,chunk(im,x,1),bg);
  assert.deepEqual(out,expected);assert.ok(stats(out,truth).recall>.93,`${channels}: ${JSON.stringify(stats(out,truth))}`);
 }
});
test('state is bounded after many target tiles and does not retain source images',()=>{
 const ref=reference(3,64,37),bg=scanBackground(ref);for(let i=0;i<100;i++)writeForegroundMask(new Uint8Array(Math.ceil(64*37/8)),0,ref,bg);
 const st=bg._foreground;
 let bytes=0;const seen=new Set();function walk(v){if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(ArrayBuffer.isView(v)){bytes+=v.byteLength;return;}for(const a of Object.values(v))walk(a);}walk(bg);
 assert.ok(bytes<37*40+3000,`${bytes}`);assert.ok(!Object.values(st).includes(ref.data));
});
