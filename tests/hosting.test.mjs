import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCloudbreakServer } from '../server/app.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ORIGIN = 'https://cloudbreak.example';
const PORT = 5314;
const EMPTY = { auth: false, rate: 0, isolated: false };

async function fixture(t, options = {}) {
  let now = 10_000;
  await mkdir(resolve(ROOT, 'logs'), { recursive: true });
  const directory = await mkdtemp(resolve(ROOT, 'logs', 'hosting-test-'));
  const distDir = resolve(directory, 'dist');
  await mkdir(distDir);
  await writeFile(resolve(distDir, 'index.html'), '<!doctype html><title>Cloudbreak</title>');
  await writeFile(resolve(distDir, 'theme.mp3'), 'test audio bytes');
  const app = createCloudbreakServer({ port: PORT, publicOrigin: ORIGIN, autoTick: false, clock: () => now, distDir, logDir: resolve(directory, 'session-logs'), ...options });
  await app.listen();
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolveResponse, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method,
      headers: { host: new URL(ORIGIN).host, ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolveResponse({ status: res.statusCode, headers: res.headers, text, data: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : undefined });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  const client = async () => {
    const page = await request('/');
    const setCookie = page.headers['set-cookie'][0];
    const cookie = setCookie.split(';')[0];
    const api = (path, body, extraHeaders = {}) => request(path, { method: body === undefined ? 'GET' : 'POST', body, headers: { cookie, ...extraHeaders } });
    const created = await api('/api/session', {});
    assert.equal(created.status, 201);
    const id = created.data.sessionId;
    return { id, cookie, setCookie, api, state: async () => (await api(`/api/state?sessionId=${id}`)).data };
  };
  return { app, request, client, directory, distDir, advance: ms => { now += ms; } };
}

test('hosted startup binds publicly, checks the exact origin, and requires a built frontend for health', async t => {
  const f = await fixture(t);
  assert.equal(f.app.server.address().address, '0.0.0.0');
  const health = await f.request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.localOnly, false);
  assert.equal(health.data.frontend, 'ready');
  assert.equal(health.data.maxSessions, 8);
  assert.equal((await f.request('/api/health', { headers: { host: 'attacker.example' } })).status, 403);
  assert.equal((await f.request('/api/health', { headers: { host: `127.0.0.1:${PORT}` } })).status, 200);
  assert.equal((await f.request('/api/session', { method: 'POST', body: {}, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.request('/api/session', { method: 'POST', body: {}, headers: { origin: '' } })).status, 403);
  assert.equal((await f.request('/api/session', { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  await rm(resolve(f.distDir, 'index.html'));
  assert.equal((await f.request('/api/health')).status, 503);
  assert.equal((await f.request('/')).status, 404);
});

test('hosted sessions require their browser cookie for reads, logs and every mutation', async t => {
  const f = await fixture(t);
  const a = await f.client(), b = await f.client();
  assert.match(a.setCookie, /HttpOnly; Secure; SameSite=Strict/);
  assert.notEqual(a.cookie, b.cookie);
  assert.equal((await a.api('/api/start', { sessionId: a.id })).status, 200);
  assert.equal((await b.api(`/api/state?sessionId=${a.id}`)).status, 404);
  assert.equal((await b.api(`/api/log?sessionId=${a.id}`)).status, 404);
  assert.equal((await f.request(`/api/state?sessionId=${a.id}`)).status, 404);
  for (const [path, body] of [
    ['/api/start', { sessionId: a.id }], ['/api/pause', { sessionId: a.id, paused: true }],
    ['/api/policy', { sessionId: a.id, route: 'accounts', policy: { ...EMPTY, isolated: true } }],
    ['/api/heartbeat', { sessionId: a.id }],
  ]) assert.equal((await b.api(path, body)).status, 404);
  assert.equal((await a.state()).phase, 'running');
  assert.ok((await a.state()).routes.every(route => !route.policy.isolated));
});

test('two hosted missions run independently, including policies, pause, restart and full traffic caps', async t => {
  const f = await fixture(t);
  const a = await f.client(), b = await f.client();
  await a.api('/api/start', { sessionId: a.id });
  await b.api('/api/start', { sessionId: b.id });
  assert.equal((await a.state()).phase, 'running');
  await a.api('/api/policy', { sessionId: a.id, route: 'storefront', policy: { ...EMPTY, auth: true } });
  for (let i = 0; i < 24; i++) {
    const [first, second] = await Promise.all([a, b].map(client => f.app.dispatchRequest(client.id, { route: 'storefront', role: 'legitimate', credential: 'missing' })));
    assert.equal(first.status, 401);
    assert.equal(second.status, 200);
    assert.notEqual(first.id, second.id);
  }
  for (const client of [a, b]) assert.equal(await f.app.dispatchRequest(client.id, { route: 'storefront', role: 'legitimate', credential: 'valid' }), null);
  await a.api('/api/pause', { sessionId: a.id, paused: true });
  f.advance(1000);
  assert.equal((await a.state()).elapsed, 0);
  assert.equal((await b.state()).elapsed, 1);
  await a.api('/api/pause', { sessionId: a.id, paused: false });
  assert.equal((await b.state()).phase, 'running');
  await a.api('/api/start', { sessionId: a.id });
  assert.equal((await a.state()).totalRequests, 0);
  assert.equal((await b.state()).totalRequests, 24);
  assert.equal((await b.state()).phase, 'running');
});

test('concurrent hosted schedulers preserve real two-second approaches and the same authored workload', async t => {
  const f = await fixture(t);
  const a = await f.client(), b = await f.client();
  for (const client of [a, b]) await client.api('/api/start', { sessionId: client.id });
  for (let step = 0; step < 120; step++) {
    f.advance(100);
    if (step % 8 === 0) for (const client of [a, b]) await client.api('/api/heartbeat', { sessionId: client.id });
    await f.app.tick();
  }
  const states = await Promise.all([a.state(), b.state()]);
  assert.ok(states[0].totalRequests >= 57);
  assert.equal(states[0].totalRequests, states[1].totalRequests);
  for (const state of states) {
    assert.equal(state.phase, 'running');
    assert.equal(state.legitimateServed, state.totalRequests);
    assert.ok(state.incoming.length > 0);
    assert.ok(state.events.every(event => event.status === 200 && Math.abs(event.decisionAt - event.approachStartedAt - 2) < 1e-8 && event.missionTime >= event.decisionAt));
  }
  const firstIds = new Set(states[0].events.map(event => event.id));
  assert.ok(states[1].events.every(event => !firstIds.has(event.id)));
});

test('public callers cannot inject gateway traffic or arbitrary URLs, files, policy fields or oversized bodies', async t => {
  const f = await fixture(t);
  const client = await f.client();
  await client.api('/api/start', { sessionId: client.id });
  await client.api('/api/policy', { sessionId: client.id, route: 'accounts', policy: { ...EMPTY, rate: 1 } });
  const forged = await f.request('/gateway/accounts', { headers: { cookie: client.cookie, 'x-cloudbreak-session': client.id, 'x-cloudbreak-request-id': 'forged', 'x-cloudbreak-internal': 'forged', authorization: 'Bearer cloudbreak-demo-valid' } });
  assert.equal(forged.status, 404);
  const real = await f.app.dispatchRequest(client.id, { route: 'accounts', role: 'hostile', credential: 'valid', threatType: 'swarm' });
  assert.equal(real.status, 200, 'The rejected external injection must not consume bucket tokens.');
  assert.equal(real.damage, 0.1);
  assert.equal((await client.state()).totalRequests, 1);
  assert.equal((await client.api('/api/dispatch', { sessionId: client.id, url: 'http://attacker.example/' })).status, 404);
  assert.equal((await client.api('/api/policy', { sessionId: client.id, route: 'http://attacker.example/', policy: EMPTY })).status, 400);
  assert.equal((await client.api('/api/policy', { sessionId: client.id, route: 'accounts', policy: { ...EMPTY, target: '/etc/passwd' } })).status, 400);
  assert.equal((await client.api('/api/policy', JSON.stringify({ sessionId: client.id, padding: 'x'.repeat(9000) }))).status, 413);
  assert.equal((await f.request('/api/session', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } })).status, 415);
  await writeFile(resolve(f.directory, 'private.txt'), 'not public');
  await symlink(resolve(f.directory, 'private.txt'), resolve(f.distDir, 'leak.txt'));
  for (const path of ['/leak.txt', '/%2e%2e%2fprivate.txt', '/server/app.mjs', '/%00.txt', '/a%5cb.txt']) assert.equal((await f.request(path)).status, 404);
  const audio = await f.request('/theme.mp3');
  assert.equal(audio.status, 200);
  assert.equal(audio.headers['content-type'], 'audio/mpeg');
  assert.deepEqual((await readdir(f.directory)).sort(), ['dist', 'private.txt'], 'Hosted sessions must not create disk logs.');
  const log = await client.api(`/api/log?sessionId=${client.id}`);
  assert.deepEqual(log.text.trim().split('\n').map(JSON.parse), [real]);
  assert.ok(!JSON.stringify((await client.state())).includes('owner'));
});

test('hosted capacity preserves connected sessions and reclaims abandoned sessions with their logs', async t => {
  const f = await fixture(t, { maxSessions: 2 });
  const a = await f.client(), b = await f.client();
  assert.equal((await a.api('/api/session', {})).status, 429, 'A fresh visitor must not evict a connected title screen.');
  await a.api('/api/start', { sessionId: a.id });
  await f.app.dispatchRequest(a.id, { route: 'storefront', role: 'legitimate', credential: 'valid' });
  for (let i = 0; i < 31; i++) {
    f.advance(1000);
    await a.api('/api/heartbeat', { sessionId: a.id });
  }
  const replacement = await a.api('/api/session', {});
  assert.equal(replacement.status, 201);
  assert.equal((await a.state()).phase, 'running');
  assert.equal((await b.api(`/api/state?sessionId=${b.id}`)).status, 404);
  assert.equal((await b.api(`/api/log?sessionId=${b.id}`)).status, 404);
  await a.api('/api/start', { sessionId: a.id });
  assert.equal((await a.api(`/api/log?sessionId=${a.id}`)).text, '');
});

test('hosted configuration rejects insecure origins, unbounded sessions and invalid ports; local ports stay reserved', () => {
  for (const publicOrigin of ['http://cloudbreak.example', 'https://cloudbreak.example/', 'https://user:pass@cloudbreak.example', 'https://cloudbreak.example/path']) assert.throws(() => createCloudbreakServer({ publicOrigin }));
  for (const port of [0, 80, 65536, NaN]) assert.throws(() => createCloudbreakServer({ publicOrigin: ORIGIN, port }));
  for (const maxSessions of [0, 9, Infinity, 1.5]) assert.throws(() => createCloudbreakServer({ publicOrigin: ORIGIN, maxSessions }));
  assert.throws(() => createCloudbreakServer({ port: 10000 }), /5310/);
});
