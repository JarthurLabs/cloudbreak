import type { ThreatType } from './types';
type SoundKind = 'click' | 'shield' | 'wave' | 'win' | 'lose';
type CaptureResult = { mimeType: string; base64: string; startedAtPerformanceMs: number; stoppedAtPerformanceMs: number };
type Voice = { source: AudioScheduledSourceNode; nodes: AudioNode[]; music: boolean; threat: boolean; envelope?: GainNode };
type ThreatCueKind = 'blocked' | 'warning';
type ThreatCounts = { requested: number; emitted: number; dropped: number; coalesced: number; blockedEmitted: number; warningEmitted: number };
type RecentThreatCue = { type: ThreatType; cue: ThreatCueKind; audioTimeSeconds: number; performanceMs: number };
type ThreatStats = { byType: Record<ThreatType, ThreatCounts & { pending: boolean }>; pendingCount: number; recent: RecentThreatCue[]; limits: { globalSpacingMs: number; perTypeCooldownMs: number; pendingTtlMs: number; maxPending: number; maxRecent: number } };

declare global {
  interface Window {
    __cloudbreakAudioCapture?: { start(): void; stop(): Promise<CaptureResult> };
    __cloudbreakAudioStats?: {
      readonly started: boolean; readonly contextState: string; readonly music: boolean;
      readonly musicEnabled: boolean; readonly sceneActive: boolean; readonly muted: boolean;
      readonly masterVolume: number; readonly musicVolume: number; readonly activeVoices: number;
      readonly musicPlaybackSeconds: number; readonly musicLoopDurationSeconds: number;
      readonly musicLoadError: string | null; readonly sfxCounts: Record<SoundKind, number>;
      readonly musicTempoBpm: number; readonly musicStyle: string;
      readonly recording: boolean; readonly threatCues: ThreatStats;
    };
  }
}

const clamp = (value: number, fallback = 0) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
const readLevel = (key: string, fallback: number) => clamp(Number(localStorage.getItem(key) ?? fallback), fallback);
let muted = localStorage.getItem('cloudbreak.muted') === 'true';
let volume = readLevel('cloudbreak.volume', .3);
let musicVolume = readLevel('cloudbreak.musicVolume', .35);
let musicEnabled = localStorage.getItem('cloudbreak.musicEnabled') !== 'false';
let sceneActive = true;
let unlocked = false;
let ctx: AudioContext | null = null;
let master: GainNode, musicBus: GainNode, effectsBus: GainNode, limiter: DynamicsCompressorNode;
let recordingBus: MediaStreamAudioDestinationNode;
let disposed = false;
let musicBuffer: AudioBuffer | null = null;
let musicLoad: Promise<void> | null = null;
let musicLoadAbort: AbortController | null = null;
let musicLoadError: string | null = null;
let musicSource: { source: AudioBufferSourceNode; envelope: GainNode; startedAt: number } | null = null;
let musicOffset = 0, musicElapsed = 0;
const sfxCounts: Record<SoundKind, number> = { click: 0, shield: 0, wave: 0, win: 0, lose: 0 };
const voices = new Set<Voice>();
let noiseBuffer: AudioBuffer | null = null;

function smooth(gain: AudioParam, value: number, duration = .08) {
  if (!ctx) return;
  const now = ctx.currentTime;
  gain.cancelAndHoldAtTime(now);
  gain.linearRampToValueAtTime(value, now + duration);
}

function ensureContext() {
  if (ctx || disposed) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  master = ctx.createGain(); musicBus = ctx.createGain(); effectsBus = ctx.createGain();
  limiter = ctx.createDynamicsCompressor(); recordingBus = ctx.createMediaStreamDestination();
  master.gain.value = muted ? 0 : volume;
  musicBus.gain.value = 0; effectsBus.gain.value = 1;
  // Gentle peak control; capture receives exactly the same post-master mix as speakers.
  limiter.threshold.value = -16; limiter.knee.value = 12;
  limiter.ratio.value = 4; limiter.attack.value = .008; limiter.release.value = .2;
  musicBus.connect(master); effectsBus.connect(master); master.connect(limiter);
  limiter.connect(ctx.destination); limiter.connect(recordingBus);
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const noise = noiseBuffer.getChannelData(0);
  // Original repeatable noise, generated locally. No samples or external assets.
  let seed = 0xC10DB4EA;
  for (let i = 0; i < noise.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    noise[i] = (seed >>> 0) / 0xffffffff * 2 - 1;
  }
  ctx.addEventListener('statechange', audioStateChanged);
}

function track(source: AudioScheduledSourceNode, nodes: AudioNode[], music: boolean, threat = false, envelope?: GainNode) {
  const voice: Voice = { source, nodes, music, threat, envelope };
  voices.add(voice);
  source.onended = () => { for (const node of nodes) node.disconnect(); voices.delete(voice); };
}

function tone(frequency: number, when: number, duration: number, level: number, music: boolean,
  type: OscillatorType = 'sine', endFrequency?: number, attack = .025, cutoff = 1800, pan = 0, threat = false) {
  if (!ctx || voices.size >= 80) return;
  const oscillator = ctx.createOscillator(), envelope = ctx.createGain();
  const filter = ctx.createBiquadFilter(), position = ctx.createStereoPanner();
  oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, when);
  if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, when + duration * .85);
  filter.type = 'lowpass'; filter.frequency.value = cutoff; filter.Q.value = .35;
  position.pan.value = pan;
  envelope.gain.setValueAtTime(0, when);
  envelope.gain.linearRampToValueAtTime(level, when + Math.min(attack, duration * .4));
  envelope.gain.exponentialRampToValueAtTime(.0001, when + duration);
  oscillator.connect(filter); filter.connect(envelope); envelope.connect(position);
  position.connect(music ? musicBus : effectsBus);
  track(oscillator, [oscillator, filter, envelope, position], music, threat, envelope);
  oscillator.start(when); oscillator.stop(when + duration + .025);
}

// Nicholas selected Firewall Drive from the five original defense-score auditions.
// The rendered 16-bar PCM loop uses that exact recipe, with circular note releases
// and echo/filter history. A buffer loop has no timer drift or codec padding.
const MUSIC_BPM = 124;
const MUSIC_URL = `${import.meta.env.BASE_URL}audio/firewall-drive-loop.wav`;
const shouldPlayMusic = () => unlocked && !!ctx && ctx.state === 'running' && !muted && volume > 0 && musicEnabled && musicVolume > 0 && sceneActive && !document.hidden && !disposed;
const currentMusicElapsed = () => musicSource && ctx ? Math.max(0, ctx.currentTime - musicSource.startedAt) : 0;

function loadMusic() {
  if (!ctx || disposed || musicBuffer || musicLoad) return;
  const owner = ctx, abort = new AbortController();
  musicLoadAbort = abort; musicLoadError = null;
  musicLoad = (async () => {
    try {
      const response = await fetch(MUSIC_URL, { signal: abort.signal, cache: 'force-cache' });
      if (!response.ok) throw new Error(`Music could not load (${response.status}).`);
      const decoded = await owner.decodeAudioData(await response.arrayBuffer());
      if (disposed || ctx !== owner || abort.signal.aborted) return;
      musicBuffer = decoded;
    } catch (error) {
      if (!disposed && !abort.signal.aborted) musicLoadError = error instanceof Error ? error.message : 'Music could not load.';
    } finally {
      musicLoad = null;
      if (musicLoadAbort === abort) musicLoadAbort = null;
    }
    if (musicBuffer && !disposed) syncMusic();
  })();
}
function stopMusic() {
  if (!ctx || !musicSource) return;
  const current = musicSource, played = currentMusicElapsed();
  musicElapsed += played;
  musicOffset = musicBuffer ? (musicOffset + played) % musicBuffer.duration : 0;
  musicSource = null;
  // Each source owns its release, so a quick resume cannot turn an old tail up.
  smooth(current.envelope.gain, 0, .055);
  try { current.source.stop(ctx.currentTime + .065); } catch { /* Already ended. */ }
}
function syncMusic() {
  if (!shouldPlayMusic()) { stopMusic(); return; }
  if (!ctx) return;
  if (!musicBuffer) { loadMusic(); return; }
  smooth(musicBus.gain, musicVolume, .12);
  if (musicSource) return;
  const source = ctx.createBufferSource(), envelope = ctx.createGain();
  source.buffer = musicBuffer; source.loop = true;
  source.loopStart = 0; source.loopEnd = musicBuffer.duration;
  const when = ctx.currentTime + .015;
  envelope.gain.setValueAtTime(0, when);
  envelope.gain.linearRampToValueAtTime(1, when + .08);
  source.connect(envelope); envelope.connect(musicBus);
  track(source, [source, envelope], true, false, envelope);
  musicSource = { source, envelope, startedAt: when };
  source.start(when, musicOffset);
}

export function setMuted(value: boolean) {
  muted = !!value; localStorage.setItem('cloudbreak.muted', String(muted));
  if (muted) clearThreatQueue();
  if (ctx) smooth(master.gain, muted ? 0 : volume);
  syncMusic();
}
export function setVolume(value: number) {
  volume = clamp(value); localStorage.setItem('cloudbreak.volume', String(volume));
  if (!volume) clearThreatQueue();
  if (ctx) smooth(master.gain, muted ? 0 : volume);
  syncMusic();
}
export function setMusicVolume(value: number) {
  musicVolume = clamp(value); localStorage.setItem('cloudbreak.musicVolume', String(musicVolume)); syncMusic();
}
export function setMusicEnabled(value: boolean) {
  musicEnabled = !!value; localStorage.setItem('cloudbreak.musicEnabled', String(musicEnabled)); syncMusic();
}
export function setSceneAudio(active: boolean) { sceneActive = !!active; if (!sceneActive) clearThreatQueue(); syncMusic(); }
export function unlockAudio() {
  ensureContext();
  if (!ctx || disposed) return;
  unlocked = true;
  void ctx.resume().then(syncMusic).catch(() => { /* Browser will retry on the next explicit gesture. */ });
}

export function sound(kind: SoundKind) {
  if (!unlocked || !ctx || ctx.state !== 'running' || muted || document.hidden || disposed) return;
  const now = ctx.currentTime;
  if (kind === 'shield') { soundThreatBlocked('bad-login'); return; }
  if (kind === 'click') {
    tone(440, now, .095, .065, false, 'sine', 380, .008, 1300);
  } else {
    const notes = kind === 'win' ? [293.665, 369.994, 440, 587.33] : kind === 'lose' ? [220, 174.614, 130.813] : [329.628, 440];
    notes.forEach((note, index) => tone(note, now + index * .16, kind === 'wave' ? .5 : .8, .09, false, 'sine', undefined, .035, 1500));
  }
  sfxCounts[kind]++;
}

// Threat cues are actual-event consumers. One pending cue per type is enough to
// represent a burst; round-robin selection prevents a busy coral stream from
// starving amber or violet. Every queued cue has a recent real triggering event.
const THREAT_TYPES: ThreatType[] = ['bad-login', 'swarm', 'breach'];
const THREAT_SPACING = .18, THREAT_COOLDOWN = .65, THREAT_TTL_MS = 500;
const newThreatCounts = (): ThreatCounts => ({ requested: 0, emitted: 0, dropped: 0, coalesced: 0, blockedEmitted: 0, warningEmitted: 0 });
const threatCounts: Record<ThreatType, ThreatCounts> = { 'bad-login': newThreatCounts(), swarm: newThreatCounts(), breach: newThreatCounts() };
const lastThreatTime: Record<ThreatType, number> = { 'bad-login': -Infinity, swarm: -Infinity, breach: -Infinity };
const threatQueue = new Map<ThreatType, { cue: ThreatCueKind; expiresAtMs: number }>();
const recentThreatCues: RecentThreatCue[] = [];
let threatTimer: ReturnType<typeof setTimeout> | undefined;
let lastThreatMixTime = -Infinity, nextThreatType = 0;
const canPlayThreat = () => unlocked && !!ctx && ctx.state === 'running' && !muted && volume > 0 && sceneActive && !document.hidden && !disposed;

function clearThreatQueue() {
  clearTimeout(threatTimer); threatTimer = undefined;
  for (const type of threatQueue.keys()) threatCounts[type].dropped++;
  threatQueue.clear();
  // Fade existing threat tails and cancel future stutter notes as well as queued
  // cues. Music and ordinary menu clicks belong to their own lifecycles.
  if (ctx) for (const voice of voices) if (voice.threat) {
    if (voice.envelope) smooth(voice.envelope.gain, 0, .015);
    try { voice.source.stop(ctx.currentTime + .02); } catch { /* Already ended. */ }
  }
}

/** Call on a new flight. Clears old queued/tail audio and resets per-flight diagnostics. */
export function resetThreatAudio() {
  clearThreatQueue();
  for (const type of THREAT_TYPES) { threatCounts[type] = newThreatCounts(); lastThreatTime[type] = -Infinity; }
  recentThreatCues.length = 0; lastThreatMixTime = -Infinity; nextThreatType = 0;
}

// Collision texture has its own soft envelope and bass rejection. Keeping this
// separate leaves the industrial score's machinery wash and every music level
// unchanged. A finite buffer offset varies the grains without random loud hits.
function collisionAir(when: number, duration: number, level: number, startHz: number, endHz: number, variation: number, pan: number) {
  if (!ctx || !noiseBuffer || voices.size >= 80) return;
  const source = ctx.createBufferSource(), band = ctx.createBiquadFilter();
  const lowCut = ctx.createBiquadFilter(), highCut = ctx.createBiquadFilter();
  const envelope = ctx.createGain(), position = ctx.createStereoPanner();
  source.buffer = noiseBuffer; source.loop = true;
  band.type = 'bandpass'; band.Q.value = .8;
  band.frequency.setValueAtTime(startHz, when);
  band.frequency.exponentialRampToValueAtTime(endHz, when + duration);
  lowCut.type = 'highpass'; lowCut.frequency.value = 320; lowCut.Q.value = .5;
  highCut.type = 'lowpass'; highCut.frequency.value = 2100; highCut.Q.value = .5;
  envelope.gain.setValueAtTime(0, when);
  envelope.gain.linearRampToValueAtTime(level * .7, when + duration * .22);
  envelope.gain.linearRampToValueAtTime(level, when + duration * .36);
  envelope.gain.exponentialRampToValueAtTime(.0001, when + duration);
  position.pan.value = pan;
  source.connect(band); band.connect(lowCut); lowCut.connect(highCut);
  highCut.connect(envelope); envelope.connect(position); position.connect(effectsBus);
  track(source, [source, band, lowCut, highCut, envelope, position], false, true, envelope);
  source.start(when, variation * .137); source.stop(when + duration + .025);
}

function emitThreat(type: ThreatType, cue: ThreatCueKind, when: number) {
  const count = cue === 'warning' ? threatCounts[type].warningEmitted : threatCounts[type].blockedEmitted;
  const variation = count % 5;
  // Small deterministic variants retain one identity and consistent loudness.
  // Changes follow emitted cues, so coalesced input bursts cannot select an odd
  // loud variant or mutate any shared random state used by the musical score.
  const pitch = [1, .985, 1.012, .994, 1.006][variation];
  const level = [.98, 1, .97, .99, .98][variation];
  const length = [1, .98, 1.025, 1, .99][variation];
  if (cue === 'warning') {
    // Related rising silhouettes, without low drum-like warning oscillators.
    if (type === 'bad-login') tone(480 * pitch, when, .20, .042 * level, false, 'sine', 580 * pitch, .038, 1250, -.10, true);
    if (type === 'swarm') {
      collisionAir(when, .26 * length, .078 * level, 780 * pitch, 1250 * pitch, variation, .08);
    }
    if (type === 'breach') {
      tone(410 * pitch, when, .28, .032 * level, false, 'sine', 475 * pitch, .055, 1200, .10, true);
      tone(615 * pitch, when + .012, .23, .012 * level, false, 'sine', 710 * pitch, .050, 1400, -.10, true);
    }
    return;
  }
  if (type === 'bad-login') {
    // Coral: one rounded digital deflection, no bright buzz or rattling tail.
    tone(620 * pitch, when, .18 * length, .046 * level, false, 'sine', 465 * pitch, .032, 1300, -.10, true);
    collisionAir(when + .012, .14, .017 * level, 1200, 900, variation, .06);
  } else if (type === 'swarm') {
    // Amber: a single airy grain sweep; replacing three low square/noise ticks
    // removes the repeated drum/rattle impression in a busy swarm.
    collisionAir(when, .255 * length, .105 * level, 1150 * pitch, 650 * pitch, variation, .08);
  } else {
    // Violet: restrained glass/energy discharge. All tonal energy stays in the
    // midrange: no 115→42 Hz kick, bass impact, or long resonant ring pileup.
    tone(392 * pitch, when, .30 * length, .035 * level, false, 'sine', 370 * pitch, .052, 1150, .08, true);
    tone(590 * pitch, when + .008, .25 * length, .017 * level, false, 'sine', 552 * pitch, .043, 1300, -.08, true);
    tone(960 * pitch, when + .012, .16, .006 * level, false, 'sine', 900 * pitch, .035, 1500, .04, true);
    collisionAir(when + .010, .24, .034 * level, 1250, 780, variation, -.05);
  }
}

function flushThreatQueue() {
  clearTimeout(threatTimer); threatTimer = undefined;
  if (!canPlayThreat() || !ctx) { clearThreatQueue(); return; }
  const now = ctx.currentTime, wall = performance.now();
  for (const [type, entry] of threatQueue) if (entry.expiresAtMs <= wall) { threatQueue.delete(type); threatCounts[type].dropped++; }
  if (!threatQueue.size) return;
  if (now - lastThreatMixTime >= THREAT_SPACING) {
    for (let offset = 0; offset < THREAT_TYPES.length; offset++) {
      const index = (nextThreatType + offset) % THREAT_TYPES.length, type = THREAT_TYPES[index];
      const entry = threatQueue.get(type);
      if (!entry || now - lastThreatTime[type] < THREAT_COOLDOWN) continue;
      threatQueue.delete(type);
      if (voices.size > 70) { threatCounts[type].dropped++; continue; }
      emitThreat(type, entry.cue, now);
      lastThreatTime[type] = now; lastThreatMixTime = now; nextThreatType = (index + 1) % THREAT_TYPES.length;
      threatCounts[type].emitted++;
      if (entry.cue === 'blocked') { threatCounts[type].blockedEmitted++; sfxCounts.shield++; }
      else threatCounts[type].warningEmitted++;
      recentThreatCues.push({ type, cue: entry.cue, audioTimeSeconds: now, performanceMs: wall });
      if (recentThreatCues.length > 96) recentThreatCues.shift();
      break;
    }
  }
  if (threatQueue.size) {
    const due = Math.min(...[...threatQueue].map(([type, entry]) => Math.min(
      Math.max(lastThreatMixTime + THREAT_SPACING - now, lastThreatTime[type] + THREAT_COOLDOWN - now) * 1000,
      entry.expiresAtMs - wall)));
    threatTimer = setTimeout(flushThreatQueue, Math.max(5, due + 1));
  }
}

function queueThreat(type: ThreatType, cue: ThreatCueKind) {
  if (!THREAT_TYPES.includes(type)) return;
  threatCounts[type].requested++;
  if (!canPlayThreat()) { threatCounts[type].dropped++; return; }
  const previous = threatQueue.get(type);
  if (previous) {
    threatCounts[type].coalesced++;
    // A fresh actual event may renew the pending cue; a warning is not demoted
    // by the first blocked request while it waits for the shared audio slot.
    previous.expiresAtMs = performance.now() + THREAT_TTL_MS;
    if (cue === 'warning') previous.cue = 'warning';
  } else threatQueue.set(type, { cue, expiresAtMs: performance.now() + THREAT_TTL_MS });
  flushThreatQueue();
}
export function soundThreatBlocked(kind: ThreatType) { queueThreat(kind, 'blocked'); }
export function soundThreatWarning(kind: ThreatType) { queueThreat(kind, 'warning'); }

// Explicit local QA capture only. Starting a recorder does not resume audio,
// start music, start traffic, or replay a synthetic timeline. Unlock normally
// before start() for audiovisual capture; both timestamps use performance.now().
type CaptureSession = {
  recorder: MediaRecorder; result: Promise<CaptureResult>; stoppedAt: number;
  timer: ReturnType<typeof setTimeout>; stop(): void;
};
let capture: CaptureSession | null = null;
function startCapture() {
  if (capture?.recorder.state === 'recording') throw new Error('Cloudbreak audio capture is already running.');
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record the Cloudbreak audio mix.');
  ensureContext();
  if (!ctx || disposed) throw new Error('Cloudbreak audio is unavailable.');
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('This browser has no supported Cloudbreak audio recording format.');
  const recorder = new MediaRecorder(recordingBus.stream, { mimeType, audioBitsPerSecond: 128_000 });
  const chunks: Blob[] = [];
  let bytes = 0;
  let resolveResult!: (value: CaptureResult) => void, rejectResult!: (error: Error) => void;
  const result = new Promise<CaptureResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // Prevent an unhandled rejection if a browser recorder fails before QA calls stop.
  void result.catch(() => {});
  const startedAtPerformanceMs = performance.now();
  const run: CaptureSession = {
    recorder, result, stoppedAt: 0,
    timer: setTimeout(() => run.stop(), 600_000),
    stop() {
      if (recorder.state === 'inactive') return;
      run.stoppedAt = performance.now(); clearTimeout(run.timer); recorder.stop();
    },
  };
  recorder.ondataavailable = event => {
    if (event.data.size) { chunks.push(event.data); bytes += event.data.size; }
    if (bytes >= 16 * 1024 * 1024) run.stop();
  };
  recorder.onerror = () => { clearTimeout(run.timer); rejectResult(new Error('Cloudbreak audio recording was interrupted.')); };
  recorder.onstop = () => {
    clearTimeout(run.timer);
    const reader = new FileReader();
    reader.onerror = () => rejectResult(new Error('Cloudbreak audio recording could not be exported.'));
    reader.onload = () => {
      resolveResult({ mimeType: recorder.mimeType, base64: String(reader.result).split(',')[1], startedAtPerformanceMs, stoppedAtPerformanceMs: run.stoppedAt || performance.now() });
      chunks.length = 0;
    };
    reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType }));
  };
  capture = run;
  try { recorder.start(1000); } catch (error) { clearTimeout(run.timer); capture = null; throw error; }
}

const captureHook = {
  start: startCapture,
  stop() {
    if (!capture) return Promise.reject(new Error('No Cloudbreak audio recording has started.'));
    const run = capture; run.stop(); return run.result;
  },
};
const statsHook = {
  get started() { return unlocked && !!ctx && ctx.state === 'running'; },
  get contextState() { return ctx?.state ?? 'not-started'; },
  get music() { return musicSource !== null; },
  get musicEnabled() { return musicEnabled; },
  get sceneActive() { return sceneActive; },
  get muted() { return muted; },
  get masterVolume() { return volume; },
  get musicVolume() { return musicVolume; },
  get activeVoices() { return voices.size; },
  get musicPlaybackSeconds() { return musicElapsed + currentMusicElapsed(); },
  get musicLoopDurationSeconds() { return musicBuffer?.duration ?? 0; },
  get musicLoadError() { return musicLoadError; },
  get musicTempoBpm() { return MUSIC_BPM; },
  get musicStyle() { return 'Firewall Drive · urgent synth defense score'; },
  get sfxCounts() { return { ...sfxCounts }; },
  get recording() { return capture?.recorder.state === 'recording'; },
  get threatCues(): ThreatStats {
    return {
      byType: Object.fromEntries(THREAT_TYPES.map(type => [type, { ...threatCounts[type], pending: threatQueue.has(type) }])) as ThreatStats['byType'],
      pendingCount: threatQueue.size, recent: recentThreatCues.map(cue => ({ ...cue })),
      limits: { globalSpacingMs: THREAT_SPACING * 1000, perTypeCooldownMs: THREAT_COOLDOWN * 1000, pendingTtlMs: THREAT_TTL_MS, maxPending: 3, maxRecent: 96 },
    };
  },
};
// Expose inspection only on this game's loopback preview; never user telemetry.
if (['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.__cloudbreakAudioCapture = captureHook;
  window.__cloudbreakAudioStats = statsHook;
}
function visibilityChanged() { if (document.hidden) clearThreatQueue(); syncMusic(); }
function audioStateChanged() { if (ctx?.state !== 'running') clearThreatQueue(); syncMusic(); }
document.addEventListener('visibilitychange', visibilityChanged);
function dispose() {
  disposed = true; clearThreatQueue(); stopMusic(); musicLoadAbort?.abort(); musicBuffer = null; capture?.stop();
  document.removeEventListener('visibilitychange', visibilityChanged);
  if (ctx) {
    ctx.removeEventListener('statechange', audioStateChanged);
    for (const voice of voices) { try { voice.source.stop(); } catch { /* Already ended. */ } for (const node of voice.nodes) node.disconnect(); }
    voices.clear(); recordingBus.stream.getTracks().forEach(track => track.stop());
    master.disconnect(); musicBus.disconnect(); effectsBus.disconnect(); limiter.disconnect();
    void ctx.close().catch(() => {});
  }
  if (window.__cloudbreakAudioCapture === captureHook) delete window.__cloudbreakAudioCapture;
  if (window.__cloudbreakAudioStats === statsHook) delete window.__cloudbreakAudioStats;
}
if (import.meta.hot) import.meta.hot.dispose(dispose);
