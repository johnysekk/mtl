import Stripe from 'stripe';
import { ladderRate } from './_rate.js';

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
// ---------------------------------------------------------------------------
// THE ONE RULE for what application_fee_percent a membership subscription carries.
//
// This field was being set from THREE places that knew nothing about each other:
//   * pay.js at creation        -> acquisition 20% (10% EP, first month) / ladder
//   * cron-attendance at renewal  -> ALWAYS base, which silently threw the acquisition rate away
//     one invoice early
//   * this file                   -> whatever is correct right now
// PRECEDENCE: acquisition (20 / 10 EP, first month only) beats the provider's ladder rate.
// (Do konce 2026-08 tu byla jeste tretí, prednejsi uroven -- uvitaci okno 0 % na 30 dnu. Zruseno:
//  pri zakladu 2 % na Stripe a 2,5 % na bance uz nemelo co zlevnit.)
// Welcome wins because it is a promise made to the provider; when it ends, the sub lands
// on whatever is correct AT THAT MOMENT (still inside the 2 months -> acquisition; else ladder).
//
// Returns null when it cannot decide (Stripe call failed) -> the caller must CHANGE NOTHING.
// Never guess with someone's money.
async function subRateFor(stripe, acct, subId, sub, ladderPct) {
  // ODSTRANENO: `if (welcomeActive) return 0;`. Uvitaci okno bylo zruseno -- pri zakladu 2 %
  // na Stripe a 2,5 % na bance uz neni co zlevnovat, a to okno stalo za vic kodu na penezni
  // ceste nez samotny zebricek. Zbyva precedence: akvizice > zebricek.
  const md = (sub && sub.metadata) || {};
  if (md.mtl_acq === '1') {
    const pct = parseFloat(md.mtl_acq_pct || '0') || 0;
    if (pct > 0) {
      let paid;
      try {
        const invs = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 3 }, { stripeAccount: acct });
        paid = ((invs && invs.data) || []).length;
      } catch (e) { return null; }            // cannot count -> do not touch the rate
      // CHANGED: was `paid < 2` -- the acquisition rate rode the first TWO paid invoices.
      // Acquisition is now a single 20% (10% EP) charge on the first month only, so it comes
      // off after one. The rule lives in _rate.js; this is the subscription mirror of it.
      if (paid < 1) return pct;               // first month only -> the acquisition rate
    }
  }
  return ladderPct;
}

// Apply it. Returns true if the rate actually changed.
async function applySubRate(stripe, acct, subId, sub, ladderPct) {
  const want = await subRateFor(stripe, acct, subId, sub, ladderPct);
  if (want === null) return false;                                  // undecidable -> leave alone
  const cur = (sub.application_fee_percent != null) ? Number(sub.application_fee_percent) : null;
  if (cur === want) return false;
  const md = Object.assign({}, (sub && sub.metadata) || {});
  if (md.mtl_acq === '1' && want !== 0 && want === ladderPct) md.mtl_acq = 'done';   // window closed
  await stripe.subscriptions.update(subId, { application_fee_percent: want, metadata: md }, { stripeAccount: acct });
  return true;
}

export default async function handler(req, res) {
  try {
    const owner = req.query.owner;
    if (!owner) return res.status(400).json({ error: 'missing owner' });

    const prof = (await sbGet(`profiles?id=eq.${encodeURIComponent(owner)}&select=coach_ref_score,partner,founding,bankai_eligible`))[0];
    if (!prof) return res.status(404).json({ error: 'owner not found' });

    const score = prof.coach_ref_score || 0;
    // Single source of truth -- a local copy of the ladder had drifted: EP was billed 1% instead
    // of 0.5% and founding was not handled at all, so every run raised a Founding Partner's rate.
    const pct = ladderRate('stripe', { partner: prof.partner, founding: prof.founding, score, bankai: prof.bankai_eligible }) * 100;

    let rerated = 0;
    const gyms = await sbGet(`gyms?owner_id=eq.${encodeURIComponent(owner)}&select=id,stripe_account`);
    for (const g of gyms || []) {
      if (!g.stripe_account) continue;
      // Was: blindly set application_fee_percent = pct on EVERY active subscription, which
      // wiped out an open acquisition charge (20%/10% EP).
      // Now every sub goes through the one shared rule.
      const mems = await sbGet(`gym_memberships?gym_id=eq.${encodeURIComponent(g.id)}&status=in.(active,cancelling)&select=stripe_subscription`);
      for (const m of mems || []) {
        if (!m.stripe_subscription) continue;
        try {
          const sub = await stripe.subscriptions.retrieve(m.stripe_subscription, { stripeAccount: g.stripe_account });
          if (await applySubRate(stripe, g.stripe_account, m.stripe_subscription, sub, pct)) rerated++;
        } catch (e) { console.error('rerate sub', m.stripe_subscription, e.message); }
      }
    }
    res.status(200).json({ ok: true, pct, rerated });
  } catch (err) {
    console.error('gym-rerate', err);
    res.status(500).json({ error: err.message });
  }
}
