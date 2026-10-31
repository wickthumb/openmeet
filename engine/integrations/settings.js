// Bounded typed settings interchange. The application's own settings stay JSON.
const types=['Bool','Int','Rat','Float','String','Group'];
const held=message=>Object.assign(new Error(message),{code:'ERR_SETTINGS_UNSPECIFIED'});
const lower=s=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
const ascii=s=>{if(typeof s!=='string'||/[^\x01-\x7f]/.test(s))throw new TypeError('Bounded ASCII text required');return s;};
const gcd=(a,b)=>{a=Math.abs(a);b=Math.abs(b);while(b)[a,b]=[b,a%b];return a;};
const bounded=n=>{if(!Number.isSafeInteger(n)||n< -2147483648||n>2147483647)throw held('Settings integer arithmetic outside signed32');return n;};

export function settingsIntegerPrefix(text,{decimal=false}={}){
  ascii(text);let start=0,base=10,sign=1,value=0,digits=0;
  if(!decimal&&/^0[xX]/.test(text)){base=16;start=2;}
  else if(!decimal&&text[0]==='0'){base=8;}
  else if(text[0]==='-'||text[0]==='+'){sign=text[0]==='-'?-1:1;start=1;}
  let i=start;
  for(;i<text.length;i++){
    const c=text.charCodeAt(i),digit=c>=48&&c<=57?c-48:c>=65&&c<=70?c-55:c>=97&&c<=102?c-87:99;
    if(digit>=base)break;value=value*base+digit;digits++;
  }
  return digits?{ok:true,value:bounded(value*sign)||0,prefixLength:i,signedDecimal:String(value*sign||0)}:{ok:false};
}

export function settingsRationalPrefix(text){
  ascii(text);const negative=text[0]==='-',body=negative?text.slice(1):text;
  const whole=settingsIntegerPrefix(body,{decimal:true});if(!whole.ok)return {ok:false};
  let n=whole.value,d=1,at=whole.prefixLength;
  if(body[at]==='/'){
    const denominator=settingsIntegerPrefix(body.slice(at+1),{decimal:true});
    if(!denominator.ok||denominator.value===0)return {ok:false};d=denominator.value;
  }else if(body[at]===' '){
    const numerator=settingsIntegerPrefix(body.slice(at+1));
    if(numerator.ok&&body[at+1+numerator.prefixLength]==='/'){
      const denominator=settingsIntegerPrefix(body.slice(at+2+numerator.prefixLength));
      if(denominator.ok){d=denominator.value;n=bounded(n*d+numerator.value);}
    }
  }else if(body[at]==='.'){
    const digits=/^\d*/.exec(body.slice(at+1))[0];
    if(digits){d=10**digits.length;n=bounded(n*d+Number(digits));}
  }
  if(negative)n=-n;
  const common=gcd(n,d);if(common>1){n/=common;d/=common;}
  return {ok:true,value:[bounded(n),bounded(d)]};
}
export function formatSettingsRational([n,d]){
  if(d===0)return '';if(d<0)throw held('Negative rational denominator');
  const sign=n<0?'-':'',a=Math.abs(n),whole=Math.trunc(a/d),remainder=a%d;
  if(!remainder)return sign+whole;
  return sign+(whole?whole+' ':'')+remainder+'/'+d;
}

export function settingsFloatPrefix(text,{convert}={}){
  ascii(text);const token=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.exec(text)?.[0];
  if(!token)return {ok:false};
  if(convert){const value=convert(token);if(!Number.isFinite(value))throw held('Nonfinite Float outcome');return {ok:true,token,value};}
  // Exact dyadic values need no choice of decimal floating-point environment.
  const [a,b='']=token.replace(/^[+-]/,'').split('.');
  let numerator=BigInt((a||'0')+b),denominator=10n**BigInt(b.length),x=numerator,y=denominator;
  while(y)[x,y]=[y,x%y];if(x){numerator/=x;denominator/=x;}
  if((denominator&(denominator-1n))!==0n||numerator>=(1n<<53n))throw held('Supply a Float conversion policy for non-exact decimals');
  return {ok:true,token,value:Number(token)};
}

export function createSettingsNode(name,type){
  if(typeof name!=='string'||!types.includes(type))throw new TypeError('Known typed node required');
  const node={name,type,metadata:1,runtime:4};
  if(type==='Group')return {...node,label:'',children:[]};
  if(type==='Int')return {...node,value:0,lower:-2147483648,upper:2147483647};
  if(type==='Float')return {...node,value:0,lower:2.2250738585072014e-308,upper:Number.MAX_VALUE};
  return node;
}
export function setSettingsValue(node,text,providers={}){
  ascii(text);let value;
  if(node.type==='Group')value=null;
  else if(node.type==='String')value=text;
  else if(node.type==='Int'||node.type==='Bool'){
    const parsed=settingsIntegerPrefix(text);if(!parsed.ok)return {valueSuccess:false};value=node.type==='Bool'?parsed.value!==0:parsed.value;
  }else if(node.type==='Rat'){
    const parsed=settingsRationalPrefix(text);if(!parsed.ok)return {valueSuccess:false};value=parsed.value;
  }else if(node.type==='Float'){
    const parsed=settingsFloatPrefix(text,{convert:providers.floatConvert});if(!parsed.ok)return {valueSuccess:false};value=parsed.value;
  }else throw new TypeError('Unsupported settings type');
  let result=true;
  if(node.type!=='Float'&&node.type!=='Group'&&providers.onSet)result=providers.onSet(node,value);
  else if(node.type!=='Group')node.value=value;
  if(node.type==='String'&&result!==true)return {valueSuccess:false};
  node.runtime|=2;return {valueSuccess:true};
}

function metadata(node,text,providers){
  const parts=text.split(','),type=parts[0].replace(/^ +| +$/g,'');
  const success=node.type==='Group'||lower(type)===lower(node.type);
  if(node.type==='Group'&&!node.label&&type)node.label=type;
  const number=settingsIntegerPrefix(parts[1]||'');if(number.ok)node.metadata=number.value;
  if(node.type==='Int'||node.type==='Float')for(const [i,key]of[[2,'lower'],[3,'upper']]){
    const parsed=node.type==='Int'?settingsIntegerPrefix(parts[i]||''):settingsFloatPrefix(parts[i]||'',{convert:providers.floatConvert});
    if(parsed.ok)node[key]=parsed.value;
  }
  return success;
}
export function resolveSettingsLine(root,line,providers={}){
  ascii(line);if(root.type!=='Group')throw new TypeError('Settings root must be Group');
  let prefixConsumed=0;
  if(root.name===''&&line[0]==='\\'){line=line.slice(1);prefixConsumed=1;}
  function resolve(group,remaining){
    if(remaining[0]===':')return update(group,remaining.slice(1),false);
    for(const child of group.children){
      if(lower(remaining.slice(0,child.name.length))!==lower(child.name))continue;
      const next=remaining[child.name.length];
      if(child.type==='Group'){
        if(next!=='\\')continue;
        const rest=remaining.slice(child.name.length+1);
        if(rest[0]!==':')return resolve(child,rest);
        return update(child,rest.slice(1),false);
      }
      if(next&&/[A-Za-z0-9_\\]/.test(next))continue;
      return next===':'?update(child,remaining.slice(child.name.length+1),false):{node:child,localStages:0,inserted:false,targetAssigned:false};
    }
    const match=/^([A-Za-z0-9_]+)(\\?):([^=]*)=([\s\S]*)$/.exec(remaining);
    if(!match)return {node:group,localStages:0,inserted:false,targetAssigned:false};
    const [,name,groupSuffix,description,payload]=match;
    const token=/^[A-Za-z0-9]+/.exec(description)?.[0];
    const type=groupSuffix?'Group':types.find(t=>t!=='Group'&&lower(t)===lower(token||''));
    if(!type)return {node:null,localStages:0,inserted:false,targetAssigned:false};
    const node=createSettingsNode(name,type),result=update(node,description+'='+payload,true);
    if(result.localStages===3){group.children.push(node);result.inserted=true;}else result.node=null;
    return result;
  }
  function update(node,remaining,isNew){
    const equals=remaining.indexOf('=');
    if(equals<0)return {node,localStages:0,inserted:false,targetAssigned:false};
    const meta=metadata(node,remaining.slice(0,equals),providers);
    const value=setSettingsValue(node,remaining.slice(equals+1),providers).valueSuccess;
    return {node,localStages:(meta?1:0)|(value?2:0),inserted:false,targetAssigned:value,newNode:isNew};
  }
  const result=resolve(root,line);return {...result,rootPrefixConsumed:prefixConsumed};
}
export function loadSettingsRegistry(text,{root=createSettingsNode('','Group'),providers={},maximumLines=100000}={}){
  ascii(text);if(text.length>8*1024*1024)throw new RangeError('Settings input exceeds limit');
  const lines=text.split('\n');if(lines.at(-1)!=='')throw held('Unterminated settings registry');lines.pop();lines.shift();
  if(lines.length>maximumLines)throw new RangeError('Settings line limit');
  const results=lines.map(line=>resolveSettingsLine(root,line,providers));return {root,results};
}
export function serializeSettingsNode(node,{prefix='',floatFormat,decimalSeparator='.'}={}){
  const float=value=>{if(!floatFormat)throw held('Float serialization needs an explicit formatter');return normalizeSettingsDecimal(floatFormat(value),decimalSeparator);};
  function visit(node,prefix){
    let metadata=node.type==='Group'?(node.label||''):node.type;
    metadata+=','+node.metadata;
    if(node.type==='Int')metadata+=','+(node.lower===-2147483648?'':node.lower)+','+(node.upper===2147483647?'':node.upper);
    if(node.type==='Float')metadata+=','+(node.lower===2.2250738585072014e-308?'':float(node.lower))+','+(node.upper===Number.MAX_VALUE?'':float(node.upper));
    let value='';
    if(node.type==='String')value=ascii(node.value);
    else if(node.type==='Bool')value=node.value?'1':'0';
    else if(node.type==='Int')value=String(bounded(node.value));
    else if(node.type==='Rat')value=formatSettingsRational(node.value);
    else if(node.type==='Float')value=float(node.value);
    const name=node.name+(node.type==='Group'?'\\':'');
    let result=prefix+name+':'+metadata+'='+value+'\n';
    if(node.type==='Group')for(const child of node.children)if((child.runtime&4)&&!(child.runtime&1))result+=visit(child,prefix+name);
    return result;
  }
  return visit(node,prefix);
}
export function serializeSettingsRegistry(root,options){return 'Registry Version: 1.00\n'+serializeSettingsNode(root,options);}
export function normalizeSettingsDecimal(text,separator='.') {return separator==='.'?text:text.split(separator).join('.');}

export function decodeSettingsStream(input,{characterMode=3,newlineMode=1,swap=false}={}){
  const bytes=Buffer.from(input);let at=0,mode=characterMode,flipped=Boolean(swap),lineMode=newlineMode,pending=null,out='';
  if(![0,1,3].includes(mode)||![1,2,3,4,5].includes(lineMode))throw held('Unsupported settings stream mode');
  if(mode===3&&bytes.length){
    const first=bytes[at++];
    if(first===255||first===254){
      if(at===bytes.length)throw held('Incomplete settings marker');const second=bytes[at++];
      if(first===255&&second===254){mode=1;flipped=false;}
      else if(first===254&&second===255){mode=1;flipped=true;}
      else{mode=0;at--;}
    }else{mode=0;at--;}
  }
  function emit(c){
    if(pending!==null){const expected=pending;pending=null;if(c===expected){if(lineMode===2)lineMode=4;else if(lineMode===3)lineMode=5;return;}}
    if(lineMode===1){if(c===13){lineMode=2;pending=10;c=10;}else if(c===10){lineMode=3;pending=13;}}
    else if((lineMode===2||lineMode===4)&&c===13){if(lineMode===4)pending=10;c=10;}
    else if(lineMode===5&&c===10)pending=13;
    out+=String.fromCharCode(c);
  }
  while(at<bytes.length){
    let unit;
    if(mode===1){if(at+2>bytes.length)throw held('Incomplete settings word');unit=flipped?bytes.readUInt16BE(at):bytes.readUInt16LE(at);at+=2;if(unit===0xfeff)continue;if(unit===0xfffe){flipped=!flipped;continue;}}
    else unit=bytes[at++];emit(unit);
  }
  return {text:out,characterMode:mode,newlineMode:lineMode,swap:flipped};
}
export function encodeSettingsStream(text,{characterMode=3,inputCharacterMode=3}={}){
  ascii(text);let mode=characterMode===3?(inputCharacterMode===3?1:inputCharacterMode):characterMode;
  if(![0,1].includes(mode))throw held('Unsupported settings output mode');
  const normalized=text.replace(/\n/g,'\r\n'),bytes=Buffer.from(normalized,mode===1?'utf16le':'latin1');
  return {bytes:mode===1?Buffer.concat([Buffer.from([255,254]),bytes]):bytes,characterMode:mode,newlineMode:4,swap:false};
}
