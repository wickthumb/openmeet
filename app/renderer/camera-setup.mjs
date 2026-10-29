// Camera configuration only. Viewing/alignment and capture lifecycles stay parent-owned.
const el=(tag,text,className)=>{
  const node=document.createElement(tag);
  if(text!=null)node.textContent=text;
  if(className)node.className=className;
  return node;
};
const fields=['label','locationId','side','direction'];
const sameSetup=(a,b)=>fields.every(key=>a[key]===b[key]);
const errorText=error=>error?.message||String(error);
const scopeOf=context=>context.meetDir??null;
const captureOf=context=>context.captureId??null;
const sides=[['unspecified','Unspecified'],['inside','Inside'],['outside','Outside']];
const directions=[['normal','Normal'],['reverse','Reverse']];
const title=value=>value?value[0].toUpperCase()+value.slice(1):'';

function options(select,items,value,placeholder){
  const choices=placeholder?[['',placeholder],...items]:[...items];
  if(value&&!choices.some(([id])=>id===value))choices.push([value,'Unavailable location']);
  const signature=JSON.stringify(choices);
  if(select.dataset.options!==signature){
    select.replaceChildren(...choices.map(([id,label])=>{
      const option=el('option',label);option.value=id;return option;
    }));
    select.dataset.options=signature;
  }
  if(select.value!==value)select.value=value;
}

/**
 * render() is safe on every parent UI update; inputs and unsaved drafts persist.
 * Call refreshRecorders() while the modal is visible, or updateRecorders(reply).
 * No timers, source selection, capture controls, or persistent browser storage.
 */
export class CameraSetupConsole {
  constructor({bridge,context,changed=()=>{},toast=()=>{},applyConfig=()=>{},chooseView,align,billboards}){
    Object.assign(this,{bridge,context,changed,toast,applyConfig,chooseView,align,billboards});
    this.config=null;
    this.recorders=null;
    this.selectedId=null;
    this.drafts=new Map();
    this.busy=false;
    this.loading=false;
    this._epoch=0;
    this._captureEpoch=0;
    this._ready=false;
    this._finishName='';
    this._loadError='';
    this._recorderError='';
    this._notice='';
  }

  _context(){return this.context?.()||{};}

  _syncContext(){
    const context=this._context(),meetDir=scopeOf(context),captureId=captureOf(context);
    if(!this._ready||meetDir!==this._meetDir){
      this._ready=true;this._meetDir=meetDir;this._epoch++;
      this.config=null;this.recorders=null;this.selectedId=null;this.drafts.clear();
      this._heatDraft=null;this._finishName='';this._loadError='';this._recorderError='';this._notice='';
      this._loadPromise=null;this._writePromise=null;this._recorderPromise=null;
      this.loading=false;this.busy=false;this._captureId=captureId;this._captureEpoch++;
    }else if(captureId!==this._captureId){
      this._captureId=captureId;this._captureEpoch++;this.recorders=null;
      this._recorderPromise=null;this._recorderError='';
    }
    return context;
  }

  _current(epoch){return this._epoch===epoch&&scopeOf(this._context())===this._meetDir;}

  _locations(){return this.config?.locations?.length?this.config.locations:[{id:'home',name:'Home finish'}];}

  _locationName(id){return this._locations().find(location=>location.id===id)?.name||id||'Unassigned';}

  _cameras(context=this._context()){
    const cameras=new Map();
    for(const scan of context.scans||[])if(scan.id)cameras.set(scan.id,{...scan,scan});
    for(const recorder of this.recorders?.cameras||[])if(recorder.id){
      const previous=cameras.get(recorder.id)||{id:recorder.id};
      cameras.set(recorder.id,{...recorder,...previous,recorder});
    }
    for(const setup of Object.values(this.config?.setups||{}))if(setup.cameraId&&!cameras.has(setup.cameraId))cameras.set(setup.cameraId,{id:setup.cameraId});
    return [...cameras.values()];
  }

  _setup(camera){
    const saved=this.config?.setups?.[camera.id]||camera.recorder?.setup||{};
    return {cameraId:camera.id,label:saved.label||camera.label||camera.id,locationId:saved.locationId||'home',
      side:sides.some(([id])=>id===saved.side)?saved.side:'unspecified',
      direction:saved.direction==='reverse'?'reverse':'normal',revision:saved.revision,effectiveAt:saved.effectiveAt};
  }

  _draft(camera){
    if(!this.drafts.has(camera.id))this.drafts.set(camera.id,{...this._setup(camera),dirty:false,edit:0});
    return this.drafts.get(camera.id);
  }

  _heat(context){
    const key=context.heatKey??'',assignment=this.config?.heats?.[key];
    if(!this._heatDraft||this._heatDraft.key!==key||!this._heatDraft.dirty){
      const timingCameraId=assignment?.timingCameraId||context.timingId||'';
      const locationId=assignment?.locationId||this.config?.setups?.[timingCameraId]?.locationId||'home';
      this._heatDraft={key,locationId,timingCameraId,dirty:false,edit:this._heatDraft?.edit||0};
    }
    return this._heatDraft;
  }

  _validate(config){
    if(config?.version!==1||!Array.isArray(config.locations)||!config.setups||!config.heats||!Array.isArray(config.history))throw Error('Invalid camera configuration response.');
    return config;
  }

  async _publish(config,reason,after){
    this.config=this._validate(config);this._loadError='';
    for(const camera of this._cameras()){
      const draft=this.drafts.get(camera.id);
      if(!draft)continue;
      const setup=this._setup(camera);
      if(!draft.dirty)this.drafts.set(camera.id,{...setup,dirty:false,edit:draft.edit});
      else draft.dirty=!sameSetup(draft,setup);
    }
    after?.();
    this._paint();
    await this.applyConfig(config,reason);
    this.changed();
  }

  // Reads are deduplicated; writes cannot race a configuration refresh.
  load(){
    const context=this._syncContext();
    if(this._loadPromise)return this._loadPromise;
    if(this.busy)return this._writePromise||Promise.resolve(this.config);
    if(!this.bridge?.call){this._paint();return Promise.resolve(null);}
    const epoch=this._epoch;
    this.loading=true;this._loadError='';
    const facts=this.refreshRecorders();
    const promise=Promise.resolve().then(async()=>{
      try{
        const config=await this.bridge.call('camera.config.get',{meetDir:context.meetDir??null});
        if(!this._current(epoch))return null;
        await this._publish(config,'load');
        return config;
      }catch(error){
        if(this._current(epoch)){this._loadError=errorText(error);this.toast('Camera setup: '+this._loadError,true);}
        return null;
      }finally{
        if(this._current(epoch)){this.loading=false;this._loadPromise=null;this._paint();}
        await facts;
      }
    });
    this._loadPromise=promise;this._paint();return promise;
  }

  refresh(){return this.load();}

  refreshRecorders(){
    const context=this._syncContext();
    if(this._recorderPromise)return this._recorderPromise;
    if(!this.bridge?.call)return Promise.resolve(null);
    const epoch=this._epoch,captureEpoch=this._captureEpoch,captureId=captureOf(context);
    const current=()=>this._current(epoch)&&this._captureEpoch===captureEpoch&&captureOf(this._context())===captureId;
    const promise=Promise.resolve().then(async()=>{
      try{
        const facts=await this.bridge.call('camera.recorders',captureId?{captureId}:{});
        if(!current())return null;
        if(!Array.isArray(facts?.cameras))throw Error('Invalid camera recorder response.');
        return this.updateRecorders(facts)?facts:null;
      }catch(error){
        if(current()){
          const message=errorText(error);
          if(this._recorderError!==message)this.toast('Camera recorder status: '+message,true);
          this._recorderError=message;
          // Old facts cannot continue claiming that a camera is recording.
          this.recorders=null;
        }
        return null;
      }finally{if(current()){this._recorderPromise=null;this._paint();}}
    });
    this._recorderPromise=promise;this._paint();return promise;
  }

  updateRecorders(facts){
    const context=this._syncContext();
    if(!Array.isArray(facts?.cameras))return false;
    if(context.captureId&&facts.captureId!==context.captureId)return false;
    this.recorders=facts;this._recorderError='';this._paint();return true;
  }

  _canWrite(){return !!this.bridge?.call&&!!this.config&&!this.busy&&!this.loading;}

  _write(method,params,reason,after,message){
    this._syncContext();
    if(!this._canWrite())return Promise.resolve(null);
    const epoch=this._epoch,meetDir=this._meetDir;
    this.busy=true;this._notice='';
    const promise=Promise.resolve().then(async()=>{
      try{
        const config=await this.bridge.call(method,{meetDir,...params});
        if(!this._current(epoch))return null;
        await this._publish(config,reason,()=>after?.(config));
        this._notice=typeof message==='function'?message():message;
        if(this._notice)this.toast(this._notice);
        return config;
      }catch(error){
        if(this._current(epoch))this.toast('Camera setup: '+errorText(error),true);
        return null;
      }finally{if(this._current(epoch)){this.busy=false;this._writePromise=null;this._paint();}}
    });
    this._writePromise=promise;this._paint();return promise;
  }

  saveSetup(){
    const context=this._syncContext(),camera=this._cameras(context).find(camera=>camera.id===this.selectedId);
    if(!camera)return Promise.resolve(null);
    const draft=this._draft(camera),edit=draft.edit,label=draft.label.trim();
    if(!label){this.toast('Enter a camera name.',true);return Promise.resolve(null);}
    const params={cameraId:camera.id,label,locationId:draft.locationId,side:draft.side,direction:draft.direction};
    const review=!!context.recording;
    return this._write('camera.setup.save',params,'setup',()=>{
      const current=this.drafts.get(camera.id);
      if(current?.edit===edit)this.drafts.set(camera.id,{...this._setup(camera),dirty:false,edit});
    },()=>review?'Setup saved · review this capture.':'Camera setup saved.');
  }

  addLocation(){
    this._syncContext();
    const original=this._finishName,name=original.trim();
    if(!name){this.toast('Enter a finish location name.',true);return Promise.resolve(null);}
    return this._write('camera.location.save',{name},'location',()=>{
      if(this._finishName===original)this._finishName='';
    },'Finish location added.');
  }

  assignHeat(){
    const context=this._syncContext(),draft=this._heat(context),edit=draft.edit;
    const valid=this._cameras(context).some(camera=>camera.id===draft.timingCameraId&&this._setup(camera).locationId===draft.locationId);
    if(!draft.key||!valid)return Promise.resolve(null);
    const next=!!(context.recording||context.started);
    return this._write('camera.heat.assign',{heatKey:draft.key,locationId:draft.locationId,timingCameraId:draft.timingCameraId},'heat',()=>{
      if(this._heatDraft?.key===draft.key&&this._heatDraft.edit===edit)this._heatDraft.dirty=false;
    },next?'Camera assignment saved for the next capture.':'Camera assignment saved for this heat.');
  }

  _callback(callback,id){
    return Promise.resolve().then(()=>callback?.(id)).catch(error=>this.toast('Camera setup: '+errorText(error),true));
  }

  _officialRecording(context){
    return !!context.recording||(!context.preview&&!!this.recorders?.cameras.some(camera=>camera.state==='recording'));
  }

  render(body){
    this._syncContext();
    if(this.body!==body||this.root?.parentNode!==body||this._mountedEpoch!==this._epoch)this._mount(body);
    this._paint();
    if(this.bridge?.call&&!this.config&&!this.loading&&!this._loadError&&!this.busy)void this.load();
    else if(this.bridge?.call&&!this.recorders&&!this._recorderPromise&&!this._recorderError)void this.refreshRecorders();
  }

  _field(parent,tag,id,label){
    const row=el('label',null,'camera-field'),caption=el('span',label),input=el(tag);
    input.id=id;row.htmlFor=id;row.append(caption,input);parent.append(row);return input;
  }

  _mount(body){
    this.body=body;this._mountedEpoch=this._epoch;this._rows=new Map();
    const root=el('div',null,'camera-setup');this.root=root;
    const status=el('div',null,'camera-setup-status');status.setAttribute('role','status');
    this.status=el('span');this.retry=el('button','Retry','btn sm');this.retry.type='button';this.retry.onclick=()=>this.load();status.append(this.status,this.retry);
    const grid=el('div',null,'camera-setup-grid');
    const inventory=el('section',null,'camera-inventory card');inventory.append(el('h3','Cameras'));
    this.inventory=el('div');this.inventory.id='cameraInventory';this.inventory.setAttribute('aria-label','Camera inventory');
    this.empty=el('p',null,'empty');inventory.append(this.inventory,this.empty);
    const editor=el('section',null,'camera-editor card');editor.append(el('h3','Camera setup'));
    this.editorEmpty=el('p','Select a camera to edit its setup.','empty');
    const form=el('form',null,'camera-setup-form');this.editorForm=form;
    this.name=this._field(form,'input','cameraName','Name');this.name.type='text';this.name.autocomplete='off';this.name.required=true;
    this.location=this._field(form,'select','cameraLocation','Finish location');
    this.side=this._field(form,'select','cameraSide','Side');
    this.direction=this._field(form,'select','cameraDirection','Direction');
    const inputs={label:this.name,locationId:this.location,side:this.side,direction:this.direction};
    for(const [key,input] of Object.entries(inputs))input[key==='label'?'oninput':'onchange']=()=>{
      this._syncContext();const camera=this._cameras().find(camera=>camera.id===this.selectedId);if(!camera)return;
      const draft=this._draft(camera);draft[key]=input.value;draft.edit++;draft.dirty=!sameSetup(draft,this._setup(camera));this._notice='';this._paint();
    };
    const actions=el('div',null,'camera-actions');
    this.save=el('button','Save setup','btn primary');this.save.id='cameraSave';this.save.type='submit';actions.append(this.save);
    form.onsubmit=event=>{event.preventDefault();return this.saveSetup();};
    this.view=el('button','View on scan','btn');this.view.id='cameraView';this.view.type='button';
    this.view.onclick=()=>{
      const context=this._syncContext(),id=this.selectedId;
      if((context.scans||[]).some(scan=>scan.id===id))return this._callback(this.chooseView,id);
    };
    this.alignButton=el('button','Open alignment','btn');this.alignButton.id='cameraAlign';this.alignButton.type='button';
    this.alignButton.onclick=()=>{
      const context=this._syncContext(),id=this.selectedId;
      if(!this._officialRecording(context)&&(context.scans||[]).some(scan=>scan.id===id))return this._callback(this.align,id);
    };
    actions.append(this.view,this.alignButton);if(this.billboards){const button=el('button','Billboards','btn');button.type='button';button.onclick=()=>this._callback(this.billboards,this.selectedId);actions.append(button);}form.append(actions);
    this.alignStatus=el('p',null,'dimtext');this.revision=el('p',null,'dimtext camera-revision');
    const details=el('details',null,'camera-details');details.append(el('summary','Camera details'));
    this.details=el('dl',null,'kv');details.append(this.details);form.append(this.alignStatus,this.revision,details);
    editor.append(this.editorEmpty,form);grid.append(inventory,editor);

    const heat=el('section',null,'camera-heat card');this.heatTitle=el('h3','This heat');heat.append(this.heatTitle);
    this.currentAssignment=el('p',null,'camera-current-assignment');
    this.savedAssignment=el('p',null,'dimtext');heat.append(this.currentAssignment,this.savedAssignment);
    const heatForm=el('form',null,'camera-heat-form');
    this.heatLocation=this._field(heatForm,'select','heatFinishLocation','Finish location');
    this.heatTiming=this._field(heatForm,'select','heatTimingCamera','Timing camera');
    this.heatLocation.onchange=()=>{
      const context=this._syncContext(),draft=this._heat(context);draft.locationId=this.heatLocation.value;draft.dirty=true;draft.edit++;
      if(!this._cameras(context).some(camera=>camera.id===draft.timingCameraId&&this._setup(camera).locationId===draft.locationId))draft.timingCameraId='';
      this._paint();
    };
    this.heatTiming.onchange=()=>{const draft=this._heat(this._syncContext());draft.timingCameraId=this.heatTiming.value;draft.dirty=true;draft.edit++;this._paint();};
    this.heatEmpty=el('p',null,'dimtext');
    this.assign=el('button','Use for this heat','btn primary');this.assign.id='heatCameraAssign';this.assign.type='submit';
    heatForm.onsubmit=event=>{event.preventDefault();return this.assignHeat();};heatForm.append(this.heatEmpty,this.assign);heat.append(heatForm);
    const locationForm=el('form',null,'camera-location-form');
    this.finishName=this._field(locationForm,'input','finishLocationName','Add finish location');
    this.finishName.type='text';this.finishName.autocomplete='off';this.finishName.placeholder='New finish location';this.finishName.required=true;
    this.finishName.oninput=()=>{this._finishName=this.finishName.value;this._paint();};
    this.finishAdd=el('button','Add location','btn sm');this.finishAdd.id='finishLocationAdd';this.finishAdd.type='submit';
    locationForm.onsubmit=event=>{event.preventDefault();return this.addLocation();};locationForm.append(this.finishAdd);heat.append(locationForm);
    root.append(status,grid,heat);body.replaceChildren(root);
  }

  _recorderStatus(camera){
    const state=camera.recorder?.state;
    if(state==='recording')return 'Recording';
    if(state)return ({idle:'Idle',ready:'Ready',waiting:'Waiting',stopped:'Stopped',closed:'Stopped',error:'Recorder error',preview:'Preview'})[state]||title(String(state));
    if(this._recorderError)return 'Status unavailable';
    if(!this.recorders)return this.bridge?.call?'Checking recorder status…':'Status unavailable';
    return this.recorders.captureId?'Not in this capture':'No active recorder';
  }

  _paint(){
    if(this.root?.parentNode!==this.body||this._mountedEpoch!==this._epoch)return;
    const context=this._syncContext();
    if(this._mountedEpoch!==this._epoch)return;
    const cameras=this._cameras(context),locations=this._locations().map(location=>[location.id,location.name]);
    if(!cameras.some(camera=>camera.id===this.selectedId))this.selectedId=cameras[0]?.id||null;
    const camera=cameras.find(camera=>camera.id===this.selectedId),writable=this._canWrite();
    this.status.textContent=!this.bridge?.call?'Connect to the engine to load camera setup.':this._loadError?'Camera setup could not load: '+this._loadError:this.loading?'Loading camera setup…':this._recorderError?'Recorder status unavailable.':this._notice;
    this.retry.hidden=!this._loadError&&!this._recorderError;this.retry.disabled=this.loading||this.busy;
    const ids=new Set(cameras.map(camera=>camera.id));
    for(const [id,row]of this._rows)if(!ids.has(id)){row.button.remove();this._rows.delete(id);}
    for(const item of cameras){
      let row=this._rows.get(item.id);
      if(!row){
        const button=el('button',null,'camera-item');button.type='button';button.dataset.cameraId=item.id;
        row={button,name:el('strong',null,'camera-item-name'),setup:el('span',null,'camera-item-setup'),status:el('span',null,'camera-item-status')};
        button.append(row.name,row.setup,row.status);button.onclick=()=>{this.selectedId=item.id;this._paint();};this._rows.set(item.id,row);this.inventory.append(button);
      }
      const setup=this._setup(item),selected=item.id===this.selectedId;
      row.button.classList.toggle('selected',selected);row.button.setAttribute('aria-pressed',String(selected));
      row.name.textContent=setup.label;row.setup.textContent=this._locationName(setup.locationId)+' · '+title(setup.side);
      row.status.textContent=this._recorderStatus(item);row.status.dataset.state=item.recorder?.state||'unknown';
      row.status.title=item.recorder?.error||'';
    }
    this.empty.hidden=!!cameras.length;
    this.empty.textContent=this.loading||(!this.recorders&&this._recorderPromise)?'Loading cameras…':this._loadError?'Camera inventory unavailable.':!this.bridge?.call?'Camera inventory is unavailable offline.':'No cameras available. Choose a camera source to begin.';
    this.editorEmpty.hidden=!!camera;this.editorForm.hidden=!camera;
    if(camera)this._paintEditor(camera,context,locations,writable);
    this._paintHeat(cameras,context,locations,writable);
    if(this.finishName.value!==this._finishName)this.finishName.value=this._finishName;
    this.finishName.disabled=!this.config||!this.bridge?.call;
    this.finishAdd.disabled=!writable||!this._finishName.trim();
  }

  _paintEditor(camera,context,locations,writable){
    const setup=this._setup(camera),draft=this._draft(camera),scan=(context.scans||[]).find(scan=>scan.id===camera.id);
    if(this.name.value!==draft.label)this.name.value=draft.label;
    options(this.location,locations,draft.locationId);options(this.side,sides,draft.side);options(this.direction,directions,draft.direction);
    for(const input of [this.name,this.location,this.side,this.direction])input.disabled=!this.config||!this.bridge?.call;
    this.save.disabled=!writable||(!draft.dirty&&setup.revision!=null)||!draft.label.trim();this.save.textContent=this.busy?'Saving…':'Save setup';
    this.view.disabled=!scan||!this.chooseView;this.view.title=scan?'Show this camera on the scan':'No scan is available for this camera.';
    this.view.setAttribute('aria-pressed',String(context.viewId===camera.id));
    const recording=this._officialRecording(context);
    this.alignButton.disabled=recording||!scan||!this.align;
    this.alignStatus.textContent=recording?'Alignment is available after recording stops.':'';this.alignStatus.hidden=!recording;
    const history=(this.config?.history||[]).filter(revision=>revision.cameraId===camera.id&&String(revision.revision)!==String(setup.revision));
    this.revision.textContent=setup.revision!=null?`Revision ${setup.revision}${history.length?` · ${history.length} earlier ${history.length===1?'revision':'revisions'}`:''}${draft.dirty?' · Unsaved changes':''}`:draft.dirty?'Unsaved changes':'Setup not yet saved';
    const period=scan?.meta?.column_period_s||camera.recorder?.columnPeriod,width=scan?.size?.width,rows=scan?.size?.height||camera.recorder?.rows;
    const pairs=[['Camera ID',camera.id],['Native resolution',width&&rows?`${width} × ${rows}`:rows?`${rows} rows`:'Unavailable'],
      ['Scan rate',period>0?`${Number((1/period).toFixed(1)).toLocaleString()} columns/s`:'Unavailable'],
      ['Received columns',camera.recorder?.columns??'Unavailable'],['Earlier revisions',history.length]];
    if(setup.effectiveAt)pairs.push(['Setup effective',setup.effectiveAt]);
    if(camera.recorder?.setup?.revision!=null)pairs.push(['Capture setup revision',camera.recorder.setup.revision]);
    if(camera.recorder?.error)pairs.push(['Recorder error',camera.recorder.error]);
    this.details.replaceChildren(...pairs.flatMap(([key,value])=>[el('dt',key),el('dd',String(value))]));
  }

  _paintHeat(cameras,context,locations,writable){
    const draft=this._heat(context),assignment=this.config?.heats?.[draft.key],started=!!(context.recording||context.started);
    this.heatTitle.textContent='This heat'+(context.heatName?' · '+context.heatName:'');
    options(this.heatLocation,locations,draft.locationId);
    const eligible=cameras.filter(camera=>this._setup(camera).locationId===draft.locationId);
    const valid=eligible.some(camera=>camera.id===draft.timingCameraId);
    // Stale assignments never add an out-of-location camera to this select.
    options(this.heatTiming,eligible.map(camera=>[camera.id,this._setup(camera).label]),valid?draft.timingCameraId:'',eligible.length?'Choose timing camera':'No cameras at this finish');
    this.heatLocation.disabled=!this.config||!this.bridge?.call||!draft.key;
    this.heatTiming.disabled=this.heatLocation.disabled||!eligible.length;
    this.assign.textContent=started?'Use for next capture':'Use for this heat';
    this.assign.disabled=!writable||!draft.key||!valid||(assignment?.locationId===draft.locationId&&assignment?.timingCameraId===draft.timingCameraId);
    this.heatEmpty.textContent=!draft.key?'Select a heat to assign its cameras.':!eligible.length?'Assign a camera to this finish in Camera setup.':'';this.heatEmpty.hidden=!this.heatEmpty.textContent;
    const cameraName=id=>{const camera=cameras.find(camera=>camera.id===id);return camera?this._setup(camera).label:id||'Not assigned';};
    const actual=cameras.find(camera=>camera.id===context.timingId),frozen=actual?.recorder?.setup;
    this.currentAssignment.textContent=started?'This capture: '+(frozen?.label||cameraName(context.timingId)):'';
    this.currentAssignment.hidden=!started;
    this.savedAssignment.textContent=assignment?`${started?'Next capture':'Assigned'}: ${this._locationName(assignment.locationId)} · ${cameraName(assignment.timingCameraId)}`:'No finish assignment saved.';
  }
}
