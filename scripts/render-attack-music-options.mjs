// Five original music-only sketches. No live game imports, edits, or requests.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const folder = 'captures/attack-music-options';
const ffmpeg = '.cloudbreak-runtime/media/node_modules/ffmpeg-static/ffmpeg';
const SR = 44100, SECONDS = 35, TAU = Math.PI * 2;
export const tracks = [
  {id:'01-firewall-drive',name:'Firewall Drive',bpm:124,key:'D minor',style:'drive',seed:911,recommended:true,
    character:'Driving bass, a fast synth sequence, and restrained electronic drums.',tradeoff:'Urgent and controlled; the strongest starting point for active defense.',
    chords:[[38,50,53,57,60],[34,46,53,57,60],[36,48,51,55,62],[33,45,52,57,60]]},
  {id:'02-intrusion-protocol',name:'Intrusion Protocol',bpm:132,key:'C minor',style:'intrusion',seed:929,
    character:'Syncopated machine bass, dry metallic rhythm, and dark synth accents.',tradeoff:'More aggressive and mechanical, with less breathing room.',
    chords:[[36,48,51,55,58],[37,49,52,55,60],[32,44,51,55,58],[31,43,50,55,58]]},
  {id:'03-zero-day-chase',name:'Zero-Day Chase',bpm:144,key:'E minor',style:'chase',seed:941,
    character:'Rapid breakbeat rhythm and darting synth figures.',tradeoff:'The fastest and most arcade-like option; the busiest under game effects.',
    chords:[[40,52,55,59,62],[36,48,55,59,62],[38,50,57,59,64],[35,47,54,59,62]]},
  {id:'04-lockdown-clock',name:'Lockdown Clock',bpm:116,key:'F-sharp minor',style:'clock',seed:953,
    character:'A ticking pulse, clipped bass, and an insistent tension motif.',tradeoff:'Focused deadline pressure with more space between layers.',
    chords:[[30,49,52,56,61],[31,50,54,57,61],[30,49,52,56,61],[28,47,52,54,59]]},
  {id:'05-last-line',name:'Last Line',bpm:128,key:'G minor',style:'stand',seed:967,
    character:'Cinematic staccato synths, wide accents, and electronic rhythm.',tradeoff:'The strongest final-stand feeling, with a larger musical presence.',
    chords:[[31,50,55,58,62],[27,46,51,55,58],[29,48,53,57,60],[26,45,50,57,60]]},
];
const hz = midi => 440 * 2 ** ((midi - 69) / 12);
const smooth = x => {x = Math.max(0, Math.min(1, x)); return x*x*(3-2*x);};
function run(args) {
  const r = spawnSync(ffmpeg,['-nostdin','-hide_banner',...args],{maxBuffer:12*1024*1024});
  if(r.error) throw r.error; assert.equal(r.status,0,r.stderr.toString()); return r;
}
function measure(file) {
  const text = run(['-i',file,'-af','loudnorm=I=-23:TP=-3:LRA=8:print_format=json','-f','null','-']).stderr.toString();
  return JSON.parse(text.slice(text.lastIndexOf('{'),text.lastIndexOf('}')+1));
}
export function synth(spec, { loop = false } = {}) {
  const LENGTH = loop ? 64 * 60 / spec.bpm : 44, N = Math.round(SR * LENGTH);
  const left = new Float64Array(N), right = new Float64Array(N), notes = [];
  let seed=spec.seed;
  const rand = () => {seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  function note(midi,start,duration,instrument,amp=.05,pan=0) {
    if(start>=LENGTH) return;
    const f=hz(midi), begin=Math.max(0,Math.round(start*SR)), end=loop?Math.round((start+duration)*SR):Math.min(N,Math.round((start+duration)*SR));
    const phase=rand()*TAU, lg=Math.cos((pan+1)*Math.PI/4),rg=Math.sin((pan+1)*Math.PI/4);
    notes.push({midi,start:+start.toFixed(4),duration:+duration.toFixed(4),instrument,amplitude:amp,pan:+pan.toFixed(3)});
    for(let i=begin;i<end;i++) {
      const t=i/SR-start,w=TAU*f*t;
      let y=0,env=0;
      if(instrument==='bed') {
        env=smooth(t/.55)*smooth((duration-t)/.8);
        y=.5*Math.sin(w)+.24*Math.sin(w*1.003+phase)+.13*Math.sin(w*2)+.065*Math.sin(w*3.001);
      } else if(instrument==='motor') {
        env=smooth(t/.012)*Math.exp(-t/.22)*smooth((duration-t)/.065);
        y=.60*Math.sin(w)+.27*Math.sin(w*2)*Math.exp(-t/.22)+.16*Math.sin(w*3)*Math.exp(-t/.12)+.08*Math.sin(w*4)*Math.exp(-t/.07);
      } else if(instrument==='acid') {
        env=smooth(t/.008)*Math.exp(-t/.19)*smooth((duration-t)/.055);
        const opening=Math.exp(-t/.13);
        y=.59*Math.sin(w)+.27*opening*Math.sin(w*2)+.20*opening*Math.sin(w*3)+.11*opening*Math.sin(w*5)+.05*opening*Math.sin(w*7);
      } else if(instrument==='arp') {
        env=smooth(t/.011)*Math.exp(-t/.145)*smooth((duration-t)/.055);
        y=.64*Math.sin(w)+.24*Math.sin(w*2.001)*Math.exp(-t/.09)+.12*Math.sin(w*3)*Math.exp(-t/.055);
      } else if(instrument==='stab') {
        env=smooth(t/.035)*Math.exp(-t/.29)*smooth((duration-t)/.13);
        y=.44*Math.sin(w)+.27*Math.sin(w*.998+phase)+.22*Math.sin(w*2)+.11*Math.sin(w*3.001)*Math.exp(-t/.15);
      } else if(instrument==='string') {
        env=smooth(t/.019)*Math.exp(-t/.18)*smooth((duration-t)/.08);
        y=.48*Math.sin(w)+.24*Math.sin(w*2)+.16*Math.sin(w*3)+.09*Math.sin(w*4)+.045*Math.sin(w*5);
      } else if(instrument==='kick') {
        env=smooth(t/.004)*Math.exp(-t/.078)*smooth((duration-t)/.035);
        // Short original kick: pitched transient without the long low gate-hit thump.
        const phaseKick=TAU*(48*t+35*.02*(1-Math.exp(-t/.02)));
        y=.86*Math.sin(phaseKick)+.08*Math.sin(TAU*96*t)*Math.exp(-t/.025);
      } else if(instrument==='snare') {
        env=smooth(t/.003)*Math.exp(-t/.047)*smooth((duration-t)/.027);
        const air=(rand()*2-1)+(rand()*2-1)*.4;
        y=air*.38+.18*Math.sin(TAU*182*t)*Math.exp(-t/.028);
      } else if(instrument==='hat') {
        env=smooth(t/.002)*Math.exp(-t/.016)*smooth((duration-t)/.012);
        y=.17*Math.sin(TAU*2330*t)+.15*Math.sin(TAU*3217*t)+.10*Math.sin(TAU*4123*t)+(rand()*2-1)*.23;
      } else if(instrument==='tick') {
        env=smooth(t/.003)*Math.exp(-t/.028)*smooth((duration-t)/.018);
        y=.6*Math.sin(TAU*900*t)+.15*Math.sin(TAU*1433*t)*Math.exp(-t/.009);
      } else if(instrument==='lift') {
        env=smooth(t/2)*smooth((duration-t)/1.2);
        const rising=t*t*.016;
        y=.55*Math.sin(w+rising)+.22*Math.sin(w*1.003+rising)+.13*Math.sin(w*2+rising);
      }
      const value=y*env*amp;
      left[i%N]+=value*lg;right[i%N]+=value*rg;
    }
  }
  const beat=60/spec.bpm, span=8*beat;
  for(let c=0;c<Math.ceil(LENGTH/span);c++) {
    const chord=spec.chords[c%4],start=c*span;
    const pressure=Math.min(1,start/22),g=.78+.22*pressure;
    chord.slice(1,4).forEach((m,k)=>note(m,start,span+.8,'bed',spec.style==='clock'?.009:.013,(k-1)*.5));
    // Percussion begins immediately. Every design gets its own meter accents.
    const kicks=spec.style==='chase'?[0,1.5,2.75,4,5.5,6.5]:spec.style==='intrusion'?[0,1.75,3,4,5.75,7]:spec.style==='clock'?[0,2.5,4,6.5]:[0,2,3.5,4,6];
    for(const b of kicks)note(36,start+b*beat,.23,'kick',spec.style==='clock'?.068:.105);
    for(const b of [1,3,5,7])note(50,start+b*beat,.15,'snare',spec.style==='clock'?.033:.068*g,b%4===1?-.09:.09);
    const hatStep=spec.style==='chase'?.25:.5;
    for(let b=.5;b<8;b+=hatStep) {
      if(spec.style==='clock'&&Math.round(b*2)%2===0)continue;
      note(80,start+b*beat,.085,'hat',(b%1===.5?.031:.014)*g,Math.sin(b*1.7)*.35);
    }
    if(spec.style==='drive') {
      const bass=[0,0,12,0,0,7,0,10,0,0,12,0,7,0,10,7];
      for(let n=0;n<16;n++)note(chord[0]+bass[n],start+n*.5*beat,beat*.72,'motor',n%4===0?.104:.068);
      const order=[1,3,2,3,1,4,2,3];
      for(let n=0;n<32;n++) {
        if(n%8===7||(!pressure&&n%2))continue;
        note(chord[order[n%8]]+12,start+n*.25*beat,beat*.43,'arp',n%4===0?.037:.023,Math.sin(n*.45)*.42);
      }
      if(c>=2)for(const b of [.5,4.5])chord.slice(2).forEach((m,k)=>note(m,start+b*beat,.65,'stab',.03,(k-1)*.42));
    } else if(spec.style==='intrusion') {
      const pattern=[0,.75,1.25,1.75,2.5,3,3.5,4,4.75,5.5,6,6.5,7.25,7.5];
      pattern.forEach((b,k)=>note(chord[0]+[0,0,12,0,7,0,1][k%7],start+b*beat,beat*.65,'acid',k%3?.082:.105));
      for(const b of [.5,2.25,3.75,4.5,6.25,7.75])note(chord[2]+12,start+b*beat,beat*.36,'arp',.043,Math.sin(b)*.45);
      for(const b of [0,4])chord.slice(1,4).forEach((m,k)=>note(m,start+b*beat,.5,'stab',.039,(k-1)*.35));
      if(c>1)for(let b=.25;b<8;b++)note(80,start+b*beat,.075,'tick',.013,.25);
    } else if(spec.style==='chase') {
      for(let n=0;n<16;n++)note(chord[0]+[0,0,12,7,0,10,7,12][n%8],start+n*.5*beat,beat*.55,'motor',.088);
      const melody=[1,3,4,3,2,1,3,2,1,3,2,4,3,2,4,3];
      for(let n=0;n<32;n++) {
        if([7,15,23,30].includes(n))continue;
        note(chord[melody[(n+c)%16]]+12,start+n*.25*beat,beat*.35,'arp',.033*g,Math.sin(n*.8)*.48);
      }
      if(c>1)for(const b of [2.75,6.75])note(50,start+b*beat,.13,'snare',.031,.12);
    } else if(spec.style==='clock') {
      for(let n=0;n<16;n++)note(chord[0]+(n%8===6?12:0),start+n*.5*beat,beat*.6,'motor',n%4===0?.093:.054);
      for(let b=0;b<8;b+=.5)note(80,start+b*beat,.09,'tick',b%1===0?.028:.015,b%1===0?-.22:.22);
      for(const [b,offset] of [[.75,0],[2.25,1],[4.75,0],[6.25,-1]])note(chord[2]+12+offset,start+b*beat,.48,'arp',.048,.1);
      if(c>2)chord.slice(1,3).forEach((m,k)=>note(m,start+3*beat,2.5,'lift',.017,(k-.5)*.65));
    } else {
      const pulse=[1,1,3,1,2,1,4,3,1,1,3,2,1,4,3,2];
      for(let n=0;n<16;n++) {
        note(chord[pulse[n]],start+n*.5*beat,beat*.68,'string',.053*g,Math.sin(n*.4)*.35);
        if(n%2===0)note(chord[0],start+n*.5*beat,beat*.8,'motor',.095);
      }
      for(const b of [0,3.5,4.5])chord.slice(2).forEach((m,k)=>note(m,start+b*beat,.9,'stab',.035*g,(k-1)*.5));
      if(c>1)for(const [b,m] of [[1.5,chord[2]+12],[3,chord[3]+12],[5.5,chord[4]+12]])note(m,start+b*beat,.7,'string',.041,.15);
    }
    // Add harmonic lift in the latter half, not a piercing siren or faux warning.
    if(c===4||c===6)note(chord[1],start,span+1.2,'lift',.018,-.35);
  }
  const dryL=left.slice(),dryR=right.slice();
  // Short, quiet echoes leave gaps between rhythmic attacks.
  const taps=[[beat*.75,.075],[beat*1.5,.04],[.113,.035],[.241,.025]];
  for(const [index,[delay,gain]] of taps.entries()) {
    const offset=Math.round(delay*SR);let l=0,r=0;
    for(let i=loop?-SR:offset;i<N;i++) {
      const source=loop?((i-offset)%N+N)%N:i-offset;
      l=.8*l+.2*(index%2?dryL:dryR)[source];r=.8*r+.2*(index%2?dryR:dryL)[source];
      if(i>=0){left[i]+=l*gain;right[i]+=r*gain;}
    }
  }
  const frames=loop?N:SR*SECONDS,data=Buffer.alloc(frames*4);let prevL=0,prevR=0,hpL=0,hpR=0,peak=0;
  // One second of circular filter history reaches steady state before sample zero.
  // Natural note releases and echoes wrap; a loop has no fade-out or silent gap.
  for(let i=loop?-SR:0;i<frames;i++) {
    const source=(i+N)%N,t=i/SR,fade=loop?1:smooth(t/.16)*smooth((SECONDS-t)/1.6);
    hpL=left[source]-prevL+.998*hpL;prevL=left[source];hpR=right[source]-prevR+.998*hpR;prevR=right[source];
    if(i<0)continue;
    const l=hpL*fade*.72,r=hpR*fade*.72;peak=Math.max(peak,Math.abs(l),Math.abs(r));
    assert.ok(peak<.96,'Original render must not clip');
    data.writeInt16LE(Math.round(l*32767),i*4);data.writeInt16LE(Math.round(r*32767),i*4+2);
  }
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(data.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(SR,24);header.writeUInt32LE(SR*4,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(data.length,40);
  return {wav:Buffer.concat([header,data]),notes,rawPeak:peak};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
await mkdir(`${folder}/raw`,{recursive:true});
const results=[];
for(const spec of tracks) {
  const generated=synth(spec),raw=`${folder}/raw/${spec.id}.wav`,master=`${folder}/raw/${spec.id}-master.wav`,file=`${folder}/${spec.id}.mp3`;
  await writeFile(raw,generated.wav);
  const m=measure(raw);
  const filter=`loudnorm=I=-23:TP=-3:LRA=8:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  run(['-y','-loglevel','error','-i',raw,'-af',filter,'-ar',String(SR),'-c:a','pcm_s16le',master]);
  run(['-y','-loglevel','error','-i',master,'-codec:a','libmp3lame','-b:a','192k',file]);
  const check=measure(file),bytes=await readFile(file);
  assert.ok(Math.abs(Number(check.input_i)+23)<.7);assert.ok(Number(check.input_tp)<-3);
  results.push({...spec,seconds:SECONDS,sampleRate:SR,channels:2,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),loudnessLufs:Number(check.input_i),truePeakDbtp:Number(check.input_tp),rawPeak:generated.rawPeak,notes:generated.notes});
  console.log(`${spec.name}: ${SECONDS}s, ${check.input_i} LUFS, ${check.input_tp} dBTP`);
}
await writeFile(`${folder}/manifest.json`,JSON.stringify({title:'Cloudbreak — five urgent defense score options',gameCheckpoint:'21d6e0a575f2efd0a2596bd1641b94fd88af5eb3',createdAt:new Date().toISOString(),source:'Original action-score arrangements with locally synthesized tonal instruments and restrained electronic percussion. No external songs, recordings or samples; earlier previews are not sped up or reused.',status:'Music-only attack-score auditions with immediate rhythm and staged musical development, not final seamless loops. No option has been installed.',normalization:'35-second stereo MP3s matched near -23 integrated LUFS for comparison. No game effects included.',tracks:results},null,2)+'\n');
}
