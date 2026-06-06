import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── MTL — Stripe Express login link ──
// Vrátí krátkodobou URL do Express Dashboardu PŘIHLÁŠENÉHO uživatele.
// BEZPEČNOST: účet se NEbere od klienta. Ověříme Supabase access token →
// získáme user id → service-role čteme jeho profiles.stripe_account.
// (Login link dává přístup k Express dashboardu daného účtu, takže nikdy
//  nesmí jít vytvořit pro cizí, klientem dodané account id.)
export default async function handler(req, res) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Chybí přihlášení' });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // 1) ověř token → user id
    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SVC },
    });
    const u = await uRes.json();
    if (!u || !u.id) return res.status(401).json({ error: 'Neplatné přihlášení' });

    // 2) service-role: načti jeho stripe_account
    const pRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${u.id}&select=stripe_account`, {
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` },
    });
    const rows = await pRes.json();
    const acct = rows && rows[0] && rows[0].stripe_account;
    if (!acct) return res.status(400).json({ error: 'Nemáš připojený Stripe účet' });

    // 3) login link do Express dashboardu
    const link = await stripe.accounts.createLoginLink(acct);
    res.status(200).json({ url: link.url });
  } catch (err) {
    console.error('stripe-login-link error:', err);
    res.status(500).json({ error: err.message });
  }
}
