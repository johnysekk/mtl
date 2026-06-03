import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  try {
    const { coachId, coachName, amount } = req.query;

    if (!coachId || !amount) {
      return res.status(400).json({ error: 'Chybí coachId nebo amount' });
    }

    const rate = parseInt(amount);                          // cena kouče (jeho rate)
    const amountInHaler = Math.round(rate * 1.10 * 100);    // student platí rate +10%
    const applicationFee = Math.round(rate * 0.20 * 100);   // MTL = 20% z rate (10% student + 10% kouč)

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'czk',
          product_data: { name: `Trénink — ${coachName || 'MTL Coach'}` },
          unit_amount: amountInHaler,
        },
        quantity: 1,
      }],
      payment_intent_data: {
        application_fee_amount: applicationFee,
        on_behalf_of: coachId,              // kouč = merchant of record (země/výpis), Stripe fee platí platforma
        transfer_data: {
          destination: coachId,
        },
      },
     success_url: `https://${req.headers.host}/?platba=ok&slot=${req.query.slotId || ''}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://${req.headers.host}/?platba=zruseno`,
    });

    res.redirect(303, session.url);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
