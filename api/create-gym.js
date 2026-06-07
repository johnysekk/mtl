import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vytvoří STANDARD connected account pro MTL gym.
// Standard = gym nese Stripe processing fee (fee payer = account) a má vlastní
// Stripe dashboard. To je přesně to, co chceme pro direct charges:
// MTL si bere čistou application fee, Stripe poplatek jde z podílu gymu.
export default async function handler(req, res) {
  try {
    const host = req.headers.host;
    const proto = host && host.includes('localhost') ? 'http' : 'https';

    // (volitelné) předvyplň zemi/e-mail z query, jinak je gym zadá v onboardingu
    const { email, country, gymProfileId, for: forRole } = req.query;
    const isCoach = String(forRole) === 'coach';

    const account = await stripe.accounts.create({
      type: 'standard',
      ...(email ? { email } : {}),
      ...(country ? { country: String(country).toUpperCase() } : {}),
      metadata: { mtl_role: isCoach ? 'coach_payout' : 'gym', gym_profile_id: gymProfileId || '' },
    });

    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${proto}://${host}/?${isCoach ? 'coach_payout=refresh' : 'gym_stripe=refresh'}`,
      return_url: `${proto}://${host}/?${isCoach ? 'coach_payout=done' : 'gym_stripe=done'}&acct=${account.id}`,
      type: 'account_onboarding',
    });

    res.status(200).json({ accountId: account.id, url: link.url });
  } catch (err) {
    console.error('create-gym error:', err);
    res.status(500).json({ error: err.message });
  }
}
