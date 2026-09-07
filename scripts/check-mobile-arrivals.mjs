// Read-only visual diagnostics, real touch controls and unchanged HTTP/clock.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DEFENSES, modeForPolicy, signalsForState } from '../src/defenses.ts';
import { ROUTE_NAMES } from '../src/types.ts';

const target = new URL(process.env.CLOUDBREAK_CHECK_URL || 'http://127.0.0.1:5310');
assert.ok(['http://127.0.0.1:5310/', 'https://cloudbreak.onrender.com/'].includes(target.href), 'Only the exact local preview or public Cloudbreak root URL is allowed.');
const publicRun = target.protocol === 'https:', recordClip = process.env.RECORD_CLIP === '1' || (!publicRun && process.env.RECORD_CLIP !== '0');
const root = resolve(import.meta.dirname, '..'), output = resolve(root, publicRun ? 'captures/mobile-arrivals/public' : 'captures/mobile-arrivals');
const ffmpeg = resolve(root, '.cloudbreak-runtime/media/node_modules/ffmpeg-static/ffmpeg');
await mkdir(output, { recursive: true });
const report = { passed: false, url: target.origin, checkedAt: new Date().toISOString(), method: 'Actual HTTP, ordinary touch controls, original wall clock; per-render diagnostics are observed only.', physicalDeviceTested: false, stages: [], errors: [], geometryWarnings: [], screenshots: [] };
const sourceFiles = ['src/CityScene.tsx', 'src/traffic-path.ts', 'src/style.css', 'server/app.mjs', 'server/gateway.mjs', 'server/waves.mjs'];
const hash = value => createHash('sha256').update(value).digest('hex');
report.sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(resolve(root, file)))])));
const alias = id => hash(id).slice(0, 12), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sanitize = value => String(value).replaceAll(root, '[project]').replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted-id]');
let browser, page, id, recording;

function installAudit() {
  const audit = window.__arrivalsAudit = { actors: {}, sampledFrames: 0 };
  const inside = point => Math.abs(point[0]) <= 1 && Math.abs(point[1]) <= 1;
  const sample = () => {
    const current = window.__cloudbreakPerf?.trafficContinuity;
    const canvas = document.querySelector('.city-scene canvas')?.getBoundingClientRect();
    audit.sampledFrames++;
    if (current && canvas) {
      for (const birth of current.recentBirths) if (!audit.actors[birth.id]) audit.actors[birth.id] = {
        birth: structuredClone(birth), viewport: [innerWidth, innerHeight], canvas: [canvas.width, canvas.height],
        samples: 0, uuidChanged: false, backwardProgress: false, maxProgressStep: 0, last: null, firstEntry: null, response: null,
      };
      for (const actor of current.active) {
        const trace = audit.actors[actor.id];
        if (!trace) continue;
        const now = performance.now(), previous = trace.last;
        trace.samples++;
        trace.extendedApproach ??= actor.extendedApproach;
        if (actor.uuid !== trace.birth.uuid) trace.uuidChanged = true;
        if (previous && actor.progress < previous.progress - 1e-10) trace.backwardProgress = true;
        if (previous) trace.maxProgressStep = Math.max(trace.maxProgressStep, actor.progress - previous.progress);
        const point = actor.screenPosition;
        if (!trace.firstEntry && previous && !inside(previous.screenPosition) && inside(point) && previous.canvas[0] === canvas.width && previous.canvas[1] === canvas.height) {
          const movement = Math.hypot((point[0] - previous.screenPosition[0]) * canvas.width / 2, (point[1] - previous.screenPosition[1]) * canvas.height / 2);
          trace.firstEntry = { viewport: [innerWidth, innerHeight], ndc: [...point], edgeDistancePixels: Math.min((1 - Math.abs(point[0])) * canvas.width / 2, (1 - Math.abs(point[1])) * canvas.height / 2), movementPixels: movement, intervalMs: now - previous.at, progress: actor.progress };
        }
        if (actor.measuredStatus !== null && !trace.response) trace.response = { status: actor.measuredStatus, progress: actor.progress, phase: actor.phase, decisionAt: actor.decisionAt };
        if (actor.phase === 'rejected') trace.rejectedAtGate = actor.progress;
        trace.last = { at: now, progress: actor.progress, screenPosition: [...point], canvas: [canvas.width, canvas.height] };
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
const state = () => page.evaluate(async id => {
  const response = await fetch('/api/state?sessionId=' + encodeURIComponent(id));
  if (!response.ok) throw new Error('State HTTP ' + response.status);
  return response.json();
}, id);
const continuity = () => page.evaluate(() => structuredClone(window.__cloudbreakPerf.trafficContinuity));
const audit = () => page.evaluate(() => structuredClone(window.__arrivalsAudit));
const photo = async name => { await page.screenshot({ path: resolve(output, name + '.png') }); report.screenshots.push(name + '.png'); };
const tap = async name => { await page.getByRole('button', { name, exact: true }).tap(); };
async function mode(route, next) {
  if (modeForPolicy((await state()).routes.find(item => item.id === route).policy) === next) return;
  const tab = page.locator(`.district-tabs button[data-route="${route}"]`);
  if (await tab.isVisible()) await tab.tap();
  const label = `${ROUTE_NAMES[route]}: ${DEFENSES.find(item => item.id === next).label}`;
  await tap(label);
  await page.waitForFunction(label => document.querySelector(`.mode-choice[aria-label="${label}"]`)?.getAttribute('aria-pressed') === 'true', label);
}
async function defend() {
  const current = await state();
  if (current.phase !== 'running') return;
  for (const signal of signalsForState(current)) await mode(signal.route, signal.mode);
}
async function observeFor(ms, autoDefend = true) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (autoDefend) await defend(); await page.waitForTimeout(100); }
}
async function layout(width, height) {
  await page.setViewportSize({ width, height }); await page.waitForTimeout(250);
  const desktop = width === 1280;
  const badges = await page.locator('.city-scene [aria-label="City districts"] button').evaluateAll(elements => elements.map(element => ({ display: getComputedStyle(element).display, rects: element.getClientRects().length, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })));
  if (!desktop) assert.ok(badges.every(badge => badge.display === 'none' && badge.rects === 0 && badge.width === 0 && badge.height === 0), 'Mobile world badges must have no visible or clickable rectangle.');
  assert.equal(await page.locator('.district-tabs button:visible').count(), desktop ? 0 : 3);
  assert.equal(await page.locator('.mode-choice:visible').count(), desktop ? 12 : 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1), false);
  return { viewport: [width, height], worldBadges: badges, visibleModes: desktop ? 12 : 4, districtSelectors: desktop ? 0 : 3 };
}
async function pausedResize(width, height) {
  await tap('Pause game'); await page.getByRole('button', { name: 'Resume First Light', exact: true }).waitFor(); await page.waitForTimeout(350);
  const frozen = current => current.active.map(actor => ({ id: actor.id, uuid: actor.uuid, progress: actor.progress, position: actor.position, extendedApproach: actor.extendedApproach })).sort((a, b) => a.id.localeCompare(b.id));
  const before = frozen(await continuity()), elapsed = (await state()).elapsed;
  assert.ok(before.length, 'Paused rotation needs actual active travelers.');
  await layout(width, height); await page.waitForTimeout(350);
  assert.deepEqual(frozen(await continuity()), before, 'Pause and rotation must preserve every traveler, path, progress and world position.');
  assert.equal((await state()).elapsed, elapsed);
  await tap('Resume First Light');
  return { viewport: [width, height], actorsFrozen: before.length, exactWorldPositionsPreserved: true };
}
async function beginRecording() {
  const folder = resolve(output, 'phone-frames'), cdp = await page.context().newCDPSession(page);
  await mkdir(folder, { recursive: true }); await cdp.send('Page.enable');
  const frames = [], writes = new Set(), errors = []; let accepting = true, bytes = 0;
  const onFrame = event => {
    const ack = () => cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    if (!accepting) { void ack(); return; }
    if (writes.size >= 6 || bytes > 100_000_000) { errors.push('Capture exceeded its bounded queue or byte limit.'); void ack(); return; }
    const timestamp = event.metadata.timestamp;
    if (!Number.isFinite(timestamp) || (frames.length && timestamp <= frames.at(-1).timestamp)) { errors.push('Non-monotonic compositor timestamp.'); void ack(); return; }
    const data = Buffer.from(event.data, 'base64'), file = `phone-frames/${String(frames.length).padStart(5, '0')}.jpg`;
    bytes += data.length; frames.push({ file, timestamp });
    const writing = writeFile(resolve(output, file), data).catch(error => errors.push(error.message)).finally(ack);
    writes.add(writing); void writing.finally(() => writes.delete(writing));
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 390, maxHeight: 844, everyNthFrame: 2 });
  return { async stop() {
    const end = await page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000);
    await cdp.send('Page.stopScreencast'); accepting = false; await Promise.all(writes); cdp.off('Page.screencastFrame', onFrame); await cdp.detach();
    assert.ok(frames.length > 100, 'A motion clip needs actual continuous compositor frames.'); assert.deepEqual(errors, []);
    const duration = end - frames[0].timestamp, lines = ['ffconcat version 1.0'];
    for (let index = 0; index < frames.length; index++) lines.push(`file '${frames[index].file}'`, 'option framerate 1000', `duration ${((frames[index + 1]?.timestamp ?? end) - frames[index].timestamp).toFixed(6)}`);
    lines.push(`file '${frames.at(-1).file}'`, 'option framerate 1000');
    await writeFile(resolve(output, 'phone.ffconcat'), lines.join('\n') + '\n');
    const intervals = frames.slice(1).map((frame, index) => frame.timestamp - frames[index].timestamp);
    const receipt = { file: 'accounts-arrivals-phone-silent.mp4', width: 390, height: 844, durationSeconds: duration, actualFrames: frames.length, averageFps: frames.length / duration, maximumFrameIntervalSeconds: Math.max(...intervals), finalRealFrameHoldSeconds: end - frames.at(-1).timestamp, audio: 'Silent technical review clip; no audio recorded.', timing: 'Original compositor timestamps, variable frame rate. No speed changes or interpolated gameplay. Final real image held only to recording stop.', frames };
    await writeFile(resolve(output, 'phone-recording.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } };
}
async function encodeClip(receipt) {
  const run = args => new Promise((resolveRun, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
    child.stderr.on('data', data => { error = (error + data).slice(-4000); });
    child.on('error', reject); child.on('close', code => code ? reject(new Error(error)) : resolveRun());
  });
  await run(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', resolve(output, 'phone.ffconcat'), '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', '-fps_mode:v', 'vfr', '-enc_time_base:v', '1:1000', '-video_track_timescale', '1000000', '-t', receipt.durationSeconds.toFixed(6), '-movflags', '+faststart', resolve(output, receipt.file)]);
  await run(['-hide_banner', '-v', 'error', '-i', resolve(output, receipt.file), '-f', 'null', '-']);
  const { frames, ...summary } = receipt; report.recording = { ...summary, fullDecodePassed: true, sha256: hash(await readFile(resolve(output, receipt.file))) };
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(sanitize(error.message)));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(sanitize(message.text())); if (/NaN|BufferGeometry|WebGL.*(?:INVALID|error|lost)/i.test(message.text())) report.geometryWarnings.push(sanitize(message.text())); });
  assert.equal((await page.goto(report.url, { waitUntil: 'domcontentloaded' })).status(), 200);
  await tap('Enter the city'); await page.evaluate(installAudit); await tap('Begin First Light');
  id = await page.evaluate(() => sessionStorage.getItem('cloudbreak.session')); assert.ok(id);
  await page.waitForFunction(() => window.__cloudbreakPerf?.trafficContinuity?.active.length > 0);
  report.stages.push(await layout(390, 844));
  const started = Date.now();
  while ((await state()).elapsed < 32.6) {
    assert.ok(Date.now() - started < 45000, 'The original clock must reach the Accounts swarm.');
    // Leave Accounts open until actors are visible so Slow flow is an actual
    // policy transition, not a no-op against an already enabled defense.
    for (const signal of signalsForState(await state())) if (!(signal.route === 'accounts' && signal.mode === 'rate')) await mode(signal.route, signal.mode);
    await page.waitForTimeout(150);
  }
  console.log(`Accounts swarm reached using the original clock; collecting continuity${recordClip ? ' and phone motion' : ''}.`);
  // Observe the newly arriving swarm before touching Slow flow.
  await page.waitForFunction(() => window.__cloudbreakPerf.trafficContinuity.active.some(actor => actor.route === 'accounts' && actor.threatType === 'swarm' && actor.progress < .4));
  if (recordClip) recording = await beginRecording();
  const clipStarted = Date.now();
  const before = (await continuity()).active.filter(actor => actor.route === 'accounts' && actor.source === 'incoming' && actor.measuredStatus === null && actor.progress < .45);
  assert.ok(before.length, 'Need approaching Accounts actors before the policy change.');
  assert.equal(modeForPolicy((await state()).routes.find(route => route.id === 'accounts').policy), 'open');
  await mode('accounts', 'rate'); await page.waitForTimeout(100);
  const after = await continuity();
  for (const old of before) { const current = after.active.find(actor => actor.id === old.id); assert.ok(current, 'Slow flow must retain the approaching actor.'); assert.equal(current.uuid, old.uuid); assert.equal(current.decisionAt, old.decisionAt); assert.ok(current.progress >= old.progress && current.progress - old.progress < .25, 'Mode changes must preserve forward progress.'); }
  report.slowFlowContinuity = { actorsCompared: before.length, sameRequestAndObjectIdentities: true, deadlinesUnchanged: true, forwardProgress: true };
  await observeFor(Math.max(0, 10100 - (Date.now() - clipStarted)));
  const clip = recording ? await recording.stop() : null; recording = null;
  await photo('phone-390x844-accounts');
  for (const [width, height] of [[320, 568], [430, 932], [844, 390], [932, 430]]) {
    const rotation = await pausedResize(width, height); await observeFor(3600);
    report.stages.push({ ...await layout(width, height), rotation }); await photo(`mobile-${width}x${height}`);
  }
  console.log('Mobile viewport and paused-rotation checks complete; checking desktop births and real HTTP joins.');
  await pausedResize(1280, 900); await observeFor(4500); report.stages.push(await layout(1280, 900)); await photo('desktop-1280x900');
  await tap('Pause game'); await page.getByRole('button', { name: 'Resume First Light', exact: true }).waitFor();
  const observed = await audit(), final = await state();
  const logResponse = await context.request.get(report.url + '/api/log?sessionId=' + encodeURIComponent(id)); assert.equal(logResponse.status(), 200);
  const records = (await logResponse.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(records.length, final.totalRequests);
  const byId = new Map(records.map(record => [record.id, record]));
  const mobile = Object.values(observed.actors).filter(trace => trace.viewport[0] !== 1280), accounts = mobile.filter(trace => trace.birth.route === 'accounts');
  assert.ok(accounts.length >= 20, 'Sample at least twenty actual mobile Accounts births.');
  for (const trace of accounts) {
    const [x, y, z] = trace.birth.screenPosition;
    assert.ok(Math.abs(x) > 1 || Math.abs(y) > 1, 'Every sampled mobile Accounts birth must start outside the XY frame.');
    assert.ok(z >= -1 && z <= 1, 'The feeder birth must remain within the camera Z clip.');
    assert.equal(trace.birth.firstProgress, 0); assert.ok(trace.extendedApproach);
    assert.equal(trace.uuidChanged, false); assert.equal(trace.backwardProgress, false);
    if (trace.firstEntry) assert.ok(trace.firstEntry.edgeDistancePixels <= Math.max(24, trace.firstEntry.movementPixels + 1), 'The same actor must enter through a sampled frame edge.');
    if (trace.rejectedAtGate !== undefined) assert.equal(trace.rejectedAtGate, .72);
    const record = byId.get(trace.birth.id);
    if (record) { assert.equal(record.decisionAt, trace.birth.decisionAt); if (trace.response) assert.equal(trace.response.status, record.status); }
  }
  const viewportEvidence = report.stages.filter(stage => stage.viewport[0] !== 1280).map(stage => {
    const births = accounts.filter(trace => same(trace.viewport, stage.viewport));
    const entered = births.filter(trace => trace.firstEntry && same(trace.firstEntry.viewport, stage.viewport));
    const joined = entered.filter(trace => trace.response && byId.has(trace.birth.id));
    assert.ok(births.length >= 2 && entered.length >= 1 && joined.length >= 1, `Need birth, edge entry and actual HTTP evidence at ${stage.viewport.join('×')}.`);
    return { viewport: stage.viewport, births: births.length, entered: entered.length, sameActorsJoinedRealHTTP: joined.length, maximumFirstEntryDistancePixels: Math.max(...entered.map(trace => trace.firstEntry.edgeDistancePixels)) };
  });
  const other = mobile.filter(trace => trace.birth.route !== 'accounts');
  assert.ok(other.length > 10); assert.ok(other.every(trace => !trace.extendedApproach));
  const desktop = Object.values(observed.actors).filter(trace => trace.viewport[0] === 1280);
  assert.ok(desktop.some(trace => trace.birth.route === 'accounts')); assert.ok(desktop.every(trace => !trace.extendedApproach));
  for (const route of ['storefront', 'dispatch']) {
    const origins = [...mobile, ...desktop].filter(trace => trace.birth.route === route).map(trace => trace.birth.rawCurveOrigin);
    assert.ok(origins.every(origin => same(origin, origins[0])), 'Other-lane origins must remain identical across layouts.');
  }
  report.arrivals = { sampledFrames: observed.sampledFrames, mobileAccountsBirths: accounts.length, allBornOutsideXYInsideZ: true, allStartedAtZero: true, sameIdentitiesAndForwardProgress: true, realHTTPDeadlinesPreserved: true, originalRejectedGateProgress: .72, viewports: viewportEvidence, otherLaneBirths: other.length, otherLaneOriginsUnchanged: true, desktopBirths: desktop.length, desktopOriginalPaths: true };
  report.examples = accounts.filter(trace => trace.firstEntry && trace.response && byId.has(trace.birth.id)).slice(0, 12).map(trace => ({ actor: alias(trace.birth.id), viewport: trace.viewport, birthNdc: trace.birth.screenPosition, firstEntry: trace.firstEntry, response: trace.response, actualHttpStatus: byId.get(trace.birth.id).status }));
  report.actualRequests = final.totalRequests; report.missionSecondsObserved = final.elapsed;
  assert.deepEqual(report.errors, []); assert.deepEqual(report.geometryWarnings, []);
  for (const [file, expected] of Object.entries(report.sourceHashes)) assert.equal(hash(await readFile(resolve(root, file))), expected, `Source changed during the run: ${file}`);
  if (clip) await encodeClip(clip);
  else report.recording = { recorded: false, reason: 'Recording disabled; actual screenshots and per-render measurements retained.' };
  report.passed = true; console.log(JSON.stringify({ passed: true, actualAccountsBirths: accounts.length, actualRequests: final.totalRequests, missionSeconds: final.elapsed, clip: report.recording.file ?? null }));
} catch (error) {
  report.failure = sanitize(error.stack || error); process.exitCode = 1; console.error(report.failure);
  if (page) { await photo('failure').catch(() => {}); const partial = await audit().catch(() => null); if (partial) report.partialAudit = { sampledFrames: partial.sampledFrames, births: Object.values(partial.actors).map(trace => ({ actor: alias(trace.birth.id), route: trace.birth.route, viewport: trace.viewport, birthNdc: trace.birth.screenPosition, extendedApproach: trace.extendedApproach, firstEntry: trace.firstEntry, response: trace.response })) }; }
} finally {
  if (recording) await recording.stop().catch(() => {});
  await writeFile(resolve(output, 'report.json'), sanitize(JSON.stringify(report, null, 2)) + '\n');
  await browser?.close();
}
