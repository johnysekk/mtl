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

// Vytvoří STANDARD connected account pro MTL gym.
// Standard = gym nese Stripe processing fee (fee payer = account) a má vlastní
// Stripe dashboard. To je přesně to, co chceme pro direct charges:
// MTL si bere čistou application fee, Stripe poplatek jde z podílu gymu.
export default async function handler(req, res) {
  try {
    const host = req.headers.host;
    const proto = host && host.includes('localhost') ? 'http' : 'https';

    // (volitelné) předvyplň zemi/e-mail z query, jinak je gym zadá v onboardingu
    const { email, country, gymId, for: forRole } = req.query;
    const isCoach = String(forRole) === 'coach';
    const _u = await _authUser(req);
    if (!_u) return res.status(401).json({ error: 'Nejsi přihlášený.' });
    // Účet pro EXISTUJÍCÍ klub zakládá jen majitel nebo spolumajitel.
    if (!isCoach && gymId) {
      const _h = { headers: { apikey: _SKEY, Authorization: `Bearer ${_SKEY}` } };
      const _g = ((await (await fetch(`${_SB}/rest/v1/gyms?id=eq.${encodeURIComponent(String(gymId))}&select=owner_id`, _h)).json()) || [])[0];
      let _ok = !!(_g && String(_g.owner_id) === String(_u.id));
      if (_g && !_ok) { const _c = await (await fetch(`${_SB}/rest/v1/gym_coaches?gym_id=eq.${encodeURIComponent(String(gymId))}&coach_id=eq.${encodeURIComponent(_u.id)}&status=eq.active&co_owner=eq.true&select=id&limit=1`, _h)).json(); _ok = !!(_c && _c.length); }
      if (!_ok) return res.status(403).json({ error: 'Stripe účet klubu zakládá jen majitel nebo spolumajitel.' });
    }
    // Existujici klub nese svoje id az do navratove adresy. Bez nej appka po navratu nepozna,
    // ze jde o klub, ktery uz existuje, otevre prihlasku noveho klubu a ucet se nikam nezapise.
    const gymQ = (!isCoach && gymId) ? `&gym=${encodeURIComponent(String(gymId))}` : '';

    const account = await stripe.accounts.create({
      type: 'standard',
      ...(email ? { email } : {}),
      ...(country ? { country: String(country).toUpperCase() } : {}),
      metadata: { mtl_role: isCoach ? 'coach_payout' : 'gym', mtl_user: String(_u.id), gym_profile_id: String(_u.id), gym_id: (!isCoach && gymId) ? String(gymId) : '' },
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
