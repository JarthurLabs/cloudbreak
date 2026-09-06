// Native 4K educational edit of a measured, normal-clock Cloudbreak playthrough.
// Captions and illustrated cards are editorial; gameplay and its audio are real.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, relative } from 'node:path';
import assert from 'node:assert/strict';
const ROOT=resolve(import.meta.dirname,'..'),folder=resolve(ROOT,'captures/release');
const raw=resolve(folder,'raw'),parts=resolve(raw,'film-parts'),proof=resolve(folder,'film-verification');
const ffmpeg=resolve(ROOT,'.cloudbreak-runtime/media/node_modules/ffmpeg-static/ffmpeg');
const source=resolve(raw,'Cloudbreak-Full-Flight-4k.mp4'),music=resolve(ROOT,'public/audio/firewall-drive-loop.wav');
const FPS=24,WIDTH=3840,HEIGHT=2160;
const selected=new Set(process.argv.slice(2));
const font='/System/Library/Fonts/Supplemental/Arial.ttf',bold='/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const local=path=>relative(ROOT,path),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(args,collect=false)=>new Promise((done,reject)=>{const child=spawn(ffmpeg,['-nostdin','-hide_banner','-nostats',...args],{cwd:ROOT,stdio:['ignore','pipe','pipe']});let stderr='',data=[];child.stdout.on('data',chunk=>{if(collect)data.push(chunk)});child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-40000));child.once('error',reject);child.once('close',code=>code===0?done({stderr,data:collect?Buffer.concat(data):null}):reject(new Error(`FFmpeg ${code}: ${stderr}`)))});
const measure=async args=>{const{stderr}=await run([...args,'-vn','-af','loudnorm=I=-20:TP=-1.5:LRA=8:print_format=json','-f','null','-']);return JSON.parse(stderr.slice(stderr.lastIndexOf('{'),stderr.lastIndexOf('}')+1))};
await stat(resolve(raw,'mux-report.json')); // Never read an unfinished source encode.
const p=JSON.parse(await readFile(resolve(folder,'playthrough.json'),'utf8'));
const sourceManifest=JSON.parse(await readFile(p.recording.manifestPath,'utf8'));
const stage=name=>p.stages.find(s=>s.name===name);
// Each mission timestamp is mapped from the nearest observed source epoch,
// not the time a script started or an assumed capture delay.
const missionVideo=seconds=>{const candidates=p.stages.filter(s=>s.state.elapsed<180&&s.name!=='briefing');const near=candidates.reduce((a,b)=>Math.abs(a.state.elapsed-seconds)<Math.abs(b.state.elapsed-seconds)?a:b);return near.epochSeconds-p.recording.firstFrameEpochSeconds+(seconds-near.state.elapsed)};
const captions={
 customers:{tag:'THE CHALLENGE',title:'Customers and attacks share the same connection.',detail:'Keep at least 75% of legitimate customer requests moving.',color:'79e5ed'},
 auth:{tag:'01  AUTHENTICATION',title:'Bad credentials? Require a valid key.',detail:'Key check blocks probes. Anonymous customers can be refused too.',color:'ff819d'},
 rate:{tag:'02  RATE LIMITING',title:'Too many requests? Slow the flow.',detail:'One request per second. Customers and attackers share that cap.',color:'ffd17c'},
 isolate:{tag:'03  ISOLATION',title:'A dangerous request can have a valid key.',detail:'Close bridge stops all traffic on that route, including customers.',color:'c7a1f8'},
 reopen:{tag:'RESTORE SERVICE',title:'When the threat clears, reopen the route.',detail:'Protecting a cloud environment also means keeping it available.',color:'79e5ed'},
 multi:{tag:'MULTIPLE SERVICES',title:'Match each threat to the right control.',detail:'Defend several routes while legitimate work continues.',color:'79e5ed'},
 victory:{tag:'THE RESULT',title:'85.4% of customers served. The city stays online.',detail:'This actual run preserved 80.9 integrity and blocked 762 threats.',color:'79e5ed'},
 evidence:{tag:'LOOK UNDER THE HOOD',title:'Every decision leaves a real request record.',detail:'Real HTTP responses. Authored traffic. Fictional city damage.',color:'79e5ed'},
};
const edit=[
 {id:'00-intro',type:'card',file:'intro-4k.mp4',start:0,seconds:12},
 {id:'01-customers',type:'gameplay',missionStart:2,missionEnd:9,caption:'customers'},
 {id:'02-authentication',type:'gameplay',missionStart:14,missionEnd:23,caption:'auth'},
 {id:'03-rate-limit',type:'gameplay',missionStart:32,missionEnd:42,caption:'rate'},
 {id:'04-isolation',type:'gameplay',missionStart:52,missionEnd:59,caption:'isolate'},
 {id:'05-isolation-responses',type:'gameplay',missionStart:60.5,missionEnd:63.8,caption:'isolate'},
 {id:'06-reopen',type:'gameplay',missionStart:64,missionEnd:68,caption:'reopen'},
 {id:'07-customers-return',type:'gameplay',missionStart:69.5,missionEnd:73,caption:'reopen'},
 {id:'08-simultaneous-defense',type:'gameplay',missionStart:144,missionEnd:159,caption:'multi'},
 {id:'09-victory',type:'gameplay',start:187.8,seconds:4.5,caption:'victory'},
 {id:'10-evidence',type:'gameplay',start:195.1,seconds:4.2,caption:'evidence'},
 {id:'11-outro',type:'card',file:'outro-4k.mp4',start:0,seconds:8},
];
await mkdir(parts,{recursive:true});await mkdir(proof,{recursive:true});
const captionFilter=async(key,id)=>{const cap=captions[key],lines=[cap.tag,cap.title,cap.detail],sizes=[31,58,40],ys=[1400,1458,1538];
 let filter=`drawbox=x=760:y=1370:w=2320:h=238:color=0x081b25@0.94:t=fill,drawbox=x=760:y=1370:w=2320:h=4:color=0x${cap.color}:t=fill`;
 for(let i=0;i<lines.length;i++){const file=resolve(parts,`${id}-caption-${i}.txt`);await writeFile(file,lines[i]);filter+=`,drawtext=fontfile='${i===1?bold:font}':textfile='${file}':expansion=none:fontsize=${sizes[i]}:fontcolor=${i===0?'0x'+cap.color:i===1?'0xecf7f8':'0xb7ccd4'}:x=(w-text_w)/2:y=${ys[i]}`}
 return filter;
};
const reference=await measure(['-i',source]);
const musicLevel=await measure(['-i',music]);
const cardGainDb=Number(reference.input_i)-Number(musicLevel.input_i);
let timeline=0;
for(const item of edit){
 if(item.missionStart!==undefined){item.start=missionVideo(item.missionStart);item.seconds=item.missionEnd-item.missionStart;}
 item.frames=Math.round(item.seconds*FPS);item.seconds=item.frames/FPS;
 item.filmStart=timeline;item.filmEnd=timeline+item.seconds;timeline=item.filmEnd;
 const file=resolve(parts,`${item.id}.mkv`);item.part=local(file);
 const input=item.type==='card'?resolve(folder,'cards-assets',item.file):source;
 const color='scale=iw:ih:in_color_matrix=bt601:out_color_matrix=bt709,setsar=1,fps=24';
 const vf=item.caption?`${color},${await captionFilter(item.caption,item.id)}`:color;
 const audioFade=`afade=t=in:st=0:d=${item.type==='card'&&item.id==='00-intro'?.18:.035},afade=t=out:st=${Math.max(0,item.seconds-(item.id==='11-outro'?.8:.035))}:d=${item.id==='11-outro'?.8:.035}`;
 const args=['-y','-loglevel','warning','-ss',String(item.start),'-i',input];
 if(item.type==='card')args.push('-stream_loop','-1','-i',music);
 args.push('-map','0:v:0','-map',item.type==='card'?'1:a:0':'0:a:0','-vf',vf,'-af',`${item.type==='card'?`volume=${cardGainDb}dB,`:''}aresample=48000,${audioFade}`,'-t',String(item.seconds),'-c:v','libx264','-preset','fast','-crf','19','-maxrate','7M','-bufsize','14M','-threads','4','-level:v','5.1','-pix_fmt','yuv420p','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-r',String(FPS),'-c:a','pcm_s16le','-ac','2','-ar','48000',file);
 console.log(`Rendering ${item.id}: ${item.seconds.toFixed(3)} seconds, source ${item.start.toFixed(3)}.`);
 if(!selected.size||selected.has(item.id))await run(args);else await stat(file);
 const gaps=sourceManifest.frames.slice(1).map((f,i)=>({start:sourceManifest.frames[i].timestampEpochSeconds-sourceManifest.firstFrameEpochSeconds,end:f.timestampEpochSeconds-sourceManifest.firstFrameEpochSeconds})).filter(g=>g.end>item.start&&g.start<item.start+item.seconds);
 if(item.type==='gameplay')item.maximumSourceIntervalSeconds=Math.max(0,...gaps.map(g=>g.end-g.start));
}
const list=resolve(parts,'edit.ffconcat');await writeFile(list,'ffconcat version 1.0\n'+edit.map(s=>`file '${resolve(ROOT,s.part)}'`).join('\n')+'\n');
const assemblyLevel=await measure(['-f','concat','-safe','0','-i',list]);
const gainDb=Math.min(-20-Number(assemblyLevel.input_i),-1.5-Number(assemblyLevel.input_tp));
const output=resolve(folder,'Cloudbreak-4k-Demo.mp4');
await run(['-y','-loglevel','warning','-f','concat','-safe','0','-i',list,'-map','0:v:0','-map','0:a:0','-c:v','copy','-af',`volume=${gainDb}dB`,'-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-movflags','+faststart',output]);
const bytes=await readFile(output);assert.ok(bytes.length<=95_000_000,'Final film must remain below 95 MB');
const doc={title:'Cloudbreak — 4K game demonstration',width:WIDTH,height:HEIGHT,fps:FPS,seconds:timeline,frames:edit.reduce((n,s)=>n+s.frames,0),bytes:bytes.length,sha256:sha(bytes),codec:'H.264 High / AAC stereo',container:'MP4 with faststart',audio:{gameplay:'Original recorded post-master mix and enemy effects, retained at normal speed.',cards:'Selected original Firewall Drive loop, level matched to the captured soundtrack.',cardGainDb,finalStaticGainDb:gainDb,targetIntegratedLufs:-20,shortEditorialAudioFades:true,narration:false},source:{video:local(source),videoSha256:sha(await readFile(source)),width:3840,height:2160,originalCadence:p.recording.cadence,realWallClockMissionSeconds:p.missionWallSeconds,missionResult:{phase:p.final.phase,integrity:p.final.integrity,service:p.final.service,totalRequests:p.final.totalRequests,hostileBlocked:p.final.hostileBlocked},clockMapping:'Nearest observed stage epoch plus the mission-time difference, relative to the first source compositor frame.',uiAdjustment:p.typographyNote,speed:1,interpolation:false,cadenceConversion:'24 FPS presentation holds or drops original frames at their real timestamps. No motion interpolation or gameplay acceleration.'},edit,captionText:captions,omissions:'Unselected mission intervals and screenshot-induced long compositor holds were omitted through visible editorial cuts. The film is an edited demonstration, not an uninterrupted mission recording.',review:'Final decoded verification is recorded separately. This manifest alone does not claim completion.'};
await writeFile(resolve(folder,'film-edit.json'),JSON.stringify(doc,null,2)+'\n');
console.log(JSON.stringify({output:local(output),seconds:timeline,bytes:bytes.length,sha256:doc.sha256,finalStaticGainDb:gainDb}));
