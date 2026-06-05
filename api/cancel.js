import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── MTL Coaches — storno / refund (destination charge) ──
// Refund se počítá z toho, co student REÁLNĚ zaplatil (base × 1.10 — markup je vždy 10 %).
//   • Student ruší 16h+   → student 93 %, kouč 0, MTL ~7 % (pokryje Stripe fee)
//   • Student ruší <16h   → student 50 %, kouč si nechá 45 % zaplaceného, MTL ~5 %
//   • Kouč ruší (sentinel hoursUntil>=900) → student 100 %, kouč 0 (MTL nese fee)
//   • No-show / po termínu → 0
//
// Koučův podíl se NEPOČÍTÁ z konstanty — reverzuje se podle REÁLNÉHO transferu,
// který koučovi odešel (95 % i founding 97 % tak funguje automaticky / grandfathered).
const STUDENT_MARKUP = 1.10; // markup studenta (vždy 10 %, founding mění jen cut)

export default async function handler(req, res) {
  try {
    const { paymentIntent, amount, hoursUntil } = req.query;
    if (!paymentIntent) { return res.status(400).json({ error: 'Chybí payment intent' }); }

    const base = parseInt(amount, 10);
    const paid = base * STUDENT_MARKUP; // co student reálně zaplatil
    const hours = parseFloat(hoursUntil);

    let studentPct, coachKeepPct;
    if (hours >= 900)      { studentPct = 1.00; coachKeepPct = 0;    } // kouč ruší → student 100 %
    else if (hours >= 16)  { studentPct = 0.93; coachKeepPct = 0;    } // 93 %
    else if (hours >= 0)   { studentPct = 0.50; coachKeepPct = 0.45; } // 50 %
    else                   { studentPct = 0;    coachKeepPct = 0;    } // no-show

    if (studentPct === 0) {
      return res.status(200).json({ refunded: 0, pct: 0, message: 'Žádný refund (no-show / po termínu)' });
    }

    const refundToStudent = Math.round(paid * studentPct * 100); // haléře

    // najdi transfer ke koučovi
    let transferId = null;
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ['latest_charge'] });
      const charge = pi && pi.latest_charge;
      transferId = charge && charge.transfer ? charge.transfer : null;
    } catch (e) { console.error('PI retrieve:', e.message); }

    // 1) refund studentovi — MTL si nechává provizi; koučův podíl reverzneme ručně
    const refund = await stripe.refunds.create({
      payment_intent: paymentIntent,
      amount: refundToStudent,
      refund_application_fee: false,
      reverse_transfer: transferId ? false : true, // fallback když transfer nenajdeme
    });

    // 2) reverze koučova podílu podle REÁLNÉHO transferu
    let reversed = 0;
    if (transferId) {
      try {
        if (coachKeepPct === 0) {
          // 16h+ / kouč ruší → kouč 0: reverzni CELÝ transfer (bez amount = celý)
          const rev = await stripe.transfers.createReversal(transferId);
          reversed = (rev.amount || 0) / 100;
        } else {
          // <16h → kouč si nechá paid×coachKeepPct; reverzni zbytek z reálného transferu
          const tr = await stripe.transfers.retrieve(transferId);
          const coachKeepHal = Math.round(paid * coachKeepPct * 100);
          const reverseHal = Math.max((tr.amount || 0) - coachKeepHal, 0);
          if (reverseHal > 0) {
            const rev = await stripe.transfers.createReversal(transferId, { amount: reverseHal });
            reversed = (rev.amount || 0) / 100;
          }
        }
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
