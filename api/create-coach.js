import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const _SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Kdo účet zakládá (token v hlavičce). Zapíše se do metadat účtu -- /api/stripe-link pak připojí
// účet jen tomu, kdo ho založil.
async function _authUser(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  try {
    const r = await fetch(`${_SB}/auth/v1/user`, { headers: { apikey: _SKEY, Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.id) ? u : null;
  } catch (e) { return null; }
}

// STANDARD connected account pro 1:1 kouče (a MTL Ambassadora — sdílí profiles.stripe_account).
// Standard = kouč nese Stripe processing fee a má vlastní Stripe dashboard. Přesně to,
// co chceme pro DIRECT charges: MTL si bere čistou application fee, Stripe poplatek jde
// z podílu kouče. ŽÁDNÉ Express účty / destination charges.
// MTL Ambassador 0,5 % chodí separátním transferem z platform balance na tento účet
// (Standard má po onboardingu capability `transfers`, takže transfer projde).
export default async function handler(req, res) {
  try {
    const _u = await _authUser(req);
    if (!_u) return res.status(401).json({ error: 'Nejsi přihlášený.' });
    const host = req.headers.host;
    const proto = host && host.includes('localhost') ? 'http' : 'https';

    // (volitelné) předvyplň e-mail/zemi z query; jinak default CZ (zachováno z původní verze)
    const { email, country } = req.query;

    const account = await stripe.accounts.create({
      type: 'standard',
      ...(email ? { email } : {}),
      country: country ? String(country).toUpperCase() : 'CZ',
      metadata: { mtl_role: 'coach', mtl_user: String(_u.id) },
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
