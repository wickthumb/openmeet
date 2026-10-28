// Saved display preference and refreshable service state; no inference implementation.
export function scanMaskPreferences(saved={}) {
  if(saved.maskDefaultVersion===1&&['simple','learned'].includes(saved.occlusionMethod))return saved;
  return {...saved,occlusionMethod:'learned',maskDefaultVersion:1};
}

export function modelMaskStatus({method,enabled,behind,ready,busy,error,state,captureId,service,checking,queued}) {
  if(method!=='learned')return '';
  if(ready)return 'Learned preview ready';
  if(busy)return 'Generating mask…';
  if(error)return 'Simple fallback';
  if(!enabled)return 'Enable lane overlays';
  if(!behind)return 'Enable Behind runners';
  if(state==='running')return 'Simple while recording';
  if(!captureId)return 'Record a capture first';
  if(checking)return 'Connecting…';
  if(queued||service?.error==='OCCLUSION_BUSY')return 'Model busy';
  if(!service?.configured)return 'Private service not configured';
  return service.ready?'Ready':'Private service unavailable';
}

export class OcclusionAvailability {
  constructor(probe,onChange=()=>{}) {this.probe=probe;this.onChange=onChange;this.info=null;this.checking=false;this.pending=null;}
  refresh() {
    if(this.pending)return this.pending;
    // A provider refusal is never retried automatically.
    if(this.info?.error==='OCCLUSION_REFUSED')return Promise.resolve(this.info);
    this.checking=true;this.onChange();
    this.pending=Promise.resolve().then(()=>this.probe()).then(info=>{
      if(info.error==='OCCLUSION_BUSY'&&this.info?.ready)return this.info;
      this.info=info;return info;
    }).catch(()=>{this.info={configured:true,ready:false,error:'OCCLUSION_TRANSPORT'};return this.info;})
      .finally(()=>{this.checking=false;this.pending=null;this.onChange();});
    return this.pending;
  }
}
