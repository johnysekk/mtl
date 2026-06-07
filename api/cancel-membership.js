import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Zruší členské předplatné. Subscription žije na connected accountu gymu,
// takže cancel musí jít s { stripeAccount: gymAccount }.
// Defaultně zruší na konci zaplaceného období (student dotrénuje, co zaplatil).
export default async function handler(req, res) {
  try {
    const { subscriptionId, gymAccount, immediate, resume } = req.query;
    if (!subscriptionId || !gymAccount) {
      return res.status(400).json({ error: 'Chybí subscriptionId nebo gymAccount' });
    }

    let sub;
    if (String(resume) === '1') {
      // zrušení zrušení — předplatné zase poběží dál
      sub = await stripe.subscriptions.update(
        subscriptionId,
        { cancel_at_period_end: false },
        { stripeAccount: gymAccount }
      );
    } else if (String(immediate) === '1') {
      sub = await stripe.subscriptions.cancel(subscriptionId, { stripeAccount: gymAccount });
    } else {
      // zruší na konci období — student dochodí zaplacené
      sub = await stripe.subscriptions.update(
        subscriptionId,
        { cancel_at_period_end: true },
        { stripeAccount: gymAccount }
      );
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
