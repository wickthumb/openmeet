const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));

// A spatial raster and a time strip are different sources. Only area frames
// may be cropped around a sensor centreline; line input uses its newest samples.
export function alignmentCrop({width,height,kind,mode,slitX=null}) {
  if(!Number.isInteger(width)||width<1||!Number.isInteger(height)||height<1||!['area','slit'].includes(kind)||!['area','slit'].includes(mode))throw TypeError('Invalid alignment frame');
  if(mode==='area'&&kind!=='area')return null;
  const count=mode==='slit'?Math.min(2,width):width;
  const x=mode==='area'?0:kind==='area'?clamp(Math.floor(slitX??width/2)-Math.floor(count/2),0,width-count):width-count;
  return {x,y:0,width:count,height};
}

export function alignmentPlacement({width,height,viewportWidth,viewportHeight,mode,zoom=1,horizontalZoom=1,panX=0,panY=0}) {
  const fit=Math.max(1,viewportHeight-16)/height,sy=fit*clamp(zoom,1,16);
  const sx=(mode==='slit'?Math.max(fit,16):fit)*clamp(zoom,1,16)*clamp(horizontalZoom,1,16);
  const w=width*sx,h=height*sy,px=clamp(panX,-Math.max(0,(w-viewportWidth)/2+8),Math.max(0,(w-viewportWidth)/2+8)),py=clamp(panY,-Math.max(0,(h-viewportHeight)/2+8),Math.max(0,(h-viewportHeight)/2+8));
  return {x:(viewportWidth-w)/2+px,y:(viewportHeight-h)/2+py,width:w,height:h,sx,sy,panX:px,panY:py};
}

const el=(tag,text,className)=>{const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
export class AlignmentPreview {
  constructor({id='alignment-preview',mode='slit'}={}) {
    this.mode=mode;this.zoom=1;this.horizontalZoom=1;this.panX=0;this.panY=0;
    this.root=el('section','','alignment-preview');this.root.id=id;this.root.hidden=true;
    const controls=el('div','','alignment-controls');this.buttons={};
    const button=(key,label,action)=>{const b=el('button',label,'btn sm');b.type='button';b.dataset.alignmentAction=key;b.onclick=action;controls.append(b);this.buttons[key]=b;};
    button('area','Area · 2D',()=>this.setMode('area'));
    button('slit','Slit · 2 columns',()=>this.setMode('slit'));
    button('fit','Fit height',()=>this.fit());
    button('out','−',()=>this.setZoom(this.zoom/2));
    button('in','+',()=>this.setZoom(this.zoom*2));
    button('narrow','Narrower',()=>{this.horizontalZoom=Math.max(1,this.horizontalZoom/2);this.paint();});
    button('width','Wider',()=>{this.horizontalZoom=Math.min(16,this.horizontalZoom*2);this.paint();});
    this.caption=el('span','','alignment-caption');controls.append(this.caption);
    this.stage=el('div','','alignment-stage');this.canvas=el('canvas');this.canvas.tabIndex=0;this.canvas.setAttribute('aria-label','Camera alignment preview');this.stage.append(this.canvas);
    this.help=el('p','','alignment-help dimtext');this.root.append(controls,this.stage,this.help);
    this.observer=new ResizeObserver(()=>this.paint());this.observer.observe(this.stage);
    this.canvas.addEventListener('wheel',event=>{event.preventDefault();if(event.ctrlKey||event.metaKey)this.setZoom(this.zoom*Math.exp(-event.deltaY*.002));else{this.panY-=event.deltaY;this.panX-=event.deltaX;this.paint();}},{passive:false});
    this.canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();this.canvas.focus({preventScroll:true});this.drag={id:event.pointerId,x:event.clientX,y:event.clientY,panX:this.panX,panY:this.panY};this.canvas.setPointerCapture(event.pointerId);});
    this.canvas.addEventListener('pointermove',event=>{if(this.drag?.id!==event.pointerId)return;this.panX=this.drag.panX+event.clientX-this.drag.x;this.panY=this.drag.panY+event.clientY-this.drag.y;this.paint();});
    const stop=()=>{this.drag=null;};this.canvas.addEventListener('pointerup',stop);this.canvas.addEventListener('pointercancel',stop);this.canvas.addEventListener('lostpointercapture',stop);
    this.canvas.addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','0','+','=','-'].includes(event.key))return;event.preventDefault();event.stopPropagation();if(event.key==='0')this.fit();else if(['+','=','-'].includes(event.key))this.setZoom(this.zoom*(event.key==='-'?.5:2));else{const amount=event.shiftKey?100:20;this.panX+=event.key==='ArrowLeft'?amount:event.key==='ArrowRight'?-amount:0;this.panY+=event.key==='ArrowUp'?amount:event.key==='ArrowDown'?-amount:0;this.paint();}});
  }
  setMode(mode){if(mode==='area'&&this.frame?.kind!=='area')return;this.mode=mode;this.fit();}
  setZoom(value){this.zoom=clamp(value,1,16);this.paint();}
  fit(){this.zoom=1;this.horizontalZoom=1;this.panX=this.panY=0;this.paint();}
  clear(){this.frame=null;this.paint();}
  setFrame(source,{kind,revision,label='',slitX=null}={}) {
    if(!source)return this.clear();
    if(this.frame?.input===source&&this.frame.revision===revision&&this.frame.kind===kind)return;
    const width=source.naturalWidth||source.width,height=source.naturalHeight||source.height;
    alignmentCrop({width,height,kind,mode:'slit',slitX});
    const input=source;
    if(source.tagName==='IMG'){
      // Keep the displayed pixels stable while the next PNG decodes into the
      // reusable image element. One canvas is retained per viewer.
      this.pixels??=document.createElement('canvas');if(this.pixels.width!==width||this.pixels.height!==height){this.pixels.width=width;this.pixels.height=height;}
      this.pixels.getContext('2d').drawImage(source,0,0);source=this.pixels;
    }
    this.frame={source,input,width,height,kind,revision,label,slitX};if(kind!=='area')this.mode='slit';this.paint();
  }
  paint(){
    const frame=this.frame;this.buttons.area.disabled=frame?.kind!=='area';this.buttons.area.title=frame?.kind==='area'?'Spatial view from this camera':'This source has no matching area frame';
    for(const key of ['area','slit'])this.buttons[key].setAttribute('aria-pressed',String(this.mode===key));
    this.buttons.out.disabled=this.zoom<=1;this.buttons.in.disabled=this.zoom>=16;this.buttons.narrow.disabled=this.horizontalZoom<=1;this.buttons.width.disabled=this.horizontalZoom>=16;
    this.root.dataset.mode=this.mode;this.root.dataset.sourceKind=frame?.kind??'';
    this.help.textContent=(frame?.label?frame.label+' · ':'')+(this.mode==='slit'?'Latest two sensor columns, widened for inspection.':'Green line: aiming guide; timing-column calibration is separate.')+' Drag to pan · Ctrl+wheel to zoom · Fit height resets the view.';
    const width=this.stage.clientWidth,height=this.stage.clientHeight;if(width<1||height<1)return;
    const ratio=Math.min(2,window.devicePixelRatio||1);if(this.canvas.width!==Math.round(width*ratio)||this.canvas.height!==Math.round(height*ratio)){this.canvas.width=Math.round(width*ratio);this.canvas.height=Math.round(height*ratio);}
    const g=this.canvas.getContext('2d');g.setTransform(ratio,0,0,ratio,0,0);g.fillStyle='#080c17';g.fillRect(0,0,width,height);
    if(!frame){this.caption.textContent='Waiting for camera pixels';return;}
    const crop=alignmentCrop({...frame,mode:this.mode}),rect=alignmentPlacement({...crop,viewportWidth:width,viewportHeight:height,mode:this.mode,zoom:this.zoom,horizontalZoom:this.horizontalZoom,panX:this.panX,panY:this.panY});
    this.panX=rect.panX;this.panY=rect.panY;this.rect=rect;this.root.dataset.nativeWidth=String(crop.width);this.root.dataset.nativeHeight=String(crop.height);
    this.caption.textContent=`${this.mode==='area'?'Area':'Slit'} · ${crop.width} × ${crop.height} · ${Math.round(this.zoom*100)}% of fit${this.horizontalZoom>1?' · '+this.horizontalZoom+'× width':''}`;
    g.imageSmoothingEnabled=false;g.drawImage(frame.source,crop.x,0,crop.width,crop.height,rect.x,rect.y,rect.width,rect.height);
    if(this.mode==='area'){
      const x=rect.x+(frame.slitX??Math.floor(frame.width/2))*rect.sx,y=rect.y+frame.height/2*rect.sy;
      g.strokeStyle='#37e4a9';g.lineWidth=1;g.beginPath();g.moveTo(x,rect.y);g.lineTo(x,rect.y+rect.height);g.moveTo(x-20,y);g.lineTo(x+20,y);g.stroke();
    }
  }
  destroy(){this.observer.disconnect();this.frame=null;if(this.pixels)this.pixels.width=this.pixels.height=0;this.root.remove();}
}
