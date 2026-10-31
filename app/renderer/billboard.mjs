// Presentation-only geometry and mask compositing. No capture or timing writes.
import {visibleColumnPieces,originalCoordinate} from './column-map.mjs';
import {foregroundInRows} from './scan-overlays.mjs';
import {drawOpenMeetLogo,LOGO_WIDTH,LOGO_HEIGHT} from './openmeet-logo.mjs';
const finite=(n,fallback)=>Number.isFinite(n)?n:fallback;
export function billboardSettings(saved={},context={}) {
  if(!saved||typeof saved!=='object'||Array.isArray(saved))saved={};
  const rows=context.rows||480,period=context.period||.00125;
  return {id:typeof saved.id==='string'?saved.id:'openmeet',label:typeof saved.label==='string'?saved.label:'OpenMeet + meet name',enabled:saved.enabled===true,edit:saved.edit===true,text:typeof saved.text==='string'?saved.text:'',
    color:/^#[a-f0-9]{6}$/i.test(saved.color)?saved.color:'#102c48',
    textColor:/^#[a-f0-9]{6}$/i.test(saved.textColor)?saved.textColor:'#ffffff',
    mode:saved.mode==='art'?'art':'basic',name:saved.name||'',logo:saved.logo||null,
    time:finite(saved.time,0),duration:Math.max(period*4,finite(saved.duration,rows*.64*period)),
    row:Math.max(0,Math.min(rows-1,finite(saved.row,rows*.08))),height:Math.max(1,Math.min(rows,finite(saved.height,rows*.08)))};
}
export function billboardCollection(saved,context={}){
  const items=(saved?.version===2&&Array.isArray(saved.items)?saved.items:[saved||{}]).map((item,i)=>billboardSettings({...item,id:item?.id||`billboard-${i+1}`},context));
  const unique=items.filter((item,i)=>items.findIndex(other=>other.id===item.id)===i);
  return {version:2,selected:unique.some(item=>item.id===saved?.selected)?saved.selected:unique[0]?.id||null,items:unique};
}
// One repeating band extends through ALL received columns, with its texture phase
// anchored to original source time. Hidden gaps never restart or stretch it.
export function billboardPieces(b,view) {
  const {period,timeOrigin,count,width,height,c0,zx,r0,zy,flip,map,last=count}=view;
  if(!b.enabled||!(period>0)||!(b.duration>0)||!(b.height>0))return [];
  const start=(b.time-timeOrigin)/period,tile=b.duration/period;
  const top=(b.row-r0)*zy,bottom=top+b.height*zy;
  if(bottom<=0||top>=height)return [];
  const pieces=[];
  for(const piece of visibleColumnPieces(map,Math.max(0,c0),Math.min(map?.length??count,c0+width/zx),count)){
    const a=Math.max(0,piece.start),z=Math.min(piece.end,last);
    if(z<=a)continue;
    const left=(piece.displayStart+a-piece.start-c0)*zx,w=(z-a)*zx;
    const u=((a-start)/tile%1+1)%1;
    pieces.push({x:flip?width-left-w:left,y:top,w,h:bottom-top,u,uw:(z-a)/tile,flip,start:a,end:z});
  }
  return pieces;
}
export function billboardPoint(x,y,view) {
  const display=view.c0+(view.flip?view.width-x:x)/view.zx;
  const column=view.map?originalCoordinate(view.map,display):display;
  return {time:view.timeOrigin+column*view.period,row:view.r0+y/view.zy};
}
export function moveBillboard(b,from,to,resize,view) {
  const dt=to.time-from.time,dr=to.row-from.row;
  return resize?{...b,duration:Math.max(view.period*4,b.duration+dt),height:Math.max(1,Math.min(view.rows-b.row,b.height+dr))}
    :{...b,time:b.time+dt,row:Math.max(0,Math.min(view.rows-b.height,b.row+dr))};
}
// No matching mask => leave original pixels visible. Conservative row/column
// footprints protect compressed runner edges; only the decorative layer changes.
export function maskBillboard(image,rects,columnsAt,rowAt,rows) {
  for(const r of rects){
    const x0=Math.max(0,Math.floor(r.x)),x1=Math.min(image.width,Math.ceil(r.x+r.w));
    const y0=Math.max(0,Math.floor(r.y)),y1=Math.min(image.height,Math.ceil(r.y+r.h));
    for(let x=x0;x<x1;x++){
      const columns=columnsAt(x,x+1);
      // Empty native row bands need no per-pixel work. Most artwork columns
      // contain only background, including during live follow.
      if(columns.length&&!columns.some(c=>foregroundInRows(c.mask,c.column,rows,Math.max(0,Math.floor(rowAt(y0))-2),Math.min(rows-1,Math.ceil(rowAt(y1))+2))))continue;
      for(let y=y0;y<y1;y++){
        const lo=Math.max(0,Math.floor(rowAt(y))-2),hi=Math.min(rows-1,Math.ceil(rowAt(y+1))+2);
        if(!columns.length||columns.some(c=>foregroundInRows(c.mask,c.column,rows,lo,hi)))image.data[(y*image.width+x)*4+3]=0;
      }
    }
  }
  return image;
}
export const BILLBOARD_PAD=192;
export function billboardCacheKey(b,v){return JSON.stringify([b,v.width,v.height,v.zx,v.r0,v.zy,v.rows,v.flip,v.map,v.period,v.timeOrigin,v.count,v.maskLast,v.revision]);}
export function billboardCacheOffset(cache,v){return -(v.c0-cache.c0)*v.zx*(v.flip?-1:1);}
export function reusableBillboardCache(cache,key,v){return cache?.key===key&&Math.abs(billboardCacheOffset(cache,v))<BILLBOARD_PAD*.75;}
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;};
export class BillboardConsole {
  constructor({bridge,store,context,changed,toast,place,finishPlacing,open}) {
    Object.assign(this,{bridge,store,context,changed,toast,place,finishPlacing,open});this.images=new Map();this.imageLoads=new Map();this.list=[];this.busy=false;this.log='';this.snapshots=new Map();this.paintCaches=new Map();
    this.editor=document.querySelector('#billboardEditor');
    bridge?.on('billboard.agentOutput',d=>{if(d.name===this.building){this.log=(this.log+'\n'+d.line).slice(-16000);const box=document.querySelector('#billboardLog');if(box)box.textContent=this.log;}});
  }
  key(){return `billboard:${this.context().scope}`;}
  collection(){return billboardCollection(this.store.get(this.key(),null),this.context());}
  settings(){const c=this.collection();return c.items.find(b=>b.id===c.selected)||null;}
  placeSelected(center=false){
    const current=this.settings();if(!current)return;
    const c=this.context(),top=c.centerRow-c.visibleRows/2,bottom=c.centerRow+c.visibleRows/2;
    const outside=current.row+current.height<=top||current.row>=bottom;
    this.save({...current,enabled:true,...(center||outside?{row:Math.max(0,Math.min(c.rows-current.height,c.centerRow-current.height/2))}:{})});
    this.renderList();this.place?.();
  }
  hasUnsavedPrompt(){const id=this.settings()?.id,prompt=this.prompts?.get(id)?.trim();return !this.busy&&!!prompt&&prompt!==this.submittedPrompts?.get(id);}
  discardPrompt(){this.prompts?.delete(this.settings()?.id);const input=document.getElementById('billboard-prompt');if(input)input.value='';}
  hasEnabled(){return this.collection().items.some(b=>b.enabled);}
  save(b){const c=this.collection();c.items=c.items.map(item=>item.id===b.id?b:item);this.store.set(this.key(),c);this.changed();}
  saveCollection(c){this.store.set(this.key(),c);this.paintCaches.clear();this.changed();}
  add(){const c=this.collection(),n=c.items.length+1,b=billboardSettings({id:crypto.randomUUID(),label:`Billboard ${n}`,enabled:true,row:Math.min(this.context().rows*.8,this.context().rows*(.08+.12*c.items.length))},this.context());c.items.push(b);c.selected=b.id;this.saveCollection(c);}
  remove(id){const c=this.collection();this.removed={scope:this.key(),collection:structuredClone(c)};c.items=c.items.filter(b=>b.id!==id);if(c.selected===id)c.selected=c.items[0]?.id||null;this.saveCollection(c);}
  async loadImage(name,asset='assets/billboard.svg',refresh=false){
    const key=name+'/'+asset;if(refresh){this.images.delete(key);this.paintCaches.clear();}
    if(this.images.has(key))return this.images.get(key);
    const load={};this.images.set(key,null);this.imageLoads.set(key,load);
    try {
      const {dataUrl}=await this.bridge.call('billboard.read',{name,asset});
      if(this.imageLoads.get(key)!==load)return this.images.get(key)||null;
      const image=new Image();image.src=dataUrl;await image.decode();
      if(this.imageLoads.get(key)!==load)return this.images.get(key)||null;
      this.images.set(key,image);this.paintCaches.clear();this.previewKey=null;this.changed();return image;
    }
    catch(error){if(this.imageLoads.get(key)===load)this.toast('Billboard image unavailable: '+error.message,true);return null;}
    finally{if(this.imageLoads.get(key)===load)this.imageLoads.delete(key);}
  }
  forgetImages(name){for(const key of this.images.keys())if(key.startsWith(name+'/')){this.images.delete(key);this.imageLoads.delete(key);}}
  image(name,asset){const key=name+'/'+asset;if(!this.images.has(key)&&this.bridge)this.loadImage(name,asset);return this.images.get(key);}
  paint(g,view,columnsAt){
    const selected=this.settings();if(selected)this.syncEditor(selected,billboardPieces(selected,view),view);else this.editor.hidden=true;
    this.renderPlacementTools(selected,view);
    const status=document.querySelector('#billboardMaskStatus');if(status)status.textContent=view.maskStatus;
    this.updatePreview();
    for(const b of this.collection().items)this.paintOne(g,view,columnsAt,b);
  }
  renderPlacementTools(b,view){
    if(!this.placementTools){const bar=el('div',null,'billboard-placement-tools');bar.id='billboardPlacementTools';bar.onkeydown=e=>e.stopPropagation();this.placementTitle=el('span');bar.append(this.placementTitle);
      for(const [label,action]of [['Edit design',()=>this.open?.()],['Done',()=>this.finishPlacing?.()]]){const button=el('button',label,'btn sm');button.dataset.placement=label==='Done'?'done':'edit';button.onclick=action;bar.append(button);}this.editor.parentNode.append(bar);this.placementTools=bar;}
    this.placementTools.hidden=!b||!this.context().placing||view.framing;this.placementTitle.textContent=b?`Positioning: ${b.label}`:'';
  }
  textureFor(b){
    const texture=document.createElement('canvas');texture.width=1200;texture.height=160;const t=texture.getContext('2d');
    const art=b.mode==='art'?this.image(b.name,'assets/billboard.svg'):null;if(b.mode==='art'&&!art)return null;
    if(art)t.drawImage(art,0,0,1200,160);
    else {
      t.fillStyle=b.color;t.fillRect(0,0,1200,160);
      const logo=b.logo&&this.image(b.logo.name,b.logo.asset);
      if(logo){const scale=Math.min(420/logo.width,110/logo.height);t.drawImage(logo,40,(160-logo.height*scale)/2,logo.width*scale,logo.height*scale);}
      else drawOpenMeetLogo(t,40,(160-420*LOGO_HEIGHT/LOGO_WIDTH)/2,420);
      const name=b.text||this.context().meetName||'Track meet';t.fillStyle=b.textColor;t.font='600 48px sans-serif';t.textBaseline='middle';
      t.fillText(name,510,80,645);
    }return texture;
  }
  updatePreview(){
    const canvas=document.querySelector('#billboard-preview'),b=this.settings();if(!canvas||!b)return;
    const key=JSON.stringify([b,this.context().meetName,[...this.images.values()].map(i=>!!i)]);if(key===this.previewKey)return;
    const texture=this.textureFor(b);if(!texture)return;this.previewKey=key;canvas.width=2400;canvas.height=160;const g=canvas.getContext('2d');
    g.drawImage(texture,0,0);g.drawImage(texture,1200,0);
  }
  paintOne(g,view,columnsAt,b){
    const rects=billboardPieces(b,view);
    if(!rects.length)return;
    const key=billboardCacheKey(b,view)+JSON.stringify([this.context().meetName,[...this.images.values()].map(i=>!!i)]);
    const composite=cache=>{
      // The source presentation edge advances smoothly between packets. Clip the
      // cached received artwork to that edge without rebuilding its mask.
      g.save();g.beginPath();for(const r of rects)g.rect(r.x,r.y,r.w,r.h);g.clip();
      g.drawImage(cache.canvas,cache.x-BILLBOARD_PAD+billboardCacheOffset(cache,view),cache.y);g.restore();
    };
    const previous=this.paintCaches.get(b.id);if(reusableBillboardCache(previous,key,view)){composite(previous);return;}
    const texture=this.textureFor(b);if(!texture)return;
    // Cache a padded view, but allocate/read/mask ONLY the artwork's bounding
    // rectangle. Horizontal RAF movement translates this buffer. Packets, source
    // switches, learned masks and geometry changes invalidate it explicitly.
    const expanded={...view,width:view.width+2*BILLBOARD_PAD,c0:view.c0-BILLBOARD_PAD/view.zx,last:view.maskLast};
    const pieces=billboardPieces(b,expanded);if(!pieces.length)return;
    const x=Math.max(0,Math.floor(Math.min(...pieces.map(r=>r.x)))),y=Math.max(0,Math.floor(Math.min(...pieces.map(r=>r.y))));
    const right=Math.min(expanded.width,Math.ceil(Math.max(...pieces.map(r=>r.x+r.w)))),bottom=Math.min(view.height,Math.ceil(Math.max(...pieces.map(r=>r.y+r.h))));
    if(right<=x||bottom<=y)return;
    const layer=previous?.canvas||document.createElement('canvas');layer.dataset.billboardMask='true';layer.width=right-x;layer.height=bottom-y;const c=layer.getContext('2d',{willReadFrequently:true});
    c.translate(-x,-y);
    for(const r of pieces){c.save();c.beginPath();c.rect(r.x,r.y,r.w,r.h);c.clip();c.translate(r.flip?r.x+r.w:r.x,r.y);if(r.flip)c.scale(-1,1);c.scale(r.w/(r.uw*texture.width),r.h/texture.height);c.translate(-r.u*texture.width,0);c.fillStyle=c.createPattern(texture,'repeat');c.fillRect(r.u*texture.width,0,r.uw*texture.width,texture.height);c.restore();}
    const pixels=c.getImageData(0,0,layer.width,layer.height);
    maskBillboard(pixels,pieces.map(r=>({...r,x:r.x-x,y:r.y-y})),(a,z)=>columnsAt(a+x-BILLBOARD_PAD,z+x-BILLBOARD_PAD),row=>view.r0+(row+y)/view.zy,view.rows);
    c.putImageData(pixels,0,0);const cache={key,canvas:layer,c0:view.c0,x,y};this.paintCaches.set(b.id,cache);composite(cache);
  }

  syncEditor(b,rects,view){
    for(const key of ['time','duration','row','height']){const input=document.getElementById('billboard-'+key);if(input&&input!==document.activeElement)input.value=+b[key].toFixed(key==='time'||key==='duration'?6:2);}
    const editing=!!this.context().placing;
    this.editor.hidden=!editing||!b.enabled||view.framing||!rects.length;
    if(this.editor.hidden){this.editor.replaceChildren();this.editorSignature=null;return;}
    if(this.dragging)return;
    const signature=JSON.stringify([b,rects,view.framing,editing]);if(signature===this.editorSignature)return;this.editorSignature=signature;
    const focused=this.editor.contains(document.activeElement)?document.activeElement.className:null;this.editor.replaceChildren();
    const resized=(base,dr,top=false)=>{const bottom=base.row+base.height,row=top?Math.max(0,Math.min(bottom-1,base.row+dr)):base.row,height=top?bottom-row:Math.max(1,Math.min(view.rows-row,base.height+dr));return {...base,row,height,duration:Math.max(view.period*4,base.duration*height/base.height)};};
    const bind=(target,kind)=>{
      target.onpointerdown=e=>{
        if(e.button!==0)return;e.preventDefault();e.stopPropagation();target.setPointerCapture(e.pointerId);this.dragging=true;
        const bounds=this.editor.getBoundingClientRect(),point=ev=>billboardPoint(ev.clientX-bounds.left,ev.clientY-bounds.top,view),from=point(e);
        target.onpointermove=ev=>{const to=point(ev);this.save(kind==='move'?moveBillboard(b,from,to,false,view):resized(b,to.row-from.row,kind==='top'));};
        target.onpointerup=target.onpointercancel=()=>{this.dragging=false;target.onpointermove=target.onpointerup=target.onpointercancel=null;this.editorSignature=null;this.changed();};
      };
      target.onkeydown=e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();e.stopPropagation();const step=e.shiftKey?10:1,dr=(e.key==='ArrowDown'?1:e.key==='ArrowUp'?-1:0)*step,dt=(e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0)*step*view.period*(view.flip?-1:1);this.save(kind==='move'?moveBillboard(this.settings(),{time:0,row:0},{time:dt,row:dr},false,view):resized(this.settings(),dr,kind==='top'));};
    };
    for(const r of rects){
      const box=el('div',null,'billboard-placement'+(editing?' direct-drag':''));Object.assign(box.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px'});box.setAttribute('aria-label','Drag billboard to position');
      if(editing)bind(box,'move');
      for(const [kind,label,cls]of [['move','Drag billboard','billboard-move'],['top','Resize top','billboard-top'],['bottom','Resize bottom','billboard-resize']]){
        const handle=el('button',kind==='move'?'Drag':kind==='top'?'Top':'Bottom',cls);handle.type='button';handle.setAttribute('aria-label',label);handle.title=label+' · arrow keys for fine control';bind(handle,kind);box.append(handle);
      }this.editor.append(box);
    }
    if(focused)this.editor.querySelector('.'+focused.split(' ').join('.'))?.focus({preventScroll:true});
  }
  render(body){
    body.onkeydown=e=>{if(body.dataset.tab==='billboards')e.stopPropagation();};
    const collection=this.collection();
    if(body.dataset.tab==='billboards'&&body.dataset.billboardScope===this.key()&&body.dataset.billboardSelection===(collection.selected||'')){this.updateStatus();return;}
    body.dataset.tab='billboards';body.dataset.billboardScope=this.key();body.dataset.billboardSelection=collection.selected||'';body.replaceChildren();this.body=body;this.previewKey=null;
    const list=el('div',null,'card billboard-list');list.append(el('h3','Billboards'));
    const rows=el('div');rows.id='billboard-list';list.append(rows);
    const create=el('button','New billboard','btn sm primary');create.id='billboard-new';create.onclick=()=>{this.add();this.refresh(body);};
    list.append(create);
    if(this.removed?.scope===this.key()){const undo=el('button','Undo removal','btn sm');undo.id='billboard-undo-remove';undo.onclick=()=>{this.saveCollection(this.removed.collection);this.removed=null;this.refresh(body);};list.append(undo);}
    body.append(list);this.renderList();
    const b=this.settings();if(!b){const empty=el('div',null,'card');empty.append(el('h3','Create a billboard'),el('p','Add a repeating logo and meet name, or build a custom design.'));body.append(empty);return;}
    const card=el('div',null,'card billboard-card');const heading=el('div',null,'billboard-heading'),label=el('input');label.id='billboard-label';label.value=b.label;label.maxLength=80;label.setAttribute('aria-label','Billboard name');label.onchange=()=>{this.save({...this.settings(),label:label.value.trim()||'Billboard'});this.renderList();};heading.append(label);card.append(heading);
    const preview=el('canvas');preview.id='billboard-preview';preview.className='billboard-preview';preview.setAttribute('aria-label','Repeating billboard preview');card.append(preview);
    const field=(label,input,parent=card)=>{const row=el('label');row.append(el('span',label),input);parent.append(row);return input;};
    const placementHint=el('div',null,'billboard-placement-hint');placementHint.append(el('span','Position the billboard directly on the camera image.'));
    const place=el('button','Place on scan','btn sm primary');place.id='billboard-place';place.onclick=()=>this.placeSelected();placementHint.append(place);
    const center=el('button','Bring into view','btn sm');center.id='billboard-center';center.onclick=()=>this.placeSelected(true);placementHint.append(center);card.append(placementHint);
    if(b.mode==='basic'){
      const text=el('input');text.id='billboard-text';text.value=b.text||this.context().meetName||'Track meet';text.maxLength=240;text.oninput=()=>this.save({...this.settings(),text:text.value});field('Text',text);
      const logo=el('button','Change logo…','btn sm');logo.id='billboard-logo';logo.disabled=!this.bridge;logo.onclick=()=>this.action(async()=>{const file=await this.bridge.pickFile('Billboard logo','image');if(!file)return;let name=this.settings().logo?.name;if(!name){name='logos-'+Date.now();await this.bridge.call('billboard.create',{name});}const asset=await this.bridge.call('billboard.addAsset',{name,path:file});await this.loadImage(name,asset);this.save({...this.settings(),logo:{name,asset}});});card.append(logo);
      const resetLogo=el('button','Use OpenMeet logo','btn sm');resetLogo.onclick=()=>this.save({...this.settings(),logo:null});if(b.logo)card.append(resetLogo);
      const appearance=el('details');appearance.append(el('summary','Colors'));
      for(const [key,title]of [['color','Background'],['textColor','Meet name']]){const input=el('input');input.type='color';input.value=b[key];input.oninput=()=>this.save({...this.settings(),[key]:input.value});field(title,input,appearance);}card.append(appearance);
    }else{
      const reset=el('button','Use logo & text','btn sm');reset.id='billboard-reset-design';reset.onclick=()=>{this.save({...this.settings(),mode:'basic'});this.refresh(body);};card.append(reset);
    }
    const placement=el('details');placement.append(el('summary','Fine adjustments'));
    for(const [key,title,step]of [['time','Pattern offset (s)',this.context().period],['duration','Repeat width (s)',this.context().period],['row','Top row',1],['height','Band height (rows)',1]]){
      const input=el('input');input.type='number';input.id='billboard-'+key;input.step=step;input.value=+b[key].toFixed(key==='time'||key==='duration'?6:2);input.onchange=()=>{if(input.value!==''&&Number.isFinite(input.valueAsNumber))this.save(billboardSettings({...this.settings(),[key]:input.valueAsNumber},this.context()));input.value=+this.settings()[key].toFixed(key==='time'||key==='duration'?6:2);};field(title,input,placement);
    }
    const status=el('p','Simple fallback','dimtext');status.id='billboardMaskStatus';status.setAttribute('aria-live','polite');placement.append(status);body.append(card);
    const library=el('details',null,'billboard-ai');library.id='billboard-ai';library.open=this.busy||this.aiOpen===true;library.ontoggle=()=>{this.aiOpen=library.open;};library.append(el('summary','Customize with AI'));card.append(library);
    const importSvg=el('button','Import design…','btn sm');importSvg.id='billboard-import';importSvg.disabled=!this.bridge||this.busy;importSvg.onclick=()=>this.action(async()=>{const file=await this.bridge.pickFile('Import billboard SVG','image');if(!file)return;const name='art-'+Date.now();await this.bridge.call('billboard.create',{name});const result=await this.bridge.call('billboard.importSvg',{name,path:file});this.snapshots.set(name,result.snapshotId);this.list=await this.bridge.call('billboard.list');this.save({...this.settings(),name,mode:'art'});await this.loadImage(name,'assets/billboard.svg',true);this.refresh(body);});library.append(importSvg);
    this.prompts??=new Map();const prompt=el('textarea');prompt.id='billboard-prompt';prompt.setAttribute('aria-label','Describe your billboard design');prompt.value=this.prompts.get(b.id)||'';prompt.oninput=()=>this.prompts.set(b.id,prompt.value);prompt.rows=4;prompt.placeholder='Describe the design for one repeating panel…';library.append(prompt);
    const agent=el('select');agent.id='billboard-agent';agent.setAttribute('aria-label','Billboard coding agent');for(const name of ['muse','codex','grok']){const option=el('option',name[0].toUpperCase()+name.slice(1));option.value=name;agent.append(option);}agent.value=this.store.get('billboardAgent','muse');agent.onchange=()=>this.store.set('billboardAgent',agent.value);library.append(agent);
    const build=el('button',this.busy?'Generating…':'Generate design','btn sm primary');build.id='billboard-build';build.disabled=!this.bridge||this.busy;build.onclick=()=>this.action(async()=>{
      const request=prompt.value.trim(),target=this.settings().id;if(!request)throw Error('Describe the artwork first');this.busy=true;this.log='Building design…';this.updateStatus();let name;
      try {name=await this.ensureArtwork(target);}catch(error){this.busy=false;this.updateStatus();throw error;}this.building=name;
      try {const result=await this.bridge.call('billboard.agent',{name,request,preset:agent.value});this.snapshots.set(name,result.snapshotId);this.log+=`\nExit ${result.code}${result.restored?' · restored previous artwork':''}${result.error?' · '+result.error:''}`;await this.loadImage(name,'assets/billboard.svg',true);if(result.restored)this.toast(result.error||'Previous design restored.',true);else {if(result.code===0){this.submittedPrompts??=new Map();this.submittedPrompts.set(target,request);}const c=this.collection();c.items=c.items.map(item=>item.id===target?{...item,mode:'art',name}:item);this.saveCollection(c);}}
      finally{this.busy=false;this.building=null;this.refresh(body);}
    });library.append(build);
    const undo=el('button','Undo last change','btn sm');undo.id='billboard-undo';undo.disabled=this.busy||!this.snapshots.has(b.name);undo.onclick=()=>this.action(async()=>{await this.bridge.call('billboard.restore',{name:b.name,snapshotId:this.snapshots.get(b.name)});this.snapshots.delete(b.name);await this.loadImage(b.name,'assets/billboard.svg',true);this.refresh(body);});if(this.snapshots.has(b.name))heading.append(undo);
    const assets=el('button','Add design image…','btn sm');assets.disabled=!this.bridge||this.busy;assets.onclick=()=>this.action(async()=>{const file=await this.bridge.pickFile('Image for custom billboard','image');if(file){const name=await this.ensureArtwork(b.id),asset=await this.bridge.call('billboard.addAsset',{name,path:file});this.log+='\nAdded '+asset+'; mention it in the design request.';this.updateStatus();}});library.append(assets);
    const log=el('pre',this.log||'Uses your installed coding agent. Builds can be undone.','billboard-log');log.id='billboardLog';library.append(log);if(b.name){const del=el('button','Delete saved design','btn sm warn');del.id='billboard-delete-art';del.disabled=this.busy;del.onclick=()=>this.action(async()=>{if(this.confirmDelete!==b.name){this.confirmDelete=b.name;del.textContent='Delete design?';return;}await this.bridge.call('billboard.delete',{name:b.name});this.forgetImages(b.name);const c=this.collection();c.items=c.items.map(item=>item.name===b.name?{...item,name:'',mode:'basic'}:item);this.saveCollection(c);this.list=await this.bridge.call('billboard.list');this.confirmDelete=null;this.refresh(body);});library.append(del);}
    card.append(placement);this.updatePreview();if(this.bridge&&!this.loaded){this.loaded=true;this.action(async()=>{this.list=await this.bridge.call('billboard.list');this.refresh(body);});}
  }
  renderList(){
    const rows=document.getElementById('billboard-list');if(!rows)return;rows.replaceChildren();
    const c=this.collection();for(const b of c.items){const row=el('div',null,'brow'+(b.id===c.selected?' cur':''));row.dataset.billboard=b.id;
      const enabled=el('input');enabled.type='checkbox';enabled.checked=b.enabled;enabled.setAttribute('aria-label',`Show ${b.label}`);if(b.id===c.selected)enabled.id='billboard-enabled';enabled.onclick=e=>e.stopPropagation();enabled.onchange=()=>{const currentState=this.collection();this.save({...currentState.items.find(item=>item.id===b.id),enabled:enabled.checked});this.changed();};
      const name=el('button',b.label,'billboard-select');name.onclick=()=>{const current=this.collection();current.selected=b.id;this.saveCollection(current);this.refresh(this.body);};
      const del=el('button','×','btn sm warn');del.setAttribute('aria-label',`Remove ${b.label}`);del.title='Remove this billboard';del.onclick=()=>{this.remove(b.id);this.refresh(this.body);};row.append(enabled,name,del);rows.append(row);
    }
    if(!c.items.length)rows.append(el('p','No billboards on this camera.','dimtext'));
  }
  async ensureArtwork(id){const c=this.collection(),item=c.items.find(b=>b.id===id);if(!item)throw Error('Billboard was removed');if(item.name)return item.name;const name='art-'+Date.now();await this.bridge.call('billboard.create',{name});const current=this.collection();current.items=current.items.map(b=>b.id===id?{...b,name}:b);this.saveCollection(current);return name;}
  refresh(body){if(body?.dataset.tab!=='billboards')return;body.dataset.tab='';this.render(body);}
  updateStatus(){const log=document.querySelector('#billboardLog');if(log)log.textContent=this.log;for(const id of ['billboard-build','billboard-import','billboard-agent','billboard-delete-art','billboard-undo']){const input=document.getElementById(id);if(input)input.disabled=this.busy||!this.bridge;}}
  async action(fn){try{await fn();}catch(error){this.toast(error.message,true);}}
}
