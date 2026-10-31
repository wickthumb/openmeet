// Versioned metadata only. Referenced camera pixels remain separate files.
const LIMIT=64*1024*1024;
const unsupported=message=>Object.assign(new Error(message),{code:'ERR_ARCHIVE_UNSUPPORTED'});
export function transformEventArchive(input,{write=false,family='ROOT',maxBytes=LIMIT}={}){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>LIMIT)throw new RangeError('Invalid archive limit');
  const bytes=write?null:Buffer.from(input),pieces=[];let at=0,total=0,depth=0;
  if(bytes?.length>maxBytes)throw new RangeError('Archive exceeds limit');
  function primitive(value,n,signed=false,hex=false){
    if(write){
      let b;
      if(hex){if(typeof value!=='string'||value.length!==n*2||!/^[0-9a-f]*$/i.test(value))throw new TypeError('Exact opaque bytes required');b=Buffer.from(value,'hex');}
      else{const v=BigInt(value),bits=BigInt(n*8),min=signed?-(1n<<(bits-1n)):0n,max=signed?(1n<<(bits-1n))-1n:(1n<<bits)-1n;if(v<min||v>max)throw new RangeError('Archive integer overflow');b=Buffer.alloc(n);if(signed)b.writeIntLE(Number(v),0,n);else b.writeUIntLE(Number(v),0,n);}
      total+=n;if(total>maxBytes)throw new RangeError('Archive exceeds limit');pieces.push(b);return value;
    }
    if(at+n>bytes.length)throw new RangeError('Truncated archive');const b=bytes.subarray(at,at+n);at+=n;
    return hex?b.toString('hex'):n===6?String(signed?b.readIntLE(0,n):b.readUIntLE(0,n)):signed?b.readIntLE(0,n):b.readUIntLE(0,n);
  }
  function record(type,value){
    if(++depth>32)throw new RangeError('Archive nesting limit');
    const o=write?value:{};if(!o||typeof o!=='object')throw new TypeError('Archive record required');
    const f=(key,n=4,signed=false,hex=false)=>(o[key]=primitive(o[key],n,signed,hex));
    const u=key=>f(key),i=key=>f(key,4,true),t=key=>f(key,6,true),raw=(key,n)=>f(key,n,false,true);
    const array=(key,count,n=4,signed=false,hex=false)=>{
      if(!Number.isSafeInteger(count)||count<0||count>100000)throw new RangeError('Archive array limit');
      const a=write?o[key]:[];if(write&&(!Array.isArray(a)||a.length!==count))throw new TypeError('Exact archive array required: '+key);
      for(let j=0;j<count;j++)a[j]=primitive(a[j],n,signed,hex);o[key]=a;return a;
    };
    const child=(key,kind)=>o[key]=record(kind,o[key]);
    const list=(key,kind)=>{
      const tag=primitive(write?0x10007:undefined,4);if(tag!==0x10007)throw unsupported('Invalid list tag');
      const count=primitive(write?o[key]?.length:undefined,4);if(count>100000)throw new RangeError('Archive list limit');
      if(write&&!Array.isArray(o[key]))throw new TypeError('Archive list required');
      const a=write?o[key]:[];for(let j=0;j<count;j++)a[j]=record(kind,a[j]);o[key]=a;
    };
    const version=(min,max=min)=>{const v=u('version');if(v<min||v>max)throw unsupported('Unsupported '+type+' version');return v;};
    let v;
    switch(type){
      case 'STRING':v=u('tag');if(![0x10005,0x10010005].includes(v))throw unsupported('Unsupported string tag');raw('encodedHex',u('codeUnitCount')*(v===0x10005?1:2));break;
      case 'TIME':version(0x20001);t('ticks');t('quantum');i('origin');break;
      case 'DATE':version(0x10008);array('opaque',8);break;
      case 'OPTIONS':{
        version(0x2000c);u('opaque0');raw('opaque1',8);raw('opaque2',8);
        const n=primitive(write?o.groups?.length:undefined,4);if(n>8)throw new RangeError('Too many option groups');
        const groups=write?o.groups:[];for(let j=0;j<n;j++){const g=write?groups[j]:{},count=primitive(write?g.length:undefined,4);if(count>100000)throw new RangeError('Option group too large');const a=write?g:[];for(let k=0;k<count;k++)a[k]=primitive(a[k],4);groups[j]=a;}o.groups=groups;break;
      }
      case 'ROOT':v=version(0x20004,0x20008);u('fileVersionOpaque');if(v>=0x20007)u('encodingOpaque');for(const k of ['event','round','heat'])v<0x20006?u(k):child(k,'STRING');array('savedOpaque',4);array('rootOpaque',2);child('date','DATE');child('title','STRING');child('description','STRING');child('options','OPTIONS');list('starts','START');child('timeConfig','TIME_CONFIG');list('windows','WINDOW');if(v>=0x20005)child('timingState','TIMING_STATE');if(v>0x20007)list('extraStarts','START');break;
      case 'START':v=version(0x20003,0x20005);u('id');if(v<0x20005)array('opaque',3);child('label','STRING');list('times','TIME');if(v!==0x20003)child('extraTime','TIME');if(v>0x20004)child('comment','STRING');break;
      case 'TIME_CONFIG':v=version(0x20002,0x20005);array('opaque',2);if(v!==0x20002){child('time','TIME');array('configuration',3);}if(v>=0x20004)array('weather',14,4,true);if(v===0x20005)u('extra');break;
      case 'WINDOW':v=version(0x20009,0x2000d);u('id');if(v<0x2000c)child('oldTimeConfig','TIME_CONFIG');array('position',6,4,true);child('label','STRING');child('results','RESULTS_TABLE');list('images','IMAGE');if(v>0x2000c)raw('tail',8);break;
      case 'RESULTS_TABLE':v=version(0x20005,0x20007);u('id');u('opaque');list('groups','RESULT_GROUP');array('configuration',6);child('text','STRING');list('rows','RESULT_ROW');if(v>0x20005)t('precision');if(v>0x20006)list('extraResults','EXTRA_RESULT');break;
      case 'EXTRA_RESULT':v=version(0x2000f,0x20010);u('opaque');child('time','TIME');if(v===0x20010){u('extra');child('text','STRING');}break;
      case 'RESULT_GROUP':{
        v=version(0x2000b,0x20012);u('id');child('label','STRING');raw('opaque0',8);raw('opaque1',8);if(v>0x2000b)u('opaque2');if(v>0x2000b&&v<0x20011)array('oldConfiguration',8);
        if(v>=0x20011){const n=u('configCount');array('configuration',n*4);u('configurationTail');}
        if(v>=0x2000d)list('conditions','CONDITION');const n=u('fieldCount');if(v<0x2000f)array('oldBoundaries',n);if(v===0x2000e){u('visibleCount');array('oldFieldOrder',n);}if(v>=0x2000f){array('boundaries',n+1);array('fieldOrder',n);}if(v>0x2000f)array('tail',2);if(v>=0x20012)array('fieldExtra',n);break;
      }
      case 'CONDITION':version(0x2000e);u('opaque');child('label','STRING');array('prefix',2);child('time','TIME');array('configuration',4);child('lower','RESULT_ROW');child('upper','RESULT_ROW');break;
      case 'RESULT_ROW':v=version(0x20006,0x20009);i('id');u('flags');{const n=u('stringCount');if(n>9)throw new RangeError('Too many result strings');const a=write?o.strings:[];if(write&&a?.length!==n)throw new RangeError('Result string count mismatch');for(let j=0;j<n;j++)a[j]=record('STRING',a[j]);o.strings=a;}i('storedPlace');t('precision');child('time','TIME');i('state');if(v===0x20006)array('oldTail',6);else child('extraTime','TIME');if(v>=0x20008)child('textOverride','STRING');if(v>=0x20009)array('tail',3,4,true);break;
      case 'CAMERA':{
        v=version(0x20007,0x20010);u('id');child('label','STRING');if(v<0x2000a){const n=u('oldLutCount');if(n>0)array('oldLut',n+1);}else child('lut','LUT');
        const n=u('attributeCount');if(n>89)throw new RangeError('Camera attribute limit');const a=write?o.attributes:[];if(write&&a?.length!==n)throw new RangeError('Attribute count mismatch');for(let j=0;j<n;j++){const attr=write?a[j]:{};attr.value=primitive(attr.value,4,true);attr.specified=primitive(attr.specified,1);a[j]=attr;}o.attributes=a;
        if(v>0x20008)child('profiles','PROFILE_CONTAINER');if(v===0x2000b){const a=write?o.legacyText:[];if(write&&a?.length!==16)throw new RangeError('Legacy text count mismatch');for(let j=0;j<16;j++)a[j]=record('STRING',a[j]);o.legacyText=a;}if(v>0x2000b)list('properties','NAMED_PROPERTY');break;
      }
      case 'LUT':version(0x20013);array('opaque',2);{const n=u('count');if(n>0)array('values',n+1);}break;
      case 'PROFILE_CONTAINER':version(0x20012);u('opaque');list('profiles','CAMERA_PROFILE');break;
      case 'CAMERA_PROFILE':v=version(0x20011,0x20012);{const a=array('words',v===0x20011?8:9);if(a[1]&1){const n={1:256,2:188,3:1532}[a.at(-1)];if(!n)throw unsupported('Unknown profile payload kind');raw('payload',n);}}break;
      case 'NAMED_PROPERTY':version(0x20017);array('opaque',2);child('name','STRING');u('valueType');child('value','STRING');break;
      case 'VIEW':v=version(0x2000a,0x2000c);u('id');array('position',2,4,true);child('transform','TRANSFORM');array('cursor',2,4,true);u('cursorEnabled');array('region1',4,4,true);u('region1Enabled');array('region2',4,4,true);u('region2Enabled');if(v>0x2000a)array('tail',2,4,true);if(v===0x2000c)i('extra');break;
      case 'TRANSFORM':v=i('selector');if([0x20010,0x20011].includes(v))array('words',6,4,true);else if([1,2,4,8,16,32,64,128,256,-2,-4,-8,-16].includes(v))i('oldWord');else throw unsupported('Unknown transform selector');break;
      case 'IMAGE':{
        v=version(0x20008,0x2000f);u('id');u('flags');child('camera','CAMERA');list('views','VIEW');child('extension','STRING');if(v<0x2000b)u('legacyPrefixOpaque');array('core',4);if(v<0x2000b)u('legacyExtraOpaque');if(v>0x2000c)u('imageExtra0');if(v>0x2000e)array('imageExtra1',2);
        if(v===0x20008){const c=o.camera;if(c.version===0x20007||c.attributes.length<=27)throw unsupported('Legacy palette requires resolved camera attributes');if(c.attributes[0].value-100<3&&[0,1].includes(c.attributes[27].value))raw('legacyPalette',256);}
        u('tailOpaque');if(v<0x2000b)array('legacyTail',9);else{u('chunkId');list('chunks','IMAGE_CHUNK');}break;
      }
      case 'IMAGE_CHUNK':version(1);array('words',2);break;
      case 'TIMING_STATE':v=version(0x20014,0x20015);array('words',7);child('time0','TIME');child('time1','TIME');list('groups','TIMELINE_GROUP');if(v>0x20014)list('auxiliaryStarts','AUX_START');break;
      case 'TIMELINE_GROUP':v=version(0x20015,0x20016);array('words',2);child('label','STRING');list('entries','TIMELINE_ENTRY');if(v>0x20015)child('extraText','STRING');break;
      case 'TIMELINE_ENTRY':v=version(0x20016,0x2001a);array('words',2);child('time','TIME');if(v>0x20016)i('field1');if(v>0x20017)i('field2');if(v>0x20018)child('point','POINT');if(v>0x20019)child('extraTime','TIME');break;
      case 'POINT':v=version(0x20019,0x2001a);{const subtype=u('subtype'),n=subtype===0?0:subtype===1?(v===0x20019?7:8):v===0x20019?{2:4,3:3}[subtype]:undefined;if(n==null)throw unsupported('Unknown point subtype');array('words',n);}break;
      case 'AUX_START':v=version(1,3);child('label','STRING');if(v>1){array('words',2);child('time','TIME');}if(v>2)child('extraTime','TIME');break;
      default:throw unsupported('Unknown archive family');
    }
    depth--;return o;
  }
  const result=record(family,write?structuredClone(input):undefined);
  if(write)return Buffer.concat(pieces,total);
  if(at!==bytes.length)throw new RangeError('Unconsumed archive bytes');return result;
}
export const readEventArchive=(bytes,options)=>transformEventArchive(bytes,options);
export const writeEventArchive=(value,options)=>transformEventArchive(value,{...options,write:true});
