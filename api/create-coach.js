import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// STANDARD connected account pro 1:1 kouče (a MTL Ambassadora — sdílí profiles.stripe_account).
// Standard = kouč nese Stripe processing fee a má vlastní Stripe dashboard. Přesně to,
// co chceme pro DIRECT charges: MTL si bere čistou application fee, Stripe poplatek jde
// z podílu kouče. ŽÁDNÉ Express účty / destination charges.
// MTL Ambassador 0,5 % chodí separátním transferem z platform balance na tento účet
// (Standard má po onboardingu capability `transfers`, takže transfer projde).
export default async function handler(req, res) {
  try {
    const host = req.headers.host;
    const proto = host && host.includes('localhost') ? 'http' : 'https';

    // (volitelné) předvyplň e-mail/zemi z query; jinak default CZ (zachováno z původní verze)
    const { email, country } = req.query;

    const account = await stripe.accounts.create({
      type: 'standard',
      ...(email ? { email } : {}),
      country: country ? String(country).toUpperCase() : 'CZ',
      metadata: { mtl_role: 'coach' },
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${proto}://${host}/`,
      return_url: `${proto}://${host}/?onboarded=${account.id}`,
      type: 'account_onboarding',
    });

    res.status(200).json({ accountId: account.id, url: accountLink.url });
  } catch (err) {
    console.error('create-coach error:', err);
    res.status(500).json({ error: err.message });
  }
}
