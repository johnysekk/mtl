// /api/doklad-buyer — NÁKUP NA FIRMU u platby kartou (sql/doklad-buyer.sql).
// POST { sessionId, acct, company, ico?, dic?, address?, country }  -> uloží firmu k platbě
// POST { sessionId, acct, clear: true }                               -> „Nakupuji na firmu" odškrtnuto
//
// Firma se pak propíše do dokladu jako Odběratel. Funguje i pro hosta bez účtu (QR na recepci):
// kdo má otevřenou platbu (Checkout session na účtu klubu / kouče), smí k ní firmu vyplnit.
// Po zaplacení jde údaje ještě chvíli opravit (stisknutí Zaplatit dřív, než se uložily) --
// do už vystaveného dokladu se doplní jen tehdy, když v něm firma ještě není.
import Stripe from 'stripe';
import { bindBuyerForSession } from './_doklad-buyer.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
const str = (v, n) => (v == null ? null : (String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null));
const LATE_MS = 2 * 60 * 60 * 1000;

async function _userId(req) {
  try {
    const t = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!t) return null;
    const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${t}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.id) || null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const sessionId = String(b.sessionId || ''), acct = String(b.acct || '');
    if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId) || !/^acct_[A-Za-z0-9]{6,64}$/.test(acct)) return res.status(400).json({ error: 'bad request' });

    // Platba musí existovat na účtu klubu / kouče -- jinak tam nikdo nic neuloží.
    let s;
    try { s = await stripe.checkout.sessions.retrieve(sessionId, { stripeAccount: acct }); } catch (e) { return res.status(404).json({ error: 'Platba nenalezena.' }); }
    if (!s || s.status === 'expired') return res.status(410).json({ error: 'Platba vypršela. Otevři ji znovu.' });
    const done = s.status === 'complete';
    if (done && (Date.now() - (s.created || 0) * 1000) > LATE_MS) return res.status(409).json({ error: 'Platba je už uzavřená, údaje firmy k ní nejde změnit.' });

    if (b.clear === true) {
      if (!done) await fetch(`${SB}/rest/v1/doklad_buyers?session_id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: H() });
      return res.status(200).json({ ok: true });
    }

    const company = str(b.company, 200);
    const country = String(b.country || 'CZ').trim().toUpperCase();
    const ico = str(b.ico, 20) ? String(b.ico).replace(/\s+/g, '') : null;
    const dic = str(b.dic, 20) ? String(b.dic).replace(/\s+/g, '').toUpperCase() : null;
    const address = str(b.address, 300);
    if (!company) return res.status(400).json({ error: 'Vyplň název firmy.' });
    if (!/^[A-Z]{2}$/.test(country)) return res.status(400).json({ error: 'Vyber zemi firmy.' });
    if (country === 'CZ' && ico && !/^\d{8}$/.test(ico)) return res.status(400).json({ error: 'IČO má 8 číslic.' });
    if (dic && !/^[A-Z]{2}[0-9A-Z+*.]{2,14}$/.test(dic)) return res.status(400).json({ error: 'DIČ začíná kódem země (např. CZ12345678).' });
    if (!address) return res.status(400).json({ error: 'Vyplň sídlo firmy.' });

    const row = { session_id: sessionId, acct, user_id: await _userId(req), company, ico, dic, address, country, updated_at: new Date().toISOString() };
    const r = await fetch(`${SB}/rest/v1/doklad_buyers?on_conflict=session_id`, { method: 'POST', headers: { ...H(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
    if (!r.ok) throw new Error(`SB ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);

    // Už zaplaceno (stisknul Zaplatit dřív, než se údaje uložily) -> napojit hned a doplnit doklad.
    let filled = 0;
    if (done) filled = await bindBuyerForSession(stripe, s, acct);
    return res.status(200).json({ ok: true, filled });
  } catch (e) {
    console.error('[doklad-buyer]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
