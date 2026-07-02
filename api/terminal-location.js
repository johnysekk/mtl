// /api/terminal-location
// Ensures a Stripe Terminal *Location* exists for a gym and returns its id.
// A Location is a required object that tells Stripe WHERE payments happen, so the
// device downloads the right regional config (CZ address -> CZK + Czech card rules).
// MTL creates it automatically from the gym's stored address — the gym owner never
// touches Stripe. Call this once per gym (or lazily before the first Tap-to-Pay).
//
// Body: { token, gym_id, postal_code? }
// Auth: token must be the gym OWNER's access token (gyms.owner_id === uid).
// Stores the id on gyms.terminal_location_id (run terminal-location.sql once).
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body,
  });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { token, gym_id, postal_code } = b;
    if (!token || !gym_id) return res.status(400).json({ error: 'missing fields' });

    // auth
    const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!ur.ok) return res.status(401).json({ error: 'bad token' });
    const u = await ur.json(); const uid = u && u.id;
    if (!uid) return res.status(401).json({ error: 'bad token' });

    const gyms = await sb(`gyms?id=eq.${gym_id}&select=id,owner_id,name,address,city,country,stripe_account,terminal_location_id`);
    const gym = gyms && gyms[0];
    if (!gym) return res.status(404).json({ error: 'gym not found' });
    if (gym.owner_id !== uid) return res.status(403).json({ error: 'not your gym' });
    if (gym.terminal_location_id) return res.status(200).json({ ok: true, location_id: gym.terminal_location_id, cached: true });
    if (!gym.stripe_account) return res.status(400).json({ error: 'gym has no Stripe connected account' });

    // country: Stripe wants 2-letter ISO (e.g. "CZ"). gyms.country may be a name -> map the common one.
    const cc = (gym.country || '').trim();
    const country = cc.length === 2 ? cc.toUpperCase()
      : (/česk|czech/i.test(cc) ? 'CZ' : cc.slice(0, 2).toUpperCase());
    if (!gym.address || !gym.city || !country) {
      return res.status(400).json({ error: 'gym address incomplete (need address, city, country)' });
    }

    // Create the Location ON the gym's connected account.
    const loc = await stripe.terminal.locations.create({
      display_name: gym.name || 'MTL Gym',
      address: {
        line1: gym.address,
        city: gym.city,
        postal_code: postal_code || '00000', // TODO: capture real postal once at onboarding
        country,
      },
    }, { stripeAccount: gym.stripe_account });

    // persist back on the gym
    await sb(`gyms?id=eq.${gym_id}`, { method: 'PATCH', body: JSON.stringify({ terminal_location_id: loc.id }) });

    return res.status(200).json({ ok: true, location_id: loc.id, cached: false });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
