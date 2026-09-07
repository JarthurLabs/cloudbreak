// Real touch controls and HTTP responses. No mocked state, game hooks or accelerated clock.
// FULL_RUN=1 also plays one complete mission after the shorter responsive checks.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFENSES, modeForPolicy, policyCost, signalsForState } from '../src/defenses.ts';
import { ROUTE_NAMES } from '../src/types.ts';

const target = new URL(process.env.CLOUDBREAK_CHECK_URL || 'http://127.0.0.1:5310');
assert.ok(!target.username && !target.password && !target.search && !target.hash && target.pathname === '/', 'Use an approved root URL without credentials, query or fragment.');
assert.ok((target.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(target.hostname) && /^531[0-9]$/.test(target.port)) || target.href === 'https://cloudbreak.onrender.com/', 'Only local ports 5310–5319 or the exact Cloudbreak public URL are allowed.');
const url = target.origin, fullRun = process.env.FULL_RUN === '1';
const output = resolve(import.meta.dirname, target.origin === 'https://cloudbreak.onrender.com' ? '../captures/mobile/public' : '../captures/mobile');
await mkdir(output, { recursive: true });
const report = { passed: false, url, checkedAt: new Date().toISOString(), fullRunRequested: fullRun, method: 'Isolated Chrome context; real touch input, unchanged server clock, actual HTTP responses.', physicalDeviceTested: false, layouts: [], actions: [], screenshots: [], errors: [], geometryWarnings: [] };
const privateValues = new Set();
const sanitize = value => {
  let text = String(value);
  for (const secret of privateValues) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[redacted-id]');
};
let browser, page, sessionId, policyRequests = 0;
const snapshotPolicies = state => ({ credits: state.credits, routes: state.routes.map(route => ({ id: route.id, policy: route.policy })) });
const state = async () => {
  const result = await page.evaluate(async id => {
    const response = await fetch('/api/state?sessionId=' + encodeURIComponent(id));
    return { status: response.status, body: await response.json() };
  }, sessionId);
  assert.equal(result.status, 200, 'The real state endpoint must succeed.');
  return result.body;
};
const waitState = async (predicate, message, timeout = 7000) => {
  const deadline = Date.now() + timeout;
  do { const current = await state(); if (predicate(current)) return current; await page.waitForTimeout(100); } while (Date.now() < deadline);
  throw new Error(message);
};
const screenshot = async name => {
  const file = name + '.png';
  await page.screenshot({ path: resolve(output, file) });
  report.screenshots.push(file);
};
const targets = async (locator, stage, { minimum = 44, viewport = true } = {}) => {
  const boxes = await locator.evaluateAll(elements => elements.flatMap(element => {
    const style = getComputedStyle(element), rect = element.getBoundingClientRect();
    if (!element.getClientRects().length || style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none' || Number(style.opacity) === 0) return [];
    return [{ label: element.getAttribute('aria-label') || element.textContent?.trim() || element.tagName, x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
  }));
  const size = page.viewportSize();
  for (const box of boxes) {
    assert.ok(box.width >= minimum - .5 && box.height >= minimum - .5, `${stage}: ${box.label} has a ${box.width.toFixed(1)}×${box.height.toFixed(1)} touch target.`);
    if (viewport) assert.ok(box.x >= -.5 && box.y >= -.5 && box.x + box.width <= size.width + .5 && box.y + box.height <= size.height + .5, `${stage}: ${box.label} falls outside the viewport.`);
  }
  return boxes;
};
const tap = async locator => {
  await locator.waitFor({ state: 'visible' });
  await locator.scrollIntoViewIfNeeded();
  await targets(locator, 'Before tap');
  await locator.tap();
};
const selected = () => page.locator('.district-tabs button[data-route][aria-pressed="true"]').getAttribute('data-route');
const select = async route => {
  await tap(page.locator(`.district-tabs button[data-route="${route}"]`));
  assert.equal(await selected(), route);
};
const setMode = async (routeId, mode, reason) => {
  const before = await state(), route = before.routes.find(item => item.id === routeId);
  if (modeForPolicy(route.policy) === mode) return;
  await select(routeId);
  const defense = DEFENSES.find(item => item.id === mode);
  const button = page.locator('.mode-choice').and(page.getByRole('button', { name: `${ROUTE_NAMES[routeId]}: ${defense.label}`, exact: true }));
  await tap(button);
  const after = await waitState(current => modeForPolicy(current.routes.find(item => item.id === routeId).policy) === mode, `${routeId} did not enter ${mode}.`);
  for (const other of before.routes.filter(item => item.id !== routeId)) assert.deepEqual(after.routes.find(item => item.id === other.id).policy, other.policy, 'Changing one district must preserve other policies.');
  assert.equal(after.credits, before.credits + policyCost(route.policy) - defense.cost, 'Credits must release the old mode and reserve the new mode.');
  await page.waitForFunction(label => document.querySelector(`.mode-choice[aria-label="${label}"]`)?.getAttribute('aria-pressed') === 'true', `${ROUTE_NAMES[routeId]}: ${defense.label}`);
  report.actions.push({ elapsed: after.elapsed, route: routeId, mode, credits: after.credits, reason });
};
const defendVisibleSignals = async reason => {
  // Read the same wave-plus-incoming-tail signals that are displayed to the player.
  // Refresh after every action: switching districts must never target stale controls.
  for (const route of ['storefront', 'accounts', 'dispatch']) {
    const current = await state();
    if (current.phase !== 'running') return;
    const signal = signalsForState(current).find(item => item.route === route);
    const tab = page.locator(`.district-tabs button[data-route="${route}"]`);
    // A real wave can change between the HTTP read and the next paint. Skip
    // that district until the next observation rather than waiting for old text.
    if (!(await tab.getAttribute('class'))?.split(/\s+/).includes(signal.kind)) continue;
    await setMode(route, signal.mode, reason);
  }
};
const layout = async (width, height, name) => {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(220);
  const desktop = width === 1280;
  const modes = page.locator('.mode-choice:visible'), tabs = page.locator('.district-tabs button[data-route]:visible');
  assert.equal(await modes.count(), desktop ? 12 : 4, `${name}: visible mode count.`);
  assert.equal(await tabs.count(), desktop ? 0 : 3, `${name}: district selector count.`);
  const overflow = await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth > innerWidth + 1, vertical: document.documentElement.scrollHeight > innerHeight + 1 }));
  assert.deepEqual(overflow, { horizontal: false, vertical: false }, `${name}: page overflow.`);
  const touchTargets = await targets(page.locator('button:visible, a:visible, input:visible'), name, { minimum: desktop ? 0 : 44 });
  const canvas = await page.locator('.city-scene canvas').boundingBox();
  assert.ok(canvas && canvas.width > 0 && canvas.height > 0, 'The actual city renderer must occupy visible space.');
  report.layouts.push({ name, width, height, visibleModes: await modes.count(), visibleDistrictSelectors: await tabs.count(), overflow, targets: touchTargets, canvas });
  await screenshot(name);
};

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(sanitize(error.message)));
  page.on('console', message => {
    if (message.type() === 'error') report.errors.push(sanitize(message.text()));
    if (/NaN|BufferGeometry|computeBounding|WebGL.*(?:INVALID|error|lost)/i.test(message.text())) report.geometryWarnings.push(sanitize(message.text()));
  });
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/policy' && request.method() === 'POST') policyRequests++; });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  assert.equal(response.status(), 200);
  const enter = page.getByRole('button', { name: 'Enter the city', exact: true });
  await enter.waitFor({ state: 'visible' });
  await screenshot('01-title-390x844');
  await tap(enter);
  const begin = page.getByRole('button', { name: 'Begin First Light', exact: true });
  await begin.waitFor({ state: 'visible' });
  await targets(begin, 'Quick briefing start');
  await screenshot('02-briefing-390x844');
  report.smallBriefings = [];
  for (const [width, height] of [[320, 568], [375, 667]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(180);
    const touchTargets = await targets(begin, `Briefing ${width}×${height}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'The small briefing must not overflow horizontally.');
    report.smallBriefings.push({ width, height, startVisibleWithinViewport: true, targets: touchTargets });
    await screenshot(`briefing-${width}x${height}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await tap(begin);
  sessionId = await page.evaluate(() => sessionStorage.getItem('cloudbreak.session'));
  assert.ok(sessionId); privateValues.add(sessionId);
  await waitState(current => current.phase === 'running', 'The mission did not start.');
  await layout(390, 844, '03-playing-390x844');

  const beforeSelection = snapshotPolicies(await state()), beforeRequests = policyRequests;
  for (const route of ['accounts', 'dispatch', 'storefront']) await select(route);
  assert.deepEqual(snapshotPolicies(await state()), beforeSelection, 'Selecting districts must not change policies or credits.');
  assert.equal(policyRequests, beforeRequests, 'District selection must not submit a policy request.');
  for (const mode of ['auth', 'rate', 'isolate', 'open']) await setMode('accounts', mode, 'All four mode controls and credit refunds');
  assert.equal(await selected(), 'accounts');
  report.selectionDoesNotMutatePolicies = true;
  report.allFourModesAndCreditRefunds = true;

  await tap(page.getByRole('button', { name: 'Pause game', exact: true }));
  const paused = await waitState(current => current.phase === 'paused', 'Pause did not reach the gateway.');
  const pause = page.locator('.pause-panel');
  const soundToggle = pause.locator('.settings label').filter({ has: page.getByText('Sound', { exact: true }) }).getByRole('button');
  const originalSound = await soundToggle.textContent();
  await tap(soundToggle); assert.notEqual(await soundToggle.textContent(), originalSound);
  await tap(soundToggle); assert.equal(await soundToggle.textContent(), originalSound);
  const musicToggle = pause.locator('.settings label').filter({ has: page.getByText('Background music', { exact: true }) }).getByRole('button');
  const originalMusic = await musicToggle.getAttribute('aria-pressed');
  await tap(musicToggle); assert.notEqual(await musicToggle.getAttribute('aria-pressed'), originalMusic);
  await tap(musicToggle); assert.equal(await musicToggle.getAttribute('aria-pressed'), originalMusic);
  await tap(pause.getByRole('button', { name: 'Quick guide', exact: true }));
  await pause.locator('.mobile-guide').waitFor({ state: 'visible' });
  await screenshot('04-paused-guide-390x844');
  assert.equal((await state()).elapsed, paused.elapsed, 'Reading settings and help must not advance the mission.');
  await tap(pause.getByRole('button', { name: 'Hide quick guide', exact: true }));
  await tap(page.getByRole('button', { name: 'Resume First Light', exact: true }));
  await waitState(current => current.phase === 'running', 'Resume did not reach the gateway.');
  report.pauseSettingsAndGuide = true;

  for (const [width, height] of [[320, 568], [360, 640], [375, 667], [430, 932], [844, 390], [932, 430]]) {
    await defendVisibleSignals('Responsive check');
    await layout(width, height, `playing-${width}x${height}`);
  }
  await layout(1280, 900, 'desktop-1280x900');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(220);

  if (fullRun) {
    await tap(page.getByRole('button', { name: 'Pause game', exact: true }));
    await tap(page.getByRole('button', { name: 'Restart mission', exact: true }));
    await waitState(current => current.phase === 'running' && current.elapsed < 3 && current.credits === 40, 'The real restart must reset the mission.');
    const started = Date.now(); let previousElapsed = 0, lastWave = -1;
    const covered = new Set();
    while (Date.now() - started < 225000) {
      const current = await state();
      assert.notEqual(current.phase, 'lost', 'The mobile touch mission was lost.');
      assert.notEqual(current.phase, 'paused', 'The mission unexpectedly paused.');
      assert.ok(current.elapsed >= previousElapsed); previousElapsed = current.elapsed;
      if (current.phase === 'won') break;
      const selectedBefore = await selected();
      await page.waitForTimeout(220);
      assert.equal(await selected(), selectedBefore, 'Incoming attacks must not auto-select a district.');
      await defendVisibleSignals('Real-time mobile mission');
      const after = await state(), active = signalsForState(after).filter(signal => signal.kind !== 'calm');
      if (after.wave.index !== lastWave) { lastWave = after.wave.index; console.log(`Mobile mission ${after.elapsed.toFixed(1)}s; integrity ${after.integrity}; service ${after.service.toFixed(1)}%.`); }
      for (const signal of active) covered.add(signal.kind);
      if (active.length >= 2 && !report.simultaneousDistrictAwareness) {
        assert.equal(await page.locator('.district-tabs .district-tab:not(.calm):visible').count(), active.length);
        report.simultaneousDistrictAwareness = true;
        await screenshot('mission-overlapping-attacks');
      }
    }
    const final = await state();
    assert.equal(final.phase, 'won'); assert.equal(final.elapsed, 180); assert.ok(final.service >= 75);
    assert.ok(Date.now() - started >= 177000, 'A full mission must consume real wall time.');
    assert.deepEqual([...covered].sort(), ['bad-login', 'breach', 'swarm']);
    const logs = await context.request.get(url + '/api/log?sessionId=' + encodeURIComponent(sessionId));
    assert.equal(logs.status(), 200);
    const records = (await logs.text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(records.length, final.totalRequests);
    assert.equal(records.filter(record => record.role === 'legitimate' && record.status === 200).length, final.legitimateServed);
    assert.equal(records.filter(record => record.role === 'hostile' && record.status !== 200).length, final.hostileBlocked);
    report.mission = { completed: true, wallSeconds: (Date.now() - started) / 1000, phase: final.phase, elapsed: final.elapsed, integrity: final.integrity, service: final.service, totalRequests: final.totalRequests, legitimateServed: final.legitimateServed, legitimateTotal: final.legitimateTotal, hostileBlocked: final.hostileBlocked, hostileAdmitted: final.hostileAdmitted, logCountsReconciled: true };
    // The server can finish between two UI polls. Wait for the actual results
    // DOM before capturing it or measuring its buttons.
    await page.locator('.results-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.results-panel button:visible').count(), 3);
    await targets(page.locator('.results-panel button:visible, .utility button:visible'), 'Post-flight controls');
    await screenshot('mission-complete-390x844');
    await tap(page.getByRole('button', { name: 'Mute sound', exact: true }));
    await page.getByRole('button', { name: 'Unmute sound', exact: true }).waitFor({ state: 'visible' });
    await tap(page.getByRole('button', { name: 'Unmute sound', exact: true }));
    await tap(page.getByRole('button', { name: 'Inspect the flight', exact: true }));
    await page.locator('.evidence-panel').waitFor({ state: 'visible' });
    assert.ok(await page.locator('.request-event').count(), 'The post-flight panel must show real request rows.');
    await screenshot('mission-evidence-390x844');
    await tap(page.getByRole('button', { name: 'Close evidence', exact: true }));
    assert.equal((await state()).phase, 'won', 'Inspecting the result must preserve the completed mission.');
    await tap(page.getByRole('button', { name: 'Fly again', exact: true }));
    await waitState(current => current.phase === 'running' && current.elapsed < 3 && current.credits === 40 && current.routes.every(route => modeForPolicy(route.policy) === 'open'), 'Fly again must start a fresh open mission.');
    await tap(page.getByRole('button', { name: 'Pause game', exact: true }));
    report.postFlight = { visibleTouchTargets: true, muteUnmute: true, actualRequestEvidence: true, flyAgainResetsMission: true };
  } else {
    report.mission = { completed: false, reason: 'FULL_RUN was not requested; responsive/control checks only.' };
    await tap(page.getByRole('button', { name: 'Pause game', exact: true }));
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.geometryWarnings, []);
  report.passed = true;
  console.log(JSON.stringify({ passed: true, responsiveLayouts: report.layouts.length, actualModeActions: report.actions.length, completeRealMission: report.mission.completed }));
} catch (error) {
  report.failure = sanitize(error.stack || error);
  if (page) await screenshot('failure').catch(() => {});
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(resolve(output, 'report.json'), sanitize(JSON.stringify(report, null, 2)) + '\n');
  await browser?.close();
}
