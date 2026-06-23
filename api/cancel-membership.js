import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Zruší členské předplatné. Subscription žije na connected accountu gymu/kouče,
// takže cancel i refund musí jít s { stripeAccount }.
//   (default)      -> cancel_at_period_end (člen dotrénuje, co zaplatil; bez refundu)
//   immediate=1    -> zrušit hned (žádný refund; zaplacené období propadá)
//   immediate=1&refund=1 -> zrušit hned + PLNÝ refund poslední platby (vrací se i MTL
//                           application fee přes refund_application_fee:true). Stripe
//                           poplatek se nevrací (drží si ho Stripe).
//   resume=1       -> vrátit zrušení (předplatné zase poběží)
export default async function handler(req, res) {
  try {
    const { subscriptionId, gymAccount, immediate, resume, refund } = req.query;
    if (!subscriptionId) {
      return res.status(400).json({ error: 'Chybí subscriptionId' });
    }
    const opts = gymAccount ? { stripeAccount: gymAccount } : undefined;

    let sub; let refunded = 0, refundId = null;
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
            const rf = await stripe.refunds.create(
              { payment_intent: pi, refund_application_fee: true }, opts
            );
            refunded = (rf.amount || 0) / 100; refundId = rf.id;
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
      refunded, refundId,
    });
  } catch (err) {
    console.error('cancel-membership error:', err);
    res.status(500).json({ error: err.message });
  }
}
