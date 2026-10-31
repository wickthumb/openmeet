import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {LiveFollow} from '../renderer/live-follow.mjs';

function replay(jitter=[0],rate=800,packet=64) {
  const follow=new LiveFollow(),events=[];
  for(let n=packet;n<=rate*10;n+=packet)events.push({at:Math.max(events.at(-1)?.at??0,n/rate*1000+jitter[events.length%jitter.length]),n});
  let next=0;const frames=[];
  for(let at=0;at<10000;at+=1000/60){
    while(events[next]?.at<=at){follow.observe(events[next].n,events[next].at,rate);next++;}
    frames.push({at,p:follow.sample(at),available:follow.available,resumed:follow.resumed});
  }
  return {follow,frames};
}

test('64-column batches advance smoothly between arrivals, with bounded display delay',()=>{
  for(const jitter of [[0],[0,13,0,22,4,8],[0,160,0,0,0]]){
    const {follow,frames}=replay(jitter);
    for(let i=1;i<frames.length;i++){
      const p=frames[i],old=frames[i-1];assert.ok(p.p>=old.p&&p.p<=p.available);
      if(p.at>3000)assert.ok(Math.abs((p.p-old.p)/(p.at-old.at)-.8)<1e-8,'Motion follows packet arrivals instead of the presentation clock');
    }
    assert.ok(follow.bufferMs<=240);assert.ok(follow.available-follow.position<800*.3);
  }
});

test('the same clock supports high-rate sensors without scaling source columns',()=>{
  const {frames}=replay([0,3,1,6],6000);
  const last=frames.at(-1);assert.ok(last.p>58000&&last.p<=last.available);
  for(let i=181;i<frames.length;i++)assert.ok(Math.abs((frames[i].p-frames[i-1].p)/(frames[i].at-frames[i-1].at)-6)<1e-8);
});

test('network stalls never invent pixels; delivery recovery and background resume re-anchor',()=>{
  const follow=new LiveFollow();follow.observe(800,1000,800);follow.sample(1000);
  for(let at=1016;at<6000;at+=16)assert.ok(follow.sample(at)<=800);
  assert.equal(follow.position,800);
  follow.observe(4800,6000,800);follow.sample(6000);assert.equal(follow.resumed,true);assert.ok(follow.position<=4800&&follow.position>4400);
  const old=follow.position;follow.observe(6400,8000,800);assert.ok(follow.sample(8000)>=old);assert.equal(follow.resumed,true);
});

test('rate changes and invalid observations cannot rewind or corrupt the display',()=>{
  const follow=new LiveFollow();follow.observe(800,1000,800);follow.sample(1000);follow.sample(1500);
  const old=follow.position;follow.observe(1600,1800,2000);assert.ok(follow.sample(1800)>=old);
  const snapshot=JSON.stringify(follow);
  for(const args of [[3,1900,800],[Infinity,1900,800],[2000,NaN,800],[2000,1900,Infinity],[2000,1900,0]])follow.observe(...args);
  assert.equal(JSON.stringify(follow),snapshot);
  assert.ok(follow.sample(1816)<=1600);
});

test('cached packet statistics preserve every baseline presentation-clock result',()=>{
  const vectors=JSON.parse(readFileSync(new URL('./fixtures/live-follow-vectors.json',import.meta.url),'utf8'));
  for(const fixture of vectors.cases){
    const follow=new LiveFollow(),hash=createHash('sha256');let available=0,random=fixture.seed;
    for(let frame=0;frame<fixture.frames;frame++){
      random=(Math.imul(random,1664525)+1013904223)>>>0;
      const now=frame*(1000/(fixture.seed%2?60:144))+(frame>1200?3000:0),rate=[800,6000,500,1250][Math.floor(frame/600)];
      if(frame%(fixture.seed%7+1)===0){available+=[1,64,200][random%3];follow.observe(available,now+(random%41)-20,rate);}
      if(frame%29===0)follow.observe(available,now,rate);
      if(frame%97===0){follow.observe(available-1,now,rate);follow.observe(available,NaN,rate);follow.observe(available,now,0);}
      const position=follow.sample(now);hash.update(JSON.stringify([position,follow.available,follow.anchor,follow.lastAt,follow.rate,follow.bufferMs??null,follow.resumed])+'\n');
    }
    assert.equal(hash.digest('hex'),fixture.sha256,'Presentation clock changed for seed '+fixture.seed);
  }
});
