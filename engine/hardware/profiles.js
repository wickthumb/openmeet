import {randomUUID,createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {packCameraParameters,normalizeCameraGeometry} from '../cameras/parameters.js';
import {deriveCameraDefaults} from '../cameras/configuration.js';
export const CAMERA_MARKER=0x4b69726b;
export const SCOREBOARD_SCRIPT=';;TimeRunning\n1%s\\0d\\0a\n;;TimeStopped\n1%s\\0d\\0a\n;;Results\n1%s \n2%s \n4%s \n6%s\\0d\\0a';
const fail=message=>Object.assign(new TypeError(message),{code:'ERR_HARDWARE_PROFILE'});
export function validateAddress(value,{optional=false,broadcast=false}={}){
  if(optional&&(value==null||value===''))return null;
  if(typeof value!=='string'||isIP(value)!==4||value==='0.0.0.0'||!broadcast&&(value.startsWith('255.')||Number(value.split('.')[0])>=224)||broadcast&&Number(value.split('.')[0])>=224&&Number(value.split('.')[0])<=239)throw fail('Enter a unicast IPv4 address');return value;
}
export function hardwareFingerprint(profile){
  return createHash('sha256').update(JSON.stringify({kind:profile.kind,address:profile.address,localAddress:profile.localAddress,transport:profile.transport,port:profile.port,broadcast:profile.broadcast,section:profile.section,settings:profile.settings,configuration:profile.configuration,script:profile.script,bindings:profile.bindings})).digest('hex');
}
export function hardwareProfile(input,previous=null){
  if(!input||!['camera','scoreboard'].includes(input.kind)||previous&&input.kind!==previous.kind)throw fail('Choose a camera or scoreboard profile');
  const name=String(input.name??'').trim();if(!name||name.length>100)throw fail('Enter an equipment name');
  const address=validateAddress(input.address,{broadcast:input.kind==='scoreboard'&&input.transport==='udp'&&input.broadcast===true}),localAddress=validateAddress(input.localAddress,{optional:true});
  const profile={version:1,id:previous?.id??'hardware-'+randomUUID(),kind:input.kind,name,address,localAddress,
    port:input.kind==='camera'?41925:input.port,transport:input.transport??(input.kind==='camera'?'tcp':'tcp-client')};
  if(!Number.isInteger(profile.port)||profile.port<1||profile.port>65535)throw fail('Enter a port from 1 to 65535');
  if(profile.kind==='camera'){
    if(!['tcp','udp'].includes(profile.transport))throw fail('Choose TCP or UDP camera delivery');
    const supplied=structuredClone(input.configuration??{});if(Object.keys(supplied).length&&!supplied.profile)throw fail('Camera JSON must contain a profile object');
    profile.configuration=supplied;profile.settings={height:640,rate:800,depth:5,alignmentWidth:128,alignmentRate:5,queueEpochTrusted:false,...input.settings};
    for(const [key,min,max]of[['height',16,2560],['rate',1,20000],['depth',3,7],['alignmentWidth',16,512],['alignmentRate',1,30]])if(!Number.isInteger(profile.settings[key])||profile.settings[key]<min||profile.settings[key]>max)throw fail('Invalid camera '+key);
    if(profile.settings.height%8)throw fail('Encoded camera height must be a multiple of 8');if(typeof profile.settings.queueEpochTrusted!=='boolean')throw fail('Explicit start-queue policy required');
    if(supplied.profile?.marker!=null&&(!Number.isInteger(supplied.profile.marker)||supplied.profile.marker<0||supplied.profile.marker>0xffffffff))throw fail('Invalid camera marker');
    profile.assumptions=Object.keys(supplied).length?['Imported configuration; device behavior is unverified.']:['Experimental runtime profile from the protocol handoff.','Optional trigger, serial, synchronization and motion controls are disabled.','Exposure, color and sensor geometry need operator checks.'];
  }else{
    if(!['tcp-client','tcp-server','udp'].includes(profile.transport))throw fail('Choose TCP connect, TCP listen or UDP');
    if(profile.transport==='tcp-server'&&!localAddress)throw fail('Choose the local interface used to listen');
    profile.broadcast=input.broadcast===true;profile.script=input.script??SCOREBOARD_SCRIPT;if(typeof profile.script!=='string'||profile.script.length>1048576)throw fail('Script exceeds its input limit');
    profile.bindings=structuredClone(input.bindings??[]);if(!Array.isArray(profile.bindings))throw fail('Field bindings must be an array');
    for(const item of profile.bindings)if(!Number.isInteger(item.group)||item.group<16||item.group>24||!Number.isInteger(item.variable)||item.variable<1||typeof item.field!=='string')throw fail('Invalid scoreboard field binding');
    profile.section=input.section??'auto';if(!['auto','Results','StartList','TimeRunning'].includes(profile.section))throw fail('Unsupported scoreboard output selection');
    profile.assumptions=['A matching device script, wiring and controller settings are required.'];
  }
  profile.fingerprint=hardwareFingerprint(profile);const same=previous?.fingerprint===profile.fingerprint;
  profile.observations=same?structuredClone(previous.observations??{}):{};return profile;
}
export function makeCameraConfiguration(saved,inspection,{alignment=false}={}){
  if(!inspection||inspection.address!==saved.address||inspection.clockOrigin<1)throw fail('Check the camera before opening a session');
  const base=structuredClone(saved.configuration??{}),settings=saved.settings,observed=inspection.configuration;
  if(!observed?.orderedBounds)throw fail('Camera geometry bounds have not been validated');
  if(settings.height<observed.height.min||settings.height>observed.height.max||settings.rate<observed.rate.min||settings.rate>observed.rate.max)throw fail('Requested height or rate is outside the camera’s reported limits');
  let words=base.parameterSettings?packCameraParameters(base.parameterSettings).words:base.profile?.parameters;
  if(!words){
    let defaults={};try{defaults=deriveCameraDefaults(observed);}catch{/* The generic draft stays explicitly experimental. */}
    const values=Object.fromEntries(['frameMode','frameOffset','compression','quality','gainMethod','gain','brightness','rawTone','frequency','orientation','red','green','blue','gamma','gunSensor','gunDebounce','photoeyes','photoeyeDebounce','eyeTrigger','eyeSize','maximumGain','gunLight','motionTrigger','motionLeader','motionTrailer','primaryPort','motionBackTrigger','eyeTop','eyeBottom','motionTop','motionBottom','motionSize','motionMinimumTime','syncMode','syncMaximumError','tdiCount','secondaryPort','rawSplitMode','irisMode','filter','automaticTdi','currentTdi','blackLevel','switchGroup'].map(k=>[k,0]));
    Object.assign(values,{height:settings.height,rate:settings.rate,quality:75,gainMethod:1,gain:32,red:defaults.red??100,green:defaults.green??100,blue:defaults.blue??100,gamma:defaults.gamma??1000,tdiCount:1,currentTdi:1});
    const geometry=normalizeCameraGeometry({mode:values.frameMode,height:values.height,offset:0,rate:values.rate,minimumHeight:observed.height.min,maximumHeight:observed.height.max,minimumRate:observed.rate.min,maximumRate:observed.rate.max});Object.assign(values,geometry);
    words=packCameraParameters({values,hostType:observed.internalType,callerFlags:0,gates:{whiteBalanceZero:false,blackLevelSupported:false,serialRouting:false,externalSync:false,extraFlag4:false},extra:{irisOverride:0,irisInitial:0,digitalGainMinimum:0,analogGain:0,pixelFloor:0}}).words;
  }else{if(!Array.isArray(words)||words.length!==19)throw fail('Imported camera parameters must contain 19 words');words=words.slice();words[2]=settings.height;words[3]=settings.rate;}
  return {...base,profile:{id:'host13-ec8l',cameraKey:saved.id,port:41925,marker:CAMERA_MARKER,modelClass:3,statusFlags:0,displayState:0,sources:[],wired:{enabled:false,offsetMs:0},...base.profile,
    address:saved.address,localAddress:saved.localAddress,delivery:saved.transport,clockOrigin:inspection.clockOrigin,epochId:randomUUID(),history:'fresh',expectedBlockIndex:1,queueEpochTrusted:settings.queueEpochTrusted,
    parameters:words,reset:[settings.depth<<2,0,0,0,0,0]},imageProfile:{family:3,height:settings.height,tickScale:8,columnPeriod:1/settings.rate,...base.imageProfile,height:settings.height},
    timeoutMs:1000,clockMaxAgeMs:1000,maxQueuedBlocks:128,drainIntervalMs:20,alignment,
  };
}
