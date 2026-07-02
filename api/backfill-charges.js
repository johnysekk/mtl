// /api/backfill-charges?key=YOUR_BACKFILL_KEY
// One-time (safe to re-run): syncs charges_enabled for ALL connected Stripe accounts
// into profiles + gyms. Run this AFTER charges-enabled.sql and BEFORE enabling the
// listing filter, so legit providers aren't hidden.
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKFILL_KEY
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function sbPatch(table, filter, patch) {
  await fetch(`${SB}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}
module.exports = async (req, res) => {
  if (!process.env.BACKFILL_KEY || req.query.key !== process.env.BACKFILL_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  let synced = 0, ready = 0, starting_after;
  try {
    while (true) {
      const page = await stripe.accounts.list(starting_after ? { limit: 100, starting_after } : { limit: 100 });
      for (const a of page.data) {
        const ce = !!a.charges_enabled;
        await sbPatch('profiles', `stripe_account=eq.${encodeURIComponent(a.id)}`, { charges_enabled: ce });
        await sbPatch('gyms', `stripe_account=eq.${encodeURIComponent(a.id)}`, { charges_enabled: ce });
        synced++; if (ce) ready++;
      }
      if (!page.has_more || !page.data.length) break;
      starting_after = page.data[page.data.length - 1].id;
    }
    return res.status(200).json({ ok: true, accounts_synced: synced, charges_enabled_true: ready });
  } catch (e) {
    return res.status(500).json({ error: e.message, synced_before_error: synced });
  }
};
