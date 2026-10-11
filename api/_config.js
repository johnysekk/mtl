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

// MINIMÁLNÍ ČÁSTKA PRO STRŽENÍ PROVIZE Z KARTY: 50 Kč a zaokrouhlený ekvivalent v ostatních
// měnách (podle kurzu ECB, podzim 2026). Pod touhle částkou se provize nestrhává -- zůstane
// 'pending', přičte se k dalšímu měsíci a strhne se, až minimum přeteče. Stripe sám bere od
// 15 Kč, ale u malých částek by jeho poplatek snědl většinu a každé stržení je pro poskytovatele
// další položka na výpisu. Částky v haléřích / centech (u HUF ve fillérech).
// Používá commission-cron (kdy strhnout, upozornění před stržením) i unified-doklad-cron.
export const MIN_CHARGE = { czk: 5000, eur: 200, usd: 235, gbp: 175, chf: 190, pln: 870, huf: 80000, sek: 2300, dkk: 1500, nok: 2400 };
// Měna mimo seznam: 2 jednotky (řádově 50 Kč u CAD/AUD/NZD apod.).
export const minChargeFor = (cur) => MIN_CHARGE[String(cur || 'czk').toLowerCase()] || 200;
