import Stripe from 'stripe';
import { feeRefundableForPI, feeRefundableForTx, bankFeeRefundable } from './_fee-window.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

// ── MTL Gym — refund DIRECT CHARGE ──
// U direct charges refund vzniká NA účtu gymu => nutná hlavička { stripeAccount }.
// refundApp=1 => vrátí se i MTL application fee (plný refund / chyba na straně gymu).
// Bez něj si MTL provizi nechá (např. storno z viny studenta dle politiky).
//
// OVĚŘENÍ (dřív žádné: kdokoli mohl s číslem účtu a platby vrátit cizí peníze):
//   • příjemce platby -- majitel / správce klubu s tímhle Stripe účtem, nebo kouč, jehož účet to je;
//   • student, kterému platba patří -- jen u své rezervace a nejvýš 95 % (storno studentem).
async function sb(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function whoami(req) {
  const tok = String(req.headers.authorization || req.headers['x-access-token'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return (u && u.id) ? u.id : null;
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
    const { gymAccount, paymentIntent, amount, refundApp } = req.query;

    if (!gymAccount || !paymentIntent) {
      return res.status(400).json({ error: 'Chybí gymAccount nebo paymentIntent' });
    }
    const me = await whoami(req);
    if (!me) return res.status(401).json({ error: 'Nejsi přihlášený' });

    if (!(await isPayee(me, gymAccount))) {
      // Student: jen vlastní platba.
      //  • vstup do klubu (gym_bookings): storno studentem = nejvýš 95 %;
      //  • soukromá lekce (bookings): spor / nedorazil kouč -> vrací se celé hned (pravidlo appky;
      //    zneužití hlídá MTL v přehledu sporů).
      const gb = (await sb(`gym_bookings?payment_intent=eq.${q(paymentIntent)}&select=student_id,amount`)) || [];
      if (gb.length) {
        if (String(gb[0].student_id) !== String(me)) return res.status(403).json({ error: 'Tuhle platbu vrátit nemůžeš' });
        const max = Math.floor(Number(gb[0].amount || 0) * 0.95 * 100) / 100;
        if (!amount || !(parseFloat(amount) > 0) || parseFloat(amount) > max + 0.01) {
          return res.status(403).json({ error: 'Vrátit lze nejvýš 95 %' });
        }
      } else {
        const cb = (await sb(`bookings?payment_intent=eq.${q(paymentIntent)}&select=student_id`)) || [];
        if (!cb.length || String(cb[0].student_id) !== String(me)) return res.status(403).json({ error: 'Tuhle platbu vrátit nemůžeš' });
      }
    }

    const params = { payment_intent: paymentIntent };
    if (amount) params.amount = Math.round(parseFloat(amount) * 100); // částečný refund (minor units)
    // Provize MTL se vrací (poměrně) jen do vystavení dokladu za období platby -- viz _fee-window.js.
    if (String(refundApp) === '1' && await feeRefundableForPI(paymentIntent)) params.refund_application_fee = true;

    const refund = await stripe.refunds.create(params, { stripeAccount: gymAccount });

    res.status(200).json({ refunded: (refund.amount || 0) / 100, id: refund.id, status: refund.status });
  } catch (err) {
    console.error('gym-refund error:', err);
    res.status(500).json({ error: err.message });
  }
}
