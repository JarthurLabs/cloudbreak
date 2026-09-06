import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, relative, sep, join } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const CAPTURES = resolve(ROOT, 'captures');
const FFMPEG = resolve(ROOT, '.cloudbreak-runtime/media/node_modules/ffmpeg-static/ffmpeg');
const MAX_PENDING_WRITES = 6;
const MAX_BYTES = 1_500_000_000;
const MAX_SECONDS = 600;
const MAX_FPS = 30;

function withinCaptures(path) {
  const result = resolve(ROOT, path);
  if (!result.startsWith(CAPTURES + sep)) throw new Error('Cloudbreak recording files must stay inside this game’s captures folder.');
  return result;
}
const quoteConcat = name => `'${name.replaceAll("'", "'\\''")}'`;

async function runFFmpeg(args, countOutput = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(FFMPEG, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', bytes = 0;
    child.stdout.on('data', data => { if (countOutput) bytes += data.length; });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-20_000); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveRun({ bytes, stderr }) : reject(new Error(`Cloudbreak media command failed (${code}): ${stderr}`)));
  });
}

async function decodedAudioDuration(path) {
  const { bytes } = await runFFmpeg(['-hide_banner', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], true);
  return bytes / 4 / 48_000;
}

/**
 * Record continuous CDP screencast frames, never Playwright's synthetic-cadence
 * video recorder. Each JPEG is an actual compositor frame with its CDP epoch
 * timestamp. Audio is the simultaneously heard live post-master Web Audio mix.
 *
 * Call after an ordinary UI gesture has unlocked sound. This helper never starts
 * a mission, unlocks music, changes policies, or injects visual/audio events.
 */
export async function startRecording(page, folder, options = {}) {
  const maxWidth = options.width ?? 1920, maxHeight = options.height ?? 1080;
  const byteLimit = options.maxBytes ?? MAX_BYTES;
  if (![1920, 3840].includes(maxWidth) || maxHeight !== maxWidth * 9 / 16) throw new Error('Capture must be 1080p or native 4K, 16:9.');
  if (!Number.isInteger(byteLimit) || byteLimit < 1 || byteLimit > 5_000_000_000) throw new Error('Invalid bounded capture byte limit.');
  folder = withinCaptures(folder);
  await mkdir(folder, { recursive: true });
  const frameFolder = join(folder, 'frames');
  try { await stat(join(folder, 'manifest.json')); throw new Error('This recording folder already has a manifest. Use a new folder.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(frameFolder, { recursive: true });
  const preflight = await page.evaluate(() => ({
    hook: !!window.__cloudbreakAudioCapture,
    unlocked: window.__cloudbreakAudioStats?.started,
    timeOrigin: performance.timeOrigin,
    browserEpochMs: performance.timeOrigin + performance.now(),
    browserDateMs: Date.now(),
  }));
  if (!preflight.hook || !preflight.unlocked) throw new Error('Unlock Cloudbreak sound with a normal UI gesture before recording. Capture does not start audio itself.');
  if (Math.abs(preflight.browserEpochMs - preflight.browserDateMs) > 250) throw new Error('Browser performance and wall clocks differ by more than 250 ms; cannot align honest audio/video.');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  const frames = [], writes = new Set(), errors = [];
  let accepting = true, lastTimestamp = -Infinity, sequence = 0, received = 0;
  let cadenceDrops = 0, queueDrops = 0, nonMonotonicDrops = 0, encodedBytes = 0;
  let firstResolve;
  const firstFrame = new Promise(resolveFirst => { firstResolve = resolveFirst; });
  let automaticStop, stopPromise;
  const startedNodeEpochMs = Date.now();

  const onFrame = event => {
    received++;
    const ack = () => cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(error => { if (accepting) errors.push(error.message); });
    const timestamp = event.metadata.timestamp;
    const receivedNodeEpochMs = Date.now();
    if (!accepting) { void ack(); return; }
    if (!Number.isFinite(timestamp) || Math.abs(timestamp * 1000 - receivedNodeEpochMs) > 2000) {
      errors.push('CDP frame timestamp is not a plausible epoch time.'); void ack(); return;
    }
    if (timestamp <= lastTimestamp) { nonMonotonicDrops++; void ack(); return; }
    if (timestamp - lastTimestamp < 1 / MAX_FPS - .0005) { cadenceDrops++; void ack(); return; }
    if (writes.size >= MAX_PENDING_WRITES) { queueDrops++; void ack(); return; }
    const bytes = Buffer.from(event.data, 'base64');
    if (encodedBytes + bytes.length > byteLimit || receivedNodeEpochMs - startedNodeEpochMs > MAX_SECONDS * 1000) {
      errors.push('Continuous recording reached its bounded size or duration limit.');
      accepting = false; void ack(); return;
    }
    encodedBytes += bytes.length; lastTimestamp = timestamp;
    const filename = `frame-${String(sequence++).padStart(6, '0')}.jpg`;
    const frame = { file: `frames/${filename}`, timestampEpochSeconds: timestamp, receivedNodeEpochMs, bytes: bytes.length, metadata: event.metadata };
    frames.push(frame);
    const writing = (async () => {
      try { await writeFile(join(frameFolder, filename), bytes, { flag: 'wx' }); firstResolve(); }
      catch (error) { errors.push(`Frame write: ${error.message}`); }
      finally { await ack(); }
    })();
    writes.add(writing);
    void writing.finally(() => writes.delete(writing));
  };
  cdp.on('Page.screencastFrame', onFrame);
  try {
    await page.evaluate(() => window.__cloudbreakAudioCapture.start());
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth, maxHeight, everyNthFrame: 2 });
    let startupTimeout;
    try {
      await Promise.race([firstFrame, new Promise((_, reject) => { startupTimeout = setTimeout(() => reject(new Error('No continuous compositor frames arrived within five seconds.')), 5000); })]);
    } finally { clearTimeout(startupTimeout); }
  } catch (error) {
    accepting = false;
    await Promise.allSettled([cdp.send('Page.stopScreencast'), page.evaluate(() => window.__cloudbreakAudioCapture.stop())]);
    cdp.off('Page.screencastFrame', onFrame); await cdp.detach();
    throw error;
  }

  async function finish() {
    clearTimeout(automaticStop);
    const stopRequestedNodeEpochMs = Date.now();
    const audioPromise = page.evaluate(async () => {
      const timeOrigin = performance.timeOrigin;
      const audio = await window.__cloudbreakAudioCapture.stop();
      return { ...audio, timeOrigin };
    });
    try { await cdp.send('Page.stopScreencast'); }
    catch (error) { errors.push(`Stop screencast: ${error.message}`); }
    accepting = false;
    await Promise.all([...writes]);
    cdp.off('Page.screencastFrame', onFrame); await cdp.detach();
    const audio = await audioPromise;
    const audioStartEpochSeconds = (audio.timeOrigin + audio.startedAtPerformanceMs) / 1000;
    const audioStopEpochSeconds = (audio.timeOrigin + audio.stoppedAtPerformanceMs) / 1000;
    const audioWallDurationSeconds = audioStopEpochSeconds - audioStartEpochSeconds;
    const audioPath = join(folder, audio.mimeType.includes('mp4') ? 'audio.m4a' : 'audio.webm');
    await writeFile(audioPath, Buffer.from(audio.base64, 'base64'));
    // Stop at the actual audio stop event. Any tail from the last compositor
    // update is the real unchanged screen until recording stops, not new motion.
    const selected = frames.filter(frame => frame.timestampEpochSeconds <= audioStopEpochSeconds);
    if (!selected.length) throw new Error('No actual video frames overlap the live audio capture.');
    const firstEpoch = selected[0].timestampEpochSeconds;
    const durationSeconds = audioStopEpochSeconds - firstEpoch;
    if (durationSeconds <= 0) throw new Error('The recording did not span positive real time.');
    const intervals = selected.slice(1).map((frame, index) => frame.timestampEpochSeconds - selected[index].timestampEpochSeconds);
    const sortedIntervals = [...intervals].sort((a, b) => a - b);
    const concatPath = join(folder, 'frames.ffconcat');
    const lines = ['ffconcat version 1.0'];
    for (let index = 0; index < selected.length; index++) {
      const frame = selected[index];
      const until = selected[index + 1]?.timestampEpochSeconds ?? audioStopEpochSeconds;
      lines.push(`file ${quoteConcat(frame.file)}`, 'option framerate 1000', `duration ${(until - frame.timestampEpochSeconds).toFixed(6)}`);
    }
    // ffconcat requires a final endpoint to honor the last duration. This repeats
    // only the last real image as a timing marker; mux clips at the exact endpoint.
    lines.push(`file ${quoteConcat(selected.at(-1).file)}`, 'option framerate 1000');
    await writeFile(concatPath, lines.join('\n') + '\n');
    const audioDecodedDurationSeconds = await decodedAudioDuration(audioPath);
    const report = {
      format: 'cloudbreak-continuous-screencast-v1', folder,
      videoSource: 'Chrome Page.startScreencast actual JPEG compositor frames',
      audioSource: 'Live game post-master/post-compressor Web Audio graph; no replay or injected events',
      audioPath, concatPath, manifestPath: join(folder, 'manifest.json'),
      startedNodeEpochMs, stopRequestedNodeEpochMs,
      firstFrameEpochSeconds: firstEpoch, lastFrameEpochSeconds: selected.at(-1).timestampEpochSeconds,
      videoEndEpochSeconds: audioStopEpochSeconds, durationSeconds,
      audio: { mimeType: audio.mimeType, timeOrigin: audio.timeOrigin, startedAtPerformanceMs: audio.startedAtPerformanceMs, stoppedAtPerformanceMs: audio.stoppedAtPerformanceMs,
        startEpochSeconds: audioStartEpochSeconds, stopEpochSeconds: audioStopEpochSeconds,
        wallDurationSeconds: audioWallDurationSeconds, decodedDurationSeconds: audioDecodedDurationSeconds,
        codecDurationDifferenceMs: (audioWallDurationSeconds - audioDecodedDurationSeconds) * 1000,
        offsetFromVideoStartSeconds: audioStartEpochSeconds - firstEpoch,
        latencyDisclosure: 'Aligned by actual start clocks. MediaRecorder/Opus startup priming is not directly timestamped; decoded versus capture duration difference is measured above, with no guessed latency compensation.' },
      clockCheck: { ...preflight, firstFrameReceiptDifferenceMs: selected[0].receivedNodeEpochMs - firstEpoch * 1000 },
      cadence: { requestedEveryNthFrame: 2, maximumStoredFps: MAX_FPS, received, stored: selected.length,
        averageFps: selected.length / durationSeconds, maximumIntervalSeconds: Math.max(0, ...intervals),
        medianIntervalSeconds: sortedIntervals[Math.floor(sortedIntervals.length / 2)] ?? 0,
        finalFrameHoldSeconds: audioStopEpochSeconds - selected.at(-1).timestampEpochSeconds,
        cadenceDrops, queueDrops, nonMonotonicDrops, maxPendingWrites: MAX_PENDING_WRITES, encodedBytes },
      timingPolicy: 'Variable frame timestamps preserved. No speed changes, interpolated frames, fabricated gameplay, or still-image storyboard.',
      errors, frames: selected,
    };
    await writeFile(report.manifestPath, JSON.stringify(report, null, 2));
    if (errors.length) throw new Error(`Recording evidence saved but incomplete: ${errors.join('; ')}`);
    if (Math.abs(audioWallDurationSeconds - audioDecodedDurationSeconds) > .25) throw new Error('Recorded audio differs from its real capture window by more than 250 ms. Inspect the saved manifest before muxing.');
    return report;
  }
  const handle = { stop() { return stopPromise ??= finish(); } };
  automaticStop = setTimeout(() => { void handle.stop().catch(() => {}); }, MAX_SECONDS * 1000);
  return handle;
}

/** Produce a playable full-length MP4. Audio and all frame intervals stay real-time. */
export async function muxRecording(report, output) {
  output = withinCaptures(output);
  if (report.errors.length) throw new Error('Refusing to mux an incomplete Cloudbreak recording.');
  const offset = report.audio.offsetFromVideoStartSeconds;
  const shift = offset < 0 ? `atrim=start=${(-offset).toFixed(6)},asetpts=PTS-STARTPTS` : `asetpts=PTS-STARTPTS,adelay=${(offset * 1000).toFixed(3)}:all=1`;
  const audioFilter = `[1:a]${shift},apad,atrim=duration=${report.durationSeconds.toFixed(6)}[audio]`;
  const { stderr } = await runFFmpeg(['-y', '-hide_banner', '-loglevel', 'warning',
    '-f', 'concat', '-safe', '0', '-i', report.concatPath, '-i', report.audioPath,
    '-filter_complex', audioFilter, '-map', '0:v:0', '-map', '[audio]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-fps_mode:v', 'vfr', '-enc_time_base:v', '1:1000', '-video_track_timescale', '1000000',
    '-c:a', 'aac', '-b:a', '160k', '-t', report.durationSeconds.toFixed(6), '-movflags', '+faststart', output]);
  return { output, durationSeconds: report.durationSeconds, audioOffsetSeconds: offset, variableFrameRate: true, warnings: stderr };
}
