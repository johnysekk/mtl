import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Anon key je veřejný (je i v klientovi). Použijeme ho jako apikey pro ověření
// uživatelského tokenu přes GoTrue /auth/v1/user (dokumentovaný způsob).
const ANON_FALLBACK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxZW92Y3ZjaHR5Znd0eXpwcXJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTY1MjksImV4cCI6MjA5NTkzMjUyOX0.oQMTjym7VM4ZqAXYfQqqgxJCXpOM5aLEQiJfuuChu7U';

export default async function handler(req, res) {
  try {
    const SB = (process.env.SUPABASE_URL || 'https://iqeovcvchtyfwtyzpqrh.supabase.co').replace(/\/+$/, '');
    const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ANON = process.env.SUPABASE_ANON_KEY || ANON_FALLBACK;
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Chybí přihlášení' });
    if (!SVC) return res.status(500).json({ error: 'Server: chybí SUPABASE_SERVICE_ROLE_KEY' });

    // 1) ověř uživatelský token → user id (apikey = ANON, Authorization = user token)
    const uRes = await fetch(`${SB}/auth/v1/user`, {
      headers: { apikey: ANON, Authorization: `Bearer ${token}` },
    });
    const u = await uRes.json();
    if (!u || !u.id) return res.status(401).json({ error: 'Neplatné přihlášení (' + uRes.status + ')' });
    const uid = u.id;

    const svcHeaders = { apikey: SVC, Authorization: `Bearer ${SVC}` };
    const gymId = req.query.gymId;
    let acct = null;

    if (gymId) {
      const gRes = await fetch(`${SB}/rest/v1/gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id,stripe_account`, { headers: svcHeaders });
      const g = (await gRes.json())[0];
      if (!g) return res.status(404).json({ error: 'Gym nenalezen' });
      if (g.owner_id !== uid) return res.status(403).json({ error: 'Nejsi vlastník tohoto gymu' });
      acct = g.stripe_account;
    } else {
      const pRes = await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=stripe_account`, { headers: svcHeaders });
      const p = (await pRes.json())[0];
      acct = p && p.stripe_account;
    }

    if (!acct) return res.status(400).json({ error: 'Žádný připojený Stripe účet' });

    // 2) typ účtu → Express/Custom = login link, Standard = vlastní dashboard
    let acctObj;
    try { acctObj = await stripe.accounts.retrieve(acct); }
    catch (e) { return res.status(400).json({ error: 'Stripe účet nenalezen (' + (e.message || '') + ')' }); }

    if (acctObj.type === 'express' || acctObj.type === 'custom') {
      const link = await stripe.accounts.createLoginLink(acct);
      return res.status(200).json({ url: link.url, type: acctObj.type });
    }
    return res.status(200).json({ url: 'https://dashboard.stripe.com/', type: 'standard' });
  } catch (err) {
    console.error('stripe-login-link error:', err);
    res.status(500).json({ error: err.message });
  }
}
