// /api/terminal-connection-token
// Mints a Stripe Terminal connection token scoped to a gym's connected account.
// The NATIVE app (Capacitor + Stripe Terminal SDK) calls this to initialise the
// Tap-to-Pay reader before collecting a payment at reception.
//
// Body: { token, gym_id }
// Auth: token must be the gym OWNER's access token (gyms.owner_id === uid).
//       TODO(post-launch): allow gym STAFF/receptionist roles once a staff-role
//       table exists (right now only the owner can mint tokens).
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// NOTE: Tap to Pay works ONLY through the native Terminal SDK. The PWA cannot
// call this to any effect — it exists so the native build can drop straight in.

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
    const { token, gym_id } = b;
    if (!token || !gym_id) return res.status(400).json({ error: 'missing fields' });

    // --- auth: token -> uid ---
    const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!ur.ok) return res.status(401).json({ error: 'bad token' });
    const u = await ur.json(); const uid = u && u.id;
    if (!uid) return res.status(401).json({ error: 'bad token' });

    // --- verify the caller owns the gym + get its connected account ---
    const gyms = await sb(`gyms?id=eq.${gym_id}&select=id,owner_id,stripe_account,account_suspended`);
    const gym = gyms && gyms[0];
    if (!gym) return res.status(404).json({ error: 'gym not found' });
    if (gym.owner_id !== uid) return res.status(403).json({ error: 'not your gym' });
    if (gym.account_suspended) return res.status(403).json({ error: 'account suspended' });
    if (!gym.stripe_account) return res.status(400).json({ error: 'gym has no Stripe connected account' });

    // --- mint the connection token ON the gym's connected account ---
    // Everything charged through this reader session lands on the gym account,
    // exactly like the existing online direct-charge model.
    const ct = await stripe.terminal.connectionTokens.create({}, { stripeAccount: gym.stripe_account });

    return res.status(200).json({ ok: true, secret: ct.secret, account: gym.stripe_account });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
