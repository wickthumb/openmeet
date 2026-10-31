// Display geometry and background subtraction only; no timing or identity model.
export function scanBoundaries(bands, style, height) {
  const ordered = [...bands].sort((a, b) => a.top - b.top);
  if (!ordered.length) return [];
  const edge = (above, below) => {
    const a = above && (style.positions?.[above.lane] || above);
    const b = below && (style.positions?.[below.lane] || below);
    const key = above && below ? `${above.lane}:${below.lane}` : above ? `${above.lane}:bottom` : `top:${below.lane}`;
    const fallback = a && b ? (a.bottom + b.top) / 2 : a ? a.bottom : b.top;
    return { key, above: above?.lane ?? null, below: below?.lane ?? null, row: style.boundaries?.[key] ?? fallback };
  };
  const result = [edge(null, ordered[0]), ...ordered.map((band, i) => edge(band, ordered[i + 1]))];
  // Preserve spatial order, including old profiles whose independently moved bands overlapped.
  result.forEach((b, i) => {
    const row = Number.isFinite(b.row) ? b.row : i;
    b.row = Math.max(i ? result[i - 1].row + 1 : 0, Math.min(height - result.length + i, row));
  });
  return result;
}

export function movedBoundaryRow(boundaries, index, row, height) {
  return Math.max(index ? boundaries[index - 1].row + 1 : 0,
    Math.min(index + 1 < boundaries.length ? boundaries[index + 1].row - 1 : height - 1, row));
}

const pixelIndex = (image, x, y) => (image.layout === 'rows' ? y * image.width + x : x * image.height + y) * image.channels;

// The caller supplies empty pre-roll. Keep the reference fixed: adapting it to
// foreground would eventually burn stationary/slow objects into the background.
export function scanBackground(image, sample = 24) {
  const n = Math.max(0, Math.min(Math.floor(sample), image.width));
  // Empty pre-roll has a zero reference and the same minimum noise tolerance.
  if(n===0){
    return {colors:new Uint8Array(image.height*3),tolerance:new Uint8Array(image.height).fill(18)};
  }
  const {data,width,height,channels}=image;
  const bytes=Number.isInteger(n)&&n<=0xffffffff&&Number.isInteger(width)&&Number.isInteger(height)&&Number.isInteger(channels)&&width>=0&&height>0&&channels>0
    &&(data instanceof Uint8Array||data instanceof Uint8ClampedArray)&&data.length>=width*height*channels;
  const gray=channels<3,step=image.layout==='rows'?channels:height*channels;
  // One valid sample is its own upper median, with zero absolute deviation.
  if(bytes&&n===1){
    const colors=new Uint8Array(height*3),tolerance=new Uint8Array(height).fill(18);
    for(let y=0;y<height;y++){
      const src=(image.layout==='rows'?y*width:y)*channels,ref=y*3;
      colors[ref]=data[src];colors[ref+1]=data[src+(gray?0:1)];colors[ref+2]=data[src+(gray?0:2)];
    }
    return {colors,tolerance};
  }
  // Native byte sorting is numeric. Retain the generic numeric-sort behavior
  // for incomplete buffers, other sample types and unusual geometry.
  const values=bytes?new Uint8Array(n):new Array(n),colors=new Uint8Array(height*3),tolerance=new Uint8Array(height);
  const compare=bytes?undefined:(a,b)=>a-b;
  for(let y=0;y<height;y++){
    let noise=0;
    const first=(image.layout==='rows'?y*width:y)*channels;
    for(let c=0;c<(gray?1:3);c++){
      if(bytes)for(let x=0,src=first+c;x<n;x++,src+=step)values[x]=data[src];
      else for(let x=0;x<n;x++)values[x]=data[pixelIndex(image,x,y)+(gray?0:c)];
      values.sort(compare);
      const median=values[n>>1];colors[y*3+c]=median;
      for(let x=0;x<n;x++)values[x]=Math.abs(values[x]-median);
      values.sort(compare);noise=Math.max(noise,values[n>>1]);
    }
    // Grayscale and gray+alpha repeat the same median/MAD in all RGB channels.
    if(gray)colors[y*3+1]=colors[y*3+2]=colors[y*3];
    tolerance[y]=Math.max(18,Math.min(64,noise*6));
  }
  return {colors,tolerance};
}

// Bounded one-column lookahead. The newest column is provisional; the next call
// may refine it, even when it belongs to the preceding target tile. Retain only
// three fixed column buffers and one caller-owned target, never source bytes.
function streamState(background, height) {
  let state = background._foreground;
  if (!state || state.height !== height) {
    state = background._foreground = {
      height, hist: new Uint32Array(511), offsets: new Int16Array(3),
      columns: Array.from({ length: 3 }, () => ({
        weak: new Uint8Array(height), strong: new Uint8Array(height),
        keep: new Uint8Array(height), seed: new Uint8Array(height),
        delta: new Int16Array(height * 3)
      })), left: null, pending: null, next: 0, target: null, offset: 0
    };
  }
  return state;
}

function evidence(image, x, background, state, out) {
  const h = image.height, colors = background.colors, hist = state.hist;
  const data=image.data,channels=image.channels,step=image.layout==='rows'?image.width*channels:channels;
  const base=(image.layout==='rows'?x:x*h)*channels,gOffset=channels<3?0:1,bOffset=channels<3?0:2;
  // A median signed RGB residual estimates per-column exposure/colour drift.
  // This resists sparse foreground and spikes without learning noise from pre-roll.
  for (let c = 0; c < 3; c++) {
    hist.fill(0);let minimum=510;
    for (let y = 0,src=base+(channels<3?0:c),ref=c; y < h; y++,src+=step,ref+=3) {
      const residual=data[src]-colors[ref]+255;hist[residual]++;if(residual<minimum)minimum=residual;
    }
    // Bins below the smallest observed residual are empty; the exact median is unchanged.
    let count = 0, i = h?minimum:0;
    for (; i < 510; i++) { count += hist[i]; if (count > (h >> 1)) break; }
    state.offsets[c] = i - 255;
  }
  for (let y = 0,src=base,ref=0; y < h; y++,src+=step,ref+=3) {
    const r = data[src] - state.offsets[0];
    const g = data[src + gOffset] - state.offsets[1];
    const b = data[src + bOffset] - state.offsets[2];
    const R = colors[ref], G = colors[ref + 1], B = colors[ref + 2];
    const delta = Math.max(Math.abs(r - R), Math.abs(g - G), Math.abs(b - B));
    const tolerance = background.tolerance[y];
    out.delta[ref] = r - R; out.delta[ref + 1] = g - G; out.delta[ref + 2] = b - B;
    out.weak[y] = delta > Math.max(7, tolerance / 2);
    // A neutral attenuation is evidence of shadow, not a foreground seed.
    // Leave it weak so an attached, otherwise visible limb/garment can survive.
    // Shadow classification cannot affect a pixel below the strong threshold.
    out.strong[y] = 0;
    if(delta > tolerance){
      const norm = R * R + G * G + B * B;
      const gain = norm ? (r * R + g * G + b * B) / norm : 1;
      const chroma = Math.max(Math.abs(r - gain * R), Math.abs(g - gain * G), Math.abs(b - gain * B));
      const shadow = gain >= 0.55 && gain < 1 && chroma <= 7;
      out.strong[y] = !shadow;
    }
  }
  // A five-row residual mean recovers low-contrast fabric through independent
  // noise. Require some evidence at the pixel itself to avoid expanding a clean
  // contour onto unchanged background. The spatial radius is only two rows.
  for (let y = 2; y + 2 < h; y++) {
    if (out.weak[y] || Math.max(Math.abs(out.delta[y * 3]), Math.abs(out.delta[y * 3 + 1]), Math.abs(out.delta[y * 3 + 2])) <= 4) continue;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let j = y - 2; j <= y + 2; j++) sum += out.delta[j * 3 + c];
      if (Math.abs(sum) > Math.max(6, background.tolerance[y] / 3) * 5) out.weak[y] = 1;
    }
  }
}

// The caller has already checked the middle pixel's strong evidence.
function coherentEnds(a, ay, c, cy, middle, ref, threshold, height) {
  if (!a || !c || ay < 0 || ay >= height || cy < 0 || cy >= height || !a.strong[ay] || !c.strong[cy]) return false;
  const ad=a.delta,cd=c.delta,ai=ay*3,ci=cy*3;
  return Math.abs(ad[ai]+middle[ref]+cd[ci])>threshold
    || Math.abs(ad[ai+1]+middle[ref+1]+cd[ci+1])>threshold
    || Math.abs(ad[ai+2]+middle[ref+2]+cd[ci+2])>threshold;
}

function resolve(column, left, right, height, tolerance) {
  const weak = column.weak, strong = column.strong, keep = column.keep, seed = column.seed,delta=column.delta;
  keep.fill(0); seed.fill(0);
  const sides=left&&right;
  for (let y = 0; y < height; y++) {
    if (!strong[y]) continue;
    const threshold = tolerance[y]*3,ref=y*3;
    seed[y] = coherentEnds(column,y-1,column,y+1,delta,ref,threshold,height)
      || (sides&&(coherentEnds(left,y,right,y,delta,ref,threshold,height)
      || coherentEnds(left,y-1,right,y+1,delta,ref,threshold,height)
      || coherentEnds(left,y+1,right,y-1,delta,ref,threshold,height)));
    // Rasterized one-pixel limbs form staircases rather than exact straight
    // diagonals. Require coherent support on both sides within one row.
    if (!seed[y]&&sides) for (let a = y - 1; a <= y + 1 && !seed[y]; a++) {
      for (let b = y - 1; b <= y + 1 && !seed[y]; b++) seed[y] = coherentEnds(left,a,right,b,delta,ref,threshold,height);
    }
    // A high-contrast vertical pair also supports small two-pixel details.
    if (!seed[y]) for (let j=y-1;j<=y+1;j+=2) {
      if (j < 0 || j >= height || !strong[j]) continue;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(delta[ref+c] + delta[j*3+c]) > 120) seed[y] = 1;
      }
    }
  }
  // Vertical weak components retain attached low-contrast clothing and limbs.
  // Only a local seed (or the preceding column's seed) can accept a component;
  // accepted weak noise cannot propagate indefinitely through the stream.
  for (let y = 0; y < height;) {
    if (!weak[y]) { y++; continue; }
    const first = y;
    let supported = false;
    while (y < height && weak[y]) { supported ||= !!seed[y] || !!left?.seed[y]; y++; }
    if (supported) keep.fill(1, first, y);
  }
}

function writeColumn(target, offset, column, height) {
  const keep=column.keep;
  let bit=offset*height,y=0;
  // Preserve neighbouring columns in partial bytes; write complete bytes once.
  if(bit&7){
    const shift=bit&7,n=Math.min(height,8-shift),mask=((1<<n)-1)<<shift;
    let value=0;for(;y<n;y++)value|=keep[y]<<(shift+y);
    target[bit>>3]=(target[bit>>3]&~mask)|value;bit+=n;
  }
  for(;y+7<height;y+=8,bit+=8)target[bit>>3]=keep[y]|keep[y+1]<<1|keep[y+2]<<2|keep[y+3]<<3|keep[y+4]<<4|keep[y+5]<<5|keep[y+6]<<6|keep[y+7]<<7;
  if(y<height){
    const mask=(1<<(height-y))-1;let value=0;
    for(let shift=0;y<height;y++,shift++)value|=keep[y]<<shift;
    target[bit>>3]=(target[bit>>3]&~mask)|value;
  }
}

// Display-only column-major bitmask. Use a fresh background for each stream or
// replay; consecutive calls may switch target tiles and reset columnOffset.
// Alpha is ignored. Input bytes and the fixed background reference are unchanged.
export function writeForegroundMask(target, columnOffset, image, background) {
  const state = streamState(background, image.height), h = image.height;
  // Rewriting the same target from a different position starts a replay.
  if (state.target === target && columnOffset !== state.offset + 1) {
    state.left = state.pending = null;
  }
  for (let x = 0; x < image.width; x++) {
    const current = state.columns[state.next];
    state.next = (state.next + 1) % 3;
    evidence(image, x, background, state, current);
    if (state.pending) {
      resolve(state.pending, state.left, current, h, background.tolerance);
      writeColumn(state.target, state.offset, state.pending, h);
    }
    resolve(current, state.pending, null, h, background.tolerance);
    writeColumn(target, columnOffset + x, current, h);
    state.left = state.pending;
    state.pending = current;
    state.target = target;
    state.offset = columnOffset + x;
  }
}

export function foregroundInRows(mask, column, height, firstRow, lastRow) {
  if (!mask || column < 0) return false;
  const lo=Math.max(0,firstRow),hi=Math.min(height-1,lastRow);
  if(hi<lo)return false;
  const first=column*height+lo,last=column*height+hi,a=first>>3,b=last>>3;
  const start=255<<(first&7),end=255>>>(7-(last&7));
  if(a===b)return !!(mask[a]&start&end);
  if((mask[a]&start)||(mask[b]&end))return true;
  // Whole bytes skip empty native rows without a per-pixel query.
  for(let i=a+1;i<b;i++)if(mask[i])return true;
  return false;
}
