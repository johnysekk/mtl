import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  try {
    const { sessionId } = req.query;
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    res.status(200).json({ paymentIntent: session.payment_intent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
