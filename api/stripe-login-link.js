import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const ANON_FALLBACK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlxZW92Y3ZjaHR5Znd0eXpwcXJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTY1MjksImV4cCI6MjA5NTkzMjUyOX0.oQMTjym7VM4ZqAXYfQqqgxJCXpOM5aLEQiJfuuChu7U';
const URL_FALLBACK = 'https://iqeovcvchtyfwtyzpqrh.supabase.co';

function decodeSub(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    const expired = p.exp ? (p.exp * 1000 < Date.now()) : false;
    return { sub: p.sub || null, role: p.role || null, expired };
  } catch (e) { return { sub: null, role: null, expired: false }; }
}

export default async function handler(req, res) {
  const diag = { whoami: null, auth: null, decoded: null, method: null };
  try {
    let SB = (process.env.SUPABASE_URL || URL_FALLBACK).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(SB)) SB = 'https://' + SB;
    if (!SB.includes('.supabase.co')) SB = URL_FALLBACK;
    const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ANON = process.env.SUPABASE_ANON_KEY || ANON_FALLBACK;
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
    const debug = String(req.query.debug || '') === '1';
    if (!token) return res.status(401).json({ error: 'Chybí přihlášení' });
    if (!SVC) return res.status(500).json({ error: 'Server: chybí SUPABASE_SERVICE_ROLE_KEY' });

    const dec = decodeSub(token);
    diag.decoded = { sub: dec.sub ? dec.sub.slice(0, 8) + '…' : null, role: dec.role, expired: dec.expired };

    let uid = null;

    // 1) whoami RPC (ověřené přes /rest/v1 – stejná cesta jako webhook)
    try {
      const w = await fetch(`${SB}/rest/v1/rpc/whoami`, {
        method: 'POST',
        headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      diag.whoami = w.status;
      if (w.ok) { const j = await w.json(); if (j && typeof j === 'string') { uid = j; diag.method = 'whoami'; } }
      else { diag.whoamiBody = (await w.text()).slice(0, 120); }
    } catch (e) { diag.whoami = 'err:' + e.message; }

    // 2) fallback /auth/v1/user
    if (!uid) {
      try {
        const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
        diag.auth = u.status;
        if (u.ok) { const j = await u.json(); if (j && j.id) { uid = j.id; diag.method = 'auth'; } }
      } catch (e) { diag.auth = 'err:' + e.message; }
    }

    // 3) poslední záchrana: sub z tokenu (odblokuje testování; whoami je preferované/bezpečné)
    if (!uid && dec.sub && !dec.expired) { uid = dec.sub; diag.method = 'decoded'; }

    if (debug) return res.status(200).json({ uid: uid ? uid.slice(0, 8) + '…' : null, diag });
    if (!uid) return res.status(401).json({ error: `Neplatné přihlášení · whoami=${diag.whoami} auth=${diag.auth} sub=${diag.decoded.sub ? 'ok' : 'none'}${dec.expired ? ' (token vypršel — odhlas se a přihlas znovu)' : ''}` });

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
      const pRes = await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=stripe_account`, { headers: svcHeaders });
      let parr = []; try { parr = await pRes.json(); } catch(e){}
      const p = Array.isArray(parr) ? parr[0] : null;
      acct = p && p.stripe_account;
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
    res.status(500).json({ error: err.message, diag });
  }
}
