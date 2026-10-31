import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as settings from './settings.js';
const fixtures=JSON.parse(fs.readFileSync(new URL('./settings-vectors.json',import.meta.url),'utf8'));
const copy=structuredClone;
function projection(actual,expected){for(const [key,value]of Object.entries(expected))assert.deepEqual(actual[key],value,key);}
for(const item of fixtures.integerPrefix)test(item.id+' integer lexical prefix',()=>{
  const result=settings.settingsIntegerPrefix(item.input);assert.equal(result.ok,item.expected.ok);
  if(item.expected.ok)assert.deepEqual(result,item.expected);
});
for(const [family,key]of[['booleanSetter','Bool'],['rationalSetter','Rat'],['stringSetter','String']])for(const item of fixtures[family])test(item.id+' '+key+' setter',()=>{
  const node=copy(item.initial),result=settings.setSettingsValue(node,item.input);
  assert.equal(result.valueSuccess,item.expected.valueSuccess);
  if('value'in item.expected)assert.deepEqual(node.value,item.expected.value);
  if('runtime'in item.expected)assert.equal(node.runtime,item.expected.runtime);
  if('writerPayload'in item.expected){const text=settings.serializeSettingsNode(node);assert.equal(text.slice(text.indexOf('=')+1,-1),item.expected.writerPayload);}
});
for(const item of fixtures.floatPrefix)test(item.id+' Float lexical profile',()=>{
  if(item.expected.value==='HELD_numerical_rounding'){
    let token;const out=settings.settingsFloatPrefix(item.input,{convert:value=>{token=value;return 0;}});
    assert.equal(token,item.expected.token);assert.equal(out.ok,true);
  }else{const out=settings.settingsFloatPrefix(item.input);assert.equal(out.ok,item.expected.ok);if(out.ok)projection(out,item.expected);}
});
for(const item of fixtures.declarations)test(item.id+' dynamic typed declaration',()=>{
  const root=copy(fixtures.initialStates[item.initialState]),result=settings.resolveSettingsLine(root,item.input),e=item.expected;
  assert.equal(result.inserted,e.inserted);
  if('localStages'in e)assert.equal(result.localStages,e.localStages);
  if(e.newChild)assert.deepEqual(root.children.at(-1),e.newChild);
  else assert.equal(result.inserted,false);
});
for(const item of fixtures.existingUpdates)test(item.id+' existing metadata/value partial mutation',()=>{
  const root=copy(fixtures.initialStates[item.initialState]),result=settings.resolveSettingsLine(root,item.input);
  projection(root.children[0],item.expected.stateProjectionOfOriginalChild);assert.equal(result.localStages,item.expected.localStages);
});
for(const item of fixtures.rootPrefixes)test(item.id+' literal root/path matching',()=>{
  const root=copy(fixtures.initialStates[item.initialState]),result=settings.resolveSettingsLine(root,item.input),e=item.expected;
  assert.equal(result.rootPrefixConsumed,e.rootPrefixConsumed);assert.equal(result.node===root.children[0].children[0]&&result.targetAssigned,e.targetAssigned);
  assert.equal(root.children[0].children[0].value,e.originalTallyValue);
  if(e.insertedSiblingName){assert.equal(root.children[0].children.at(-1).name,e.insertedSiblingName);assert.equal(root.children[0].children.at(-1).value,e.insertedSiblingValue);}
});
for(const item of fixtures.writerTrees)test(item.id+' ordered serialization',()=>{
  assert.equal(item.input.root?settings.serializeSettingsRegistry(item.input.root):settings.serializeSettingsNode(item.input.node,{prefix:item.input.prefix}),item.expected.text);
});
for(const item of fixtures.registrySequences.filter(x=>x.expected.expectedFinalTree&&x.change!==undefined))test(item.id+' full load/change/write',()=>{
  const root=copy(fixtures.initialStates[item.initialState]);settings.loadSettingsRegistry(item.inputText,{root});
  if(item.change)settings.resolveSettingsLine(root,item.change);
  assert.deepEqual(root,item.expected.expectedFinalTree);assert.equal(settings.serializeSettingsRegistry(root),item.expected.writerText);
});
for(const item of fixtures.floatFormatting)test(item.id+' supplied Float formatter/locale',()=>{
  if(item.input.raw){assert.equal(settings.normalizeSettingsDecimal(item.input.raw,item.input.localeDecimalSeparator),item.expected.text);return;}
  if(item.expected.disposition){assert.throws(()=>settings.serializeSettingsNode({type:'Float',runtime:4,metadata:1,lower:2.2250738585072014e-308,upper:Number.MAX_VALUE,...item.input}),{code:'ERR_SETTINGS_UNSPECIFIED'});return;}
  const values=item.injected,node={type:'Float',runtime:4,...item.input};
  const raw=value=>value===node.value?values.valueRaw:value===node.lower?values.lowerRaw:values.upperRaw;
  assert.equal(settings.serializeSettingsNode(node,{floatFormat:raw,decimalSeparator:values.localeDecimalSeparator}),item.expected.text);
});
for(const item of fixtures.streamEnvelope.decodeCharacters)test(item.id+' character envelope',()=>{
  const result=settings.decodeSettingsStream(Buffer.from(item.inputHex,'hex'));
  assert.deepEqual(Array.from(result.text,c=>c.charCodeAt(0)),item.expected.units);
  assert.equal(result.characterMode,item.expected.characterMode);assert.equal(Number(result.swap),item.expected.swap);
});
for(const item of fixtures.streamEnvelope.normalizeNewlines)test(item.id+' newline state machine',()=>{
  const result=settings.decodeSettingsStream(Buffer.from(item.inputUnits),{characterMode:0,newlineMode:item.initialNewlineMode});
  assert.deepEqual(Array.from(result.text,c=>c.charCodeAt(0)),item.expected.logicalUnits);assert.equal(result.newlineMode,item.expected.finalNewlineMode);
});
test('custom setters preserve mutations and type-specific Boolean completion',()=>{
  const n={name:'x',type:'Int',runtime:4,value:3,metadata:1,lower:-5,upper:9};
  assert.equal(settings.setSettingsValue(n,'18',{onSet(node){node.value=18;return false;}}).valueSuccess,true);assert.equal(n.runtime,6);
  const s={name:'x',type:'String',runtime:4,value:'old',metadata:1};
  assert.equal(settings.setSettingsValue(s,'new',{onSet(node){node.value='changed';return false;}}).valueSuccess,false);assert.equal(s.value,'changed');assert.equal(s.runtime,4);
  assert.throws(()=>settings.setSettingsValue(n,'8',{onSet(){throw Error('caller');}}),/caller/);
});
test('unresolved Float conversion is explicit, while output mode follows resolved input mode',()=>{
  assert.throws(()=>settings.settingsFloatPrefix('0.1'),{code:'ERR_SETTINGS_UNSPECIFIED'});
  assert.equal(settings.settingsFloatPrefix('0.1',{convert:Number}).value,0.1);
  assert.equal(settings.encodeSettingsStream('A\n',{inputCharacterMode:0}).bytes.toString('hex'),'410d0a');
  assert.equal(settings.encodeSettingsStream('A\n').bytes.toString('hex'),'fffe41000d000a00');
});
