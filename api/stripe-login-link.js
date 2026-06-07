import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── MTL — Stripe Express login link ──
// Vrátí krátkodobou URL do Express Dashboardu (zůstatek, příští výplata, historie).
// BEZPEČNOST: účet se NEbere od klienta. Ověříme uživatele přes RPC whoami()
// (vrátí auth.uid() z jeho tokenu — funguje napříč key-systémy), pak service-role
// načteme jeho stripe_account (nebo u gymu ověříme vlastnictví).
export default async function handler(req, res) {
  try {
    const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Chybí přihlášení' });
    if (!SB || !SVC) return res.status(500).json({ error: 'Server není nakonfigurován (SUPABASE_URL / SERVICE_ROLE)' });

    // 1) ověř token → user id (RPC whoami běží v kontextu volajícího tokenu)
    const wRes = await fetch(`${SB}/rest/v1/rpc/whoami`, {
      method: 'POST',
      headers: { apikey: SVC, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const uid = await wRes.json();
    if (!uid || typeof uid !== 'string') return res.status(401).json({ error: 'Neplatné přihlášení' });

    const svcHeaders = { apikey: SVC, Authorization: `Bearer ${SVC}` };
    const gymId = req.query.gymId;
    let acct = null;

    if (gymId) {
      // login link pro účet GYMU — jen vlastník
      const gRes = await fetch(`${SB}/rest/v1/gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id,stripe_account`, { headers: svcHeaders });
      const g = (await gRes.json())[0];
      if (!g) return res.status(404).json({ error: 'Gym nenalezen' });
      if (g.owner_id !== uid) return res.status(403).json({ error: 'Nejsi vlastník tohoto gymu' });
      acct = g.stripe_account;
    } else {
      // login link pro vlastní coach/ambassador účet
      const pRes = await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=stripe_account`, { headers: svcHeaders });
      const p = (await pRes.json())[0];
      acct = p && p.stripe_account;
    }

    if (!acct) return res.status(400).json({ error: 'Žádný připojený Stripe účet' });

    const link = await stripe.accounts.createLoginLink(acct);
    res.status(200).json({ url: link.url });
  } catch (err) {
    console.error('stripe-login-link error:', err);
    res.status(500).json({ error: err.message });
  }
}
