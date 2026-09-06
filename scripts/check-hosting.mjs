import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { resolve } from 'node:path';

// Local production check only. Model the reverse proxy's exact public Host and
// Origin headers while preserving actual HTTP, default clocks and server ticks.
// This does not measure Render latency, TLS, cold start or public capacity.
const ROOT = resolve(import.meta.dirname, '..');
const port = 5315;
const origin = 'https://cloudbreak.example';
const child = spawn(process.execPath, ['server/cloud.mjs'], { cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), CLOUDBREAK_PUBLIC_ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const request = (path, { method = 'GET', cookie, body } = {}) => new Promise((resolveResponse, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: new URL(origin).host,
    ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin, 'content-type': 'application/json' } : {}) } }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('error', reject);
    res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end(body === undefined ? undefined : JSON.stringify(body));
});
const api = async (path, cookie, body) => {
  const result = await request(path, { cookie, body, method: body === undefined ? 'GET' : 'POST' });
  assert.ok(result.status < 400, `${path}: ${result.status} ${result.bytes}`);
  return JSON.parse(result.bytes);
};

try {
  let health;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Hosted startup exited: ${output}`);
    try { health = await api('/api/health'); break; }
    catch { await sleep(100); }
  }
  assert.equal(health?.game, 'cloudbreak', output);
  assert.equal(health.localOnly, false);
  assert.equal(health.frontend, 'ready');
  const cookies = [], assetPaths = new Set();
  for (let i = 0; i < 2; i++) {
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(page.bytes.toString(), /<title>Cloudbreak/);
    const header = page.headers['set-cookie']?.[0];
    assert.match(header ?? '', /HttpOnly; Secure; SameSite=Strict/);
    cookies.push(header.split(';')[0]);
    for (const match of page.bytes.toString().matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) assetPaths.add(match[1]);
  }
  assert.notEqual(cookies[0], cookies[1]);
  assert.ok(assetPaths.size >= 2, 'The production HTML must reference built frontend assets.');
  for (const path of assetPaths) {
    const asset = await request(path);
    assert.equal(asset.status, 200, path);
    assert.ok(asset.bytes.length > 0, path);
    assert.equal((await request(path, { method: 'HEAD' })).bytes.length, 0);
  }
  const sessions = [];
  for (const cookie of cookies) {
    const created = await api('/api/session', cookie, {});
    assert.equal(created.phase, 'ready');
    sessions.push(created.sessionId);
    await api('/api/start', cookie, { sessionId: created.sessionId });
  }
  // Keep both real missions connected long enough for authored two-second
  // approaches to reach the fixed internal HTTP gateway.
  for (let i = 0; i < 6; i++) {
    await sleep(600);
    for (let index = 0; index < sessions.length; index++) await api('/api/heartbeat', cookies[index], { sessionId: sessions[index] });
  }
  const measurements = [];
  for (let index = 0; index < sessions.length; index++) {
    const state = await api(`/api/state?sessionId=${sessions[index]}`, cookies[index]);
    assert.equal(state.phase, 'running');
    assert.ok(state.totalRequests >= 3);
    assert.ok(state.events.every(event => event.status === 200 && event.decisionAt - event.approachStartedAt >= 1.999999));
    measurements.push({ elapsed: state.elapsed, measuredRequests: state.totalRequests, incoming: state.incoming.length });
  }
  await api('/api/pause', cookies[0], { sessionId: sessions[0], paused: true });
  assert.equal((await api(`/api/state?sessionId=${sessions[1]}`, cookies[1])).phase, 'running');
  const foreign = await request(`/api/state?sessionId=${sessions[0]}`, { cookie: cookies[1] });
  assert.equal(foreign.status, 404);
  console.log(JSON.stringify({ passed: true, runtime: process.version, port, mode: 'hosted entrypoint over isolated local HTTP', clock: 'default real monotonic clock', health, assets: [...assetPaths], independentMissions: measurements, userGateway5311Touched: false, publicDeploymentVerified: false }));
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  const result = await exited;
  assert.equal(result.code, 0, `Hosted shutdown failed: ${JSON.stringify(result)} ${output}`);
}
