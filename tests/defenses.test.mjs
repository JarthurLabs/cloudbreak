import test from 'node:test';
import assert from 'node:assert/strict';
import * as defenses from '../src/defenses.ts';
const { policyForMode, modeForPolicy, canSetMode } = defenses;

test('switching simple modes replaces the complete policy instead of stacking old restrictions', () => {
  const previous = { auth: true, rate: 6, isolated: true };
  assert.equal(modeForPolicy(previous), 'custom');
  const opened = policyForMode('open');
  assert.deepEqual(opened, { auth: false, rate: 0, isolated: false });
  const slowed = policyForMode('rate');
  assert.deepEqual(slowed, { auth: false, rate: 1, isolated: false });
  slowed.isolated = true;
  assert.equal(policyForMode('rate').isolated, false, 'callers cannot mutate the shared preset');
});

test('simultaneous warnings follow each actual target and type, independent of wave index', () => {
  assert.equal(typeof defenses.signalsForState, 'function');
  const state = { wave: { index: 1, threats: [
    { route: 'accounts', threatType: 'breach' },
    { route: 'storefront', threatType: 'swarm' },
    { route: 'dispatch', threatType: 'bad-login' },
  ] } };
  const signals = defenses.signalsForState(state);
  assert.deepEqual(signals.map(({ route, mode }) => ({ route, mode })), [
    { route: 'storefront', mode: 'rate' }, { route: 'accounts', mode: 'isolate' }, { route: 'dispatch', mode: 'auth' },
  ]);
  assert.equal(signals.filter(signal => signal.kind !== 'calm').length, 3);
  assert.match(signals[0].detail, /one per second/i);
});

test('a district cleared during another attack immediately recommends reopening', () => {
  assert.equal(typeof defenses.signalsForState, 'function');
  const signals = defenses.signalsForState({ wave: { index: 7, threats: [{ route: 'accounts', threatType: 'swarm' }] } });
  assert.equal(signals.find(signal => signal.route === 'storefront').mode, 'open');
  assert.equal(signals.find(signal => signal.route === 'dispatch').mode, 'open');
  assert.equal(signals.find(signal => signal.route === 'accounts').mode, 'rate');
});

test('keep protection until the last approaching hostile reaches the gate', () => {
  const wave = { index: 6, threats: [] };
  const incoming = [
    { id: 'last-carrier', route: 'dispatch', role: 'hostile', threatType: 'breach', approachStartedAt: 63.8, decisionAt: 65.8 },
    { id: 'customer', route: 'storefront', role: 'legitimate', threatType: null, approachStartedAt: 64, decisionAt: 66 },
  ];
  assert.equal(defenses.signalsForState({ wave, incoming }).find(s => s.route === 'dispatch').mode, 'isolate');
  assert.equal(defenses.signalsForState({ wave, incoming }).find(s => s.route === 'storefront').mode, 'open');
  assert.equal(defenses.signalsForState({ wave, incoming: incoming.slice(1) }).find(s => s.route === 'dispatch').mode, 'open');
});

test('mode availability includes the credits returned by the current district only', () => {
  assert.equal(canSetMode('auth', { auth: false, rate: 3, isolated: false }, 5), true);
  assert.equal(canSetMode('auth', { auth: false, rate: 0, isolated: false }, 5), false);
  assert.equal(canSetMode('open', { auth: true, rate: 0, isolated: false }, 0), true);
});
