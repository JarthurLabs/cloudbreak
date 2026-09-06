import { useCallback, useEffect, useRef, useState } from 'react';
import CityScene from './CityScene';
import { DEFENSES, policyForMode, modeForPolicy, canSetMode, signalsForState } from './defenses';
import type { DefenseMode } from './defenses';
import type { GameState, RouteId } from './types';
import { ROUTES, ROUTE_NAMES } from './types';
import { setMuted as audioMute, setVolume as audioVolume, sound, unlockAudio, setMusicEnabled as audioMusic, setMusicVolume as audioMusicVolume, setSceneAudio, soundThreatBlocked, soundThreatWarning, resetThreatAudio } from './audio';

function Icon({name, size=20}: {name:string; size?:number}) {
  const paths: Record<string,React.ReactNode> = {
    shield:<><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
    lock:<><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></>,
    rate:<><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
    isolate:<><path d="M5 4v16m14-16v16M2 8h6m8 0h6M2 16h6m8 0h6m2-11-6 14"/></>,
    play:<path d="m8 4 12 8-12 8Z"/>, pause:<><path d="M8 5v14m8-14v14"/></>,
    sound:<><path d="M11 4 5 9H2v6h3l6 5Zm5 4a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
    mute:<><path d="M11 4 5 9H2v6h3l6 5Zm5 5 6 6m0-6-6 6"/></>,
    arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>, close:<path d="m6 6 12 12M6 18 18 6"/>,
    flow:<><path d="M3 7h14l-4-4m4 4-4 4M21 17H7l4 4m-4-4 4-4"/></>,
    retry:<><path d="M4 10a8 8 0 1 1 2 8M4 4v6h6"/></>,
    evidence:<><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h4"/></>,
    sun:<><circle cx="12" cy="12" r="4"/><path d="M12 1v2m0 18v2M1 12h2m18 0h2M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.shield}</svg>;
}
const fmtTime = (n:number) => `${Math.floor(Math.max(0,n)/60).toString().padStart(2,'0')}:${Math.floor(Math.max(0,n)%60).toString().padStart(2,'0')}`;
function ThreatGlyph({kind}: {kind:'bad-login'|'swarm'|'breach'}) {
  return <svg className={`threat-glyph ${kind}`} viewBox="0 0 64 52" aria-hidden="true">
    {kind==='bad-login'?<><path d="m30 3 13 16-8 9 10 11-7 7-10-11-7 4-10-17Z" fill="currentColor"/><path d="m28 12 6 7-6 7-6-7Z" fill="#fff5e9"/></>:kind==='swarm'?<><path d="m32 2 8 14-8 9-8-9ZM8 31l16-4 5 10-12 10Zm48 0-9 16-12-10 5-10Z" fill="currentColor"/><path d="m32 18 0 14m-13 5 13-5 13 5" stroke="currentColor" strokeWidth="5"/><circle cx="32" cy="32" r="6" fill="#fff7de" stroke="currentColor" strokeWidth="4"/></>:<><path d="M11 6h42l9 20-9 20H11L2 26Z" fill="currentColor"/><path d="m23 13 18 0 8 13-8 13H23l-8-13Z" fill="#4f456f"/><path d="m28 18 8 0 5 8-5 8h-8l-5-8Z" fill="#eee0ff"/><path d="M8 14v24m48-24v24" stroke="#e7d8f8" strokeWidth="4"/></>}
  </svg>;
}
function QuickGuide() {
  return <div className="quick-guide">
    <p className="quick-objective">Your buildings are <b>cloud services.</b> Customers and attacks arrive through the same <b>Internet uplinks.</b> Keep the city online for <b>three minutes</b> and serve at least <b>75% of cyan customers.</b></p>
    <div className="threat-lessons">
      <div><ThreatGlyph kind="bad-login"/><div><strong>Coral probes <span>→ Key check</span></strong><p>Authentication refuses their bad login keys.</p></div></div>
      <div><ThreatGlyph kind="swarm"/><div><strong>Amber swarms <span>→ Slow flow</span></strong><p>Rate limiting caps traffic at one request per second.</p></div></div>
      <div><ThreatGlyph kind="breach"/><div><strong>Violet carriers <span>→ Close bridge</span></strong><p>Their keys work. Isolation stops everyone, including customers.</p></div></div>
    </div>
    <p className="quick-rule"><b>Click the matching mode under each attacked district.</b> Attacks can overlap. Choose <b>Open</b> when its alert clears so customers can return. Cloud security means balancing protection with availability.</p>
  </div>;
}

export default function App() {
  const [state, setState] = useState<GameState|null>(null);
  const [screen, setScreen] = useState<'title'|'briefing'|'playing'>('title');
  const [selected, setSelected] = useState<RouteId>('storefront');
  const [error, setError] = useState('');
  const [connectionIssue, setConnectionIssue] = useState<'expired'|'busy'|'offline'|null>(null);
  const reconnect = useRef<() => void>(() => {});
  const [busy, setBusy] = useState(false);
  const [muted,setMuted] = useState(localStorage.getItem('cloudbreak.muted') === 'true');
  const [volume,setVolume] = useState(Number(localStorage.getItem('cloudbreak.volume') ?? '.3'));
  const [reduced,setReduced] = useState(localStorage.getItem('cloudbreak.reducedMotion') === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [inspect,setInspect] = useState(false);
  const [helpOpen,setHelpOpen] = useState(false);
  const [music,setMusic] = useState(localStorage.getItem('cloudbreak.musicEnabled') !== 'false');
  const [musicVolume,setMusicVolume] = useState(Number(localStorage.getItem('cloudbreak.musicVolume') ?? '.35'));
  const [best,setBest] = useState(Number(localStorage.getItem('cloudbreak.firstLight.best') || 0));
  const mutationEpoch=useRef(0);
  const session = useRef(''), stateRef = useRef(state), actionLock=useRef(false), lastPhase=useRef(''), audioMission=useRef('');
  const audioRecords=useRef(new Set<string>()), audioThreats=useRef(new Set<string>());
  stateRef.current=state;
  const request = useCallback(async(path:string, body?:object):Promise<GameState> => {
    const response = await fetch(path, body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : undefined);
    const data = await response.json();
    if(!response.ok) throw Object.assign(new Error(response.status===429?'The server is busy. Please try again shortly.':data.error || 'The gateway could not complete that action.'),{status:response.status});
    return data;
  },[]);
  const expireSession=useCallback(()=>{
    mutationEpoch.current++; session.current=''; sessionStorage.removeItem('cloudbreak.session');
    stateRef.current=null; setState(null); setScreen('title'); setInspect(false); setHelpOpen(false);
    setConnectionIssue('expired'); setError(''); setSceneAudio(false);
  },[]);
  useEffect(()=>{
    let alive=true,connecting=false;
    async function connect(explicit=false) {
      if(connecting)return;
      connecting=true;setBusy(true);
      try {
        const existing=sessionStorage.getItem('cloudbreak.session');
        const initial=existing?await request(`/api/state?sessionId=${encodeURIComponent(existing)}`):await request('/api/session',{});
        if(!alive)return;
        session.current=initial.sessionId; sessionStorage.setItem('cloudbreak.session',initial.sessionId);
        const next=initial.phase==='running'?await request('/api/pause',{sessionId:initial.sessionId,paused:true}):initial;
        if(!alive)return;
        setState(next); setConnectionIssue(null); setError('');
        if(next.pauseReason?.startsWith('Practice controls.')||(explicit&&next.phase==='ready'))setScreen('briefing');
        else if(next.phase!=='ready')setScreen('playing');
      }catch(e){
        if(!alive)return;
        session.current='';
        const status=(e as Error&{status?:number}).status;
        if(status===404)expireSession();
        else{setConnectionIssue(status===429?'busy':'offline');setError('');}
      }finally{connecting=false;if(alive)setBusy(false);}
    }
    reconnect.current=()=>void connect(true);
    void connect();
    let pending=false;
    const poll=setInterval(async()=>{
      if(!session.current||pending||actionLock.current)return;
      pending=true;const epoch=mutationEpoch.current;
      try{const next=await request(`/api/state?sessionId=${encodeURIComponent(session.current)}`);if(alive&&epoch===mutationEpoch.current&&!actionLock.current){setState(next);setError(old=>old.startsWith('Connection paused.')?'':old);}}
      catch(e){if(alive&&epoch===mutationEpoch.current){if((e as Error&{status?:number}).status===404)expireSession();else setError('Connection paused. Reconnecting to the gateway…');}}
      finally{pending=false;}
    },250);
    const heartbeat=setInterval(()=>{
      if(!session.current||document.hidden)return;
      const epoch=mutationEpoch.current;
      void request('/api/heartbeat',{sessionId:session.current}).catch(e=>{if(alive&&epoch===mutationEpoch.current&&(e as Error&{status?:number}).status===404)expireSession();});
    },800);
    const hide=()=>{if(document.hidden&&stateRef.current?.phase==='running'){const epoch=++mutationEpoch.current;void request('/api/pause',{sessionId:session.current,paused:true}).then(next=>{if(alive&&epoch===mutationEpoch.current)setState(next);}).catch(e=>{if(alive&&epoch===mutationEpoch.current&&(e as Error&{status?:number}).status===404)expireSession();});}};
    const leave=()=>{if(session.current)navigator.sendBeacon('/api/pause',new Blob([JSON.stringify({sessionId:session.current,paused:true})],{type:'application/json'}));};
    document.addEventListener('visibilitychange',hide);window.addEventListener('pagehide',leave);
    return()=>{alive=false;reconnect.current=()=>{};clearInterval(poll);clearInterval(heartbeat);document.removeEventListener('visibilitychange',hide);window.removeEventListener('pagehide',leave);};
  },[request,expireSession]);
  const act=useCallback(async(path:string,body:object)=>{
    if(actionLock.current||!session.current)return null;
    actionLock.current=true;const epoch=++mutationEpoch.current;setBusy(true);setError('');unlockAudio();
    try { const next=await request(path,{sessionId:session.current,...body}); if(epoch!==mutationEpoch.current)return null;setState(next); sound('click'); return next; }
    catch(e){if(epoch===mutationEpoch.current){if((e as Error&{status?:number}).status===404)expireSession();else setError((e as Error).message);}return null;}
    finally{actionLock.current=false;setBusy(false);}
  },[request,expireSession]);
  const start=async()=>{
    const next=await act('/api/start',{});
    if(!next)return;
    resetThreatAudio();audioRecords.current.clear();audioThreats.current.clear();lastPhase.current='ready';
    sessionStorage.removeItem('cloudbreak.guide');
    setInspect(false);setHelpOpen(false);setSelected('storefront');setScreen('playing');
  };
  const changeMode=useCallback((routeId:RouteId,mode:DefenseMode)=>{
    if(stateRef.current?.phase!=='running')return;
    setSelected(routeId);
    void act('/api/policy',{route:routeId,policy:policyForMode(mode)});
  },[act]);
  const togglePause=useCallback(()=>{
    if(!stateRef.current||!['running','paused'].includes(stateRef.current.phase))return;
    setHelpOpen(false);
    void act('/api/pause',{paused:stateRef.current.phase==='running'});
  },[act]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.metaKey||event.ctrlKey||event.altKey||event.repeat)return;
      const k=event.key.toLowerCase();
      if(k==='tab'&&(connectionIssue||stateRef.current?.phase==='paused')){
        const modal=document.querySelector(connectionIssue?'.connection-panel':'.pause-panel');
        const focusable=modal?.querySelectorAll<HTMLElement>('button:not(:disabled),input,a[href]');
        if(focusable?.length){
          const first=focusable[0],last=focusable[focusable.length-1];
          if(event.shiftKey&&(document.activeElement===first||!modal?.contains(document.activeElement))){event.preventDefault();last.focus();}
          else if(!event.shiftKey&&(document.activeElement===last||!modal?.contains(document.activeElement))){event.preventDefault();first.focus();}
        }
      }
      if(connectionIssue||screen!=='playing')return;
      if(k==='escape'){event.preventDefault();if(inspect)setInspect(false);else togglePause();return;}
      if((event.target as HTMLElement).matches('input,select,textarea'))return;
      if(k===' '){if((event.target as HTMLElement).closest('button,a,input'))return;event.preventDefault();togglePause();return;}
      if(stateRef.current?.phase!=='running')return;
      if(['1','2','3'].includes(k)){setSelected(ROUTES[Number(k)-1]);sound('click');}
      const policy=stateRef.current.routes.find(r=>r.id===selected)?.policy;
      if(!policy)return;
      const mode=modeForPolicy(policy);
      if(k==='a')changeMode(selected,mode==='auth'?'open':'auth');
      if(k==='i')changeMode(selected,mode==='isolate'?'open':'isolate');
      if(k==='r')changeMode(selected,mode==='rate'?'open':'rate');
      if(k==='o')changeMode(selected,'open');
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[screen,inspect,selected,togglePause,changeMode,connectionIssue]);
  useEffect(()=>{
    const update=()=>setSceneAudio(!document.hidden&&!connectionIssue&&stateRef.current?.phase!=='paused');
    update();document.addEventListener('visibilitychange',update);
    return()=>{document.removeEventListener('visibilitychange',update);setSceneAudio(false);};
  },[state?.phase,connectionIssue]);
  useEffect(()=>{
    if(!state)return;
    const threats=state.wave.threats??[];
    if(state.logFile!==audioMission.current){
      resetThreatAudio();audioMission.current=state.logFile;
      audioRecords.current=new Set(state.events.map(event=>event.id));
      audioThreats.current=new Set(threats.map(threat=>`${threat.route}:${threat.threatType}`));lastPhase.current='';
    }
    if(state.phase==='running'){
      for(const event of state.events)if(!audioRecords.current.has(event.id)&&event.role==='hostile'&&event.status!==200&&event.threatType)soundThreatBlocked(event.threatType);
      for(const threat of threats)if(!audioThreats.current.has(`${threat.route}:${threat.threatType}`))soundThreatWarning(threat.threatType);
    }
    audioRecords.current=new Set(state.events.map(event=>event.id));
    audioThreats.current=new Set(threats.map(threat=>`${threat.route}:${threat.threatType}`));
    if(state.phase!==lastPhase.current){
      if(state.phase==='won'){sound('win');setBest(old=>{const next=Math.max(old,state.score);localStorage.setItem('cloudbreak.firstLight.best',String(next));return next;});}
      if(state.phase==='lost')sound('lose');
      lastPhase.current=state.phase;
    }
  },[state]);
  const finished=state?.phase==='won'||state?.phase==='lost';
  const playing=screen==='playing';
  const signals=state?signalsForState(state):[];
  const activeSignals=signals.filter(signal=>signal.kind!=='calm');
  const singleSignal=activeSignals.length===1?activeSignals[0]:null;
  const alertKind=activeSignals.length>1?'multiple':singleSignal?.kind??'calm';
  const defended=activeSignals.filter(signal=>modeForPolicy(state!.routes.find(route=>route.id===signal.route)!.policy)===signal.mode).length;
  const gatesOpen=state?.routes.every(route=>modeForPolicy(route.policy)==='open');
  const showHelp=async()=>{if(state?.phase==='running'){const next=await act('/api/pause',{paused:true});if(!next)return;}setHelpOpen(true);};
  const toggleMute=()=>{unlockAudio();setMuted(v=>{audioMute(!v);return !v;});};
  const motion=(value:boolean)=>{setReduced(value);localStorage.setItem('cloudbreak.reducedMotion',String(value));};
  return <main className={`app ${playing?'in-mission':'arrival'} flow-revision multi-revision ${reduced?'reduced-motion':''}`}>
    <CityScene state={state} selected={selected} onSelect={id=>{setSelected(id);sound('click');}} reducedMotion={reduced} titleMode={!playing}/>
    <div className="sky-grain"/>
    <header className="topbar">
      <div className="brand"><span className="brand-symbol"><Icon name="shield" size={34}/></span><span>CLOUDBREAK<small>CLOUD INFRASTRUCTURE DEFENSE</small></span></div>
      {playing&&state&&<div className="vitals" aria-label="City status">
        <div className={`vital ${state.integrity<35?'danger':''}`}><span><Icon name="shield" size={17}/>City integrity</span><strong>{Math.ceil(state.integrity)}<small>/ 100</small></strong><i style={{width:`${state.integrity}%`}}/></div>
        <div className={`vital ${state.service<75&&state.elapsed>20?'danger':''}`}><span><Icon name="flow" size={17}/>Customers served</span><strong>{Math.floor(state.service*10)/10}<small>% <em>target 75%</em></small></strong></div>
        <div className="budget"><span>DEFENSE CREDITS</span><strong>{state.credits}<small>/ 40 free</small></strong><div className="credit-dots">{Array.from({length:8},(_,i)=><i key={i} className={i<state.credits/5?'free':''}/>)}</div></div>
      </div>}
      <nav className="utility"><button className="icon-button" onClick={toggleMute} aria-label={muted?'Unmute sound':'Mute sound'} title={muted?'Unmute sound':'Mute sound'}><Icon name={muted?'mute':'sound'}/></button>{playing&&!finished&&<button className="help-button" onClick={()=>void showHelp()}>How to play</button>}{playing&&!finished&&<button className="icon-button" onClick={togglePause} aria-label={state?.phase==='paused'?'Resume game':'Pause game'} title="Pause · Space"><Icon name={state?.phase==='paused'?'play':'pause'}/></button>}</nav>
    </header>
    {!playing&&<section className="title-content">
      <div className="eyebrow"><span className="status-dot"/> A GATEWAY DEFENSE GAME</div>
      <h1>The city<br/>stays <em>online.</em></h1>
      <p className="title-copy">A city above the haze. A network under pressure.<br/>Keep customers connected. Stop the threats.<br/>Control the gates.</p>
      {screen==='title'?<><button className="primary start-button" onClick={()=>{unlockAudio();sound('click');setScreen('briefing');}} disabled={!state}>Enter the city <Icon name="arrow"/></button><div className="mission-tag"><span>01</span><div>FIRST LIGHT<small>A three-minute mission</small></div></div>{best>0&&<p className="best-title">Your best flight · {best.toLocaleString()} points</p>}</>:<div className="quick-brief"><div className="eyebrow">FIRST LIGHT · THE QUICK BRIEFING</div><h2>Protect the cloud. Keep it open.</h2><QuickGuide/><button className="primary" onClick={()=>void start()} disabled={busy||!state}>Begin First Light <Icon name="play" size={18}/></button><p className="briefing-free">One click to begin. Follow the live district alerts.</p><button className="text-button" onClick={()=>setScreen('title')}>Back</button></div>}
    </section>}
    {!playing&&<div className="title-location"><span>UPPER CITY / THE AERIE</span><p>Commerce. Identity. Transit.</p><div>ALT. 2,840 M <span>◇</span> INDUSTRIAL DUSK</div></div>}
    {playing&&state&&!finished&&<>
      {activeSignals.length>0&&<div key={`${state.logFile}-${state.wave.index}`} className={`world-warning ${alertKind} ${state.phase==='paused'?'warning-paused':''}`} aria-hidden="true"/>}
      <section key={`${state.logFile}-${state.wave.index}-signal`} className={`live-signal ${alertKind}`} aria-label="Live city warning" aria-live="polite">
        <div className={`signal-icon ${activeSignals.length>1?'signal-cluster':''}`}>{activeSignals.length===0?<Icon name="sun" size={30}/>:activeSignals.map(signal=><ThreatGlyph key={signal.route} kind={signal.kind as 'bad-login'|'swarm'|'breach'}/>)}</div>
        <div><span className="eyebrow">{singleSignal?`${ROUTE_NAMES[singleSignal.route]} · LIVE ALERT`:activeSignals.length>1?'SIMULTANEOUS ATTACKS':'FIRST LIGHT'}</span>
          <h2>{singleSignal?.title??(activeSignals.length>1?`${activeSignals.length===2?'Two':'Three'} districts under attack`:'Routes clear. Keep them open.')}</h2>
          <p>{singleSignal?.detail??(activeSignals.length>1?'Match each enemy to the mode under its district. Clear routes can stay open.':'Cyan capsules are customers. Open the gates and let them through.')}</p>
          <span className={`signal-response ${(activeSignals.length?defended===activeSignals.length:gatesOpen)?'ready':''}`}>{activeSignals.length>1?`${defended} of ${activeSignals.length} defenses active`:singleSignal?(defended?'Defense active':`Use ${DEFENSES.find(defense=>defense.id===singleSignal.mode)?.label} at ${ROUTE_NAMES[singleSignal.route]}`):gatesOpen?'All gates open · customers welcome':'Reopen the gates below'}</span>
        </div>
      </section>
      <div className="mission-clock"><span>SHIFT REMAINING</span><strong>{fmtTime(state.duration-state.elapsed)}</strong><div className="timeline">{Array.from({length:9},(_,i)=><i key={i} className={i<=Math.floor(state.elapsed/20)?'active':''}/>)}</div></div>
      <div className="traffic-key"><span><i className="customer-symbol"/>Customers</span><span><ThreatGlyph kind="bad-login"/>Key check</span><span><ThreatGlyph kind="swarm"/>Slow flow</span><span><ThreatGlyph kind="breach"/>Close bridge</span></div>
      <section className="direct-controls" aria-label="District defenses">
        <div className="direct-dock-heading"><span>CHOOSE A MODE UNDER ANY DISTRICT <small>Switching returns the old mode’s credits.</small></span><button onClick={()=>setInspect(value=>!value)} aria-label="Inspect request evidence"><Icon name="evidence" size={16}/>{state.totalRequests.toLocaleString()} requests measured</button></div>
        <div className="district-grid">{state.routes.map((route,index)=>{
          const activeMode=modeForPolicy(route.policy);
          const signal=signals.find(item=>item.route===route.id)!;
          const targeted=signal.kind!=='calm', defenseSet=activeMode===signal.mode;
          const status=activeMode==='open'?'Customers welcome':activeMode==='auth'?'Authentication · valid keys only':activeMode==='rate'?'Rate limit · 1 request per second':activeMode==='isolate'?'Isolation · no arrivals admitted':'Choose a mode to replace';
          return <div key={route.id} className={`district-card ${selected===route.id?'selected':''} ${targeted?`attention ${signal.kind}`:''}`} role="group" aria-label={`${ROUTE_NAMES[route.id]} defenses`}>
            <div className="district-card-heading"><div><span className="district-number">0{index+1}</span><h2>{ROUTE_NAMES[route.id]}</h2></div><span className={`district-state ${activeMode==='isolate'?'closed':''}`}>{status}</span></div>
            <div className={`district-cue ${signal.kind}`} aria-label={`${ROUTE_NAMES[route.id]} threat`}>{targeted?<ThreatGlyph kind={signal.kind as 'bad-login'|'swarm'|'breach'}/>:<Icon name="sun" size={18}/>}<span>{signal.name}</span><small className={defenseSet?'ready':''}>{defenseSet?(targeted?'Defense active':'Gate open'):`Use ${DEFENSES.find(defense=>defense.id===signal.mode)?.label}`}</small></div>
            <div className="mode-choices">{DEFENSES.map(defense=><button key={defense.id} className={`mode-choice ${defense.id} ${activeMode===defense.id?'active':''} ${!defenseSet&&signal.mode===defense.id?'suggested':''}`} aria-label={`${ROUTE_NAMES[route.id]}: ${defense.label}`} aria-pressed={activeMode===defense.id} disabled={busy||state.phase!=='running'||!canSetMode(defense.id,route.policy,state.credits)} onClick={()=>changeMode(route.id,defense.id)}><Icon name={defense.icon} size={19}/><strong>{defense.label}</strong><small>{defense.cost?`${defense.cost} credits`:'No credits'}</small></button>)}</div>
          </div>;
        })}</div>
      </section>
    </>}
    {playing&&state?.phase==='paused'&&<div className="modal-backdrop"><section className="pause-panel" role="dialog" aria-modal="true" aria-labelledby="pause-title"><span className="eyebrow">MISSION PAUSED</span><h2 id="pause-title">{helpOpen?'Here’s how to play.':'Traffic on hold.'}</h2><p>{state.pauseReason?.startsWith('Connection')?'The connection went quiet, so your city paused.':'Your city, mission clock, and traffic are paused.'}</p><button className="primary" autoFocus onClick={togglePause}>Resume First Light <Icon name="play"/></button>{helpOpen&&<QuickGuide/>}<div className="settings"><label><span>Sound</span><button onClick={toggleMute}>{muted?'Off':'On'}</button></label><label><span>Volume</span><input aria-label="Volume" type="range" min="0" max="1" step=".05" value={volume} onChange={e=>{const v=Number(e.target.value);setVolume(v);audioVolume(v);}}/></label><label><span>Background music</span><button onClick={()=>{const next=!music;setMusic(next);audioMusic(next);}} aria-pressed={music}>{music?'On':'Off'}</button></label><label><span>Music volume</span><input aria-label="Music volume" type="range" min="0" max="1" step=".05" value={musicVolume} onChange={e=>{const v=Number(e.target.value);setMusicVolume(v);audioMusicVolume(v);}}/></label><label><span>Reduced motion</span><button onClick={()=>motion(!reduced)} aria-pressed={reduced}>{reduced?'On':'Off'}</button></label></div><p className="keyboard-help">Click any district’s mode directly.<br/>Keyboard: 1–3 district · A key check · R slow flow · I close · O open<br/>Space pause · Scroll to zoom</p><div className="pause-restart-actions"><button className="text-button" onClick={start}><Icon name="retry" size={16}/>Restart mission</button><button className="text-button" onClick={()=>setHelpOpen(value=>!value)}>{helpOpen?'Hide quick guide':'Quick guide'}</button></div></section></div>}
    {playing&&finished&&state&&<div className={`results-wrap ${state.phase}`}><section className="results-panel"><div className="result-medallion"><Icon name={state.phase==='won'?'sun':'shield'} size={36}/></div><span className="eyebrow">FIRST LIGHT · {state.phase==='won'?'MISSION COMPLETE':'FLIGHT INTERRUPTED'}</span><h1>{state.phase==='won'?<>Network<br/><em>secured.</em></>:<>Regroup.<br/><em>Reconnect.</em></>}</h1><p>{state.phase==='won'?'The network held. You kept customers connected while stopping the threats.':state.integrity<=0?'Too much hostile traffic reached the city. Match the threat to its defense. Close the bridge against violet carriers. Slow flow cannot stop every heavy hit.':'Too many honest customers were turned away. Open defenses during calm windows and avoid leaving routes isolated.'}</p><div className="results-metrics"><div><strong>{Math.ceil(state.integrity)}<small>/100</small></strong><span>Integrity preserved</span></div><div><strong>{Math.floor(state.service*10)/10}<small>%</small></strong><span>Customers served</span></div><div><strong>{state.hostileBlocked}</strong><span>Threats stopped</span></div></div><div className="score-line"><span>FLIGHT SCORE</span><strong>{state.score.toLocaleString()}</strong>{state.phase==='won'&&state.score>=best&&<small>PERSONAL BEST</small>}</div><p className="score-formula">{state.legitimateServed} served × 5 + rounded ({state.integrity} integrity × 10) + {state.economyBonus} economy.<br/>Economy = rounded average free credits × 25.</p><div className="result-actions"><button className="primary" onClick={start}>Fly again <Icon name="retry" size={18}/></button><button className="secondary" onClick={()=>setInspect(true)}>Inspect the flight <Icon name="evidence" size={18}/></button></div><button className="text-button results-practice" onClick={()=>{setScreen('briefing');setInspect(false);}}>Quick briefing</button><span className="phase-note">FIRST LIGHT · ART REVIEW SLICE</span></section></div>}
    {inspect&&state&&<aside className="evidence-panel" role="dialog" aria-label="Measured request evidence"><div className="evidence-head"><span className="eyebrow">THE REAL REQUESTS</span><button className="icon-button" onClick={()=>setInspect(false)} aria-label="Close evidence"><Icon name="close"/></button></div><h2>Under the clouds.</h2><p>Every count comes from an HTTP request to this local gateway. Authentication, token buckets, and isolation make real decisions.</p><div className="evidence-counts"><span><b>{state.legitimateServed}</b>customers served</span><span><b>{state.hostileBlocked}</b>hostile rejected</span><span><b>{state.hostileAdmitted}</b>hostile admitted</span></div><p className="evidence-note">The Internet uplinks represent public connections from browsers, apps and other systems. Real cloud services can also use private connections. Enemy colors are teaching cues, not information given to the gateway. The workload is authored. Integrity is fictional. The generator’s role and threat labels are joined after the gateway decides. Admitted probes deal 0.3 fictional damage, swarms 0.1, and breach carriers 2. Up to 54 traffic actors show a bounded sample of authored local requests. Late visual samples are omitted; every displayed approach starts at an uplink and keeps its identity through the real gateway decision. Only completed HTTP responses affect these counts.</p><a className="secondary" href={`/api/log?sessionId=${encodeURIComponent(state.sessionId)}`} download>Download full request log <Icon name="arrow" size={18}/></a><h3>Latest measured responses</h3><div className="request-list">{state.events.slice(-35).reverse().map(event=><div key={event.id} className="request-event"><span className={`http-status ${event.status===200?'ok':''}`}>{event.status}</span><div><strong>{ROUTE_NAMES[event.route]} · {event.role==='hostile'?(event.threatType==='breach'?'Breach carrier':event.threatType==='swarm'?'Swarm':'Login probe'):'Customer'}</strong><small>{event.reason} · {event.elapsedMs.toFixed(1)} ms</small><code>{event.id}</code></div></div>)}</div></aside>}
    {connectionIssue&&<div className="modal-backdrop"><section className="pause-panel connection-panel" role="alertdialog" aria-modal="true" aria-labelledby="connection-title" aria-describedby="connection-description">
      <span className="eyebrow">{connectionIssue==='expired'?'FLIGHT UNAVAILABLE':'CONNECTION ON HOLD'}</span>
      <h2 id="connection-title">{connectionIssue==='expired'?'This flight has expired.':connectionIssue==='busy'?'The city is busy.':'Let’s reconnect.'}</h2>
      <p id="connection-description">{connectionIssue==='expired'?'The server no longer has this flight. Its progress cannot be resumed. Your saved best score and sound settings are still here.':connectionIssue==='busy'?'The server is serving other flights. Please wait a moment, then try again.':'We couldn’t reach the game. Check your connection, then reconnect or reload this page.'}</p>
      <button className="primary" autoFocus disabled={busy} onClick={()=>reconnect.current()}>{busy?'Connecting…':connectionIssue==='expired'?'Start a new flight':connectionIssue==='busy'?'Try again':'Reconnect'}<Icon name="retry"/></button>
      {connectionIssue==='expired'&&<p className="keyboard-help">A new flight opens at the briefing. The mission starts when you choose Begin First Light.</p>}
    </section></div>}
    {error&&<div className="error-toast" role="alert">{error}<button onClick={()=>setError('')} aria-label="Dismiss message">×</button></div>}
    <footer className="bottomline"><span>LOCAL SIMULATION <i/> FICTIONAL CITY. REAL GATEWAY.</span><span>{playing?'MATCH THE THREAT · REOPEN WHEN CLEAR · SPACE TO PAUSE':'DESIGNED TO PLAY. BUILT TO UNDERSTAND.'}</span></footer>
  </main>;
}
