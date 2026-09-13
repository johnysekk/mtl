// /api/commission-pay-now.js — jednorázová úhrada nestržené provize MTL.
//
// PROČ: když se měsíční stržení z karty nepovede, cron to zkouší po třech dnech a po dvou
// týdnech pozastaví účet. Do té doby neměl poskytovatel žádnou možnost to zaplatit sám —
// jen čekat na další pokus. Tohle mu dá tlačítko „Zaplatit hned".
//
// Postup: spočítá dlužnou částku ze stejných řádků, které počítá commission-cron
// (commission_status = 'failed'), založí Stripe Checkout a vrátí odkaz. Po zaplacení
// stripe-webhook řádky označí za vybrané a vystaví doklad.
//
// GET  ?token=...            → údaje k úhradě (kolik, za co) pro stránku výzvy
// POST { token }             → vrátí { url } na Stripe Checkout
//
// Token je podepsaný odkaz z e-mailu, takže na úhradu stačí kliknout — přihlášení se
// nevyžaduje. Nic jiného token neumožňuje.

import Stripe from 'stripe';
import crypto from 'crypto';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const APP = process.env.APP_URL || 'https://app.martialtraininglab.com';

const sb = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...svc, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`SB ${path}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
};

// ── TOKEN ───────────────────────────────────────────────────────────────────────────────
// Podepsaný obsah, ne náhodné id: nemusí se nic ukládat a nejde ho podvrhnout bez klíče.
// Platí 30 dní; po zaplacení je stejně k ničemu, protože už není co uhradit.
const SECRET = process.env.CRON_SECRET || KEY || 'mtl';
const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url').slice(0, 32);

export function makePayToken(kind, id, ym) {
  const payload = b64(JSON.stringify({ k: kind, i: id, m: ym, t: Date.now() }));
  return payload + '.' + sign(payload);
}
function readToken(tok) {
  try {
    const [payload, sig] = String(tok || '').split('.');
    if (!payload || !sig || sign(payload) !== sig) return null;
    const o = JSON.parse(unb64(payload));
    if (!o || !o.k || !o.i) return null;
    if (Date.now() - (o.t || 0) > 30 * 86400000) return null;   // odkaz starší 30 dní neplatí
    return o;
  } catch (e) { return null; }
}

// ── DLUŽNÁ ČÁSTKA ───────────────────────────────────────────────────────────────────────
// Bere přesně ty řádky, které cron označil jako 'failed'. Součet po měnách -- klub může mít
// transakce ve víc měnách a Stripe každou účtuje zvlášť.
const OWNER_COL = { gym: 'gym_id', coach: 'coach_id', org: 'organization_id' };

async function owedFor(kind, id) {
  const col = OWNER_COL[kind];
  if (!col) return null;
  const rows = await sb(`transactions?${col}=eq.${encodeURIComponent(id)}&commission_status=eq.failed&select=id,mtl_fee,mtl_fee_refunded,currency,commission_month`);
  const by = {};
  (rows || []).forEach(r => {
    const cur = String(r.currency || 'CZK').toLowerCase();
    const net = (Number(r.mtl_fee) || 0) - (Number(r.mtl_fee_refunded) || 0);
    if (net <= 0) return;
    by[cur] = (by[cur] || 0) + net;
  });
  return { rows: rows || [], by };
}

async function ownerInfo(kind, id) {
  if (kind === 'gym') {
    const g = (await sb(`gyms?id=eq.${encodeURIComponent(id)}&select=id,name,owner_id`))[0];
    return g ? { name: g.name, userId: g.owner_id } : null;
  }
  if (kind === 'org') {
    const o = (await sb(`organizations?id=eq.${encodeURIComponent(id)}&select=id,name,owner_id`))[0];
    return o ? { name: o.name, userId: o.owner_id } : null;
  }
  const p = (await sb(`profiles?id=eq.${encodeURIComponent(id)}&select=id,name`))[0];
  return p ? { name: p.name, userId: p.id } : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const tok = (req.method === 'GET') ? req.query.token : ((req.body || {}).token);
    const o = readToken(tok);
    if (!o) return res.status(400).json({ error: 'invalid or expired link' });

    const info = await ownerInfo(o.k, o.i);
    if (!info) return res.status(404).json({ error: 'not found' });

    const owed = await owedFor(o.k, o.i);
    const curs = Object.keys(owed.by);
    const total = curs.reduce((a, c) => a + owed.by[c], 0);

    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true, name: info.name, month: o.m || null,
        amounts: owed.by, count: owed.rows.length, settled: total <= 0,
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

    // Nic nedluží -- typicky proto, že mezitím prošel další pokus cronu. Ať to řekne rovnou,
    // místo aby vytvořil platbu na nulu.
    if (total <= 0) return res.status(200).json({ ok: true, settled: true });
    if (curs.length > 1) {
      // Víc měn = víc plateb. Řeší se po jedné; vrací se ta největší, zbytek zůstane na cron.
      curs.sort((a, b) => owed.by[b] - owed.by[a]);
    }
    const cur = curs[0];
    const amount = Math.round(owed.by[cur]);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: cur,
          unit_amount: amount,
          product_data: { name: `MTL provize${o.m ? (' · ' + o.m) : ''} — ${info.name || ''}`.trim() },
        },
      }],
      // Podle metadat webhook pozná, které řádky označit za vybrané a komu vystavit doklad.
      metadata: { mtl_kind: 'commission_paynow', owner_kind: o.k, owner_id: String(o.i), month: String(o.m || ''), currency: cur },
      success_url: `${APP}/?commission_paid=1`,
      cancel_url: `${APP}/?commission_paid=0`,
    });

    return res.status(200).json({ ok: true, url: session.url, amount, currency: cur });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
