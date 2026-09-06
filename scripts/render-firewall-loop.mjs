// Reproducible loop made from the exact selected audition's synthesis recipe.
// The 16-bar phrase retains its original notes, timbres, rhythmic build and seed.
import { synth, tracks } from './render-attack-music-options.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const folder = 'public/audio', output = `${folder}/firewall-drive-loop.wav`;
const ffmpeg = '.cloudbreak-runtime/media/node_modules/ffmpeg-static/ffmpeg';
const run = args => { const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', ...args], { maxBuffer: 4 * 1024 * 1024 }); if (result.error) throw result.error; assert.equal(result.status, 0, result.stderr.toString()); return result.stderr.toString(); };
const measure = file => { const log = run(['-i', file, '-af', 'loudnorm=I=-23:TP=-3:LRA=8:print_format=json', '-f', 'null', '-']); return JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1)); };
await mkdir(folder, { recursive: true });
const spec = tracks[0], { wav, notes, rawPeak } = synth(spec, { loop: true });
const raw = 'captures/attack-music-options/raw/firewall-drive-loop.wav';
await mkdir('captures/attack-music-options/raw', { recursive: true }); await writeFile(raw, wav);
const before = measure(raw), gainDb = -23 - Number(before.input_i);
// Static gain preserves the circular waveform. No time-varying normalization,
// codec padding, trimming, crossfade, tempo change or new instrument is involved.
run(['-y', '-loglevel', 'error', '-i', raw, '-af', `volume=${gainDb}dB`, '-ar', '44100', '-c:a', 'pcm_s16le', output]);
const measured = measure(output), bytes = await readFile(output);
assert.ok(Math.abs(Number(measured.input_i) + 23) < .15);
await writeFile(`${folder}/firewall-drive-loop.json`, JSON.stringify({
  name: spec.name, bpm: spec.bpm, key: spec.key, beats: 64, bars: 16,
  sampleRate: 44100, channels: 2, frames: Math.round(64 * 60 / spec.bpm * 44100),
  seconds: Math.round(64 * 60 / spec.bpm * 44100) / 44100,
  source: 'Original Firewall Drive audition synthesis, same notes, instruments, seed and arrangement over a complete 16-bar phrase.',
  loop: 'Natural releases and stereo echoes wrap into the start; circular high-pass filter history; no fade, silence or encoded padding.',
  loudnessLufs: Number(measured.input_i), truePeakDbtp: Number(measured.input_tp), staticGainDb: gainDb,
  rawPeak, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), notes: notes.length,
}, null, 2) + '\n');
console.log(`${output}: ${spec.bpm} BPM, 16 bars, ${measured.input_i} LUFS, ${measured.input_tp} dBTP`);
