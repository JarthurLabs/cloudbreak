import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCloudbreakServer } from '../server/app.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const EMPTY = { auth: false, rate: 0, isolated: false };

async function fixture(t, options = {}) {
  let time = 10_000;
  await mkdir(resolve(ROOT, 'logs'), { recursive: true });
  const logDir = await mkdtemp(resolve(ROOT, 'logs', 'test-'));
  const app = createCloudbreakServer({ port: 5318, autoTick: false, clock: () => time, logDir, ...options });
  await app.listen();
  t.after(async () => { await app.close(); await rm(logDir, { recursive: true, force: true }); });
  const api = async (path, body) => {
    const response = await fetch(`${app.url}${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const { data: session } = await api('/api/session', {});
  const id = session.sessionId;
  await api('/api/start', { sessionId: id });
  return { app, api, id, advance: (ms) => { time += ms; }, request: (route, role = 'legitimate', credential = 'valid') => app.dispatchRequest(id, { route, role, credential, ...(role === 'hostile' ? { threatType: { storefront: 'bad-login', accounts: 'swarm', dispatch: 'breach' }[route] } : {}) }), state: async () => (await api(`/api/state?sessionId=${id}`)).data };
}

test('authentication rejects missing and invalid credentials, but admits a valid attacker', async t => {
  const f = await fixture(t);
  await f.api('/api/policy', { sessionId: f.id, route: 'storefront', policy: { ...EMPTY, auth: true } });
  assert.equal((await f.request('storefront', 'legitimate', 'missing')).status, 401);
  assert.equal((await f.request('storefront', 'hostile', 'invalid')).reason, 'invalid_credentials');
  assert.equal((await f.request('storefront', 'hostile', 'valid')).status, 200);
  const state = await f.state();
  assert.equal(state.integrity, 99.7);
  assert.equal(state.legitimateTotal, 1);
  assert.equal(state.legitimateServed, 0);
  assert.equal(state.hostileBlocked, 1);
  assert.equal(state.hostileAdmitted, 1);
  assert.equal(state.events.length, 3);
  assert.ok(state.events.every(event => event.id && event.timestamp && event.elapsedMs >= 0));
});

test('route token bucket throttles real legitimate HTTP bursts and refills with time', async t => {
  const f = await fixture(t);
  await f.api('/api/policy', { sessionId: f.id, route: 'accounts', policy: { ...EMPTY, rate: 3 } });
  const burst = [];
  for (let i = 0; i < 4; i++) burst.push((await f.request('accounts')).status);
  assert.deepEqual(burst, [200, 200, 200, 429]);
  assert.equal((await f.request('dispatch')).status, 200);
  f.advance(334);
  assert.equal((await f.request('accounts')).status, 200);
  assert.equal((await f.request('accounts')).reason, 'rate_limited');
  assert.equal((await f.state()).legitimateServed, 5);
});

test('isolation blocks every role and reopening immediately returns service', async t => {
  const f = await fixture(t);
  await f.api('/api/policy', { sessionId: f.id, route: 'dispatch', policy: { ...EMPTY, isolated: true } });
  assert.equal((await f.request('dispatch')).reason, 'route_isolated');
  assert.equal((await f.request('dispatch', 'hostile', 'valid')).status, 503);
  await f.api('/api/policy', { sessionId: f.id, route: 'dispatch', policy: EMPTY });
  assert.equal((await f.request('dispatch')).status, 200);
  assert.equal((await f.state()).credits, 40);
});

test('budget reservations are atomic and rejected purchases leave all policies untouched', async t => {
  const f = await fixture(t);
  await f.api('/api/policy', { sessionId: f.id, route: 'storefront', policy: { ...EMPTY, auth: true, rate: 3 } });
  await f.api('/api/policy', { sessionId: f.id, route: 'accounts', policy: { ...EMPTY, auth: true } });
  const rejected = await f.api('/api/policy', { sessionId: f.id, route: 'dispatch', policy: { ...EMPTY, isolated: true } });
  assert.equal(rejected.status, 409);
  assert.match(rejected.data.error, /credits/i);
  let state = await f.state();
  assert.equal(state.reserved, 40);
  assert.equal(state.credits, 0);
  assert.equal(state.routes[2].policy.isolated, false);
  await f.api('/api/policy', { sessionId: f.id, route: 'storefront', policy: EMPTY });
  state = await f.state();
  assert.equal(state.credits, 25);
  assert.equal((await f.api('/api/policy', { sessionId: f.id, route: 'accounts', policy: { ...EMPTY, rate: 7 } })).status, 400);
});

test('pause freezes mission time and traffic; retry clears measured records and gives unique request IDs', async t => {
  const f = await fixture(t);
  const old = await f.request('accounts');
  f.advance(1_000);
  const paused = await f.api('/api/pause', { sessionId: f.id, paused: true });
  const elapsed = paused.data.elapsed;
  f.advance(8_000);
  await f.app.tick();
  assert.equal((await f.state()).elapsed, elapsed);
  assert.equal(await f.request('accounts'), null);
  assert.equal((await f.state()).totalRequests, 1);
  await f.api('/api/pause', { sessionId: f.id, paused: false });
  f.advance(500);
  assert.equal((await f.state()).elapsed, elapsed + 0.5);
  const restarted = await f.api('/api/start', { sessionId: f.id });
  assert.equal(restarted.data.elapsed, 0);
  assert.equal(restarted.data.totalRequests, 0);
  assert.equal(restarted.data.integrity, 100);
  assert.equal(restarted.data.reserved, 0);
  assert.notEqual((await f.request('accounts')).id, old.id);
});

test('lost heartbeat pauses within two and a half seconds and freezes there until explicit resume', async t => {
  const f = await fixture(t);
  f.advance(2_400);
  await f.app.tick();
  const state = await f.state();
  assert.equal(state.phase, 'paused');
  assert.match(state.pauseReason, /connection/i);
  const count = state.totalRequests;
  f.advance(5_000);
  await f.api('/api/heartbeat', { sessionId: f.id });
  assert.equal((await f.state()).phase, 'paused');
  assert.equal((await f.state()).totalRequests, count);
});

test('economy is time averaged and deadline wins only with required service', async t => {
  const f = await fixture(t);
  await f.request('accounts');
  for (let i = 0; i < 90; i++) { f.advance(1_000); await f.api('/api/heartbeat', { sessionId: f.id }); }
  await f.api('/api/policy', { sessionId: f.id, route: 'storefront', policy: { ...EMPTY, auth: true, rate: 3, isolated: true } });
  await f.api('/api/policy', { sessionId: f.id, route: 'accounts', policy: { ...EMPTY, rate: 3 } });
  for (let i = 0; i < 90; i++) { f.advance(1_000); await f.api('/api/heartbeat', { sessionId: f.id }); }
  const won = await f.state();
  assert.equal(won.elapsed, 180);
  assert.equal(won.phase, 'won');
  assert.equal(won.economyBonus, 500);
  assert.equal(won.score, 1505);
  assert.equal(await f.request('accounts'), null);
  await f.api('/api/start', { sessionId: f.id });
  await f.api('/api/policy', { sessionId: f.id, route: 'storefront', policy: { ...EMPTY, isolated: true } });
  await f.request('storefront');
  for (let i = 0; i < 180; i++) { f.advance(1_000); await f.api('/api/heartbeat', { sessionId: f.id }); }
  assert.equal((await f.state()).phase, 'lost');
});

test('missing sessions fail, active sessions are bounded, and retry replaces the prior generator', async t => {
  const f = await fixture(t, { maxSessions: 2 });
  assert.equal((await f.api('/api/policy', { route: 'dispatch', policy: EMPTY })).status, 404);
  assert.equal((await f.api('/api/state?sessionId=unknown')).status, 404);
  const newer = (await f.api('/api/session', {})).data;
  await f.api('/api/start', { sessionId: newer.sessionId });
  assert.equal((await f.state()).phase, 'paused');
  assert.equal((await f.api('/api/session', {})).status, 429);
});

test('downloadable NDJSON contains the measured records and game-prefixed file identity', async t => {
  const f = await fixture(t);
  const record = await f.request('storefront', 'legitimate', 'missing');
  const response = await fetch(`${f.app.url}/api/log?sessionId=${f.id}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /cloudbreak-/);
  const downloaded = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(downloaded, [record]);
  const state = await f.state();
  assert.match(state.logFile, /^cloudbreak-/);
  assert.equal(JSON.parse((await readFile(resolve(f.app.logDir, state.logFile), 'utf8')).trim()).id, record.id);
});

test('polling and heartbeats do not steal generator time, and every animation event has a measured HTTP result', async t => {
  const f = await fixture(t);
  // Ten seconds of measured traffic, after the two-second visible approach.
  for (let step = 0; step < 120; step++) {
    f.advance(100);
    await f.api('/api/heartbeat', { sessionId: f.id });
    await f.state();
    await f.app.tick();
  }
  const state = await f.state();
  assert.ok(state.totalRequests >= 57, `Expected approximately 60 authored customers; got ${state.totalRequests}`);
  assert.equal(state.legitimateTotal, state.totalRequests);
  assert.equal(state.legitimateServed, state.totalRequests);
  assert.ok(state.events.every(event => event.status === 200 && event.reason === 'accepted'));
});

async function runMission(f, defend, reactionSeconds = 0) {
  let lastWave = -1;
  let pendingWave;
  let respondAt = 0;
  let correction;
  const deferredReopen = new Set();
  for (let step = 0; step < 1_805; step++) {
    f.advance(100);
    if (step % 10 === 0) await f.api('/api/heartbeat', { sessionId: f.id });
    const before = await f.state();
    if (before.wave.index !== lastWave) {
      lastWave = before.wave.index;
      pendingWave = before.wave;
      respondAt = before.elapsed + reactionSeconds;
    }
    if (defend && pendingWave && before.elapsed >= respondAt) {
      assert.ok(Array.isArray(pendingWave.threats), 'The public wave must expose every simultaneous threat.');
      for (const route of ['storefront', 'accounts', 'dispatch']) {
        const threat = pendingWave.threats.find(item => item.route === route);
        if (!threat && before.incoming?.some(item => item.route === route && item.role === 'hostile')) {
          deferredReopen.add(route);
          continue;
        }
        deferredReopen.delete(route);
        let policy = EMPTY;
        if (threat?.threatType === 'bad-login') policy = { ...EMPTY, auth: true };
        if (threat?.threatType === 'swarm') policy = { ...EMPTY, rate: 1 };
        if (threat?.threatType === 'breach') policy = defend === 'wrong-breach-defense' ? { ...EMPTY, rate: 1 } : { ...EMPTY, isolated: true };
        if (defend === 'brief-carrier-mistake' && pendingWave.index === 5 && route === 'dispatch') {
          policy = { ...EMPTY, auth: true };
          correction = { at: before.elapsed + 4, route };
        }
        const response = await f.api('/api/policy', { sessionId: f.id, route, policy });
        assert.equal(response.status, 200, `Defense changes must fit the shared budget: ${JSON.stringify(response.data)}`);
      }
      pendingWave = undefined;
    }
    if (correction && before.elapsed >= correction.at) {
      const response = await f.api('/api/policy', { sessionId: f.id, route: correction.route, policy: { ...EMPTY, isolated: true } });
      assert.equal(response.status, 200);
      correction = undefined;
    }
    for (const route of deferredReopen) {
      if (before.wave.threats.some(item => item.route === route)) { deferredReopen.delete(route); continue; }
      if (before.incoming?.some(item => item.route === route && item.role === 'hostile')) continue;
      const response = await f.api('/api/policy', { sessionId: f.id, route, policy: EMPTY });
      assert.equal(response.status, 200);
      deferredReopen.delete(route);
    }
    await f.app.tick();
    const after = await f.state();
    if (['won', 'lost'].includes(after.phase)) return after;
  }
  throw new Error('The mission failed to finish at 180 seconds.');
}

test('the overlapping real-HTTP mission wins healthily with one-second reactions while undefended play loses', async t => {
  const f = await fixture(t);
  const defended = await runMission(f, true, 1);
  assert.equal(defended.phase, 'won', JSON.stringify({ integrity: defended.integrity, service: defended.service }));
  assert.equal(defended.elapsed, 180);
  assert.ok(defended.integrity >= 65, `Good defense should preserve useful integrity: ${defended.integrity}`);
  assert.ok(defended.service >= 80, `One-second defense should preserve useful service: ${defended.service}`);
  assert.ok(defended.totalRequests > 1_500, `The mission must generate its authored workload: ${defended.totalRequests}`);
  assert.equal(defended.events.length, 120);
  const log = (await readFile(resolve(f.app.logDir, defended.logFile), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.length, defended.totalRequests);
  assert.equal(new Set(log.map(record => record.id)).size, log.length);
  assert.deepEqual([...new Set(log.filter(record => record.role === 'hostile').map(record => record.threatType))].sort(), ['bad-login', 'breach', 'swarm']);
  for (const threatType of ['bad-login', 'swarm', 'breach']) {
    assert.deepEqual([...new Set(log.filter(record => record.threatType === threatType).map(record => record.route))].sort(), ['accounts', 'dispatch', 'storefront']);
  }
  for (const [start, end, expected] of [
    [70, 90, ['accounts:bad-login', 'dispatch:swarm']],
    [96, 114, ['dispatch:bad-login', 'storefront:breach']],
    [120, 138, ['accounts:breach', 'storefront:swarm']],
    [144, 169, ['accounts:swarm', 'dispatch:bad-login', 'storefront:breach']],
  ]) {
    const actual = [...new Set(log.filter(record => record.role === 'hostile' && record.approachStartedAt >= start && record.approachStartedAt < end).map(record => `${record.route}:${record.threatType}`))].sort();
    assert.deepEqual(actual, expected, `Every overlapping stream must produce real records in ${start}–${end}.`);
  }
  const finalCarriers = log.filter(record => record.threatType === 'breach' && record.approachStartedAt >= 144 && record.approachStartedAt < 169);
  assert.ok(finalCarriers.length >= 16, `The low-frequency carrier stream must not starve: ${finalCarriers.length}`);
  assert.equal(Number((100 - log.reduce((sum, record) => sum + record.damage, 0)).toFixed(1)), defended.integrity);
  assert.ok(log.filter(record => record.role === 'legitimate' || record.status !== 200).every(record => record.damage === 0));
  for (let second = 0; second < 180; second++) assert.ok(log.filter(record => record.missionTime >= second && record.missionTime < second + 1).length <= 24);
  await f.api('/api/start', { sessionId: f.id });
  const undefended = await runMission(f, false);
  assert.equal(undefended.phase, 'lost');
  assert.equal(undefended.integrity, 0);
  assert.ok(undefended.elapsed < 120, 'Doing nothing must still lose well before the three-minute deadline.');
  t.diagnostic(JSON.stringify({ defended: { integrity: defended.integrity, service: defended.service, requests: defended.totalRequests, score: defended.score }, undefendedLossAt: undefended.elapsed }));
});

test('pausing cannot refill an exhausted rate bucket using paused wall time', async t => {
  const f = await fixture(t);
  await f.api('/api/policy', { sessionId: f.id, route: 'accounts', policy: { ...EMPTY, rate: 3 } });
  for (let i = 0; i < 3; i++) assert.equal((await f.request('accounts')).status, 200);
  await f.api('/api/pause', { sessionId: f.id, paused: true });
  f.advance(10_000);
  await f.api('/api/pause', { sessionId: f.id, paused: false });
  assert.equal((await f.request('accounts')).status, 429);
  f.advance(334);
  assert.equal((await f.request('accounts')).status, 200);
});

test('generator cap is shared across sessions and blocks more than 24 emissions in one second', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 24; i++) assert.equal((await f.request('storefront')).status, 200);
  assert.equal(await f.request('storefront'), null);
  const second = (await f.api('/api/session', {})).data;
  await f.api('/api/start', { sessionId: second.sessionId });
  assert.equal(await f.app.dispatchRequest(second.sessionId, { route: 'storefront', role: 'legitimate', credential: 'missing' }), null);
  f.advance(1_001);
  assert.equal((await f.app.dispatchRequest(second.sessionId, { route: 'storefront', role: 'legitimate', credential: 'missing' })).status, 200);
});

test('changing rate presets or toggling off cannot mint fresh burst tokens', async t => {
  const f = await fixture(t);
  const setRate = rate => f.api('/api/policy', { sessionId: f.id, route: 'accounts', policy: { ...EMPTY, rate } });
  await setRate(3);
  for (let i = 0; i < 3; i++) assert.equal((await f.request('accounts')).status, 200);
  await setRate(6);
  assert.equal((await f.request('accounts')).status, 429);
  await setRate(3);
  assert.equal((await f.request('accounts')).status, 429);
  await setRate(0);
  await setRate(3);
  assert.equal((await f.request('accounts')).status, 429);
  f.advance(334);
  assert.equal((await f.request('accounts')).status, 200);
});

test('new sessions may evict an unused ready session while preserving a running mission', async t => {
  const f = await fixture(t, { maxSessions: 2 });
  const unused = (await f.api('/api/session', {})).data;
  const fresh = await f.api('/api/session', {});
  assert.equal(fresh.status, 201);
  assert.equal((await f.state()).phase, 'running');
  assert.equal((await f.api(`/api/state?sessionId=${unused.sessionId}`)).status, 404);
});

function delayOneGatewayResponse(app, delay = 40) {
  const received = Promise.withResolvers();
  const listener = (req, res) => {
    if (!req.url.startsWith('/gateway/')) return;
    app.server.removeListener('request', listener);
    const end = res.end.bind(res);
    res.end = (...args) => { setTimeout(() => end(...args), delay); return res; };
    received.resolve();
  };
  app.server.prependListener('request', listener);
  return received.promise;
}

test('pause drains already decided HTTP responses into the log before returning stable counts', async t => {
  const f = await fixture(t);
  const received = delayOneGatewayResponse(f.app);
  const pendingRecord = f.request('accounts', 'hostile', 'valid');
  await received;
  const paused = await f.api('/api/pause', { sessionId: f.id, paused: true });
  const record = await pendingRecord;
  assert.equal(record?.status, 200);
  assert.equal(paused.data.phase, 'paused');
  assert.equal(paused.data.totalRequests, 1);
  assert.equal(paused.data.integrity, 99.9);
  assert.ok(record.elapsedMs >= 35);
  f.advance(5_000);
  assert.equal((await f.state()).totalRequests, 1);
  const log = (await readFile(resolve(f.app.logDir, paused.data.logFile), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, record.id);
});

test('deadline settles already decided responses before service and victory are finalized', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 179; i++) { f.advance(1_000); await f.api('/api/heartbeat', { sessionId: f.id }); }
  f.advance(900);
  const received = delayOneGatewayResponse(f.app);
  const pendingRecord = f.request('accounts');
  await received;
  f.advance(100);
  const final = await f.state();
  assert.equal((await pendingRecord)?.status, 200);
  assert.equal(final.elapsed, 180);
  assert.equal(final.legitimateServed, 1);
  assert.equal(final.phase, 'won');
  assert.equal(await f.request('accounts'), null);
});

test('eight abandoned paused missions can be reclaimed after thirty seconds without heartbeats', async t => {
  const f = await fixture(t);
  const abandoned = [f.id];
  for (let i = 1; i < 8; i++) {
    const created = await f.api('/api/session', {});
    assert.equal(created.status, 201);
    abandoned.push(created.data.sessionId);
    await f.api('/api/start', { sessionId: created.data.sessionId });
  }
  assert.equal((await f.api('/api/session', {})).status, 429);
  f.advance(30_001);
  await f.app.tick();
  for (const oldestId of abandoned) {
    const created = await f.api('/api/session', {});
    assert.equal(created.status, 201, 'Disconnected missions must not permanently exhaust the server.');
    assert.equal((await f.api(`/api/state?sessionId=${oldestId}`)).status, 404);
    await f.api('/api/start', { sessionId: created.data.sessionId });
  }
  assert.equal((await f.api('/api/session', {})).status, 429);
});

test('fresh heartbeats protect paused missions while only stale paused sessions are reclaimed', async t => {
  const f = await fixture(t, { maxSessions: 2 });
  await f.api('/api/pause', { sessionId: f.id, paused: true });
  const abandoned = (await f.api('/api/session', {})).data;
  await f.api('/api/start', { sessionId: abandoned.sessionId });
  await f.api('/api/pause', { sessionId: abandoned.sessionId, paused: true });
  f.advance(29_999);
  assert.equal((await f.api('/api/session', {})).status, 429);
  f.advance(2);
  await f.api('/api/heartbeat', { sessionId: f.id });
  assert.equal((await f.api('/api/session', {})).status, 201);
  assert.equal((await f.state()).phase, 'paused');
  assert.equal((await f.api(`/api/state?sessionId=${abandoned.sessionId}`)).status, 404);
});

test('paused practice start emits no traffic or mission time while real policies reserve credits', async t => {
  const f = await fixture(t);
  await f.request('accounts', 'hostile', 'valid');
  const practice = await f.api('/api/start', { sessionId: f.id, paused: true });
  assert.equal(practice.status, 200);
  assert.equal(practice.data.phase, 'paused');
  assert.equal(practice.data.pauseReason, 'Practice controls. The mission has not started.');
  assert.equal(practice.data.elapsed, 0);
  assert.equal(practice.data.totalRequests, 0);
  assert.equal(practice.data.integrity, 100);
  for (let i = 0; i < 10; i++) { f.advance(1_000); await f.app.tick(); }
  assert.equal((await f.state()).elapsed, 0);
  assert.equal((await f.state()).totalRequests, 0);
  assert.equal(await f.request('accounts'), null);
  const storefront = await f.api('/api/policy', { sessionId: f.id, route: 'storefront', policy: { ...EMPTY, auth: true, rate: 3 } });
  assert.equal(storefront.data.phase, 'paused');
  assert.equal(storefront.data.reserved, 25);
  assert.equal(storefront.data.credits, 15);
  await f.api('/api/policy', { sessionId: f.id, route: 'accounts', policy: { ...EMPTY, auth: true } });
  assert.equal((await f.api('/api/policy', { sessionId: f.id, route: 'dispatch', policy: { ...EMPTY, isolated: true } })).status, 409);
  const refunded = await f.api('/api/policy', { sessionId: f.id, route: 'storefront', policy: EMPTY });
  assert.equal(refunded.data.credits, 25);
  assert.equal(refunded.data.elapsed, 0);
  assert.equal(refunded.data.totalRequests, 0);
  assert.equal(await readFile(resolve(f.app.logDir, refunded.data.logFile), 'utf8'), '');
});

test('normal start after practice resets policies and budget and begins a fresh running mission', async t => {
  const f = await fixture(t);
  for (const startOptions of [{}, { paused: false }]) {
    await f.api('/api/start', { sessionId: f.id, paused: true });
    await f.api('/api/policy', { sessionId: f.id, route: 'storefront', policy: { auth: true, rate: 3, isolated: true } });
    const started = await f.api('/api/start', { sessionId: f.id, ...startOptions });
    assert.equal(started.status, 200);
    assert.equal(started.data.phase, 'running');
    assert.equal(started.data.pauseReason, undefined);
    assert.equal(started.data.elapsed, 0);
    assert.equal(started.data.totalRequests, 0);
    assert.equal(started.data.integrity, 100);
    assert.equal(started.data.reserved, 0);
    assert.equal(started.data.credits, 40);
    assert.deepEqual(started.data.routes.map(route => route.policy), [EMPTY, EMPTY, EMPTY]);
    assert.deepEqual(started.data.events, []);
    for (let i = 0; i < 5; i++) { f.advance(100); await f.app.tick(); }
    assert.equal((await f.state()).elapsed, 0.5);
    assert.equal((await f.state()).totalRequests, 0);
    assert.ok((await f.state()).incoming.length > 0, 'The fresh mission should first show approaching requests.');
    for (let i = 0; i < 20; i++) {
      f.advance(100);
      await f.api('/api/heartbeat', { sessionId: f.id });
      await f.app.tick();
    }
    assert.ok((await f.state()).totalRequests > 0);
    assert.equal((await f.request('storefront', 'legitimate', 'missing')).status, 200);
  }
});

test('invalid paused start fields are rejected without resetting an existing mission', async t => {
  const f = await fixture(t);
  await f.request('accounts', 'hostile', 'valid');
  await f.api('/api/policy', { sessionId: f.id, route: 'storefront', policy: { ...EMPTY, auth: true } });
  const before = await f.state();
  for (const paused of ['true', 1, null, {}, []]) {
    const invalid = await f.api('/api/start', { sessionId: f.id, paused });
    assert.equal(invalid.status, 400);
    assert.match(invalid.data.error, /paused.*boolean/i);
    const after = await f.state();
    assert.equal(after.phase, before.phase);
    assert.equal(after.logFile, before.logFile);
    assert.equal(after.integrity, before.integrity);
    assert.equal(after.totalRequests, before.totalRequests);
    assert.equal(after.reserved, before.reserved);
    assert.deepEqual(after.routes, before.routes);
    assert.deepEqual(after.events, before.events);
  }
});

test('mixed hostile damage is summed from measured record types and caller damage is ignored', async t => {
  const f = await fixture(t);
  const badLogin = await f.app.dispatchRequest(f.id, { route: 'storefront', role: 'hostile', credential: 'invalid', threatType: 'bad-login', damage: 99 });
  const swarm = await f.request('accounts', 'hostile', 'valid');
  const breach = await f.request('dispatch', 'hostile', 'valid');
  assert.deepEqual([badLogin.damage, swarm.damage, breach.damage], [0.3, 0.1, 2]);
  assert.deepEqual([badLogin.threatType, swarm.threatType, breach.threatType], ['bad-login', 'swarm', 'breach']);
  const customer = await f.request('accounts');
  assert.equal(customer.threatType, null);
  assert.equal(customer.damage, 0);
  const state = await f.state();
  assert.equal(state.hostileAdmitted, 3);
  assert.equal(state.integrity, 97.6);
  const log = (await readFile(resolve(f.app.logDir, state.logFile), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(log, [badLogin, swarm, breach, customer]);
});

test('low-rate authored breach passes key checks and three-per-second flow limits but closing the bridge blocks its heavy damage', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 52; i++) { f.advance(1_000); await f.api('/api/heartbeat', { sessionId: f.id }); }
  const arrival = await f.state();
  assert.equal(arrival.wave.threatType, 'breach');
  assert.equal(arrival.wave.target, 'dispatch');
  await f.api('/api/policy', { sessionId: f.id, route: 'dispatch', policy: { ...EMPTY, auth: true, rate: 3 } });
  const observedHeaders = [];
  f.app.server.prependListener('request', req => {
    if (req.url.startsWith('/gateway/')) observedHeaders.push(Object.keys(req.headers).filter(key => /threat|role|damage/.test(key)));
  });
  for (let step = 0; step < 120; step++) {
    f.advance(100);
    if (step % 10 === 0) await f.api('/api/heartbeat', { sessionId: f.id });
    await f.app.tick();
  }
  const admitted = await f.state();
  const breaches = admitted.events.filter(record => record.threatType === 'breach');
  const dispatchCustomers = admitted.events.filter(record => record.route === 'dispatch' && record.role === 'legitimate');
  assert.ok(breaches.length >= 9 && breaches.length <= 10, `Expected one breach per second; got ${breaches.length}`);
  assert.ok(dispatchCustomers.length >= 9 && dispatchCustomers.length <= 10);
  assert.ok(breaches.every(record => record.credential === 'valid' && record.status === 200 && record.damage === 2));
  assert.ok(dispatchCustomers.every(record => record.status === 200 && record.damage === 0 && record.threatType === null));
  assert.equal(admitted.integrity, 100 - breaches.length * 2);
  assert.ok(observedHeaders.length > 0);
  assert.ok(observedHeaders.every(headers => headers.length === 0), 'Ground-truth threat type and damage must never be sent to gateway policy.');
  await f.api('/api/policy', { sessionId: f.id, route: 'dispatch', policy: { ...EMPTY, isolated: true } });
  const closed = await f.request('dispatch', 'hostile', 'valid');
  assert.equal(closed.status, 503);
  assert.equal(closed.reason, 'route_isolated');
  assert.equal(closed.threatType, 'breach');
  assert.equal(closed.damage, 0);
  assert.equal((await f.state()).integrity, admitted.integrity);
});

test('using Slow flow against carriers admits heavy damage despite matching every other threat', async t => {
  const f = await fixture(t);
  const wrongStrategy = await runMission(f, 'wrong-breach-defense');
  assert.ok(wrongStrategy.integrity < 60, `Wrong carrier defense should remain costly: ${wrongStrategy.integrity}`);
  t.diagnostic(JSON.stringify({ strategy: 'rate-limit every carrier wave, otherwise instant correct defenses', phase: wrongStrategy.phase, integrity: wrongStrategy.integrity, service: wrongStrategy.service, elapsed: wrongStrategy.elapsed }));
  const log = (await readFile(resolve(f.app.logDir, wrongStrategy.logFile), 'utf8')).trim().split('\n').map(JSON.parse);
  const breaches = log.filter(record => record.threatType === 'breach');
  assert.ok(breaches.reduce((sum, record) => sum + record.damage, 0) >= 40, 'Admitted carriers must still cause substantial measured damage.');
  assert.ok(breaches.some(record => record.status === 200 && record.damage === 2));
  assert.ok(breaches.filter(record => record.status !== 200).every(record => record.damage === 0));
});

test('one-per-second Slow flow blocks at least 85 percent of a swarm and cuts its measured damage', async t => {
  const f = await fixture(t);
  async function swarmBurst() {
    const records = [];
    for (let index = 0; index < 80; index++) {
      f.advance(125);
      if (index % 8 === 0) await f.api('/api/heartbeat', { sessionId: f.id });
      records.push(await f.request('accounts', 'hostile', 'valid'));
    }
    return records;
  }
  const open = await swarmBurst();
  assert.equal(open.length, 80);
  assert.ok(open.every(record => record.status === 200 && record.damage === 0.1));
  const openDamage = open.reduce((total, record) => total + record.damage, 0);
  await f.api('/api/start', { sessionId: f.id });
  const limitedPolicy = await f.api('/api/policy', { sessionId: f.id, route: 'accounts', policy: { ...EMPTY, rate: 1 } });
  assert.equal(limitedPolicy.status, 200);
  assert.equal(limitedPolicy.data.credits, 30);
  const limited = await swarmBurst();
  const blocked = limited.filter(record => record.status === 429).length;
  const limitedDamage = limited.reduce((total, record) => total + record.damage, 0);
  assert.ok(blocked / limited.length >= 0.85, `Slow flow blocked only ${blocked}/${limited.length}.`);
  assert.ok(limitedDamage <= openDamage * 0.15, `Damage did not fall enough: ${limitedDamage} versus ${openDamage}.`);
  const customer = await f.request('accounts');
  assert.equal(customer.status, 429, 'The real limiter can reject legitimate bursts too.');
  t.diagnostic(JSON.stringify({ blocked, total: limited.length, openDamage, limitedDamage }));
});

test('public wave threats expose overlapping districts without changing the forty-credit budget', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.state()).wave.threats, []);
  for (let index = 0; index < 145; index++) { f.advance(1_000); await f.api('/api/heartbeat', { sessionId: f.id }); }
  const state = await f.state();
  assert.deepEqual(state.wave.threats, [
    { route: 'dispatch', threatType: 'bad-login' },
    { route: 'accounts', threatType: 'swarm' },
    { route: 'storefront', threatType: 'breach' },
  ]);
  assert.equal(state.wave.target, 'dispatch');
  assert.equal(state.wave.threatType, 'bad-login');
  assert.equal(state.duration, 180);
  assert.equal(state.credits, 40);
  for (const [route, policy] of [
    ['dispatch', { ...EMPTY, auth: true }],
    ['accounts', { ...EMPTY, rate: 1 }],
    ['storefront', { ...EMPTY, isolated: true }],
  ]) assert.equal((await f.api('/api/policy', { sessionId: f.id, route, policy })).status, 200);
  assert.equal((await f.state()).credits, 10);
});

test('overlapping streams freeze during pause and never catch up missed active time', async t => {
  const f = await fixture(t);
  for (let second = 0; second < 145; second++) {
    f.advance(1_000);
    await f.api('/api/heartbeat', { sessionId: f.id });
  }
  await f.app.tick();
  const first = await f.state();
  assert.equal(first.wave.threats.length, 3);
  assert.equal(first.totalRequests, 0, 'Approaching requests must not appear as measured outcomes before dispatch.');
  assert.ok(first.incoming.length > 0 && first.incoming.length <= 3, `A late tick must not schedule the previous 145 seconds: ${first.incoming.length}`);
  const paused = (await f.api('/api/pause', { sessionId: f.id, paused: true })).data;
  f.advance(10_000);
  await f.app.tick();
  assert.equal((await f.state()).totalRequests, paused.totalRequests);
  assert.equal((await f.state()).elapsed, paused.elapsed);
  assert.deepEqual((await f.state()).incoming, paused.incoming, 'Pending approach IDs and times must freeze with the mission.');
  await f.api('/api/pause', { sessionId: f.id, paused: false });
  await f.app.tick();
  assert.equal((await f.state()).totalRequests, paused.totalRequests);
  // Four active seconds include two seconds of approach and two of real responses.
  for (let step = 0; step < 40; step++) {
    f.advance(100);
    await f.api('/api/heartbeat', { sessionId: f.id });
    await f.app.tick();
  }
  const resumed = await f.state();
  assert.ok(resumed.totalRequests - paused.totalRequests <= 30, 'Resuming must emit only new active-time demand.');
  assert.deepEqual([...new Set(resumed.events.filter(record => record.role === 'hostile').map(record => record.threatType))].sort(), ['bad-login', 'breach', 'swarm']);
});

test('parallel real HTTP dispatch never exceeds eight in-flight requests', async t => {
  const f = await fixture(t);
  let active = 0;
  let peak = 0;
  f.app.server.prependListener('request', (req, res) => {
    if (!req.url.startsWith('/gateway/')) return;
    active += 1;
    peak = Math.max(peak, active);
    res.on('finish', () => { active -= 1; });
    const end = res.end.bind(res);
    res.end = (...args) => { setTimeout(() => end(...args), 30); return res; };
  });
  const records = await Promise.all(Array.from({ length: 20 }, () => f.request('accounts')));
  assert.equal(peak, 8);
  assert.equal(records.filter(Boolean).length, 8);
  assert.equal((await f.state()).totalRequests, 8);
  assert.ok(records.filter(Boolean).every(record => record.status === 200 && record.elapsedMs >= 25));
});


test('three-second reactions and one four-second mistaken carrier defense still finish with recovery room', async t => {
  const f = await fixture(t);
  const result = await runMission(f, 'brief-carrier-mistake', 3);
  const log = (await readFile(resolve(f.app.logDir, result.logFile), 'utf8')).trim().split('\n').map(JSON.parse);
  t.diagnostic(JSON.stringify({ strategy: 'three-second reactions and four-second Dispatch key-check mistake', phase: result.phase, elapsed: result.elapsed, integrity: result.integrity, service: result.service, requests: result.totalRequests, damageByType: Object.fromEntries(['bad-login', 'swarm', 'breach'].map(type => [type, Number(log.filter(record => record.threatType === type).reduce((sum, record) => sum + record.damage, 0).toFixed(1))])) }));
  assert.equal(result.phase, 'won', `An ordinary corrected run should survive: ${result.integrity} integrity at ${result.elapsed}s.`);
  assert.equal(result.elapsed, 180);
  assert.ok(result.integrity >= 40, `The corrected run should retain at least 40 integrity: ${result.integrity}`);
  assert.ok(result.integrity <= 90, 'Delayed and mistaken defenses should still have a meaningful cost despite the visible approach.');
  assert.ok(result.service >= 75, `Reopening after three seconds must still meet the customer objective: ${result.service}`);
  const mistake = log.filter(record => record.threatType === 'breach' && record.route === 'dispatch' && record.missionTime >= 55.2 && record.missionTime < 58.9);
  assert.ok(mistake.length >= 3 && mistake.every(record => record.status === 200), 'The mistake must be real admitted carrier traffic, not a scripted integrity change.');
  assert.equal(Number((100 - log.reduce((sum, record) => sum + record.damage, 0)).toFixed(1)), result.integrity);
});


test('closing every bridge for the whole mission protects integrity but loses customer service', async t => {
  const f = await fixture(t);
  for (const route of ['storefront', 'accounts', 'dispatch']) {
    const response = await f.api('/api/policy', { sessionId: f.id, route, policy: { ...EMPTY, isolated: true } });
    assert.equal(response.status, 200);
  }
  const result = await runMission(f, false);
  assert.equal(result.phase, 'lost');
  assert.equal(result.elapsed, 180);
  assert.equal(result.integrity, 100);
  assert.equal(result.service, 0);
  assert.ok(result.legitimateTotal > 1_000, 'The service loss must come from the full measured customer workload.');
  assert.ok(result.events.every(record => record.status === 503 && record.damage === 0));
  t.diagnostic(JSON.stringify({ strategy: 'all routes always isolated', phase: result.phase, integrity: result.integrity, service: result.service, legitimateTotal: result.legitimateTotal }));
});
