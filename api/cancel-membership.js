import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Zruší členské předplatné. Subscription žije na connected accountu gymu,
// takže cancel musí jít s { stripeAccount: gymAccount }.
// Defaultně zruší na konci zaplaceného období (student dotrénuje, co zaplatil).
export default async function handler(req, res) {
  try {
    const { subscriptionId, gymAccount, immediate, resume } = req.query;
    if (!subscriptionId) {
      return res.status(400).json({ error: 'Chybí subscriptionId' });
    }
    // gymAccount volitelný: gym členství žije na connected accountu; EP ($49/mo) na platformě (bez gymAccount)
    const opts = gymAccount ? { stripeAccount: gymAccount } : undefined;

    let sub;
    if (String(resume) === '1') {
      sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false }, opts);
    } else if (String(immediate) === '1') {
      sub = await stripe.subscriptions.cancel(subscriptionId, opts);
    } else {
      sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, opts);
    }

    res.status(200).json({
      ok: true,
      status: sub.status,
      cancel_at_period_end: sub.cancel_at_period_end || false,
      current_period_end: sub.current_period_end || null,
    });
  } catch (err) {
    console.error('cancel-membership error:', err);
    res.status(500).json({ error: err.message });
  }
}
