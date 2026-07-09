import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };
async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders }); return r.ok ? r.json() : []; }
  catch (e) { return []; }
}

// Re-rate a gym owner's existing active member subscriptions to the owner's CURRENT
// MTL League tier rate (Shikai 3% at >=3 active, Bankai 2% at >=10, else 3.5%, EP 1%).
// Triggered client-side when the owner crosses a tier. The rate is recomputed server-side
// from the owner's real coach_ref_score,bankai_eligible, so the caller cannot spoof a lower rate — calling
// this can only set the rate to what the owner has legitimately earned. Applies to FUTURE
// invoices only; it never changes what the member pays, only the MTL<->gym split.
export default async function handler(req, res) {
  try {
    const owner = req.query.owner;
    if (!owner) return res.status(400).json({ error: 'missing owner' });

    const prof = (await sbGet(`profiles?id=eq.${encodeURIComponent(owner)}&select=coach_ref_score,partner,bankai_eligible`))[0];
    if (!prof) return res.status(404).json({ error: 'owner not found' });

    const score = prof.coach_ref_score || 0;
    const pct = prof.partner ? 1 : ((score >= 5 && prof.bankai_eligible) ? 2 : (score >= 2 ? 2.5 : 3)); // Stripe track (this cron only re-rates Stripe subscriptions)

    let rerated = 0;
    const gyms = await sbGet(`gyms?owner_id=eq.${encodeURIComponent(owner)}&select=id,stripe_account`);
    for (const g of gyms || []) {
      if (!g.stripe_account) continue;
      const mems = await sbGet(`gym_memberships?gym_id=eq.${encodeURIComponent(g.id)}&status=in.(active,cancelling)&select=stripe_subscription`);
      for (const m of mems || []) {
        if (!m.stripe_subscription) continue;
        try {
          await stripe.subscriptions.update(m.stripe_subscription, { application_fee_percent: pct }, { stripeAccount: g.stripe_account });
          rerated++;
        } catch (e) { console.error('rerate sub', m.stripe_subscription, e.message); }
      }
    }
    res.status(200).json({ ok: true, pct, rerated });
  } catch (err) {
    console.error('gym-rerate', err);
    res.status(500).json({ error: err.message });
  }
}
