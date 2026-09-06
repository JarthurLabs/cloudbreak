// Native 4K, real-time gameplay capture. Editorial UI scaling changes typography only.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createCloudbreakServer } from '../server/app.mjs';
import { signalsForState } from '../src/defenses.ts';
import { WAVES } from '../server/waves.mjs';
import { startRecording, muxRecording } from './recording.mjs';
const folder='captures/release';
await mkdir(`${folder}/raw`,{recursive:true});
const hash=data=>createHash('sha256').update(data).digest('hex');
const sourceFiles=['src/App.tsx','src/CityScene.tsx','src/style.css','src/audio.ts','src/defenses.ts','src/types.ts','server/app.mjs','server/index.mjs','server/gateway.mjs','server/waves.mjs','public/art/industrial-dusk-city.png','public/audio/firewall-drive-loop.wav'];
const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,hash(await readFile(path))])));
const typography='.topbar,.live-signal,.mission-clock,.traffic-key,.direct-controls,.bottomline,.title-content,.title-location,.modal-backdrop>*{zoom:2} .uplink-label{font-size:20px;padding:10px 16px}';
const captureApp=createCloudbreakServer({port:5318,autoTick:true,logDir:resolve('logs/release-capture')});
const names={storefront:'Storefront',accounts:'Accounts',dispatch:'Dispatch'};
const defense={'bad-login':'Key check',swarm:'Slow flow',breach:'Close bridge'};
let browser,recording;
try {
 await captureApp.listen();
 browser=await chromium.launch({channel:'chrome',headless:true,args:['--mute-audio']});
 const context=await browser.newContext({viewport:{width:3840,height:2160},deviceScaleFactor:1});
 const page=await context.newPage(),errors=[],stages=[],actions=[],shots=[];
 page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/api/**',async route=>{const response=await route.fetch({url:route.request().url().replace('127.0.0.1:5310','127.0.0.1:5318')});await route.fulfill({response});});
 await page.goto('http://127.0.0.1:5310/?release=firewall-drive');
 await page.addStyleTag({content:typography});
 await page.waitForTimeout(1800);
 const dimensions=await page.evaluate(()=>({viewport:[innerWidth,innerHeight],devicePixelRatio,canvas:[...document.querySelectorAll('canvas')].map(c=>[c.width,c.height])}));
 assert.deepEqual(dimensions.viewport,[3840,2160]);assert.ok(dimensions.canvas.some(c=>c[0]===3840&&c[1]===2160));
 await page.screenshot({path:`${folder}/title-4k.png`});
 await page.getByRole('button',{name:'Enter the city',exact:true}).click();
 await page.getByRole('button',{name:'Begin First Light',exact:true}).waitFor();
 await page.waitForFunction(()=>window.__cloudbreakAudioStats?.music&&window.__cloudbreakAudioStats.musicPlaybackSeconds>.1);
 const sessionId=await page.evaluate(()=>sessionStorage.getItem('cloudbreak.session'));
 const observe=()=>page.evaluate(async id=>({state:await(await fetch(`/api/state?sessionId=${id}`)).json(),epochSeconds:(performance.timeOrigin+performance.now())/1000,performance:window.__cloudbreakPerf,audio:window.__cloudbreakAudioStats}),sessionId);
 const mark=async name=>{const o=await observe();stages.push({name,...o,state:{...o.state,events:undefined}});console.log(`${name}: ${o.state.elapsed.toFixed(1)}s, integrity ${o.state.integrity.toFixed(1)}, service ${o.state.service.toFixed(1)}%`);return o;};
 const photo=async(name,file)=>{const o=await mark(name);await page.screenshot({path:`${folder}/${file}`});shots.push({name,file,epochSeconds:o.epochSeconds,missionTime:o.state.elapsed});};
 recording=await startRecording(page,`${folder}/raw/full-flight-${Date.now()}`,{width:3840,height:2160,maxBytes:5_000_000_000});
 await photo('briefing','briefing-4k.png');await page.waitForTimeout(3500);
 await page.getByRole('button',{name:'Begin First Light',exact:true}).click();
 const missionWall=Date.now();await mark('mission-start');
 const photoTimes=[{at:9,name:'customers',file:'01-city-online-4k.png'},{at:23,name:'authentication',file:'authentication-4k.png'},{at:42,name:'rate-limit',file:'rate-limit-4k.png'},{at:59,name:'isolation',file:'isolation-4k.png'},{at:68,name:'reopening',file:'reopening-4k.png'},{at:84,name:'two-fronts',file:'02-two-fronts-4k.png'},{at:159,name:'three-fronts',file:'03-three-fronts-4k.png'}];
 let announced=-1,applied=-1,nextPhoto=0,lastElapsed=-1;
 const deadline=Date.now()+215000;
 while(Date.now()<deadline){
  const o=await observe(),s=o.state;
  assert.notEqual(s.phase,'lost');assert.notEqual(s.phase,'paused');
  if(s.elapsed>=180)break;
  assert.ok(s.elapsed>=lastElapsed);lastElapsed=s.elapsed;
  if(s.wave.index!==announced){announced=s.wave.index;await mark(`wave-${announced}-arrives`);}
  if(s.wave.index!==applied&&s.elapsed>=WAVES[s.wave.index].start+3){
   for(const route of s.routes){
    const signal=signalsForState(s).find(t=>t.route===route.id),label=signal.kind!=='calm'?defense[signal.kind]:'Open';
    const button=page.getByRole('button',{name:`${names[route.id]}: ${label}`,exact:true});
    if(await button.getAttribute('aria-pressed')==='true')continue;
    const before=await observe();await button.click();
    await page.waitForFunction(({route,label})=>document.querySelector(`button[aria-label="${route}: ${label}"]`)?.getAttribute('aria-pressed')==='true',{route:names[route.id],label});
    actions.push({label:`${names[route.id]}: ${label}`,epochSeconds:before.epochSeconds,missionTime:before.state.elapsed});
   }
   applied=s.wave.index;await mark(`wave-${applied}-defended`);
  }
  if(nextPhoto<photoTimes.length&&s.elapsed>=photoTimes[nextPhoto].at){const p=photoTimes[nextPhoto++];await photo(p.name,p.file);}
  await page.waitForTimeout(160);
 }
 let final=(await observe()).state;
 for(let i=0;i<20&&final.phase==='running';i++){await page.waitForTimeout(100);final=(await observe()).state;}
 assert.equal(final.phase,'won');assert.equal(final.elapsed,180);assert.ok(final.integrity>=40);assert.ok(final.service>=80);
 const missionWallSeconds=(Date.now()-missionWall)/1000;assert.ok(missionWallSeconds>=180);
 await page.waitForTimeout(800);await photo('victory','04-victory-4k.png');await page.waitForTimeout(5000);
 await page.getByRole('button',{name:'Inspect the flight',exact:true}).click();await page.waitForTimeout(700);
 await photo('request-evidence','05-request-evidence-4k.png');await page.waitForTimeout(4500);
 const log=await page.evaluate(async id=>(await fetch(`/api/log?sessionId=${id}`)).text(),sessionId);
 const records=log.trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(records.length,final.totalRequests);assert.equal(new Set(records.map(r=>r.id)).size,records.length);
 assert.equal(records.filter(r=>r.role==='legitimate'&&r.status===200).length,final.legitimateServed);
 assert.equal(records.filter(r=>r.role==='hostile'&&r.status===200).length,final.hostileAdmitted);
 const audio=await page.evaluate(()=>window.__cloudbreakAudioStats);
 assert.equal(audio.musicTempoBpm,124);assert.equal(audio.musicLoadError,null);
 for(const type of ['bad-login','swarm','breach'])assert.ok(audio.threatCues.byType[type].blockedEmitted>0);
 const report=await recording.stop();recording=undefined;
 for(const entry of [...stages,...actions,...shots])entry.videoSeconds=entry.epochSeconds-report.firstFrameEpochSeconds;
 const {frames,...recordingSummary}=report;
 assert.deepEqual(errors,[]);
 for(const [path,expected]of Object.entries(sourceHashes))assert.equal(hash(await readFile(path)),expected,`Source changed during capture: ${path}`);
 await writeFile(`${folder}/request-log.ndjson`,log);
 const receipt={sourceHashes,dimensions,typographyAdjustment:typography,typographyNote:'UI-only scale increase for legibility at native 4K. No game state, outcomes, audio events or visual traffic injected.',browser:await browser.version(),gatewayPort:5318,isolatedGateway:true,normalWallClock:true,missionWallSeconds,final:{...final,events:undefined},stages,actions,shots,audio,errors,logCountsReconciled:true,recording:recordingSummary};
 await writeFile(`${folder}/playthrough.json`,JSON.stringify(receipt,null,2)+'\n');
 console.log('Native 4K mission complete; encoding the real source recording.');
 const mux=await muxRecording(report,`${folder}/raw/Cloudbreak-Full-Flight-4k.mp4`);
 await writeFile(`${folder}/raw/mux-report.json`,JSON.stringify(mux,null,2)+'\n');
 console.log(JSON.stringify({passed:true,missionWallSeconds,integrity:final.integrity,service:final.service,source:`${folder}/raw/Cloudbreak-Full-Flight-4k.mp4`}));
} finally {try{if(recording)await recording.stop().catch(()=>{});await browser?.close();}finally{await captureApp.close();}}
