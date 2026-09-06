import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCloudbreakServer } from '../server/app.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OPEN = { auth: false, rate: 0, isolated: false };
async function fixture(t) {
  let now = 10000, closed = false;
  await mkdir(resolve(ROOT, 'logs'), { recursive: true });
  const logDir = await mkdtemp(resolve(ROOT, 'logs', 'approach-test-'));
  const app = createCloudbreakServer({ port: 5316, autoTick: false, clock: () => now, logDir });
  await app.listen();
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await rm(logDir, { recursive: true, force: true }); });
  const api = async (path, body) => {
    const response = await fetch(`${app.url}${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return response.json();
  };
  const { sessionId: id } = await api('/api/session', {});
  await api('/api/start', { sessionId: id });
  const heartbeat = () => api('/api/heartbeat', { sessionId: id });
  return { app, api, id, close, heartbeat, advance: ms => { now += ms; }, now: () => now,
    state: () => api(`/api/state?sessionId=${id}`),
    policy: (route, policy) => api('/api/policy', { sessionId: id, route, policy }),
    async steps(count, ms = 100) { for (let i = 0; i < count; i++) { now += ms; await heartbeat(); await app.tick(); } },
    async jump(seconds) { for (let i = 0; i < seconds; i++) { now += 1000; await heartbeat(); } },
  };
}

test('authored arrivals precede real HTTP and a changed gate decides the same request ID', async t => {
  const f = await fixture(t), observed = [];
  f.app.server.prependListener('request', req => { if (req.url.startsWith('/gateway/')) observed.push({ id: req.headers['x-cloudbreak-request-id'], headers: req.headers }); });
  await f.steps(4);
  const before = await f.state();
  assert.equal(before.totalRequests, 0, 'Approaching traffic is not a completed HTTP request.');
  assert.equal(observed.length, 0, 'The fetch must wait for two mission seconds of approach.');
  assert.ok(before.incoming.length > 0);
  const incoming = before.incoming.find(item => item.route === 'storefront');
  assert.ok(incoming);
  assert.equal(incoming.decisionAt - incoming.approachStartedAt, 2);
  assert.deepEqual(Object.keys(incoming).sort(), ['approachStartedAt', 'decisionAt', 'id', 'role', 'route', 'threatType']);
  await f.policy('storefront', { ...OPEN, isolated: true });
  await f.steps(21);
  const after = await f.state(), record = after.events.find(item => item.id === incoming.id);
  assert.equal(record.status, 503);
  assert.equal(record.damage, 0);
  assert.equal(record.approachStartedAt, incoming.approachStartedAt);
  assert.equal(record.decisionAt, incoming.decisionAt);
  assert.ok(record.missionTime >= record.decisionAt);
  assert.equal(after.incoming.some(item => item.id === incoming.id), false);
  assert.equal(observed.filter(item => item.id === incoming.id).length, 1);
  assert.ok(observed.every(item => !Object.keys(item.headers).some(key => /role|threat|damage|approach/.test(key))));
  const log = (await readFile(resolve(f.app.logDir, after.logFile), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.find(item => item.id === incoming.id), record);
});

test('pause freezes approach identities and resume preserves them without wall-time catchup', async t => {
  const f = await fixture(t);
  await f.steps(10);
  const paused = await f.api('/api/pause', { sessionId: f.id, paused: true });
  assert.ok(paused.incoming.length > 0);
  f.advance(20000); await f.app.tick();
  const frozen = await f.state();
  assert.equal(frozen.elapsed, paused.elapsed);
  assert.deepEqual(frozen.incoming, paused.incoming);
  assert.equal(frozen.totalRequests, 0);
  await f.api('/api/pause', { sessionId: f.id, paused: false });
  await f.app.tick();
  assert.deepEqual((await f.state()).incoming, paused.incoming);
  await f.steps(20);
  const after = await f.state();
  assert.ok(paused.incoming.every(item => after.events.some(record => record.id === item.id)));
  assert.ok(after.incoming.length <= 15, 'No twenty-second burst on resume.');
});

test('restart clears approaching IDs and direct dispatch still uses immediate real HTTP', async t => {
  const f = await fixture(t);
  await f.steps(10);
  const old = await f.state();
  assert.ok(old.incoming.length > 0);
  const restarted = await f.api('/api/start', { sessionId: f.id });
  assert.deepEqual(restarted.incoming, []);
  assert.equal(restarted.totalRequests, 0);
  const record = await f.app.dispatchRequest(f.id, { route: 'accounts', role: 'legitimate', credential: 'valid' });
  assert.equal(record.status, 200);
  assert.equal(record.missionTime, 0);
  assert.equal(record.approachStartedAt, undefined);
  await f.steps(30);
  const after = await f.state();
  assert.ok(old.incoming.every(item => !after.events.some(event => event.id === item.id) && !after.incoming.some(event => event.id === item.id)));
});

test('incoming persists through a delayed actual response and pause drains only dispatched traffic', async t => {
  const f = await fixture(t);
  await f.steps(20);
  const first = (await f.state()).incoming[0];
  assert.ok(first);
  const received = Promise.withResolvers(); let release;
  const delay = (req, res) => {
    if (req.headers['x-cloudbreak-request-id'] !== first.id) return;
    f.app.server.removeListener('request', delay);
    const end = res.end.bind(res); res.end = (...args) => { release = () => end(...args); received.resolve(); return res; };
  };
  f.app.server.prependListener('request', delay);
  f.advance(400); await f.heartbeat();
  const tick = f.app.tick(); await received.promise;
  const inFlight = await f.state();
  assert.ok(inFlight.incoming.some(item => item.id === first.id));
  assert.ok(!inFlight.events.some(item => item.id === first.id));
  release(); await tick;
  const paused = await f.api('/api/pause', { sessionId: f.id, paused: true });
  assert.ok(paused.events.some(item => item.id === first.id));
  assert.ok(!paused.incoming.some(item => item.id === first.id));
  assert.ok(paused.incoming.length > 0, 'Pause retains not-yet-dispatched approaches.');
});

test('the mission ends at 180 seconds and discards approaches that never reached HTTP', async t => {
  const f = await fixture(t);
  const served = await f.app.dispatchRequest(f.id, { route: 'accounts', role: 'legitimate', credential: 'valid' });
  assert.equal(served.status, 200);
  await f.jump(178); await f.steps(10);
  const approaching = await f.state();
  assert.ok(approaching.incoming.length > 0);
  assert.equal(approaching.totalRequests, 1);
  await f.steps(10);
  const final = await f.state();
  assert.equal(final.elapsed, 180);
  assert.equal(final.phase, 'won');
  assert.deepEqual(final.incoming, []);
  assert.equal(final.totalRequests, 1);
  assert.equal(final.integrity, 100);
  assert.equal((await readFile(resolve(f.app.logDir, final.logFile), 'utf8')).trim().split('\n').length, 1);
});

test('transport interruption creates no invented request record and preserves other queued approaches', async t => {
  const f = await fixture(t);
  await f.steps(20);
  const before = await f.state(), first = before.incoming[0];
  assert.ok(first);
  f.app.server.prependListener('request', req => { if (req.headers['x-cloudbreak-request-id'] === first.id) req.socket.destroy(); });
  f.advance(400); await f.heartbeat(); await f.app.tick();
  const after = await f.state();
  assert.equal(after.phase, 'paused');
  assert.ok(!after.events.some(item => item.id === first.id));
  assert.ok(!after.incoming.some(item => item.id === first.id));
  assert.ok(after.incoming.length > 0);
  assert.equal(after.integrity, 100);
});

test('backpressure bounds approaching plus in-flight identities and actual HTTP concurrency', async t => {
  const f = await fixture(t), releases = [], pendingTicks = [], httpTimes = [];
  let active = 0, peak = 0, largestIncoming = 0;
  f.app.server.prependListener('request', (req, res) => {
    if (!req.url.startsWith('/gateway/')) return;
    httpTimes.push(f.now()); active++; peak = Math.max(peak, active);
    res.once('finish', () => active--);
    const end = res.end.bind(res);
    res.end = (...args) => { releases.push(() => end(...args)); return res; };
  });
  try {
    for (let step = 0; step < 180; step++) {
      f.advance(100); await f.heartbeat();
      pendingTicks.push(f.app.tick());
      const state = await f.state();
      largestIncoming = Math.max(largestIncoming, state.incoming.length);
      assert.ok(state.incoming.length <= 64);
      assert.equal(new Set(state.incoming.map(item => item.id)).size, state.incoming.length);
    }
    assert.equal(peak, 8);
    assert.equal(largestIncoming, 64, 'The test must actually reach the queue boundary.');
    assert.equal(httpTimes.length, 8, 'No additional fetch can bypass occupied in-flight slots.');
  } finally { for (const release of releases) release(); await Promise.all(pendingTicks); }
  const after = await f.state();
  assert.equal(after.totalRequests, 8);
  assert.ok(after.incoming.length <= 56);
});

test('scheduled approaches and actual requests each respect the rolling global emission cap', async t => {
  const f = await fixture(t), observed = [], scheduled = new Map();
  f.app.server.prependListener('request', req => { if (req.url.startsWith('/gateway/')) observed.push(f.now()); });
  await f.jump(144);
  for (let step = 0; step < 70; step++) {
    f.advance(100); await f.heartbeat(); await f.app.tick();
    const state = await f.state();
    for (const item of state.incoming) scheduled.set(item.id, item.approachStartedAt * 1000);
    // Direct authored requests share the actual dispatch cap with due arrivals.
    await Promise.all(Array.from({ length: 24 }, () => f.app.dispatchRequest(f.id, { route: 'accounts', role: 'legitimate', credential: 'valid' })));
  }
  const emitted = [...scheduled.values()].sort((a, b) => a - b);
  assert.ok(emitted.length > 24 && observed.length > 24);
  for (const times of [emitted, observed]) for (const at of times) assert.ok(times.filter(time => time > at - 1000 + 1e-6 && time <= at).length <= 24);
  const types = new Set((await f.state()).incoming.filter(item => item.role === 'hostile').map(item => item.threatType));
  assert.deepEqual([...types].sort(), ['bad-login', 'breach', 'swarm']);
});

test('restart aborts a dispatched approach instead of waiting for or replaying its old response', async t => {
  const f = await fixture(t);
  await f.steps(20);
  const old = await f.state(), first = old.incoming[0];
  const received = Promise.withResolvers(); let release;
  f.app.server.prependListener('request', (req, res) => {
    if (req.headers['x-cloudbreak-request-id'] !== first.id) return;
    const end = res.end.bind(res); res.end = (...args) => { release = () => end(...args); received.resolve(); return res; };
  });
  f.advance(400); await f.heartbeat(); const tick = f.app.tick(); await received.promise;
  try {
    const started = performance.now();
    const reset = await f.api('/api/start', { sessionId: f.id });
    assert.ok(performance.now() - started < 1000, 'Restart should cancel an old fetch rather than wait for its two-second transport timeout.');
    assert.deepEqual(reset.incoming, []);
    assert.equal(reset.totalRequests, 0);
    release(); await tick;
    assert.deepEqual((await f.state()).events, []);
    assert.equal(await readFile(resolve(f.app.logDir, reset.logFile), 'utf8'), '');
  } finally { release(); await tick; }
});

test('shutdown cancels queued approaches without waiting for their mission deadlines', async t => {
  const f = await fixture(t);
  await f.steps(10);
  assert.ok((await f.state()).incoming.length > 0);
  const started = performance.now(); await f.close();
  assert.ok(performance.now() - started < 1000);
});
