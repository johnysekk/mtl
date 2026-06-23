import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders }); return r.ok ? r.json() : []; }
  catch (e) { return []; }
}
async function sbPost(path, body) {
  const url = `${SB}/rest/v1/${path}`;
  try {
    const r = await fetch(url, { method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('sbPost', r.status, url, t); return { ok: false, status: r.status, error: t.slice(0, 300), url }; }
    return { ok: true, status: r.status };
  } catch (e) { console.error('sbPost', e.message); return { ok: false, status: 0, error: e.message, url }; }
}
async function sbPatch(path, body) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('sbPatch', r.status, t); return { ok: false, status: r.status, error: t.slice(0, 300) }; }
    return { ok: true, status: r.status };
  } catch (e) { console.error('sbPatch', e.message); return { ok: false, status: 0, error: e.message }; }
}

// Record a transaction with EXACT Stripe fees (idempotent on payment_intent).
// Backstop so the ledger is correct even if the Stripe webhook isn't delivering
// connected-account events. Mirrors stripe-webhook.js recordTransaction.
async function recordTransaction(acct, pi, fields) {
  if (!pi) return { status: 'no-pi' };
  try {
    // idempotent, but FIX rows that were previously saved with null money
    const ex = await sbGet(`transactions?payment_intent=eq.${encodeURIComponent(pi)}&select=id,gross_amount`);
    const existing = ex && ex.length ? ex[0] : null;
    if (existing && existing.gross_amount != null) return { status: 'exists', gross: existing.gross_amount };

    let gross = null, stripeFee = null, mtlFee = null, net = null, currency = fields.currency || null, chargeId = null;
    if (acct) {
      try {
        // resolve the CHARGE object explicitly (expand can return latest_charge as a string id)
        let ch = null;
        if (String(pi).startsWith('ch_')) {
          ch = await stripe.charges.retrieve(pi, { expand: ['balance_transaction'] }, { stripeAccount: acct });
        } else {
          const intent = await stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge.balance_transaction'] }, { stripeAccount: acct });
          ch = intent && intent.latest_charge;
          if (typeof ch === 'string') ch = await stripe.charges.retrieve(ch, { expand: ['balance_transaction'] }, { stripeAccount: acct });
        }
        if (ch && typeof ch === 'object') {
          chargeId = ch.id; currency = ch.currency || currency;
          let bt = ch.balance_transaction;
          if (typeof bt === 'string') { try { bt = await stripe.balanceTransactions.retrieve(bt, { stripeAccount: acct }); } catch (e) {} }
          if (bt && typeof bt === 'object') {
            // Direct charges: connected-account balance_transaction.fee is the COMBINED fee
            // (Stripe processing + our application fee); .net already nets BOTH out.
            // Split them via fee_details so we can report each separately. net = bt.net (no extra subtraction).
            gross = bt.amount; net = bt.net; currency = bt.currency || currency;
            let sFee = 0, aFee = 0;
            if (Array.isArray(bt.fee_details)) {
              for (const fd of bt.fee_details) {
                if (fd.type === 'stripe_fee') sFee += fd.amount;
                else if (fd.type === 'application_fee') aFee += fd.amount;
              }
            }
            if (sFee === 0 && aFee === 0) { aFee = ch.application_fee_amount || 0; sFee = (bt.fee || 0) - aFee; }
            stripeFee = sFee; mtlFee = aFee;
          } else {
            gross = ch.amount; mtlFee = ch.application_fee_amount || 0; net = gross - mtlFee;
          }
        }
      } catch (e) { console.error('recordTransaction fee', e.message); return { status: 'fee-error:' + e.message }; }
    }
    if (gross == null) return { status: 'no-charge-data', payId: pi };

    // WELCOME 0%: a REFERRED provider's first 30 days = MTL takes 0% (we refund our application fee
    // back to them). The window opens at their FIRST sale (set once here) and is checked PER CHARGE, so a
    // membership renewal that bills after 30 days pays the normal rate — it can NEVER become "0% forever".
    let welcomeFreed = false;
    try {
      if (!existing && mtlFee > 0) {
        let prov = null;
        if (fields.coach_id) {
          const cp = await sbGet(`profiles?id=eq.${fields.coach_id}&select=id,referred_by,welcome_free_until,stripe_account,gym_payout_account`);
          const c = cp && cp[0];
          if (c && (c.stripe_account === acct || c.gym_payout_account === acct)) prov = c;
        }
        if (!prov && fields.gym_id) {
          const gy = await sbGet(`gyms?id=eq.${fields.gym_id}&select=owner_id`);
          const oid = gy && gy[0] && gy[0].owner_id;
          if (oid) { const op = await sbGet(`profiles?id=eq.${oid}&select=id,referred_by,welcome_free_until`); prov = op && op[0]; }
        }
        if (prov && prov.referred_by) {
          const nowMs = Date.now();
          let until = prov.welcome_free_until ? new Date(prov.welcome_free_until).getTime() : null;
          if (until == null) { // first sale -> open the 30-day welcome window once
            until = nowMs + 30 * 86400000;
            await sbPatch(`profiles?id=eq.${prov.id}`, { welcome_free_until: new Date(until).toISOString() });
          }
          if (nowMs < until) {
            const fees = await stripe.applicationFees.list({ charge: chargeId, limit: 1 });
            const feeId = fees && fees.data && fees.data[0] && fees.data[0].id;
            if (feeId) { await stripe.applicationFees.createRefund(feeId); welcomeFreed = true; }
          }
        }
      }
    } catch (e) { console.error('welcome 0% refund', e.message); }

    const row = {
      charge_id: chargeId, payee_account: acct || null, type: fields.type,
      member_id: fields.member_id || null, coach_id: fields.coach_id || null, gym_id: fields.gym_id || null, plan: fields.plan || null, discipline: fields.discipline || null,
      gross_amount: gross, stripe_fee: stripeFee, mtl_fee: mtlFee, mtl_fee_refunded: (welcomeFreed ? mtlFee : 0), net_amount: net, currency, status: 'paid',
      income_class: fields.income_class || null,
    };
    if (existing) {
      const pr = await sbPatch(`transactions?payment_intent=eq.${encodeURIComponent(pi)}`, row);
      if (pr && pr.ok === false) return { status: 'update-failed', http: pr.status, dberror: pr.error, gross, stripeFee, mtlFee, net };
      return { status: 'updated', gross, stripeFee, mtlFee, net };
    }
    const ir = await sbPost('transactions', { payment_intent: pi, ...row, created_at: new Date().toISOString() });
    if (ir && ir.ok === false) return { status: 'insert-failed', http: ir.status, dberror: ir.error, dburl: ir.url, gross, stripeFee, mtlFee, net };
    return { status: 'recorded', gross, stripeFee, mtlFee, net };
  } catch (e) { console.error('recordTransaction', e.message); return { status: 'error:' + e.message }; }
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
      let txType = null; const f = { currency: m.mtl_currency || session.currency, income_class: m.mtl_income || null };
      if (m.mtl_payment_type === 'membership') { txType = 'membership'; f.member_id = m.student_id; f.gym_id = m.gym_id; f.plan = m.mtl_plan || 'Membership'; }
      else if (m.mtl_payment_type === 'drop_in') { txType = 'drop_in'; f.member_id = m.student_id || m.member_id; f.gym_id = m.gym_id; f.coach_id = m.coach_id || m.coach_profile_id || null; f.plan = m.mtl_plan || 'Drop-in'; f.discipline = m.discipline || m.disc || null; }
      else if (m.mtl_payment_type === 'merch') { txType = 'merch'; f.member_id = m.student_id; f.gym_id = m.gym_id; f.plan = m.merch_name || m.mtl_plan || 'Merch'; }
      else if (m.mtl_payment_type === 'event_ticket') { txType = 'event_ticket'; f.member_id = m.student_id || m.buyer_id; f.gym_id = m.gym_id; f.coach_id = m.payout_coach_id || null; f.plan = m.mtl_event || 'Event'; }
      else if (m.booking_type === 'inperson' || m.booking_type === 'online') { txType = (m.booking_type === 'online') ? 'coach_online' : 'coach_inperson'; f.member_id = m.student_id; f.coach_id = m.coach_profile_id; f.plan = m.online_fmt || 'Lekce 1:1'; f.currency = m.booking_currency || session.currency; f.discipline = m.discipline || null; }
      if (!txType) _tx = { recorded: false, reason: 'no mtl_payment_type / booking_type in the session metadata — redeploy pay.js (LX/LY) and make a NEW payment; old sessions have no metadata' };
      else if (!payId) _tx = { recorded: false, reason: 'could not resolve a payment id from the session (subscription invoice may lack payment_intent/charge on this API version)', txType };
      else if (!gymAccount) _tx = { recorded: false, reason: 'no gymAccount/acct passed to /api/session', txType, payId };
      else { const r = await recordTransaction(gymAccount, payId, { type: txType, ...f }); _tx = { recorded: ['recorded','updated','exists'].includes(r.status), ...r, txType, payId, gymAccount, gymId: f.gym_id, memberId: f.member_id }; }
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
