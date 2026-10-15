import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SB = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

// PŘIHLÁŠENÍ SE OVĚŘUJE U SUPABASE (/auth/v1/user), nikdy jen přečtením tokenu. Dřív tu byla
// „poslední záchrana": když ověření selhalo, vzalo se ID uživatele z nepodepsaného obsahu tokenu.
// Token si tak mohl kdokoli vyrobit s cizím ID a dostat odkaz do Stripe dashboardu cizího klubu
// nebo kouče (výplatní účet!). Stejně tak natvrdo zapsaná adresa a klíč ostré databáze --
// testovací kopie by s nimi mluvila s ostrou databází.
export default async function handler(req, res) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Chybí přihlášení' });
    if (!SB || !SVC) return res.status(500).json({ error: 'Server: chybí SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });

    let uid = null;
    try {
      const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SVC, Authorization: `Bearer ${token}` } });
      if (u.ok) { const j = await u.json(); if (j && j.id) uid = j.id; }
    } catch (e) {}
    if (!uid) return res.status(401).json({ error: 'Neplatné přihlášení — odhlas se a přihlas znovu.' });

    // Legacy JWT service key (eyJ…) jde jako Bearer; nový sb_secret_… jen jako apikey.
    const svcHeaders = (SVC.startsWith('eyJ')) ? { apikey: SVC, Authorization: `Bearer ${SVC}` } : { apikey: SVC };
    const gymId = req.query.gymId;
    let acct = null;

    if (gymId) {
      const gRes = await fetch(`${SB}/rest/v1/gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id,stripe_account`, { headers: svcHeaders });
      let garr = []; try { garr = await gRes.json(); } catch(e){}
      const g = Array.isArray(garr) ? garr[0] : null;
      if (!g) return res.status(404).json({ error: `Gym nenalezen (db=${gRes.status})` });
      if (g.owner_id !== uid) return res.status(403).json({ error: 'Nejsi vlastník tohoto gymu' });
      acct = g.stripe_account;
    } else {
      const payout = String(req.query.payout || '') === '1';
      const sel = payout ? 'gym_payout_account' : 'stripe_account';
      const pRes = await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=${sel}`, { headers: svcHeaders });
      let parr = []; try { parr = await pRes.json(); } catch(e){}
      const p = Array.isArray(parr) ? parr[0] : null;
      acct = p && p[sel];
      if (!acct) return res.status(400).json({ error: `Žádný připojený Stripe účet (db=${pRes.status}${Array.isArray(parr)?' n='+parr.length:' err'})` });
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
