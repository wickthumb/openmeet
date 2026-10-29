// Smooth the display between camera packets. Recorded columns and clocks are untouched.
// A short jitter buffer never advances beyond received source columns. Long gaps
// re-anchor the display; the viewport eases that recovery instead of jumping.
export class LiveFollow {
  constructor() {this.available=0;this.position=0;this.observations=[];this.lastAt=null;this.anchor=null;this.rate=0;this.resumed=false;}
  observe(available,now,columnsPerSecond) {
    if(!Number.isFinite(available)||!Number.isFinite(now)||!Number.isFinite(columnsPerSecond)||!(available>=this.available)||!(columnsPerSecond>0))return;
    const rate=columnsPerSecond/1000,delta=available-this.available;
    if(this.rate&&Math.abs(rate/this.rate-1)>.001){this.observations=[];this.anchor=null;this.lastAt=null;}
    this.rate=rate;
    if(delta>0){this.observations.push({phase:now-available/rate,packet:delta/rate});if(this.observations.length>64)this.observations.shift();}
    this.available=available;
  }
  sample(now) {
    this.resumed=false;if(!this.rate||!this.observations.length)return this.position;
    const phases=this.observations.map(x=>x.phase).sort((a,b)=>a-b),phase=phases[0];
    const jitter=phases[Math.floor((phases.length-1)*.9)]-phase;
    const packet=Math.max(...this.observations.map(x=>x.packet));
    this.bufferMs=Math.max(65,Math.min(240,packet+40+jitter));
    const wantedAnchor=phase+this.bufferMs,elapsed=this.lastAt==null?0:Math.max(0,now-this.lastAt);
    if(this.anchor==null)this.anchor=wantedAnchor;
    // Changing the jitter allowance slews playback speed, never rewinds the image.
    const slew=Math.min(50,elapsed)*.12;
    this.anchor+=Math.max(-slew,Math.min(slew,wantedAnchor-this.anchor));
    const wanted=Math.max(0,Math.min(this.available,(now-this.anchor)*this.rate));
    if(elapsed>1000||wanted-this.position>this.rate*500){this.position=Math.max(this.position,wanted);this.resumed=true;}
    else this.position=Math.max(this.position,Math.min(wanted,this.position+this.rate*Math.min(50,elapsed)*1.2));
    this.lastAt=now;return this.position;
  }
}
