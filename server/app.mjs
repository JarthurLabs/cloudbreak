import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync, createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ROUTES, ROUTE_NAMES, defaultPolicy, policyCost, validatePolicy, gatewayDecision, updateRateLimit, DEMO_CREDENTIAL } from './gateway.mjs';
import { DURATION, THREAT_DAMAGE, SERVICE_TARGET, waveAt, seededRandom } from './waves.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const HEARTBEAT_TIMEOUT = 2_200;
const STALE_PAUSED_SESSION_AGE = 30_000;
const MAX_GENERATED_PER_SECOND = 24;
const MAX_IN_FLIGHT = 8;
const MAX_APPROACHING = 64;
const APPROACH_SECONDS = 2;
const OWNER_COOKIE = '__Host-cloudbreak-owner';
const ownerToken = req => {
  const values = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${OWNER_COOKIE}=`));
  const value = values.length === 1 ? values[0].slice(OWNER_COOKIE.length + 1) : '';
  return /^[0-9a-f-]{36}$/.test(value) ? value : null;
};
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const isLocalOrigin = origin => {
  try { const url = new URL(origin); return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && Number(url.port) >= 5310 && Number(url.port) <= 5319; }
  catch { return false; }
};

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Use application/json.');
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 8_192) throw fail(413, 'Request body is too large.');
  }
  try {
    const body = JSON.parse(data || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw fail(400, 'Invalid JSON object.'); }
}

export function createCloudbreakServer({ port = 5311, clock = () => performance.now(), autoTick = true, logDir = resolve(ROOT, 'logs'), maxSessions = 8, distDir = resolve(ROOT, 'dist'), publicOrigin } = {}) {
  const hosted = publicOrigin !== undefined;
  let publicHost;
  if (hosted) {
    const origin = new URL(publicOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) throw new Error('Public origin must be an exact HTTPS origin.');
    publicHost = origin.host;
  }
  if (!Number.isInteger(port) || (hosted ? port < 1024 || port > 65535 : port < 5310 || port > 5319)) throw new Error(hosted ? 'Hosted PORT must be within 1024–65535.' : 'Cloudbreak ports must be within 5310–5319.');
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 8) throw new Error('Cloudbreak supports at most eight retained sessions.');
  logDir = resolve(logDir);
  if (!logDir.startsWith(ROOT + sep)) throw new Error('Cloudbreak logs must stay inside this game root.');
  if (!hosted) mkdirSync(logDir, { recursive: true });
  const sessions = new Map();
  const groundTruth = new Map();
  let sequence = 0;
  let timer;
  let closing = false;
  const sharedLimits = { emissions: [], approaches: [] };
  const internalToken = randomUUID();
  const url = `http://127.0.0.1:${port}`;

  function trafficWindow(session, key, now = clock()) {
    // Local previews retain their shared cap. Public visitors each receive the
    // same authored workload, bounded by the eight-session server limit.
    const limits = hosted ? session.trafficLimits : sharedLimits;
    limits[key] = limits[key].filter(time => now - time < 1_000);
    return limits[key];
  }

  function ownedSession(req, id) {
    const session = getSession(id);
    if (hosted && (!ownerToken(req) || session.owner !== ownerToken(req))) throw fail(404, 'Cloudbreak session not found. Start a new mission.');
    return session;
  }

  function ensureOwner(req, res) {
    const existing = ownerToken(req);
    if (existing) return existing;
    const owner = randomUUID();
    res.setHeader('set-cookie', `${OWNER_COOKIE}=${owner}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=21600`);
    return owner;
  }

  async function frontendReady() {
    try {
      const [directory, index] = await Promise.all([realpath(distDir), realpath(resolve(distDir, 'index.html'))]);
      return index.startsWith(directory + sep) && (await stat(index)).isFile();
    } catch { return false; }
  }

  function cancelTraffic(session) {
    session.generation += 1;
    for (const { controller } of session.inFlight.values()) controller.abort();
    session.inFlight.clear();
    session.approaches?.clear();
  }

  function reset(session, phase = 'ready') {
    if (session.inFlight) cancelTraffic(session);
    const now = clock();
    session.trafficLimits ??= { emissions: [], approaches: [] };
    Object.assign(session, {
      phase, elapsed: 0, integrity: 100, damageTakenTenths: 0, reserved: 0, legitimateTotal: 0,
      legitimateServed: 0, hostileBlocked: 0, hostileAdmitted: 0, totalRequests: 0,
      events: [], pauseReason: undefined, finishing: false, lastUpdate: now, lastHeartbeat: now,
      freeCreditSeconds: 0, generatedThrough: 0, generation: (session.generation || 0) + 1,
      inFlight: new Map(), approaches: new Map(), accumulators: [], streamCursor: 0, lastWave: -1, random: seededRandom(),
      routes: ROUTES.map(id => ({ id, name: ROUTE_NAMES[id], policy: defaultPolicy(), served: 0, rejected: 0, hostileAdmitted: 0, bucket: { tokens: 0, updatedAt: 0, initialized: false } })),
      logFile: `cloudbreak-${session.id}-${randomUUID().slice(0, 8)}.ndjson`,
      ...(hosted ? { records: [] } : {}),
    });
    if (!hosted) writeFileSync(resolve(logDir, session.logFile), '');
  }

  function setPaused(session, reason) {
    if (session.phase !== 'running') return;
    session.phase = 'paused';
    session.pauseReason = reason;
  }

  function advance(session, now = clock()) {
    if (session.phase !== 'running' || session.finishing) { session.lastUpdate = now; return 0; }
    const disconnectAt = session.lastHeartbeat + HEARTBEAT_TIMEOUT;
    const end = Math.min(now, disconnectAt);
    const delta = Math.min(Math.max(0, (end - session.lastUpdate) / 1_000), DURATION - session.elapsed);
    session.elapsed = Math.min(DURATION, session.elapsed + delta);
    if (DURATION - session.elapsed < 1e-9) session.elapsed = DURATION;
    session.freeCreditSeconds += delta * (40 - session.reserved);
    session.lastUpdate = now;
    if (session.elapsed >= DURATION) {
      session.finishing = true;
      finishIfDrained(session);
    } else if (now >= disconnectAt) setPaused(session, 'Connection lost. Resume when you are ready.');
    return delta;
  }

  function finishIfDrained(session) {
    if (!session.finishing) return;
    // An approach is authored intent, not an HTTP result. At the deadline or
    // zero integrity, discard only traffic that has not actually dispatched.
    for (const [id, incoming] of session.approaches) if (!incoming.dispatched) session.approaches.delete(id);
    if (session.inFlight.size) return;
    const service = session.legitimateTotal ? session.legitimateServed / session.legitimateTotal * 100 : 0;
    session.phase = session.integrity > 0 && service >= SERVICE_TARGET ? 'won' : 'lost';
    session.finishing = false;
    session.pauseReason = undefined;
  }

  async function drain(session) {
    await Promise.all([...session.inFlight.values()].map(entry => entry.done));
    finishIfDrained(session);
  }

  async function snapshot(session) {
    advance(session);
    // A paused or final snapshot includes every response already in flight.
    // Active snapshots may sample traffic normally; no result is fabricated.
    if (session.phase !== 'running' || session.finishing) await drain(session);
    return state(session);
  }

  function state(session) {
    advance(session);
    const wave = waveAt(session.elapsed);
    const economyBonus = Math.round(1_000 * (session.elapsed ? session.freeCreditSeconds / session.elapsed / 40 : 1));
    return {
      game: 'cloudbreak', sessionId: session.id, phase: session.phase,
      elapsed: Number(session.elapsed.toFixed(3)), duration: DURATION,
      integrity: Number(session.integrity.toFixed(1)),
      service: session.legitimateTotal ? session.legitimateServed / session.legitimateTotal * 100 : ['won', 'lost'].includes(session.phase) ? 0 : 100,
      credits: 40 - session.reserved, reserved: session.reserved,
      legitimateTotal: session.legitimateTotal, legitimateServed: session.legitimateServed,
      hostileBlocked: session.hostileBlocked, hostileAdmitted: session.hostileAdmitted, totalRequests: session.totalRequests,
      score: session.legitimateServed * 5 + Math.round(session.integrity * 10) + economyBonus,
      economyBonus, wave: { index: wave.index, title: wave.title, hint: wave.hint, threat: wave.threat, threatType: wave.threatType, target: wave.target, threats: wave.attacks.map(({ route, threatType }) => ({ route, threatType })) },
      routes: session.routes.map(({ bucket, ...route }) => ({ ...route, policy: { ...route.policy } })),
      incoming: [...session.approaches.values()].map(({ id, route, role, threatType, approachStartedAt, decisionAt }) => ({ id, route, role, threatType, approachStartedAt, decisionAt })),
      events: [...session.events], logFile: session.logFile,
      ...(session.pauseReason ? { pauseReason: session.pauseReason } : {}),
    };
  }

  function getSession(id) {
    const session = typeof id === 'string' && sessions.get(id);
    if (!session) throw fail(404, 'Cloudbreak session not found. Start a new mission.');
    return session;
  }

  const nextRequestId = () => `cloudbreak-${++sequence}-${randomUUID().slice(0, 8)}`;

  // The exported direct-request helper stays immediate. Only the internal
  // authored scheduler can supply an already-visible identity and its times.
  function dispatchRequest(sessionId, request) { return dispatch(sessionId, request); }

  async function dispatch(sessionId, request, prepared) {
    const session = getSession(sessionId);
    advance(session);
    if (closing || session.phase !== 'running' || session.finishing || session.inFlight.size >= MAX_IN_FLIGHT) return null;
    if (!ROUTES.includes(request.route) || !['legitimate', 'hostile'].includes(request.role) || !['missing', 'invalid', 'valid'].includes(request.credential)) throw new Error('Invalid local authored request.');
    if (request.role === 'hostile' && (typeof request.threatType !== 'string' || !Object.hasOwn(THREAT_DAMAGE, request.threatType))) throw new Error('Invalid local authored threat type.');
    const now = clock();
    const emissionTimes = trafficWindow(session, 'emissions', now);
    if (emissionTimes.length >= MAX_GENERATED_PER_SECOND) return null;
    emissionTimes.push(now);
    const id = prepared?.id ?? nextRequestId();
    if (prepared) prepared.dispatched = true;
    const generation = session.generation;
    const controller = new AbortController();
    const completion = Promise.withResolvers();
    session.inFlight.set(id, { controller, done: completion.promise });
    // Private authored ground truth. Role, threat type, and damage never enter middleware.
    groundTruth.set(id, { role: request.role, credential: request.credential, threatType: request.role === 'hostile' ? request.threatType : null, missionTime: Number(session.elapsed.toFixed(3)) });
    const started = performance.now();
    try {
      const headers = { 'x-cloudbreak-session': session.id, 'x-cloudbreak-request-id': id };
      if (hosted) headers['x-cloudbreak-internal'] = internalToken;
      if (request.credential !== 'missing') headers.authorization = request.credential === 'valid' ? DEMO_CREDENTIAL : 'Bearer cloudbreak-demo-invalid';
      const response = await fetch(`${url}/gateway/${request.route}`, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]) });
      const result = await response.json();
      const elapsedMs = Number((performance.now() - started).toFixed(3));
      const truth = groundTruth.get(id);
      if (session.generation !== generation || !truth) return null;
      if (result.requestId !== id || ![200, 401, 429, 503].includes(response.status)) throw new Error('Unexpected local gateway response.');
      const damage = response.ok && truth.role === 'hostile' ? THREAT_DAMAGE[truth.threatType] : 0;
      const record = { id, timestamp: new Date().toISOString(), elapsedMs, missionTime: truth.missionTime, route: request.route, status: response.status, reason: result.reason, role: truth.role, credential: truth.credential, threatType: truth.threatType, damage,
        ...(prepared ? { approachStartedAt: prepared.approachStartedAt, decisionAt: prepared.decisionAt } : {}) };
      if (hosted) session.records.push(JSON.stringify(record) + '\n');
      else appendFileSync(resolve(logDir, session.logFile), JSON.stringify(record) + '\n');
      session.events.push(record);
      if (session.events.length > 120) session.events.shift();
      session.totalRequests += 1;
      const route = session.routes.find(item => item.id === request.route);
      if (response.ok) route.served += 1; else route.rejected += 1;
      if (truth.role === 'legitimate') {
        session.legitimateTotal += 1;
        if (response.ok) session.legitimateServed += 1;
      } else if (response.ok) {
        session.hostileAdmitted += 1;
        route.hostileAdmitted += 1;
        session.damageTakenTenths += Math.round(record.damage * 10);
        session.integrity = Math.max(0, 100 - session.damageTakenTenths / 10);
        if (session.integrity === 0) session.finishing = true;
      } else session.hostileBlocked += 1;
      return record;
    } catch (error) {
      if (session.generation === generation && session.phase === 'running' && !closing) {
        // A transport failure is not a made-up rejection or a game request.
        advance(session);
        setPaused(session, 'The local gateway interrupted traffic. Resume to try again.');
      }
      return null;
    } finally {
      groundTruth.delete(id);
      session.inFlight.delete(id);
      session.approaches.delete(id);
      if (session.generation === generation) finishIfDrained(session);
      completion.resolve();
    }
  }

  async function tick() {
    if (closing) return;
    const pending = [];
    for (const session of sessions.values()) {
      advance(session);
      const delta = Math.max(0, session.elapsed - session.generatedThrough);
      session.generatedThrough = session.elapsed;
      if (session.phase !== 'running' || session.finishing) continue;
      // Approach and policy decision are distinct. A visible request keeps its
      // identity and private credential until a real fetch uses the current gate.
      // Saturated HTTP capacity leaves it waiting at the gate, never fabricates
      // a rejection, and never allows more than eight requests in flight.
      for (const incoming of session.approaches.values()) {
        const emissionTimes = trafficWindow(session, 'emissions');
        if (session.inFlight.size >= MAX_IN_FLIGHT || emissionTimes.length >= MAX_GENERATED_PER_SECOND) break;
        if (!incoming.dispatched && incoming.decisionAt <= session.elapsed + 1e-9) pending.push(dispatch(session.id, incoming, incoming));
      }
      const wave = waveAt(session.elapsed);
      const streams = [
        ...wave.customers.map((rate, index) => ({ rate, route: ROUTES[index], role: 'legitimate' })),
        ...wave.attacks.map(attack => ({ ...attack, role: 'hostile' })),
      ];
      if (session.lastWave !== wave.index) {
        session.accumulators = streams.map(() => 0);
        session.streamCursor = 0;
        session.lastWave = wave.index;
      }
      // Never catch up a suspended laptop with a burst of old traffic. Each
      // stream keeps at most two pending requests, including fractional demand.
      for (let index = 0; index < streams.length; index++) {
        session.accumulators[index] = Math.min(2, session.accumulators[index] + Math.min(delta, 0.25) * streams[index].rate);
      }
      // Rotate independently accumulated streams so a busy district cannot
      // starve another attack or customer stream behind the shared safety cap.
      let idleStreams = 0;
      while (idleStreams < streams.length) {
        const approachTimes = trafficWindow(session, 'approaches');
        if (session.approaches.size >= MAX_APPROACHING || approachTimes.length >= MAX_GENERATED_PER_SECOND) break;
        const index = session.streamCursor;
        session.streamCursor = (index + 1) % streams.length;
        if (session.accumulators[index] < 1) { idleStreams += 1; continue; }
        idleStreams = 0;
        session.accumulators[index] -= 1;
        const stream = streams[index];
        const credential = stream.role === 'hostile' ? stream.credential : stream.route === 'storefront' && session.random() < 0.8 ? 'missing' : 'valid';
        const id = nextRequestId();
        const approachStartedAt = Number(session.elapsed.toFixed(6));
        session.approaches.set(id, { id, route: stream.route, role: stream.role, credential, threatType: stream.threatType ?? null,
          approachStartedAt, decisionAt: Number((approachStartedAt + APPROACH_SECONDS).toFixed(6)), dispatched: false });
        approachTimes.push(clock());
      }
    }
    await Promise.all(pending);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      const parsed = new URL(req.url, url);
      const pathname = parsed.pathname;
      const loopbackHost = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
      const internal = hosted && loopbackHost && req.headers['x-cloudbreak-internal'] === internalToken;
      const healthPath = pathname === '/api/health' || pathname === '/health';
      if (hosted) {
        if (host !== publicHost && !internal && !(healthPath && loopbackHost)) throw fail(403, 'This host does not serve Cloudbreak.');
        if (req.headers.origin && req.headers.origin !== publicOrigin) throw fail(403, 'A same-origin request is required.');
        if (pathname.startsWith('/api/') && !healthPath) {
          const site = req.headers['sec-fetch-site'];
          if (site && !['same-origin', 'none'].includes(site)) throw fail(403, 'A same-origin request is required.');
          if (req.method === 'POST' && req.headers.origin !== publicOrigin) throw fail(403, 'A same-origin request is required.');
        }
        res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('x-frame-options', 'DENY');
      } else {
        if (!loopbackHost) throw fail(403, 'Use the Cloudbreak loopback address.');
        if (req.headers.origin && !isLocalOrigin(req.headers.origin)) throw fail(403, 'Cloudbreak accepts local requests only.');
      }
      if (healthPath) {
        if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Method not allowed.');
        const ready = !closing && (!hosted || await frontendReady());
        return json(res, ready ? 200 : 503, { game: 'cloudbreak', status: ready ? 'ok' : 'unavailable', port, localOnly: !hosted, ...(hosted ? { frontend: ready ? 'ready' : 'unavailable', sessions: sessions.size, maxSessions } : {}) });
      }
      if (pathname.startsWith('/gateway/')) {
        // Public callers cannot inject traffic, consume another mission's
        // token bucket, or supply role labels. Only our fixed loopback fetches
        // know this process-private transport token.
        if (hosted && !internal) throw fail(404, 'Unknown Cloudbreak route.');
        if (req.method !== 'GET') throw fail(405, 'Method not allowed.');
        const routeId = pathname.slice('/gateway/'.length);
        if (!ROUTES.includes(routeId)) throw fail(404, 'Unknown route.');
        const session = getSession(req.headers['x-cloudbreak-session']);
        advance(session);
        const requestId = req.headers['x-cloudbreak-request-id'];
        if (!requestId || typeof requestId !== 'string' || requestId.length > 100) throw fail(400, 'A Cloudbreak request ID is required.');
        if ((session.phase !== 'running' || session.finishing) && !session.inFlight.has(requestId)) return json(res, 409, { requestId, reason: 'mission_not_running' });
        const route = session.routes.find(item => item.id === routeId);
        const decision = gatewayDecision(route.policy, route.bucket, req.headers.authorization, session.elapsed * 1_000);
        return json(res, decision.status, { requestId, route: routeId, reason: decision.reason });
      }
      if (pathname === '/api/state' && req.method === 'GET') return json(res, 200, await snapshot(ownedSession(req, parsed.searchParams.get('sessionId'))));
      if (pathname === '/api/log' && req.method === 'GET') {
        const session = ownedSession(req, parsed.searchParams.get('sessionId'));
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': `attachment; filename="${session.logFile}"`, 'cache-control': 'no-store' });
        if (hosted) return res.end(session.records.join(''));
        return createReadStream(resolve(logDir, session.logFile)).pipe(res);
      }
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'POST') throw fail(405, 'Method not allowed.');
        const body = await readJson(req);
        if (pathname === '/api/session') {
          if (sessions.size >= maxSessions) {
            const now = clock();
            const existing = [...sessions.values()];
            for (const session of existing) advance(session, now);
            // Keep connected paused clients. Reclaim only an abandoned paused
            // session after 30 seconds without a heartbeat, once traffic drains.
            const reclaimable = existing.find(session => ['ready', 'won', 'lost'].includes(session.phase) && (!hosted || now - session.lastHeartbeat >= STALE_PAUSED_SESSION_AGE))
              ?? existing.filter(session => session.phase === 'paused' && !session.inFlight.size
                && now - session.lastHeartbeat >= STALE_PAUSED_SESSION_AGE)
                .sort((a, b) => a.lastHeartbeat - b.lastHeartbeat)[0];
            if (reclaimable) { cancelTraffic(reclaimable); sessions.delete(reclaimable.id); }
            else throw fail(429, 'Too many active Cloudbreak sessions. Retry an existing mission.');
          }
          const session = { id: `cloudbreak-${randomUUID()}`, ...(hosted ? { owner: ensureOwner(req, res) } : {}) };
          reset(session);
          sessions.set(session.id, session);
          return json(res, 201, await snapshot(session));
        }
        if (pathname === '/api/start' && Object.hasOwn(body, 'paused') && typeof body.paused !== 'boolean') {
          throw fail(400, 'paused must be a boolean.');
        }
        const session = ownedSession(req, body.sessionId);
        advance(session);
        if (pathname === '/api/start') {
          setPaused(session, 'Restarting mission.');
          const cancelled = [...session.inFlight.values()].map(entry => entry.done);
          cancelTraffic(session);
          await Promise.all(cancelled);
          if (!hosted) for (const other of sessions.values()) if (other !== session) { advance(other); setPaused(other, 'A newer Cloudbreak session started.'); await drain(other); }
          reset(session, body.paused ? 'paused' : 'running');
          if (body.paused) session.pauseReason = 'Practice controls. The mission has not started.';
          return json(res, 200, await snapshot(session));
        }
        if (pathname === '/api/heartbeat') {
          session.lastHeartbeat = clock();
          return json(res, 200, await snapshot(session));
        }
        if (pathname === '/api/pause') {
          if (typeof body.paused !== 'boolean') throw fail(400, 'paused must be a boolean.');
          if (body.paused) setPaused(session, 'Mission paused.');
          else if (session.phase === 'paused') {
            if (!hosted) for (const other of sessions.values()) if (other !== session) { advance(other); setPaused(other, 'A newer Cloudbreak session resumed.'); await drain(other); }
            session.phase = 'running'; session.pauseReason = undefined;
            session.lastUpdate = clock(); session.lastHeartbeat = clock();
          }
          return json(res, 200, await snapshot(session));
        }
        if (pathname === '/api/policy') {
          if (session.finishing) await drain(session);
          if (!ROUTES.includes(body.route) || !validatePolicy(body.policy)) throw fail(400, 'Provide a route and policy with auth, rate (0, 1, 3, 6, or 12), and isolated.');
          if (!['ready', 'running', 'paused'].includes(session.phase)) throw fail(409, 'This mission has finished. Retry to change policies.');
          const route = session.routes.find(item => item.id === body.route);
          const nextReserved = session.reserved - policyCost(route.policy) + policyCost(body.policy);
          if (nextReserved > 40) throw fail(409, `Not enough defense credits. This change needs ${nextReserved - 40} more.`);
          if (route.policy.rate !== body.policy.rate) updateRateLimit(route.bucket, route.policy.rate, body.policy.rate, session.elapsed * 1_000);
          route.policy = { ...body.policy };
          session.reserved = nextReserved;
          return json(res, 200, await snapshot(session));
        }
        throw fail(404, 'Unknown Cloudbreak API route.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed.');
      let filePath;
      try {
        const decoded = decodeURIComponent(pathname);
        if (decoded.includes('\0') || decoded.includes('\\')) throw new Error();
        filePath = resolve(distDir, '.' + decoded);
        if (filePath !== resolve(distDir) && !filePath.startsWith(resolve(distDir) + sep)) throw new Error();
        if (!extname(filePath)) filePath = resolve(distDir, 'index.html');
        const [realFile, realDist] = await Promise.all([realpath(filePath), realpath(distDir)]);
        if (!realFile.startsWith(realDist + sep) || !(await stat(realFile)).isFile()) throw new Error();
        const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' }[extname(realFile)] || 'application/octet-stream';
        if (hosted && extname(realFile) === '.html') ensureOwner(req, res);
        res.writeHead(200, { 'content-type': mime, 'x-content-type-options': 'nosniff', 'cache-control': extname(realFile) === '.html' ? 'no-cache' : 'public, max-age=3600' });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(realFile).pipe(res);
      } catch { throw fail(404, 'Cloudbreak page not found. Build the frontend before production start.'); }
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'The Cloudbreak gateway could not finish this request.' });
      else res.end();
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  if (hosted) server.maxConnections = 128;

  return {
    url, logDir, server, dispatchRequest, tick,
    listen: () => new Promise((resolveListen, reject) => {
      server.once('error', error => reject(error.code === 'EADDRINUSE' ? new Error(`Cloudbreak port ${port} is occupied. No process was stopped. Choose a free ${hosted ? 'hosted port' : 'port within 5310–5319'}.`) : error));
      server.listen(port, hosted ? '0.0.0.0' : '127.0.0.1', () => {
        if (autoTick) timer = setInterval(() => { tick().catch(() => { for (const session of sessions.values()) setPaused(session, 'The local gateway interrupted traffic.'); }); }, 100);
        resolveListen();
      });
    }),
    close: async () => {
      closing = true;
      clearInterval(timer);
      for (const session of sessions.values()) setPaused(session, 'The local gateway is stopping.');
      await Promise.all([...sessions.values()].map(drain));
      for (const session of sessions.values()) cancelTraffic(session);
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}
