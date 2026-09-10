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
    const { email, country, gymProfileId, gymId, for: forRole } = req.query;
    const isCoach = String(forRole) === 'coach';
    // Existujici klub nese svoje id az do navratove adresy. Bez nej appka po navratu nepozna,
    // ze jde o klub, ktery uz existuje, otevre prihlasku noveho klubu a ucet se nikam nezapise.
    const gymQ = (!isCoach && gymId) ? `&gym=${encodeURIComponent(String(gymId))}` : '';

    const account = await stripe.accounts.create({
      type: 'standard',
      ...(email ? { email } : {}),
      ...(country ? { country: String(country).toUpperCase() } : {}),
      metadata: { mtl_role: isCoach ? 'coach_payout' : 'gym', gym_profile_id: gymProfileId || '', gym_id: (!isCoach && gymId) ? String(gymId) : '' },
    });

    const link = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${proto}://${host}/?${isCoach ? 'coach_payout=refresh' : 'gym_stripe=refresh'}${gymQ}`,
      return_url: `${proto}://${host}/?${isCoach ? 'coach_payout=done' : 'gym_stripe=done'}&acct=${account.id}${gymQ}`,
      type: 'account_onboarding',
    });

    res.status(200).json({ accountId: account.id, url: link.url });
  } catch (err) {
    console.error('create-gym error:', err);
    res.status(500).json({ error: err.message });
  }
}
