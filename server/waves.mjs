export const DURATION = 180;
export const DAMAGE_PER_HOSTILE = 0.3;
// Leave time to read a warning and correct a mistake; admitted carriers still hit hardest.
export const THREAT_DAMAGE = Object.freeze({ 'bad-login': DAMAGE_PER_HOSTILE, swarm: 0.1, breach: 2 });
export const SERVICE_TARGET = 75;
export const SCORE_FORMULA = 'Score = 5 × legitimate requests served + round(10 × integrity) + economy bonus. Economy bonus = round(1000 × average unreserved credits ÷ 40), measured over active mission time.';

// One finite, seeded opening mission. Rates are authored requests per second.
// Attack streams are independent; the gateway receives none of this metadata.
const attack = (route, threatType, rate) => ({ route, threatType, rate, credential: threatType === 'bad-login' ? 'invalid' : 'valid' });
export const WAVES = [
  { start: 0, end: 14, title: 'First light', hint: 'Let customers through. Pick a district and inspect its controls.', customers: [3, 2, 1], attacks: [] },
  { start: 14, end: 28, title: 'Bad logins', hint: 'Storefront: bad logins have invalid keys. Choose Key check.', customers: [1, 2, 1], attacks: [attack('storefront', 'bad-login', 6)] },
  { start: 28, end: 32, title: 'Open for everyone', hint: 'All clear. Choose Open in every district to welcome customers without delays.', customers: [6, 3, 2], attacks: [] },
  { start: 32, end: 48, title: 'Account swarm', hint: 'Accounts: a fast swarm has valid keys. Choose Slow flow to reduce the rush.', customers: [3, 1, 1], attacks: [attack('accounts', 'swarm', 8)] },
  { start: 48, end: 52, title: 'A little breathing room', hint: 'All clear. Choose Open in every district to let customers through.', customers: [6, 3, 2], attacks: [] },
  { start: 52, end: 64, title: 'Breach carriers', hint: 'Dispatch: slow carriers have valid keys and hit hard. Choose Close bridge to stop every carrier.', customers: [3, 2, 1], attacks: [attack('dispatch', 'breach', 1)] },
  { start: 64, end: 70, title: 'Reconnect the city', hint: 'All clear. Choose Open in every district to restore service.', customers: [6, 3, 2], attacks: [] },
  { start: 70, end: 90, title: 'Two fronts', hint: 'Accounts: choose Key check for bad logins. Dispatch: choose Slow flow for the swarm.', customers: [3, 2, 0.75], attacks: [attack('accounts', 'bad-login', 4), attack('dispatch', 'swarm', 6)] },
  { start: 90, end: 96, title: 'Room to recover', hint: 'All clear. Choose Open in every district and welcome customers back.', customers: [6, 3, 2], attacks: [] },
  { start: 96, end: 114, title: 'Heavy weather', hint: 'Storefront: choose Close bridge for carriers. Dispatch: choose Key check for bad logins.', customers: [0.75, 3, 1], attacks: [attack('storefront', 'breach', 0.7), attack('dispatch', 'bad-login', 4)] },
  { start: 114, end: 120, title: 'Bridges open', hint: 'All clear. Choose Open in every district to keep service moving.', customers: [6, 3, 2], attacks: [] },
  { start: 120, end: 138, title: 'Changing course', hint: 'Storefront: choose Slow flow for the swarm. Accounts: choose Close bridge for carriers.', customers: [1, 0.5, 2], attacks: [attack('storefront', 'swarm', 6), attack('accounts', 'breach', 0.7)] },
  { start: 138, end: 144, title: 'Catch your breath', hint: 'All clear. Choose Open in every district before the final rush.', customers: [6, 3, 2], attacks: [] },
  { start: 144, end: 169, title: 'Across the skyline', hint: 'Dispatch: Key check for bad logins. Accounts: Slow flow for the swarm. Storefront: Close bridge for carriers.', customers: [0.5, 1, 1.5], attacks: [attack('dispatch', 'bad-login', 4), attack('accounts', 'swarm', 6), attack('storefront', 'breach', 0.7)] },
  { start: 169, end: 180, title: 'Clear skies', hint: 'All clear. Choose Open in every district and welcome everyone home.', customers: [6, 3, 2], attacks: [] },
];

export function waveAt(elapsed) {
  const found = WAVES.findIndex(wave => elapsed < wave.end);
  const index = found < 0 ? WAVES.length - 1 : found;
  const wave = WAVES[index];
  const first = wave.attacks[0];
  return { ...wave, index, threat: Boolean(first), target: first?.route ?? null, threatType: first?.threatType ?? null };
}

export function seededRandom(seed = 0xc10db4ea) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
