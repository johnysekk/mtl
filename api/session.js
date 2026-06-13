import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SB = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders }); return r.ok ? r.json() : []; }
  catch (e) { return []; }
}
async function sbPost(path, body) {
  try { await fetch(`${SB}/rest/v1/${path}`, { method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(body) }); }
  catch (e) { console.error('sbPost', e.message); }
}

// Record a transaction with EXACT Stripe fees (idempotent on payment_intent).
// Backstop so the ledger is correct even if the Stripe webhook isn't delivering
// connected-account events. Mirrors stripe-webhook.js recordTransaction.
async function recordTransaction(acct, pi, fields) {
  if (!pi) return 'no-pi';
  try {
    const ex = await sbGet(`transactions?payment_intent=eq.${encodeURIComponent(pi)}&select=id`);
    if (ex && ex.length) return 'exists'; // already recorded (webhook or a previous call)
    let gross = null, stripeFee = null, mtlFee = null, net = null, currency = fields.currency || null, chargeId = null;
    if (acct) {
      try {
        let ch = null;
        if (String(pi).startsWith('ch_')) { ch = await stripe.charges.retrieve(pi, { expand: ['balance_transaction'] }, { stripeAccount: acct }); }
        else { const intent = await stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge.balance_transaction'] }, { stripeAccount: acct }); ch = intent && intent.latest_charge; }
        if (ch) {
          chargeId = ch.id; gross = ch.amount; currency = ch.currency; mtlFee = ch.application_fee_amount || 0;
          const bt = ch.balance_transaction;
          if (bt) { stripeFee = bt.fee; net = bt.net - mtlFee; } else if (gross != null) { net = gross - mtlFee; }
        }
      } catch (e) { console.error('recordTransaction fee', e.message); }
    }
    await sbPost('transactions', {
      payment_intent: pi, charge_id: chargeId, payee_account: acct || null, type: fields.type,
      member_id: fields.member_id || null, coach_id: fields.coach_id || null, gym_id: fields.gym_id || null, plan: fields.plan || null,
      gross_amount: gross, stripe_fee: stripeFee, mtl_fee: mtlFee, net_amount: net, currency,
      status: 'paid', created_at: new Date().toISOString(),
    });
    return 'recorded';
  } catch (e) { console.error('recordTransaction', e.message); return 'error:' + e.message; }
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

    // Record the transaction from the session metadata (idempotent). This guarantees the
    // ledger + accounting export are correct even when the Stripe webhook isn't delivering
    // connected-account events. Direct charges live on the connected (gym/coach) account.
    let _tx = { recorded: false, reason: 'handler did not run' };
    try {
      const m = session.metadata || {};
      let payId = (session.payment_intent && (typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent.id)) || null;
      if (!payId) {
        let invId = (session.invoice && (typeof session.invoice === 'string' ? session.invoice : session.invoice.id)) || null;
        if (!invId && session.subscription) { try { const sub = await stripe.subscriptions.retrieve(typeof session.subscription === 'string' ? session.subscription : session.subscription.id, opts); invId = sub.latest_invoice && (typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice.id); } catch (e) {} }
        if (invId) { try { const inv = await stripe.invoices.retrieve(invId, opts); payId = (inv.payment_intent && (typeof inv.payment_intent === 'string' ? inv.payment_intent : inv.payment_intent.id)) || (inv.charge && (typeof inv.charge === 'string' ? inv.charge : inv.charge.id)); } catch (e) {} }
      }
      let txType = null; const f = { currency: m.mtl_currency || session.currency };
      if (m.mtl_payment_type === 'membership') { txType = 'membership'; f.member_id = m.student_id; f.gym_id = m.gym_id; f.plan = m.mtl_plan || 'Membership'; }
      else if (m.mtl_payment_type === 'drop_in') { txType = 'drop_in'; f.member_id = m.student_id || m.member_id; f.gym_id = m.gym_id; f.coach_id = m.coach_id || m.coach_profile_id || null; f.plan = m.mtl_plan || 'Drop-in'; }
      else if (m.mtl_payment_type === 'event_ticket') { txType = 'event_ticket'; f.member_id = m.student_id || m.buyer_id; f.gym_id = m.gym_id; f.coach_id = m.payout_coach_id || null; f.plan = m.mtl_event || 'Event'; }
      else if (m.booking_type === 'inperson' || m.booking_type === 'online') { txType = (m.booking_type === 'online') ? 'coach_online' : 'coach_inperson'; f.member_id = m.student_id; f.coach_id = m.coach_profile_id; f.plan = m.online_fmt || 'Lekce 1:1'; f.currency = m.booking_currency || session.currency; }
      if (!txType) _tx = { recorded: false, reason: 'no mtl_payment_type / booking_type in the session metadata — redeploy pay.js (LX/LY) and make a NEW payment; old sessions have no metadata' };
      else if (!payId) _tx = { recorded: false, reason: 'could not resolve a payment id from the session (subscription invoice may lack payment_intent/charge on this API version)', txType };
      else if (!gymAccount) _tx = { recorded: false, reason: 'no gymAccount/acct passed to /api/session', txType, payId };
      else { const st = await recordTransaction(gymAccount, payId, { type: txType, ...f }); _tx = { recorded: (st === 'recorded' || st === 'exists'), status: st, txType, payId, gymAccount }; }
    } catch (e) { _tx = { recorded: false, reason: 'exception: ' + e.message }; }

    res.status(200).json({
      paymentIntent: session.payment_intent || null,
      subscription: session.subscription || null,
      customer: session.customer || null,
      customerEmail: (session.customer_details && session.customer_details.email) || session.customer_email || null,
      customerName: (session.customer_details && session.customer_details.name) || null,
      _tx,
    });
  } catch (err) {
    console.error('session error:', err);
    res.status(500).json({ error: err.message });
  }
}
