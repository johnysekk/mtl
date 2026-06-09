import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SB = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders }); return r.ok ? r.json() : []; }
  catch (e) { return []; }
}

// Gym member referral – reward the referrer (option A):
// the referrer gets the SAME % off ONE upcoming month on their own running
// membership at the same gym (one-time coupon, paid from the gym's share).
// Fully guarded: silently no-ops if the referrer has no active subscription there.
async function rewardReferrer({ refUser, refPct, gymId, gymAccount }) {
  const pct = parseInt(refPct, 10) || 0;
  if (!refUser || !gymId || !gymAccount || pct <= 0 || pct > 100) return;
  try {
    const rows = await sbGet(
      `gym_memberships?student_id=eq.${encodeURIComponent(refUser)}&gym_id=eq.${encodeURIComponent(gymId)}&status=in.(active,cancelling)&select=stripe_subscription&order=created_at.desc&limit=1`
    );
    const sub = rows && rows[0] && rows[0].stripe_subscription;
    if (!sub) return; // referrer isn't a paying member here → nothing to discount
    const coupon = await stripe.coupons.create(
      { percent_off: pct, duration: 'once', name: `MTL referral reward -${pct}%` },
      { stripeAccount: gymAccount }
    );
    await stripe.subscriptions.update(sub, { coupon: coupon.id }, { stripeAccount: gymAccount });
  } catch (e) { console.error('rewardReferrer failed', e && e.message); }
}

// Vrátí detaily checkout session.
// Pro gym flows (direct charge / subscription) je session vytvořená NA connected accountu,
// takže se musí retrievnout s { stripeAccount: gymAccount }.
export default async function handler(req, res) {
  try {
    const { sessionId, gymAccount, refUser, refPct, gymId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'Chybí sessionId' });

    const opts = gymAccount ? { stripeAccount: gymAccount } : undefined;
    const session = await stripe.checkout.sessions.retrieve(sessionId, opts);

    // Reward the person who referred this new member (best-effort, non-blocking for the response).
    if (refUser && refPct && gymId && gymAccount) {
      await rewardReferrer({ refUser, refPct, gymId, gymAccount });
    }

    res.status(200).json({
      paymentIntent: session.payment_intent || null,
      subscription: session.subscription || null,
      customer: session.customer || null,
      customerEmail: (session.customer_details && session.customer_details.email) || session.customer_email || null,
      customerName: (session.customer_details && session.customer_details.name) || null,
    });
  } catch (err) {
    console.error('session error:', err);
    res.status(500).json({ error: err.message });
  }
}
