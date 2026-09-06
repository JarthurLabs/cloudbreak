import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { writeFile,readFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { signalsForState } from '../src/defenses.ts';
import { WAVES } from '../server/waves.mjs';
// Observe the public build without its deliberately loopback-only game hooks.
// Preserve native speaker output and attach only a parallel recording sink.
function installOutputProbe() {
 const connect=AudioNode.prototype.connect,NativeAudioContext=AudioContext,taps=[],seen=new WeakSet(),errors=[];
 AudioNode.prototype.connect=function(destination,...args){
  const result=Reflect.apply(connect,this,[destination,...args]);
  if(destination instanceof AudioDestinationNode&&!seen.has(this)){
   seen.add(this);
   try{const sink=this.context.createMediaStreamDestination();Reflect.apply(connect,this,[sink,args[0]??0]);taps.push({context:this.context,sink,kind:this.constructor.name});}
   catch(error){errors.push(String(error));}
  }
  return result;
 };
 window.__cloudbreakPublicAudioProbe={
  status:()=>({destinations:taps.length,kinds:taps.map(t=>t.kind),errors:[...errors]}),
  async capture(ms){
   if(taps.length!==1||taps[0].context.state!=='running')throw new Error('Expected one running native audio output.');
   const mimeType='audio/webm;codecs=opus',chunks=[];
   if(!MediaRecorder.isTypeSupported(mimeType))throw new Error('Output recorder is unavailable.');
   const recorder=new MediaRecorder(taps[0].sink.stream,{mimeType,audioBitsPerSecond:128000});
   let rejectStart;const begun=new Promise((resolve,reject)=>{recorder.onstart=resolve;rejectStart=reject;});
   const done=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.onstop=resolve;recorder.onerror=e=>{const error=new Error(e.error?.message??'Capture failed');rejectStart(error);reject(error);};});
   // Chrome starts MediaRecorder asynchronously; time only after its native
   // start event so encoder startup is not deducted from the requested sample.
   const requestedAt=performance.now();recorder.start();await begun;const startedAt=performance.now();
   await new Promise(resolve=>setTimeout(resolve,ms));recorder.stop();await done;const stoppedAt=performance.now();
   const bytes=new Uint8Array(await new Blob(chunks,{type:mimeType}).arrayBuffer()),decoder=new NativeAudioContext();let decoded;
   try{decoded=await decoder.decodeAudioData(bytes.slice().buffer)}finally{await decoder.close()}
   let sum=0,peak=0,clippedSamples=0;
   for(let c=0;c<decoded.numberOfChannels;c++)for(const value of decoded.getChannelData(c)){sum+=value*value;peak=Math.max(peak,Math.abs(value));if(Math.abs(value)>=.999)clippedSamples++;}
   let binary='';for(let at=0;at<bytes.length;at+=32768)binary+=String.fromCharCode(...bytes.subarray(at,at+32768));
   return{base64:btoa(binary),mimeType,bytes:bytes.length,seconds:decoded.duration,startDelaySeconds:(startedAt-requestedAt)/1000,recordingWallSeconds:(stoppedAt-startedAt)/1000,channels:decoded.numberOfChannels,sampleRate:decoded.sampleRate,rms:Math.sqrt(sum/(decoded.length*decoded.numberOfChannels)),peak,clippedSamples};
  }
 };
}
const url='https://cloudbreak.onrender.com',folder='captures/release/public-check';
await mkdir(folder,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
const context=await browser.newContext({viewport:{width:1920,height:1080}});
await context.addInitScript(installOutputProbe);
const page=await context.newPage();
const privateValues=new Set(),sanitize=value=>{let result=String(value);for(const secret of privateValues)if(secret)result=result.replaceAll(secret,'[redacted]');return result.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,'[redacted-id]');};
const errors=[],actions=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
page.setDefaultTimeout(30000);
try{
 const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:90000});assert.equal(response.status(),200);
 const health=await(await context.request.get(url+'/api/health')).json();assert.equal(health.game,'cloudbreak');assert.equal(health.localOnly,false);assert.equal(health.status,'ok');assert.equal(health.frontend,'ready');assert.equal(health.maxSessions,8);
 const assetHashes={};
 for(const path of ['public/art/industrial-dusk-city.png','public/audio/firewall-drive-loop.wav']){
  const response=await context.request.get(url+'/'+path.replace('public/',''));assert.equal(response.status(),200);
  const hash=createHash('sha256').update(await readFile(path)).digest('hex');assert.equal(createHash('sha256').update(await response.body()).digest('hex'),hash);assetHashes[path.replace('public/','')]=hash;
 }
 await page.getByRole('button',{name:'Enter the city',exact:true}).waitFor({state:'visible'});
 await page.screenshot({path:folder+'/title.png'});
 assert.equal(await page.evaluate(()=>window.__cloudbreakAudioStats),undefined);
 assert.equal(await page.evaluate(()=>window.__cloudbreakAudioCapture),undefined);
 assert.equal((await page.evaluate(()=>window.__cloudbreakPublicAudioProbe.status())).destinations,0,'No audio before a gesture.');
 const musicResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/audio/firewall-drive-loop.wav'&&r.status()===200);
 await page.getByRole('button',{name:'Enter the city',exact:true}).click();
 assert.equal(createHash('sha256').update(await(await musicResponse).body()).digest('hex'),assetHashes['audio/firewall-drive-loop.wav']);
 await page.waitForFunction(()=>window.__cloudbreakPublicAudioProbe.status().destinations===1);await page.waitForTimeout(600);
 const sample=async(name,ms)=>{
  const{base64,...metrics}=await page.evaluate(ms=>window.__cloudbreakPublicAudioProbe.capture(ms),ms);
  const bytes=Buffer.from(base64,'base64'),file='audio-'+name+'.webm';await writeFile(folder+'/'+file,bytes);
  assert.equal(metrics.clippedSamples,0,'Measured audio must not clip.');assert.ok(metrics.seconds>=ms/1000-.1,'Capture must contain the requested real duration.');
  return{...metrics,file,sha256:createHash('sha256').update(bytes).digest('hex')};
 };
 // Measure while ready in the briefing; these real mute actions cannot delay
 // the mission's original three-second defense-reaction strategy.
 const audio={method:'Harness-only parallel MediaRecorder tap at native speaker output, after game master gain and limiter.',stage:'Ready briefing after Enter the city, before Begin First Light.',browserWavHashMatches:true,privateGameHooksAbsent:true,limitation:'Decoded output and mute measurements; not subjective listening approval.',playing:await sample('playing',3000)};
 assert.ok(audio.playing.rms>.002&&audio.playing.peak<.25,'The actual Firewall Drive output must be audible and bounded.');
 await page.getByRole('button',{name:'Mute sound',exact:true}).click();await page.getByRole('button',{name:'Unmute sound',exact:true}).waitFor({state:'visible'});await page.waitForTimeout(300);
 audio.muted=await sample('muted',1000);assert.ok(audio.muted.rms<.00005,'The real mute button must silence output.');
 await page.getByRole('button',{name:'Unmute sound',exact:true}).click();await page.getByRole('button',{name:'Mute sound',exact:true}).waitFor({state:'visible'});await page.waitForTimeout(400);
 audio.resumed=await sample('resumed',2000);assert.ok(audio.resumed.rms>.002&&audio.resumed.peak<.25,'Unmute must restore audible bounded music.');
 audio.probe=await page.evaluate(()=>window.__cloudbreakPublicAudioProbe.status());assert.deepEqual(audio.probe,{destinations:1,kinds:['DynamicsCompressorNode'],errors:[]});
 console.log(`Public audio: playing RMS ${audio.playing.rms.toFixed(6)}, muted ${audio.muted.rms.toFixed(6)}, resumed ${audio.resumed.rms.toFixed(6)}.`);
 await page.getByRole('button',{name:'Begin First Light',exact:true}).click();
 const id=await page.evaluate(()=>sessionStorage.getItem('cloudbreak.session'));assert.ok(id);privateValues.add(id);
 const state=()=>page.evaluate(async id=>(await fetch('/api/state?sessionId='+id)).json(),id);
 const cookies=await context.cookies();const owner=cookies.find(c=>c.name==='__Host-cloudbreak-owner');assert.ok(owner?.httpOnly&&owner?.secure&&owner?.sameSite==='Strict');privateValues.add(owner.value);
 const other=await browser.newContext({viewport:{width:1280,height:720}}),otherPage=await other.newPage();
 await otherPage.goto(url,{waitUntil:'domcontentloaded',timeout:90000});await otherPage.getByRole('button',{name:'Enter the city',exact:true}).click();await otherPage.getByRole('button',{name:'Begin First Light',exact:true}).click();
 const otherId=await otherPage.evaluate(()=>sessionStorage.getItem('cloudbreak.session'));assert.ok(otherId);assert.notEqual(id,otherId);privateValues.add(otherId);for(const cookie of await other.cookies())privateValues.add(cookie.value);
 assert.equal((await other.request.get(url+'/api/state?sessionId='+id)).status(),404);
 const before=(await state()).elapsed;await otherPage.getByRole('button',{name:'Pause game',exact:true}).click();await page.waitForTimeout(2200);assert.ok((await state()).elapsed>before+1.5);await other.close();
 const started=Date.now();let applied=-1,last=-1;
 const names={storefront:'Storefront',accounts:'Accounts',dispatch:'Dispatch'},defense={'bad-login':'Key check',swarm:'Slow flow',breach:'Close bridge'};
 while(Date.now()-started<220000){const s=await state();assert.notEqual(s.phase,'lost');assert.notEqual(s.phase,'paused');if(s.phase==='won')break;
  assert.ok(s.elapsed>=last);last=s.elapsed;
  if(s.wave.index!==applied&&s.elapsed>=WAVES[s.wave.index].start+3){for(const route of s.routes){const signal=signalsForState(s).find(x=>x.route===route.id),label=signal.kind==='calm'?'Open':defense[signal.kind];const button=page.getByRole('button',{name:names[route.id]+': '+label,exact:true});if(await button.getAttribute('aria-pressed')!=='true'){await button.click();actions.push({elapsed:s.elapsed,route:route.id,label});}}
   applied=s.wave.index;console.log(`Public wave ${applied}: ${s.elapsed.toFixed(1)}s, integrity ${s.integrity}, service ${s.service.toFixed(1)}`);
  }
  await page.waitForTimeout(250);
 }
 const final=await state();assert.equal(final.phase,'won');assert.equal(final.elapsed,180);assert.ok(final.service>=75);await page.screenshot({path:folder+'/victory.png'});
 assert.equal(await page.evaluate(()=>window.__cloudbreakAudioStats),undefined);assert.equal(await page.evaluate(()=>window.__cloudbreakAudioCapture),undefined);
 const log=await(await context.request.get(url+'/api/log?sessionId='+id)).text();const records=log.trim().split('\n').map(x=>JSON.parse(x));assert.equal(records.length,final.totalRequests);
 assert.equal(records.filter(r=>r.role==='legitimate').length,final.legitimateTotal);
 assert.equal(records.filter(r=>r.role==='legitimate'&&r.status===200).length,final.legitimateServed);
 assert.equal(records.filter(r=>r.role==='hostile'&&r.status!==200).length,final.hostileBlocked);
 assert.equal(records.filter(r=>r.role==='hostile'&&r.status===200).length,final.hostileAdmitted);
 assert.deepEqual(errors,[]);
 // Select only aggregate fields; the public report must contain no session IDs,
 // cookie values, request IDs, log filenames or raw private request records.
 const report={passed:true,url,checkedAt:new Date().toISOString(),health:{game:health.game,status:health.status,localOnly:health.localOnly,frontend:health.frontend,maxSessions:health.maxSessions},completeRealTimePublicMission:true,missionClock:'Unmodified server clock; ordinary pointer controls and actual API responses.',ownerCookie:{name:owner.name,httpOnly:owner.httpOnly,secure:owner.secure,sameSite:owner.sameSite},independentBrowserSessions:true,crossCookieReadRejected:true,assetHashesMatch:true,assetHashes,final:{phase:final.phase,elapsed:final.elapsed,integrity:final.integrity,service:final.service,legitimateTotal:final.legitimateTotal,legitimateServed:final.legitimateServed,hostileBlocked:final.hostileBlocked,hostileAdmitted:final.hostileAdmitted,totalRequests:final.totalRequests,score:final.score,economyBonus:final.economyBonus},actions,audio,errors,logCountsReconciled:true,privateIdentifiersOmitted:true};
 const serialized=JSON.stringify(report,null,2)+'\n';assert.equal(sanitize(serialized),serialized,'Public evidence must omit private identifiers.');
 await writeFile(folder+'/report.json',serialized);console.log(JSON.stringify({passed:true,phase:final.phase,integrity:final.integrity,service:final.service,requests:final.totalRequests,audioOutputVerified:true}));
}catch(error){const message=sanitize(error?.stack??error);await writeFile(folder+'/failure.json',JSON.stringify({passed:false,checkedAt:new Date().toISOString(),error:message,errors:errors.map(sanitize)},null,2)+'\n');throw new Error(message)}finally{await browser.close()}
