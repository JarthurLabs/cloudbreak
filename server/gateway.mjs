// Gateway inputs contain no role or generator ground truth. The same policy
// applies to every HTTP client, including a hostile client with valid keys.
export const DEMO_CREDENTIAL = 'Bearer cloudbreak-demo-valid';
export const ROUTES = ['storefront', 'accounts', 'dispatch'];
export const ROUTE_NAMES = { storefront: 'Storefront', accounts: 'Accounts', dispatch: 'Dispatch' };
export const defaultPolicy = () => ({ auth: false, rate: 0, isolated: false });
export const policyCost = policy => Number(policy.auth) * 15 + Number(policy.rate > 0) * 10 + Number(policy.isolated) * 5;

export function validatePolicy(policy) {
  return policy && typeof policy === 'object' && !Array.isArray(policy)
    && typeof policy.auth === 'boolean' && typeof policy.isolated === 'boolean'
    && [0, 1, 3, 6, 12].includes(policy.rate)
    && Object.keys(policy).every(key => ['auth', 'rate', 'isolated'].includes(key));
}

export function gatewayDecision(policy, bucket, authorization, now) {
  if (policy.isolated) return { status: 503, reason: 'route_isolated' };
  if (policy.auth && !authorization) return { status: 401, reason: 'missing_credentials' };
  if (policy.auth && authorization !== DEMO_CREDENTIAL) return { status: 401, reason: 'invalid_credentials' };
  if (policy.rate) {
    bucket.tokens = Math.min(policy.rate, bucket.tokens + Math.max(0, now - bucket.updatedAt) / 1_000 * policy.rate);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) return { status: 429, reason: 'rate_limited' };
    bucket.tokens -= 1;
  }
  return { status: 200, reason: 'accepted' };
}

// Preset changes preserve tokens already earned. Neither changing capacity nor
// switching off/on grants a new burst. Refill also freezes with mission time.
export function updateRateLimit(bucket, previousRate, nextRate, now) {
  if (previousRate) bucket.tokens = Math.min(previousRate, bucket.tokens + Math.max(0, now - bucket.updatedAt) / 1_000 * previousRate);
  bucket.updatedAt = now;
  if (!bucket.initialized && nextRate) {
    bucket.tokens = nextRate;
    bucket.initialized = true;
  } else if (nextRate) bucket.tokens = Math.min(nextRate, bucket.tokens);
}
