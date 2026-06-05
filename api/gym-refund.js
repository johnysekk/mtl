import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── MTL Gym — refund DIRECT CHARGE ──
// U direct charges refund vzniká NA účtu gymu => nutná hlavička { stripeAccount }.
// refundApp=1 => vrátí se i MTL application fee (plný refund / chyba na straně gymu).
// Bez něj si MTL provizi nechá (např. storno z viny studenta dle politiky).
export default async function handler(req, res) {
  try {
    const { gymAccount, paymentIntent, amount, refundApp } = req.query;

    if (!gymAccount || !paymentIntent) {
      return res.status(400).json({ error: 'Chybí gymAccount nebo paymentIntent' });
    }

    const params = { payment_intent: paymentIntent };
    if (amount) params.amount = Math.round(parseFloat(amount) * 100); // částečný refund (minor units)
    if (String(refundApp) === '1') params.refund_application_fee = true;

    const refund = await stripe.refunds.create(params, { stripeAccount: gymAccount });

    res.status(200).json({ refunded: (refund.amount || 0) / 100, id: refund.id, status: refund.status });
  } catch (err) {
    console.error('gym-refund error:', err);
    res.status(500).json({ error: err.message });
  }
}
