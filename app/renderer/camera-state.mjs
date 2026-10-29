// A captured setup is historical evidence; the live inventory cannot rewrite it.
export const heatCameraKey=h=>`${h.ev??h.event}-${h.rd??h.round}-${h.ht??h.heat}`;
export function setupForCamera(config,heat,id){return (heat?.recordingHeat||heat)?.cameraSetups?.[id]||config?.setups?.[id]||null;}
export function cameraProfileToken(config,heat,id){const setup=setupForCamera(config,heat,id);return setup?.revision>1?`${id}@${setup.revision}`:id;}
export function sameFinish(config,heat,a,b){
  if(!a||!b)return false;
  const x=setupForCamera(config,heat,a),y=setupForCamera(config,heat,b);
  return !x||!y||x.locationId===y.locationId&&x.direction===y.direction;
}
export function cameraViewLabel(config,heat,source){
  const setup=setupForCamera(config,heat,source?.id),saved=(heat?.recordingHeat||heat)?.cameraLocations;
  const location=(saved||config?.locations||[]).find(l=>l.id===setup?.locationId)?.name;
  return [setup?.label||source?.label||source?.id,location,setup?.side&&setup.side!=='unspecified'?setup.side:null].filter(Boolean).join(' · ');
}
