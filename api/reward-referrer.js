// /api/reward-referrer.js — reward a gym member-referrer when a CASH referral is recorded at reception.
// Trust context: the GYM OWNER triggers this (reception cash sale), so it is owner-authed and the
// discount % is clamped to the gym's configured member_ref_pct (nobody can mint arbitrary discounts).
// (The Stripe new-member path is handled separately in session.js rewardReferrer, gated by the verified
// payment session — a different, payment-verified trust context. The reward logic below mirrors it.)
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB   = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
async function sbGet(p) { try { const r = await fetch(`${SB}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; } catch (e) { return []; } }
async function sbPost(p, b) { try { await fetch(`${SB}/rest/v1/${p}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(b) }); } catch (e) {} }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const token = req.headers['x-access-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'no token' });
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const u = await ures.json(); const uid = u && (u.id || (u.user && u.user.id));
    if (!uid) return res.status(401).json({ error: 'bad token' });

    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const refUser = b.refUser, gymId = b.gymId; let pct = parseInt(b.refPct, 10) || 0;
    if (!refUser || !gymId || pct <= 0) return res.status(400).json({ error: 'missing fields' });

    const gy = (await sbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id,stripe_account,member_ref_pct`))[0];
    if (!gy) return res.status(404).json({ error: 'gym not found' });
    if (gy.owner_id !== uid) return res.status(403).json({ error: 'forbidden' });   // only the gym owner
    const maxPct = parseInt(gy.member_ref_pct, 10) || 0;
    if (maxPct <= 0) return res.status(400).json({ error: 'referral off' });
    if (pct > maxPct) pct = maxPct;                                                 // clamp to the gym's setting
    if (refUser === uid) return res.status(400).json({ error: 'self' });

    // GATE: the referrer must CURRENTLY be an active member of this gym, otherwise no reward at all.
    const mem = await sbGet(`gym_memberships?select=stripe_subscription&student_id=eq.${encodeURIComponent(refUser)}&gym_id=eq.${encodeURIComponent(gymId)}&status=eq.active`);
    if (!mem || !mem.length) return res.status(200).json({ ok: true, skipped: 'referrer not an active member' });

    const gymAccount = gy.stripe_account || null;
    let stripeApplied = false;
    // Prefer discounting the referrer's NEXT Stripe invoice when they hold an active subscription here.
    if (gymAccount) {
      try {
        const subRow = mem.find(m => m.stripe_subscription);
        const sub = subRow && subRow.stripe_subscription;
        if (sub) {
          const coupon = await stripe.coupons.create({ percent_off: pct, duration: 'once', name: `MTL referral -${pct}%` }, { stripeAccount: gymAccount });
          await stripe.subscriptions.update(sub, { discounts: [{ coupon: coupon.id }] }, { stripeAccount: gymAccount });
          stripeApplied = true;
        }
      } catch (e) { console.error('reward-referrer stripe', e.message); }
    }

    if (stripeApplied) {
      await sbPost('notifications', { user_id: refUser, type: 'system', read: false, data: JSON.stringify({ kind: 'gym_member_ref_reward', gym_id: gymId, pct }), message: '🎁 Tvé doporučení se přidalo! -' + pct + ' % se ti automaticky strhne z příští faktury členství.' });
    } else {
      await sbPost('gym_member_ref_credits', { gym_id: gymId, referrer_id: refUser, pct, status: 'pending', source: 'cash', created_at: new Date().toISOString() });
      await sbPost('notifications', { user_id: refUser, type: 'system', read: false, data: JSON.stringify({ kind: 'gym_member_ref_reward', gym_id: gymId, pct }), message: '🎁 Tvé doporučení se přidalo! -' + pct + ' % se ti automaticky uplatní na další období členství (QR/hotovost).' });
    }
    return res.status(200).json({ ok: true, stripe: stripeApplied, pct });
  } catch (e) { return res.status(500).json({ error: String((e && e.message) || e) }); }
}
