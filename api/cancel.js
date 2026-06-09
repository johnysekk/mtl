import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SB = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders }); return r.ok ? r.json() : []; }
  catch (e) { return []; }
}

// ── MTL Coaches — storno / refund (DIRECT charge na účtu kouče) ──
// Lekce 1:1 je teď direct charge: platba i poplatek MTL žijí na connected
// účtu kouče. Refund se proto vystaví NA účtu kouče a refund_application_fee
// vrací poměrnou část MTL provize → student dostane svoje %, zbytek nesou
// kouč i MTL poměrně (žádný transfer reversal, žádný záporný zůstatek navíc).
//   Student ruší 16h+  → student 93 %
//   Student ruší <16h   → student 50 %
//   Kouč ruší (hoursUntil>=900) → student 100 %
//   No-show / po termínu → 0
const STUDENT_MARKUP = 1.05;

export default async function handler(req, res) {
  try {
    const { paymentIntent, amount, hoursUntil, acct } = req.query;
    if (!paymentIntent) { return res.status(400).json({ error: 'Chybí payment intent' }); }

    const base = parseInt(amount, 10);
    const hours = parseFloat(hoursUntil);

    let studentPct;
    if (hours >= 900)      studentPct = 1.00; // kouč ruší → student 100 %
    else if (hours >= 16)  studentPct = 0.93; // 93 %
    else if (hours >= 0)   studentPct = 0.50; // 50 %
    else                   studentPct = 0;    // no-show

    if (studentPct === 0) {
      return res.status(200).json({ refunded: 0, pct: 0, message: 'Žádný refund (no-show / po termínu)' });
    }

    // Dohledej connected účet kouče (acct param > z bookingu přes payment_intent)
    let coachAccount = acct || null;
    if (!coachAccount) {
      try {
        const bk = await sbGet(`bookings?payment_intent=eq.${encodeURIComponent(paymentIntent)}&select=coach_id&limit=1`);
        const coachId = bk && bk[0] && bk[0].coach_id;
        if (coachId) {
          const pr = await sbGet(`profiles?id=eq.${encodeURIComponent(coachId)}&select=gym_payout_account&limit=1`);
          coachAccount = (pr && pr[0] && pr[0].gym_payout_account) || null;
        }
      } catch (e) { console.error('coach acct lookup:', e.message); }
    }

    const opts = coachAccount ? { stripeAccount: coachAccount } : undefined;

    // Reálně zaplaceno (po slevách) — nikdy nevrátíme víc, než student zaplatil
    let paidHal = Math.round(base * STUDENT_MARKUP * 100);
    let transferId = null;
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge'] }, opts);
      const charge = pi && pi.latest_charge;
      if (charge && charge.amount) paidHal = charge.amount;
      transferId = charge && charge.transfer ? charge.transfer : null; // jen u starých destination plateb
    } catch (e) { console.error('PI retrieve:', e.message); }

    const refundToStudent = Math.round(paidHal * studentPct);

    if (coachAccount && !transferId) {
      // DIRECT charge: refund na účtu kouče, poměrně vrať i MTL application fee
      const refund = await stripe.refunds.create(
        { payment_intent: paymentIntent, amount: refundToStudent, refund_application_fee: true },
        opts
      );
      return res.status(200).json({ refunded: refundToStudent / 100, pct: studentPct * 100, refundId: refund.id, mode: 'direct' });
    }

    // ── Fallback: starý destination charge (platforma + transfer reversal) ──
    let coachKeepPct = (hours >= 0 && hours < 16) ? 0.45 : 0;
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntent,
      amount: refundToStudent,
      refund_application_fee: false,
      reverse_transfer: transferId ? false : true,
    });
    let reversed = 0;
    if (transferId) {
      try {
        if (coachKeepPct === 0) {
          const rev = await stripe.transfers.createReversal(transferId);
          reversed = (rev.amount || 0) / 100;
        } else {
          const tr = await stripe.transfers.retrieve(transferId);
          const coachKeepHal = Math.round(paidHal * coachKeepPct);
          const reverseHal = Math.max((tr.amount || 0) - coachKeepHal, 0);
          if (reverseHal > 0) {
            const rev = await stripe.transfers.createReversal(transferId, { amount: reverseHal });
            reversed = (rev.amount || 0) / 100;
          }
        }
      } catch (e) { console.error('transfer reversal:', e.message); }
    }
    return res.status(200).json({ refunded: refundToStudent / 100, reversedFromCoach: reversed, pct: studentPct * 100, refundId: refund.id, mode: 'legacy' });
  } catch (err) {
    console.error('cancel error:', err);
    res.status(500).json({ error: err.message });
  }
}
