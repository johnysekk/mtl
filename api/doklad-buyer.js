// /api/doklad-buyer — NÁKUP NA FIRMU (sql/doklad-buyer.sql, api/_doklad-buyer.js).
// Karta:     POST { sessionId, acct, company, ico?, dic?, address, country }   (clear:true = odškrtnuto)
// QR / PIS:  POST { table, id, company, ico?, dic?, address, country }         (clear:true = odškrtnuto)
//
// Firma se pak propíše do dokladu jako Odběratel. Karta funguje i pro hosta bez účtu (kdo má
// otevřenou platbu na účtu klubu / kouče, smí k ní firmu vyplnit). Po zaplacení kartou jde údaje
// ještě chvíli opravit (stiskl Zaplatit dřív, než se uložily) -- do už vystaveného dokladu se
// doplní jen tehdy, když v něm firma ještě není.
// U převodu se firma váže k řádku objednávky (rezervace, členství, vstupenka, kurz, zboží):
// řádek s účtem smí měnit jen jeho kupující, řádek hosta jen do zaplacení (id řádku je náhodné
// a zná ho jen ten, kdo objednával). Po vystavení dokladu se už nic nemění.
import Stripe from 'stripe';
import { bindBuyerForSession, cleanBuyer, saveBuyer, clearBuyer, srcKey, BUYER_TABLES } from './_doklad-buyer.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
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
async function _get(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H() });
  return r.ok ? r.json() : [];
}

async function card(b, req) {
  const sessionId = String(b.sessionId || ''), acct = String(b.acct || '');
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sessionId) || !/^acct_[A-Za-z0-9]{6,64}$/.test(acct)) return [400, { error: 'bad request' }];
  let s;
  try { s = await stripe.checkout.sessions.retrieve(sessionId, { stripeAccount: acct }); } catch (e) { return [404, { error: 'Platba nenalezena.' }]; }
  if (!s || s.status === 'expired') return [410, { error: 'Platba vypršela. Otevři ji znovu.' }];
  const done = s.status === 'complete';
  if (done && (Date.now() - (s.created || 0) * 1000) > LATE_MS) return [409, { error: 'Platba je už uzavřená, údaje firmy k ní nejde změnit.' }];
  if (b.clear === true) { if (!done) await clearBuyer(sessionId); return [200, { ok: true }]; }
  const c = cleanBuyer(b);
  if (!c.ok) return [400, { error: c.error }];
  await saveBuyer(sessionId, c.row, { acct, user_id: await _userId(req) });
  // Už zaplaceno -> napojit hned a doplnit doklad.
  const filled = done ? await bindBuyerForSession(stripe, s, acct) : 0;
  return [200, { ok: true, filled }];
}

async function source(b, req) {
  const table = String(b.table || ''), id = String(b.id || '').trim();
  if (BUYER_TABLES.indexOf(table) < 0 || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return [400, { error: 'bad request' }];
  const row = ((await _get(`${table}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`)) || [])[0];
  if (!row) return [404, { error: 'Objednávka nenalezena.' }];
  const owner = row.student_id || row.buyer_id || null;
  const me = await _userId(req);
  if (owner) {
    if (!me || (String(me) !== String(owner) && String(me) !== String(row.paid_by || ''))) return [403, { error: 'Tahle objednávka není tvoje.' }];
  } else if (Date.now() - new Date(row.created_at || 0).getTime() > 7 * 864e5) {
    return [409, { error: 'Objednávka je moc stará.' }];
  }
  // Po vystavení dokladu se nic nemění (kurz: platí pro další splátky, ty doklady ještě nevznikly).
  if (table !== 'cohort_members') {
    const tx = await _get(`transactions?source_booking_id=eq.${encodeURIComponent(id)}&select=id&limit=1`);
    if (tx && tx.length) return [409, { error: 'Za tuhle objednávku už je vystavený doklad.' }];
  }
  const key = srcKey(table, id);
  if (b.clear === true) { await clearBuyer(key); return [200, { ok: true }]; }
  const c = cleanBuyer(b);
  if (!c.ok) return [400, { error: c.error }];
  await saveBuyer(key, c.row, { user_id: me });
  return [200, { ok: true }];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const [code, body] = b.table ? await source(b, req) : await card(b, req);
    return res.status(code).json(body);
  } catch (e) {
    console.error('[doklad-buyer]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
