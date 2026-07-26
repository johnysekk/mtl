// ── MTL Test Mode helper (shared by serverless) ──────────────────────────────────────────────────
// isTestMode() reads platform_config.test_mode via the service role (bypasses RLS), cached briefly.
// getStripe() returns a Stripe client keyed to the current mode. STEP 1 only DEFINES these; the
// payment files start calling getStripe() in step 3. Until STRIPE_SECRET_KEY_TEST/LIVE are set on
// Vercel, both fall back to the existing STRIPE_SECRET_KEY, so nothing breaks in the meantime.
import Stripe from 'stripe';

const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _cache = { v: null, t: 0 };
const _TTL = 15000; // 15s: fresh enough for a mode flip, cheap enough to call per request

export async function isTestMode() {
  if (_cache.v !== null && (Date.now() - _cache.t) < _TTL) return _cache.v;
  try {
    const r = await fetch(`${_SUPA}/rest/v1/platform_config?id=eq.1&select=test_mode`, {
      headers: { apikey: _KEY, Authorization: `Bearer ${_KEY}` }
    });
    const j = await r.json();
    const v = !!(Array.isArray(j) && j[0] && j[0].test_mode);
    _cache = { v, t: Date.now() };
    return v;
  } catch (e) {
    // On a transient read error keep the last known value; if we never had one, assume LIVE (false)
    // so we preserve current behaviour. Step 3 revisits this fail-safe once getStripe() is wired in.
    return _cache.v === null ? false : _cache.v;
  }
}

export async function getStripe() {
  const test = await isTestMode();
  const key = test
    ? (process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY)
    : (process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY);
  return new Stripe(key);
}
