// Expand the four original TTP finishes into a twelve-heat operator practice meet.
// Finish footage is reused; 200/400 m practice heats shift the race clock only.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEvt } from '../engine/meetlink/parse.js';

export async function expandDemo(folder) {
  const root=path.resolve(folder),meet=path.join(root,'meet');
  const evt=await fs.readFile(path.join(meet,'lynx.evt'),'utf8');
  const originals=parseEvt(evt).filter(e=>['3','4'].includes(String(e.event))&&e.round===1&&[1,2].includes(e.heat));
  if(originals.length!==4)throw Error('Expected the original four 100 m demo heats');
  const additions=[];
  for(const [distance,eventOffset,girlsShift,boysShift] of [[200,2,12,11],[400,4,45,42]]) {
    for(let i=0;i<4;i++) {
      const original=originals[i],n=additions.length+5,source=`heat-${i+1}`,destination=`heat-${n}`;
      const event=Number(original.event)+eventOffset,name=original.name.replace('100',String(distance));
      const shift=i<2?girlsShift:boysShift,staging=path.join(root,`.${destination}.staging`),target=path.join(root,destination);
      const provenance={source_heat:source,clock_shift_s:shift,note:'Reuses the original TTP finish footage for operator practice; not a new race render.'};
      try { await fs.access(target); const existing=JSON.parse(await fs.readFile(path.join(target,'primary.json'),'utf8'));if(existing.practice?.source_heat!==source||existing.event!==event)throw Error(`${destination} already exists with different data`); }
      catch(error) {
        if(error.code!=='ENOENT')throw error;
        await fs.rm(staging,{recursive:true,force:true});await fs.mkdir(staging);
        for(const file of await fs.readdir(path.join(root,source),{withFileTypes:true})) {
          if(file.isDirectory()||file.isSymbolicLink()) {
            if(file.name==='front')await fs.symlink(`../${source}/front`,path.join(staging,'front'),'dir');
            continue;
          }
          const from=path.join(root,source,file.name),to=path.join(staging,file.name);
          if(file.name.endsWith('.json')) {
            const data=JSON.parse(await fs.readFile(from,'utf8'));
            for(const key of ['first_column_race_time_s','last_column_race_time_s','first_frame_race_time_s','last_frame_race_time_s'])if(Number.isFinite(data[key]))data[key]=Number((data[key]+shift).toFixed(9));
            for(const p of data.truth||[])if(Number.isFinite(p.time_s))p.time_s=Number((p.time_s+shift).toFixed(9));
            Object.assign(data,{event,round:original.round,heat:original.heat,event_name:name,practice:provenance});
            await fs.writeFile(to,JSON.stringify(data,null,2)+'\n');
          } else await fs.copyFile(from,to,constants.COPYFILE_FICLONE);
        }
        await fs.rename(staging,target);
      }
      additions.push({...original,event,name,folder:destination,practice:provenance});
    }
  }
  const existing=parseEvt(evt),missing=additions.filter(a=>!existing.some(e=>String(e.event)===String(a.event)&&e.round===a.round&&e.heat===a.heat));
  const backup=path.join(root,'.before-demo-expansion');await fs.mkdir(backup,{recursive:true});
  for(const file of ['lynx.evt','lynx.sch'])await fs.copyFile(path.join(meet,file),path.join(backup,file),constants.COPYFILE_EXCL).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const csv=v=>/[",\r\n]/.test(String(v))?'"'+String(v).replaceAll('"','""')+'"':String(v);
  const extra=missing.map(e=>[[e.event,e.round,e.heat,e.name],...e.entries.map(a=>[a.status?'\\'+a.status:'',a.id??'',a.lane,a.last,a.first,a.affiliation])].map(row=>row.map(csv).join(',')).join('\r\n')).join('\r\n');
  const heats=[...originals.map((e,i)=>({...e,folder:`heat-${i+1}`})),...additions];
  const updates=[
    [path.join(meet,'lynx.evt'),evt.trimEnd()+(extra?'\r\n'+extra:'')+'\r\n'],
    [path.join(meet,'lynx.sch'),heats.map(e=>[e.event,e.round,e.heat].join(',')).join('\r\n')+'\r\n'],
    [path.join(root,'openmeet-replay.json'),JSON.stringify({version:1,type:'ttp-simulator',name:'OpenMeet demo',meet:'meet',heats:heats.map(({folder,event,round,heat,practice})=>({folder,event,round,heat,...(practice?{practice}:{})}))},null,2)+'\n']
  ];
  for(const [file,text]of updates){await fs.writeFile(file+'.tmp',text);await fs.rename(file+'.tmp',file);}
  return {name:'OpenMeet demo',heats:heats.length,events:6,reusedFinishHeats:additions.length};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  if(!process.argv[2])throw Error('Usage: node app/expand-demo.mjs /path/to/openmeet-demo-assets');
  console.log(await expandDemo(process.argv[2]));
}
