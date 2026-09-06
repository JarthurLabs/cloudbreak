import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCloudbreakServer } from '../server/app.mjs';
import { SCORE_FORMULA, WAVES } from '../server/waves.mjs';
import { signalsForState } from '../src/defenses.ts';

const root = resolve(import.meta.dirname, '..');
const fast = process.argv.includes('--fast');
const undefended = process.argv.includes('--undefended');
const overIsolated = process.argv.includes('--isolated');
const portArgument = process.argv.find(arg => arg.startsWith('--port='));
const port = portArgument ? Number(portArgument.split('=')[1]) : 5319;
let simulatedTime = 0;
const app = createCloudbreakServer({ port, autoTick: !fast, ...(fast ? { clock: () => simulatedTime } : {}) });
const policyOff = { auth: false, rate: 0, isolated: false };
let stopped = false;
process.once('SIGINT', () => { stopped = true; });
process.once('SIGTERM', () => { stopped = true; });
const started = performance.now();
const api = async (path, body) => {
  const response = await fetch(`${app.url}${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
};

try {
  await app.listen();
  let state = await api('/api/session', {});
  const sessionId = state.sessionId;
  state = await api('/api/start', { sessionId });
  console.log(`Cloudbreak ${fast ? 'clock-controlled verification' : 'real-time 180-second demonstration'} at ${app.url}`);
  console.log(`Local authored traffic only. Session: ${sessionId}`);
  let lastWave = -1, lastSignals = '';
  while (!stopped && !['won', 'lost'].includes(state.phase)) {
    const signals = signalsForState(state);
    const signalKey = signals.map(signal => `${signal.route}:${signal.kind}`).join('|');
    if (state.wave.index !== lastWave || signalKey !== lastSignals) {
      lastSignals = signalKey;
      lastWave = state.wave.index;
      console.log(`${state.elapsed.toFixed(1)}s — ${state.wave.title}`);
      if (!undefended) {
        for (const route of ['storefront', 'accounts', 'dispatch']) {
          let policy = { ...policyOff };
          if (overIsolated) policy.isolated = true;
          else {
            const threat = signals.find(item => item.route === route)?.kind;
            policy = { auth: threat === 'bad-login', rate: threat === 'swarm' ? 1 : 0, isolated: threat === 'breach' };
          }
          await api('/api/policy', { sessionId, route, policy });
        }
      }
    }
    if (fast) simulatedTime += 100;
    else await new Promise(resolveWait => setTimeout(resolveWait, 100));
    await api('/api/heartbeat', { sessionId });
    if (fast) await app.tick();
    state = await api(`/api/state?sessionId=${sessionId}`);
  }
  if (stopped) {
    await api('/api/pause', { sessionId, paused: true });
    console.log('Demonstration stopped; generator paused.');
  } else {
    assert.equal(state.phase, undefended || overIsolated ? 'lost' : 'won');
    const report = {
      game: 'cloudbreak', mode: fast ? 'controlled-clock-real-http' : 'real-time-real-http',
      strategy: undefended ? 'undefended' : overIsolated ? 'all-routes-isolated' : 'guided-defense',
      wallElapsedSeconds: Number(((performance.now() - started) / 1_000).toFixed(3)),
      result: { phase: state.phase, elapsed: state.elapsed, integrity: state.integrity, service: state.service, legitimateServed: state.legitimateServed, legitimateTotal: state.legitimateTotal, hostileAdmitted: state.hostileAdmitted, hostileBlocked: state.hostileBlocked, totalRequests: state.totalRequests, score: state.score, economyBonus: state.economyBonus },
      scoreFormula: SCORE_FORMULA, requestLog: state.logFile,
      waves: WAVES.map(({ start, end, title }) => ({ start, end, title })),
    };
    const filename = `cloudbreak-demo-${Date.now()}-${fast ? 'controlled-clock' : 'real-time'}.json`;
    await writeFile(resolve(root, 'logs', filename), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report.result, null, 2));
    console.log(`Report: logs/${filename}`);
    console.log(`Measured request log: logs/${state.logFile}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await app.close();
}
