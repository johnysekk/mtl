import Stripe from 'stripe';
import { recordTransaction as recordStripeTransaction } from './stripe-webhook.js';

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
// PATCH that RETURNS the affected rows, so a conditional update can be tested for "did I actually
// change anything". sbPatch uses return=minimal and cannot answer that.
async function sbPatchRet(path, body) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=representation' }, body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('sbPatchRet', r.status, t); return []; }
    const j = await r.json().catch(() => []);
    return Array.isArray(j) ? j : [];
  } catch (e) { console.error('sbPatchRet', e.message); return []; }
}
async function sbPatch(path, body) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('sbPatch', r.status, t); return { ok: false, status: r.status, error: t.slice(0, 300) }; }
    return { ok: true, status: r.status };
  } catch (e) { console.error('sbPatch', e.message); return { ok: false, status: 0, error: e.message }; }
}

// Zapis transakce je jediny, ve stripe-webhook.js (recordTransaction). Vlastni kopie tady byla
// chudsi a podle toho, kdo vyhral souboj s webhookem, se transakce lisila.

// Vrátí detaily checkout session.
// Pro gym flows (direct charge / subscription) je session vytvořená NA connected accountu,
// takže se musí retrievnout s { stripeAccount: gymAccount }.
async function rewardReferrer({ refUser, refPct, gymId, gymAccount, subId }) {
  try {
    let pct = parseInt(refPct, 10) || 0;
    if (!refUser || !gymId || pct <= 0) return;
    // Defense in depth: clamp to the gym's configured member_ref_pct even though pay.js
    // already did - this function must stay safe even if a caller changes.
    try {
      const _g = (await sbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=member_ref_pct`))[0];
      const _mx = (_g && parseInt(_g.member_ref_pct, 10)) || 0;
      pct = Math.min(pct, _mx);
      if (pct <= 0) return;                                  // referral off at the gym
    } catch (e) { return; }                                  // cannot verify -> no reward
    // DEDUP: one reward per checkout subscription. Without this, refreshing the success page
    // re-ran the whole thing (another coupon / another pending credit row) every time.
    if (subId) {
      try {
        const _sub = await stripe.subscriptions.retrieve(subId, gymAccount ? { stripeAccount: gymAccount } : undefined);
        if (_sub && _sub.metadata && _sub.metadata.mtl_ref_rewarded === '1') return;   // already done
      } catch (e) {}
    }
    // GATE: the referrer must CURRENTLY be an active member of this gym, otherwise no reward at all.
    const mem = await sbGet(`gym_memberships?select=stripe_subscription&student_id=eq.${encodeURIComponent(refUser)}&gym_id=eq.${encodeURIComponent(gymId)}&status=in.(active,cancelling)`);
    if (!mem || !mem.length) return;
    // Prefer discounting the referrer's NEXT Stripe invoice directly when they hold an active
    // subscription here (one-time coupon on the connected account); otherwise leave a pending credit
    // they redeem on their next QR/cash membership at reception. Never both.
    let stripeApplied = false;
    if (gymAccount) {
      try {
        const subRow = mem.find(m => m.stripe_subscription);
        const sub = subRow && subRow.stripe_subscription;
        if (sub) {
          const coupon = await stripe.coupons.create({ percent_off: pct, duration: 'once', name: `MTL referral -${pct}%` }, { stripeAccount: gymAccount });
          await stripe.subscriptions.update(sub, { discounts: [{ coupon: coupon.id }] }, { stripeAccount: gymAccount });
          stripeApplied = true;
        }
      } catch (e) { console.error('referrer stripe coupon', e.message); }
    }
    if (stripeApplied) {
      await sbPost('notifications', { user_id: refUser, type: 'system', read: false, data: JSON.stringify({ kind: 'gym_member_ref_reward', gym_id: gymId, pct, msg_en: '🎁 Your referral joined! -' + pct + ' % comes off your next membership invoice automatically.' }), message: '🎁 Tvé doporučení se přidalo! -' + pct + ' % se ti automaticky strhne z příští faktury členství.' });
    } else {
      await sbPost('gym_member_ref_credits', { gym_id: gymId, referrer_id: refUser, pct, status: 'pending', source: 'stripe', created_at: new Date().toISOString() });
      await sbPost('notifications', { user_id: refUser, type: 'system', read: false, data: JSON.stringify({ kind: 'gym_member_ref_reward', gym_id: gymId, pct, msg_en: '🎁 Your referral joined! -' + pct + ' % applies automatically to your next membership period (QR/cash).' }), message: '🎁 Tvé doporučení se přidalo! -' + pct + ' % se ti automaticky uplatní na další období členství (QR/hotovost).' });
    }
    // Mark this subscription as rewarded so a success-page refresh can never double-reward.
    if (subId) {
      try { await stripe.subscriptions.update(subId, { metadata: { mtl_ref_rewarded: '1' } }, gymAccount ? { stripeAccount: gymAccount } : undefined); } catch (e) {}
    }
  } catch (e) { console.error('rewardReferrer', e.message); }
}

export default async function handler(req, res) {
  try {
    const { sessionId, gymAccount, refUser, refPct, gymId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'Chybí sessionId' });

    const opts = gymAccount ? { stripeAccount: gymAccount } : undefined;
    const session = await stripe.checkout.sessions.retrieve(sessionId, opts);

    // Reward the person who referred this new member (best-effort, non-blocking).
    // SECURITY: refUser/refPct used to be taken straight from req.query - this endpoint has no
    // auth, the pct had no clamp and there was no dedup, so any active member could call it
    // with refUser=<themselves>&refPct=<anything> and grant themselves a coupon, repeatedly.
    // The ONLY trusted source is the session's own metadata, which pay.js stamps SERVER-SIDE
    // (mtl_ref_user / mtl_ref_pct, already clamped to the gym's member_ref_pct). Query params
    // are ignored entirely.
    try {
      const _md = (session && session.metadata) || {};
      const _mdSub = typeof session.subscription === 'string' ? session.subscription : (session.subscription && session.subscription.id);
      const _ru = _md.mtl_ref_user, _rp = parseInt(_md.mtl_ref_pct, 10) || 0, _rg = _md.gym_id || gymId;
      if (_ru && _rp > 0 && _rg && gymAccount) {
        await rewardReferrer({ refUser: _ru, refPct: _rp, gymId: _rg, gymAccount, subId: _mdSub });
      }
    } catch (e) { console.error('ref reward gate', e.message); }

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
      let txType = null; const f = { currency: m.mtl_currency || session.currency, income_class: m.mtl_income || null, welcome_waived: parseInt(m.mtl_welcome_waived||'0',10)||0 };
      if (m.mtl_payment_type === 'membership') { txType = 'membership'; f.member_id = m.student_id || m.member_id; f.gym_id = m.gym_id; f.plan = m.mtl_plan || 'Membership'; f.income_class = m.mtl_income || 'side'; f.acq_months = (m.mtl_acq_months ? parseInt(m.mtl_acq_months, 10) : null); f.base_rate = (m.mtl_base_rate ? parseFloat(m.mtl_base_rate) : null); }
      else if (m.mtl_payment_type === 'drop_in') { txType = 'drop_in'; f.member_id = m.student_id || m.member_id; f.gym_id = m.gym_id; f.coach_id = m.coach_id || m.coach_profile_id || null; f.plan = m.mtl_plan || 'Drop-in'; f.discipline = m.discipline || m.disc || null; f.income_class = m.mtl_income || 'side'; f.dropin_plan_id = m.mtl_dropin_plan || null; f.need_proof = (String(m.mtl_need_proof || '') === '1'); }
      else if (m.mtl_payment_type === 'merch') { txType = 'merch'; f.member_id = m.student_id; f.gym_id = m.gym_id; f.plan = m.merch_name || m.mtl_plan || 'Merch'; }
      else if (m.mtl_payment_type === 'event_ticket') { txType = 'event_ticket'; f.member_id = m.student_id || m.buyer_id; f.gym_id = m.gym_id; f.coach_id = m.payout_coach_id || null; f.plan = m.mtl_event || 'Event'; f.income_class = m.mtl_income || 'side'; }
      else if (m.booking_type === 'inperson' || m.booking_type === 'online') { txType = (m.booking_type === 'online') ? 'coach_online' : 'coach_inperson'; f.member_id = m.student_id; f.coach_id = m.coach_profile_id; f.plan = m.online_fmt || 'Lekce 1:1'; f.currency = m.booking_currency || session.currency; f.discipline = m.discipline || null; }
      f.paid_by = m.paid_by || null; f.paid_by_name = m.paid_by_name || null;
      if (m.booking_type === 'inperson') f.slot_id = m.slot_id || null;
      if (!txType) _tx = { recorded: false, reason: 'no mtl_payment_type / booking_type in the session metadata — redeploy pay.js (LX/LY) and make a NEW payment; old sessions have no metadata' };
      else if (!payId) _tx = { recorded: false, reason: 'could not resolve a payment id from the session (subscription invoice may lack payment_intent/charge on this API version)', txType };
      else if (!gymAccount) _tx = { recorded: false, reason: 'no gymAccount/acct passed to /api/session', txType, payId };
      else { const r = await recordStripeTransaction(gymAccount, payId, { type: txType, ...f }); _tx = { recorded: ['recorded','updated','exists'].includes(r.status), ...r, txType, payId, gymAccount, gymId: f.gym_id, memberId: f.member_id }; }
    } catch (e) { _tx = { recorded: false, reason: 'exception: ' + e.message }; }

    // ---- referral credit consumption (idempotent backstop for a non-delivering webhook) ----
    let _cred = { consumed: false };
    try {
      const m2 = session.metadata || {};
      const credRow = m2.mtl_credit_row || '';
      const credUser = m2.mtl_credit_user || '';
      if (credRow && credUser) {
        // only flips a row that is still unconsumed -> whoever gets here first wins
        const upd = await sbPatchRet(`referral_credits?id=eq.${encodeURIComponent(credRow)}&consumed=eq.false`, { consumed: true });
        if (upd.length > 0) {
          const pr = await sbGet(`profiles?id=eq.${encodeURIComponent(credUser)}&select=student_credits`);
          const cur = (pr && pr[0] && pr[0].student_credits) || 0;
          await sbPatch(`profiles?id=eq.${encodeURIComponent(credUser)}`, { student_credits: Math.max(0, cur - 1) });
          _cred = { consumed: true, row: credRow };
        } else {
          _cred = { consumed: false, reason: 'already consumed (webhook got there first)' };
        }
      } else {
        _cred = { consumed: false, reason: 'no mtl_credit_row in session metadata' };
      }
    } catch (e) { _cred = { consumed: false, reason: 'exception: ' + e.message }; }

    // Renewal date, so the membership row can say WHEN it renews rather than only that it does.
    let _periodEnd = null;
    try {
      const _sid = typeof session.subscription === 'string' ? session.subscription : (session.subscription && session.subscription.id);
      if (_sid) {
        const _s = await stripe.subscriptions.retrieve(_sid, opts);
        const _cpe = _s && (_s.current_period_end || (_s.items && _s.items.data && _s.items.data[0] && _s.items.data[0].current_period_end));
        if (_cpe) _periodEnd = new Date(_cpe * 1000).toISOString();
      }
    } catch (e) { console.error('period_end', e.message); }

    res.status(200).json({
      _cred,
      periodEnd: _periodEnd,
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
