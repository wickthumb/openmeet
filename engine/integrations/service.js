import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {meetDataProtocol} from './index.js';
import * as settings from './settings.js';
import {openCaptureStore} from '../capture/store.js';
import {parseEvt} from '../meetlink/parse.js';
import * as values from '../timing/value-format.js';
import * as archive from './archive.js';
import * as weather from './weather.js';
import * as extended from '../meetlink/extended.js';
import * as media from '../capture/media.js';
import {decodeCompressedMedia,encodeCompressedMedia} from '../capture/media-codec.js';
import {encodePng} from '../sim/png-encode.js';

const copy=structuredClone;
const safeName=value=>{if(typeof value!=='string'||!value.trim()||value.length>120||/[\\/\x00-\x1f]/.test(value)||['.','..','__proto__','constructor','prototype'].includes(value))throw new TypeError('Safe nonempty local name required');return value;};
function atomicBytes(file,bytes,{overwrite=true}={}){
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp-'+randomUUID();let fd;
  try{
    fd=fs.openSync(temp,'wx');let offset=0;
    while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(!n)throw Error('Write made no progress');offset+=n;}
    fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    if(overwrite)fs.renameSync(temp,file);else{fs.linkSync(temp,file);fs.unlinkSync(temp);}
    try{const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}catch{}
  }finally{if(fd!=null)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch{}}
  return {path:file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
}

export function createBackendIntegrationService({root,captureResolver=()=>null,emit=()=>{}}){
  if(typeof root!=='string'||!root)throw new TypeError('Backend state directory required');
  const profilesFile=path.join(root,'backend-profiles.json');
  function load(){
    try{const value=JSON.parse(fs.readFileSync(profilesFile,'utf8'));if(value.version!==1||!Array.isArray(value.profiles))throw Error('Unsupported profile store');return value;}
    catch(error){if(error.code!=='ENOENT')throw error;return {version:1,selected:null,profiles:[]};}
  }
  function save(value){atomicBytes(profilesFile,Buffer.from(JSON.stringify(value,null,2)+'\n'));return copy(value);}
  return {
    profiles({operation,name,configuration,sourceName}={}){
      const state=load();
      if(operation==='list')return state;
      if(operation!=='select'||name!=null)safeName(name);
      if(name!=null)safeName(name);
      const index=state.profiles.findIndex(item=>item.name===name);
      if(operation==='get'){if(index<0)throw Error('Unknown backend profile');return copy(state.profiles[index]);}
      if(operation==='create'){
        if(index>=0)throw Error('Profile already exists');
        const source=sourceName?state.profiles.find(item=>item.name===sourceName):null;
        if(sourceName&&!source)throw Error('Unknown source profile');
        state.profiles.push({name,configuration:copy(configuration??source?.configuration??{}),revision:1});
      }else if(operation==='save'){
        if(index<0)throw Error('Unknown backend profile');state.profiles[index]={name,configuration:copy(configuration),revision:state.profiles[index].revision+1};
      }else if(operation==='select'){
        if(name!=null&&index<0)throw Error('Unknown backend profile');state.selected=name??null;
      }else if(operation==='delete'){
        if(index<0)throw Error('Unknown backend profile');state.profiles.splice(index,1);if(state.selected===name)state.selected=null;
      }else throw new TypeError('Unknown profile operation');
      return save(state);
    },
    settings({operation,text,bytes,root:tree,characterMode,inputCharacterMode,floatPolicy}={}){
      const providers=floatPolicy==='binary64'?{floatConvert:Number}:{};
      if(operation==='decode')return settings.decodeSettingsStream(bytes,{characterMode});
      if(operation==='load')return settings.loadSettingsRegistry(text,{...(tree?{root:copy(tree)}:{}),providers});
      if(operation==='resolve'){const node=copy(tree);return {root:node,...settings.resolveSettingsLine(node,text,providers)};}
      if(operation==='serialize')return {text:settings.serializeSettingsRegistry(tree,{...(floatPolicy==='fixed6'?{floatFormat:value=>value.toFixed(6)}:{})})};
      if(operation==='encode')return settings.encodeSettingsStream(text,{characterMode,inputCharacterMode});
      throw new TypeError('Unknown settings operation');
    },
    time({operation,input}){
      if(operation==='parseTimePrefix')return values.parseTimePrefix(input.text,input.options);
      if(['speedValue','paceValue','deltaValue'].includes(operation))return values[operation](input);
      const api=meetDataProtocol.time;
      if(!Object.hasOwn(api,operation)||typeof api[operation]!=='function')throw new TypeError('Unknown exact time operation');
      return api[operation](copy(input));
    },
    participants({operation,row,records,overwrite=false}){
      if(operation==='extract')return meetDataProtocol.participants.extract(records);
      if(operation!=='lookup')throw new TypeError('Unknown participant operation');
      return meetDataProtocol.participants.lookup(copy(row),records,overwrite);
    },
    eventImport(input){return meetDataProtocol.events.importNormal(copy(input));},
    schedule({operation,input,source={},controls,list,dialog,index,decisions={}}){
      const api=meetDataProtocol.schedule;
      if(operation==='records')return api.records(input);
      if(operation==='refreshDialog')return api.refreshDialog(controls,list);
      if(operation==='selectDialogItem')return api.selectDialogItem(dialog,index);
      const observed={schExists:typeof source.schText==='string',evtExists:typeof source.evtText==='string',schText:source.schText??'',evtText:source.evtText??''};
      const heats=observed.evtExists?parseEvt(Buffer.from(observed.evtText,'utf8')):[];
      const find=key=>heats.find(item=>String(item.event)===key.event&&String(item.round)===key.round&&String(item.heat)===key.heat);
      const required=(map,key)=>{if(!Object.hasOwn(map??{},key))throw new TypeError('Explicit schedule decision required: '+key);return map[key];};
      const providers={source:()=>observed,createTemporary:()=>({}),disposeTemporary:()=>{},
        interrupted:n=>decisions.cancelAfter!=null&&n>=decisions.cancelAfter,
        metadata:key=>({name:find(key)?.name??'Event not present'}),recursionCheck:true,position:n=>n,beep:()=>{},
        confirmDirty:w=>required(decisions.dirtyConfirmations,w.token),closeChoice:w=>required(decisions.closeChoices,w.token),
        save:w=>required(decisions.saveStatuses,w.token),dialog:()=>required(decisions,'dialog'),
        importEvent:key=>{const heat=find(key);return heat?{name:heat.name,rows:copy(heat.entries)}:null;},
        createWindow:()=>({token:randomUUID(),eventToken:randomUUID()}),activate:()=>{},
      };
      if(operation==='select')return api.select(copy(input),providers);
      if(operation==='loadSchedule')return api.loadSchedule(copy(input),providers);
      if(operation==='loadDialog')return api.loadDialog(copy(input),controls,providers);
      if(operation==='control')return api.control(copy(input),providers);
      throw new TypeError('Unknown schedule operation');
    },
    archive({operation,bytes,value,family='ROOT'}){
      if(operation==='read')return archive.readEventArchive(bytes,{family});
      if(operation==='write')return archive.writeEventArchive(value,{family});throw new TypeError('Unknown archive operation');
    },
    weather({operation,input,options={}}){
      const api={create:()=>weather.createWeather(input),reset:()=>weather.resetWeather(input),format:()=>weather.windHeader(input,options),parse:()=>weather.parseWind(input,options),
        packet:()=>weather.decodeWeatherPacket(input,options),serialize:()=>weather.serializeWeather(input,options),deserialize:()=>weather.deserializeWeather(input,options.previous,options),
        direction:()=>weather.weatherDirection(input,{atan2:options.arithmetic==='binary64'?Math.atan2:null})};
      if(!Object.hasOwn(api,operation))throw new TypeError('Unknown weather operation');return api[operation]();
    },
    extendedResults(input){return extended.projectExtendedExchange(input);},
    async media({operation,input}){
      if(operation==='plan')return media.mediaExportPlan(input);
      if(operation==='avi')return media.buildAvi(input);
      if(operation==='planar')return media.convertPlanar420(input);
      if(operation==='decode')return decodeCompressedMedia(input);
      if(operation==='encode')return encodeCompressedMedia(input);
      throw new TypeError('Unknown media operation');
    },
    assignResult({options,candidate,rows,selectedText='',confirmations={},people=[]}){
      const numericTime=time=>{const result={};for(const key of ['ticks','quantum','origin']){const value=time?.[key];if(typeof value==='string'&&!/^-?\d+$/.test(value))throw new TypeError('Decimal result tuple required');const n=Number(value),limit=key==='origin'?2**31:2**47;if(!Number.isSafeInteger(n)||n < -limit||n>=limit)throw new RangeError('Result tuple outside its integer domain');result[key]=n;}return result;};
      const owned=copy(rows),actions=[];for(const row of owned)row.time=numericTime(row.time);candidate=numericTime(candidate);
      const target=options.targetIndex==null?null:owned[options.targetIndex];if(options.explicitTarget&&!target)throw new TypeError('Explicit result target is missing');
      const result=meetDataProtocol.results.assign({...copy(options),target},{
        candidate:()=>copy(candidate),selectedText:()=>selectedText,
        lookup:(field,value)=>owned.find(row=>String(row[field])===String(value))||null,
        getter:row=>copy(row.time),confirm:name=>{if(typeof confirmations[name]!=='boolean')throw new TypeError('Explicit outcome required for '+name);return confirmations[name];},
        exactClose:()=>owned.map(row=>({token:row.token,time:copy(row.time)})),
        createRow:()=>({token:randomUUID(),status:0,time:{ticks:0,quantum:0,origin:-1},text:'',mode:0,cache:-1,lane:'',id:'',license:'',last:'',first:'',affiliation:'',user1:'',user2:'',user3:''}),
        append:row=>owned.push(row),ppl:(row,overwrite)=>meetDataProtocol.participants.lookup(row,people,overwrite),
        alternate:()=>actions.push({type:'alternate-result-action'}),
        integration:row=>actions.push({type:'integration-row',row:copy(row)}),refresh:(context,row)=>actions.push({type:'context-refresh',context,row:copy(row)}),
        advanceHelper:time=>actions.push({type:'cursor-helper',time}),advance:time=>actions.push({type:'cursor-advance',time}),
      });
      const output={...result,rows:owned,actions};emit('backend.results',output);return output;
    },
    exportStill({captureId,from=0,to=null,format='png',name,bitsPerPixel=24,overwrite=false,executable=null,quality=75}){
      const capture=captureResolver(captureId);if(!capture?.dir)throw Error('Unknown capture');
      if(!['png','targa','jpeg'].includes(format)||![16,24].includes(bitsPerPixel))throw new TypeError('Unsupported still output format');
      name=safeName(name||`capture-${from}.${format==='png'?'png':format==='jpeg'?'jpg':'tga'}`);
      const store=openCaptureStore(capture.dir,{readOnly:true});
      try{
        const metadata=store.meta(),end=to??store.columnCount(),width=end-from,height=metadata?.rows,channels=metadata?.channels;
        if(!Number.isInteger(from)||!Number.isInteger(end)||from<0||end>store.columnCount()||width<1||!height||width*height*3>64*1024*1024)throw new RangeError('Invalid or oversized export range');
        if(![1,3,4].includes(channels))throw Error('Unsupported capture channels');
        const columns=store.readColumns(from,end),rgb=Buffer.alloc(width*height*3);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let k=0;k<3;k++)rgb[(y*width+x)*3+k]=columns[(x*height+y)*channels+(channels===1?0:k)];
        let bytes;
        if(format==='jpeg'){return encodeCompressedMedia({executable,codec:'mjpeg',frames:[rgb],width,height,quality}).then(encoded=>({...atomicBytes(path.join(capture.dir,'exports',name),encoded.data,{overwrite}),width,height,format,codecProvider:'external',nativeCodecEquivalent:false}));}
        if(format==='png')bytes=encodePng({width,height,channels:3,data:rgb});
        else{
          const pieces=[];meetDataProtocol.still.targa(width,height,bitsPerPixel===24?3:2,y=>{
            const row=[];for(let x=0;x<width;x++)row.push([...rgb.subarray((y*width+x)*3,(y*width+x)*3+3)]);
            return meetDataProtocol.still.rgbRow(row,bitsPerPixel===24?3:2);
          },chunk=>pieces.push(Buffer.from(chunk)));bytes=Buffer.concat(pieces);
        }
        return {...atomicBytes(path.join(capture.dir,'exports',name),bytes,{overwrite}),width,height,format};
      }finally{store.close();}
    },
  };
}
