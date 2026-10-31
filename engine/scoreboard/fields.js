// Standard logical selectors. Device framing remains the configured script's job.
export const SECTION_GROUPS=[16,17,17,17,17,17,17,17,18,17,19,19,20,19,19,20,19,19,20,19,19,19,20,21,21,22];
export function standardScoreboardField(group,variable,context,timeText){
  let value='';const {row,heat,clock,state}=context;
  if(group===17){
    if(variable===1)value=clock.text;
    else if([3,4,5,6].includes(variable))value=clock.pattern??timeText(clock.seconds,{precisionTicks:({3:80,4:8,5:8000,6:800})[variable]});
  }else if(group===18){if(variable===1)value=state.wind==null?'':(state.wind>=0?'+':'')+state.wind.toFixed(1);}
  else if(group===19){value=({2:heat.name,3:state.wind==null?'':String(state.wind),4:heat.event,5:heat.round,6:heat.heat,8:state.lanes.length,9:heat.state})[variable]??'';}
  else if(group===20&&row){value=({1:row.place??'',2:row.lane??'',3:row.id??'',4:[row.last,row.first].filter(Boolean).join(', '),5:row.affiliation,6:row.status??(row.time==null?'':timeText(row.time)),23:row.first,24:row.last})[variable]??'';}
  else if(group===22&&variable===1)value=context.message??'';
  return {kind:'text',value:String(value??'')};
}
