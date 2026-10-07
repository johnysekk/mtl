import Stripe from 'stripe';
import { feeRefundableForPI } from './_fee-window.js';
import { prorata } from './_prorata.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

// Zruší členské předplatné. Subscription žije na connected accountu gymu/kouče,
// takže cancel i refund musí jít s { stripeAccount }.
//   (default)      -> cancel_at_period_end (člen dotrénuje, co zaplatil; bez refundu)
//   immediate=1    -> zrušit hned (žádný refund; zaplacené období propadá)
//   immediate=1&refund=1 -> zrušit hned + vrátit POMĚRNOU ČÁST poslední platby za nevyužité dny
//                           (_prorata.js). Provize MTL se vrací ve stejném poměru, jen do vystavení
//                           dokladu (_fee-window.js). Stripe poplatek se nevrací.
//   resume=1       -> vrátit zrušení (předplatné zase poběží)
//
// OVĚŘENÍ (dřív žádné: kdokoli s číslem předplatného ho mohl zrušit a nechat si vrátit peníze):
//   • příjemce platby (majitel / správce klubu s tímhle Stripe účtem, kouč s vlastním účtem) -- vše;
//   • člen, kterému předplatné patří (nebo kdo za něj platí) -- jen zrušení ke konci období a obnovení;
//   • Exclusive Partner (předplatné na účtu MTL, bez gymAccount) -- jen své vlastní předplatné.

async function sb(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  try { const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null; const u = await r.json(); return (u && u.id) || null; } catch (e) { return null; }
}
async function isPayee(me, acct) {
  const gyms = (await sb(`gyms?stripe_account=eq.${q(acct)}&select=id,owner_id`)) || [];
  for (const g of gyms) {
    if (String(g.owner_id) === String(me)) return true;
    const gc = (await sb(`gym_coaches?gym_id=eq.${q(g.id)}&coach_id=eq.${q(me)}&status=eq.active&select=co_owner,full_autonomy,can_manage_schedule`)) || [];
    if (gc.some((x) => x.co_owner || x.full_autonomy || x.can_manage_schedule)) return true;
  }
  const pr = (await sb(`profiles?or=(stripe_account.eq.${q(acct)},gym_payout_account.eq.${q(acct)})&id=eq.${q(me)}&select=id`)) || [];
  return pr.length > 0;
}

export default async function handler(req, res) {
  try {
    const { subscriptionId, gymAccount, immediate, resume, refund } = req.query;
    if (!subscriptionId) {
      return res.status(400).json({ error: 'Chybí subscriptionId' });
    }
    const me = await whoami(req);
    if (!me) return res.status(401).json({ error: 'Nejsi přihlášený' });
    const memberOp = String(immediate) !== '1';   // ke konci období nebo obnovení
    if (gymAccount) {
      if (!(await isPayee(me, gymAccount))) {
        const own = (await sb(`gym_memberships?stripe_subscription=eq.${q(subscriptionId)}&or=(student_id.eq.${q(me)},paid_by.eq.${q(me)})&select=id&limit=1`)) || [];
        if (!own.length || !memberOp) return res.status(403).json({ error: 'Tohle předplatné měnit nemůžeš' });
      }
    } else {
      const ep = (await sb(`profiles?id=eq.${q(me)}&partner_sub=eq.${q(subscriptionId)}&select=id&limit=1`)) || [];
      if (!ep.length) return res.status(403).json({ error: 'Tohle předplatné měnit nemůžeš' });
    }
    const opts = gymAccount ? { stripeAccount: gymAccount } : undefined;

    let sub; let refunded = 0, refundId = null, currency = null, usedDays = null, totalDays = null;
    if (String(resume) === '1') {
      sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false }, opts);
    } else if (String(immediate) === '1') {
      if (String(refund) === '1') {
        try {
          const subFull = await stripe.subscriptions.retrieve(
            subscriptionId, { expand: ['latest_invoice.payment_intent'] }, opts
          );
          const inv = subFull && subFull.latest_invoice;
          const pi = inv && (typeof inv.payment_intent === 'object'
            ? (inv.payment_intent && inv.payment_intent.id)
            : inv.payment_intent);
          if (pi) {
            // Zaplacené období poslední faktury; záloha = období předplatného.
            const line = inv.lines && inv.lines.data && inv.lines.data[0];
            const it = subFull.items && subFull.items.data && subFull.items.data[0];
            const pStart = (line && line.period && line.period.start) || subFull.current_period_start || (it && it.current_period_start);
            const pEnd = (line && line.period && line.period.end) || subFull.current_period_end || (it && it.current_period_end);
            const pr = prorata(inv.amount_paid || 0, (pStart || 0) * 1000, (pEnd || 0) * 1000);
            let already = 0;
            try { const t = ((await sb(`transactions?payment_intent=eq.${q(pi)}&select=refund_amount&limit=1`)) || [])[0]; already = Number(t && t.refund_amount) || 0; } catch (e) {}
            const amount = pr ? Math.max(0, pr.unused - already) : 0;
            currency = String(inv.currency || '').toUpperCase() || null;
            if (pr) { usedDays = pr.usedDays; totalDays = pr.totalDays; }
            if (amount > 0) {
              const rf = await stripe.refunds.create(
                { payment_intent: pi, amount, refund_application_fee: await feeRefundableForPI(pi) }, opts
              );
              refunded = (rf.amount || 0) / 100; refundId = rf.id;
            }
          }
        } catch (e) { console.error('membership refund error:', e.message); }
      }
      sub = await stripe.subscriptions.cancel(subscriptionId, opts);
    } else {
      sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, opts);
    }

    res.status(200).json({
      ok: true,
      status: sub.status,
      cancel_at_period_end: sub.cancel_at_period_end || false,
      current_period_end: sub.current_period_end || null,
      refunded, refundId, currency, used_days: usedDays, total_days: totalDays,
    });
  } catch (err) {
    console.error('cancel-membership error:', err);
    res.status(500).json({ error: err.message });
  }
}
