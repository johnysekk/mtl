import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Anon key je veřejný (je i v klientovi).
const ANON_FALLBACK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxZW92Y3ZjaHR5Znd0eXpwcXJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTY1MjksImV4cCI6MjA5NTkzMjUyOX0.oQMTjym7VM4ZqAXYfQqqgxJCXpOM5aLEQiJfuuChu7U';
const URL_FALLBACK = 'https://iqeovcvchtyfwtyzpqrh.supabase.co';

// Ověří uživatelský token → vrátí auth.uid(). Primárně přes /rest/v1/rpc/whoami
// (stejná cesta, kterou úspěšně používá webhook), fallback /auth/v1/user.
async function resolveUid(SB, ANON, token) {
  // 1) whoami RPC (auth kontext z user tokenu)
  try {
    const w = await fetch(`${SB}/rest/v1/rpc/whoami`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (w.ok) {
      const uid = await w.json();
      if (uid && typeof uid === 'string') return { uid };
    }
  } catch (e) {}
  // 2) fallback: /auth/v1/user
  try {
    const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
    if (u.ok) {
      const j = await u.json();
      if (j && j.id) return { uid: j.id };
    }
    return { err: 'auth ' + u.status };
  } catch (e) { return { err: e.message }; }
}

export default async function handler(req, res) {
  try {
    let SB = (process.env.SUPABASE_URL || URL_FALLBACK).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(SB)) SB = 'https://' + SB;            // ošetři chybějící schéma
    if (!SB.includes('.supabase.co')) SB = URL_FALLBACK;           // pojistka proti špatné env hodnotě
    const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ANON = process.env.SUPABASE_ANON_KEY || ANON_FALLBACK;
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
    if (!token) return res.status(401).json({ error: 'Chybí přihlášení' });
    if (!SVC) return res.status(500).json({ error: 'Server: chybí SUPABASE_SERVICE_ROLE_KEY' });

    const { uid, err } = await resolveUid(SB, ANON, token);
    if (!uid) return res.status(401).json({ error: 'Neplatné přihlášení (' + (err || 'token') + ')' });

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
