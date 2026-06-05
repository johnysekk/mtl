import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── MTL Coaches — storno / refund (destination charge) ──
// Model: refund se počítá z toho, co student REÁLNĚ zaplatil (base × 1.10).
//   • Student ruší 16h+   → student 95 % zaplaceného, kouč 0, MTL si nechá 5 % (pokryje Stripe fee)
//   • Student ruší <16h   → student 50 %, kouč si nechá 45 % (kompenzace), MTL 5 %
//   • Kouč ruší (sentinel hoursUntil>=900) → student 100 %, kouč 0 (MTL nese fee, je to vina kouče)
//   • No-show / po termínu → 0
//
// `amount` = ZÁKLADNÍ cena kouče (base) uložená u rezervace.
const STUDENT_MARKUP = 1.10; // co student platí navíc nad base
const COACH_SHARE    = 0.90; // podíl kouče ze base (musí sedět s checkout.js)

export default async function handler(req, res) {
  try {
    const { paymentIntent, amount, hoursUntil } = req.query;
    if (!paymentIntent) { return res.status(400).json({ error: 'Chybí payment intent' }); }

    const base = parseInt(amount, 10);
    const paid = base * STUDENT_MARKUP;        // co student reálně zaplatil
    const coachShare = base * COACH_SHARE;     // co kouč původně dostal
    const hours = parseFloat(hoursUntil);

    // procenta Z ZAPLACENÉHO (student) a kolik si kouč nechá (z paid)
    let studentPct, coachKeepPct;
    if (hours >= 900)      { studentPct = 1.00; coachKeepPct = 0;    } // kouč ruší → student 100 %
    else if (hours >= 16)  { studentPct = 0.95; coachKeepPct = 0;    } // 95 %
    else if (hours >= 0)   { studentPct = 0.50; coachKeepPct = 0.45; } // 50 %
    else                   { studentPct = 0;    coachKeepPct = 0;    } // no-show

    if (studentPct === 0) {
      return res.status(200).json({ refunded: 0, pct: 0, message: 'Žádný refund (no-show / po termínu)' });
    }

    // částky v haléřích
    const refundToStudent  = Math.round(paid * studentPct * 100);
    const reverseFromCoach = Math.round((coachShare - paid * coachKeepPct) * 100); // co stáhnout koučovi

    // najdi transfer ke koučovi
    let transferId = null;
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge'] });
      const charge = pi && pi.latest_charge;
      transferId = charge && charge.transfer ? charge.transfer : null;
    } catch (e) { console.error('PI retrieve:', e.message); }

    // 1) refund studentovi — MTL si nechává provizi (refund_application_fee: false),
    //    koučův podíl stáhneme ručně níž (přesně), ne proporčně
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntent,
      amount: refundToStudent,
      refund_application_fee: false,
      reverse_transfer: transferId ? false : true, // fallback když transfer nenajdeme
    });

    // 2) stáhni koučův podíl
    let reversed = 0;
    if (transferId && reverseFromCoach > 0) {
      try {
        const rev = await stripe.transfers.createReversal(transferId, { amount: reverseFromCoach });
        reversed = (rev.amount || 0) / 100;
      } catch (e) { console.error('transfer reversal:', e.message); }
    }

    res.status(200).json({
      refunded: refundToStudent / 100,
      reversedFromCoach: reversed,
      pct: studentPct * 100,
      refundId: refund.id,
    });
  } catch (err) {
    console.error('cancel error:', err);
    res.status(500).json({ error: err.message });
  }
}
