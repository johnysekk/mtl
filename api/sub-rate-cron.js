// =============================================================================
// SUB-RATE CRON — the safety net under the acquisition drop.
// vercel.json: { "path": "/api/sub-rate-cron", "schedule": "0 4 * * *" }
// =============================================================================
// The acquisition window is closed by stripe-webhook.js on invoice.paid. That is the right
// place — it is exact and event-driven. But a webhook is a single point of failure: one
// missed delivery and that subscription sits at 10% forever, silently, and nobody finds out
// until a gym owner does the arithmetic and stops trusting us.
//
// So once a day we sweep the young subscriptions and put each one on the rate it should
// actually be on. It is idempotent and almost always a no-op — it exists precisely for the
// day it isn't.
//
// SCOPE: memberships created in the last 120 days. The acquisition window is 2 months, so
// 120 days covers it with a wide margin; past that there is nothing left to close, and
// sweeping every membership on the platform forever would be a Stripe call per member per
// day for no reason.
//
// The rate rule itself lives in ONE place, duplicated verbatim into every file that sets
// application_fee_percent (pay.js at creation, stripe-webhook.js on invoice.paid,
// cron-attendance.js when a welcome window ends, gym-rerate.js when an owner crosses a tier,
// and here). They were four different rules once. That was the bug.
// =============================================================================
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
import { ladderRate as _mtlLadder } from './_rate.js';

async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; }
  catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// THE ONE RULE for what application_fee_percent a membership subscription carries.
// PRECEDENCE: welcome (0) beats acquisition (10 / 5, first two paid invoices) beats the
// provider's current ladder rate. Welcome wins because it is a promise made to the provider;
// when it ends, the sub lands on whatever is correct AT THAT MOMENT.
// Returns null when it cannot decide (a Stripe call failed) -> the caller CHANGES NOTHING.
// Never guess with someone's money.
async function subRateFor(stripe, acct, subId, sub, ladderPct, welcomeActive) {
  if (welcomeActive) return 0;
  const md = (sub && sub.metadata) || {};
  if (md.mtl_acq === '1') {
    const pct = parseFloat(md.mtl_acq_pct || '0') || 0;
    if (pct > 0) {
      let paid;
      try {
        const invs = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 3 }, { stripeAccount: acct });
        paid = ((invs && invs.data) || []).length;
      } catch (e) { return null; }            // cannot count -> do not touch the rate
      if (paid < 2) return pct;               // first two months -> the acquisition rate
    }
  }
  return ladderPct;
}

async function applySubRate(stripe, acct, subId, sub, ladderPct, welcomeActive) {
  const want = await subRateFor(stripe, acct, subId, sub, ladderPct, welcomeActive);
  if (want === null) return false;
  const cur = (sub.application_fee_percent != null) ? Number(sub.application_fee_percent) : null;
  if (cur === want) return false;
  const md = Object.assign({}, (sub && sub.metadata) || {});
  if (md.mtl_acq === '1' && want !== 0 && want === ladderPct) md.mtl_acq = 'done';   // window closed
  await stripe.subscriptions.update(subId, { application_fee_percent: want, metadata: md }, { stripeAccount: acct });
  return true;
}

// Stripe track (subscriptions are always Stripe): EP 1% | Bankai 2% | Shikai 2.5% | base 3%.
function ladderOf(p) {
  if (!p) return 3;
  return _mtlLadder('stripe', { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible }) * 100;
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const out = { checked: 0, fixed: 0, skipped: 0, errors: [] };
  try {
    const since = new Date(Date.now() - 120 * 86400000).toISOString();
    const mems = await sbGet(
      `gym_memberships?status=in.(active,cancelling)&stripe_subscription=not.is.null` +
      `&created_at=gte.${encodeURIComponent(since)}&select=stripe_subscription,gym_id,coach_id,paid_to&limit=1000`
    );

    const gymCache = {}, profCache = {};
    for (const m of (mems || [])) {
      if (!m.stripe_subscription) continue;
      out.checked++;
      try {
        // Who owns this money, and therefore whose rate applies?
        let ownerId = null, acct = null, entWelcome = null;
        if (m.paid_to === 'coach' && m.coach_id) {
          ownerId = m.coach_id;
        } else if (m.gym_id) {
          if (gymCache[m.gym_id] === undefined) {
            gymCache[m.gym_id] = (await sbGet(`gyms?id=eq.${m.gym_id}&select=owner_id,stripe_account,gym_payout_account,welcome_free_until`))[0] || null;
          }
          const g = gymCache[m.gym_id];
          if (!g) { out.skipped++; continue; }
          ownerId = g.owner_id;
          acct = g.gym_payout_account || g.stripe_account;
          entWelcome = g.welcome_free_until;
        }
        if (!ownerId) { out.skipped++; continue; }

        if (profCache[ownerId] === undefined) {
          profCache[ownerId] = (await sbGet(`profiles?id=eq.${ownerId}&select=partner,founding,coach_ref_score,bankai_eligible,stripe_account,gym_payout_account,welcome_free_until`))[0] || null;
        }
        const p = profCache[ownerId];
        if (!p) { out.skipped++; continue; }
        if (!acct) acct = p.gym_payout_account || p.stripe_account;
        if (!acct) { out.skipped++; continue; }

        // The welcome window can sit on the gym row or the owner's profile - whichever is set.
        const wUntil = entWelcome || p.welcome_free_until;
        const wActive = !!(wUntil && new Date(wUntil).getTime() > Date.now());

        const sub = await stripe.subscriptions.retrieve(m.stripe_subscription, { stripeAccount: acct });
        if (await applySubRate(stripe, acct, m.stripe_subscription, sub, ladderOf(p), wActive)) out.fixed++;
      } catch (e) {
        out.errors.push(`${m.stripe_subscription}: ${e.message}`);
      }
    }
    return res.status(200).json(out);
  } catch (e) {
    console.error('sub-rate-cron', e);
    return res.status(500).json({ error: e.message, ...out });
  }
}
