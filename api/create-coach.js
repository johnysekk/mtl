import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  try {
    // Vytvoř testovacího connected account (kouče)
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'CZ',
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
    });

    // Vytvoř onboarding link
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `https://${req.headers.host}/`,
      return_url: `https://${req.headers.host}/?onboarded=${account.id}`,
      type: 'account_onboarding',
    });

    res.status(200).json({ accountId: account.id, url: accountLink.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
