// /api/commission-pay-now-token.js — vydá platební odkaz přihlášenému poskytovateli.
//
// PROČ ZVLÁŠŤ: odkaz v e-mailu je podepsaný token, protože e-mail nemá přihlášení. V appce
// ale uživatel přihlášený je a nemá smysl po něm chtít, aby si hledal e-mail. Tenhle endpoint
// zjistí, které entity ten člověk vlastní, vybere tu s dluhem a vrátí rovnou odkaz na platbu.
//
// POST { user_id } → { url } | { settled: true } | { error }

import { makePayToken } from './commission-pay-now.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const APP = process.env.APP_URL || 'https://app.martialtraininglab.com';

const sbGet = async (path) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
  return r.ok ? r.json() : [];
};

// Stejný rozsah jako commission-pay-now a commission-cron: pending i failed, uzavřená
// i aktuální období, jen platby mimo Stripe. Kdyby se rozešly, appka by nabízela platbu tam,
// kde není co platit, nebo naopak.
const OWNER_COL = { gym: 'gym_id', coach: 'coach_id', org: 'organization_id' };
async function owes(kind, id) {
  const col = OWNER_COL[kind];
  const cm = new Date().toISOString().slice(0, 7);
  const rows = await sbGet(`transactions?${col}=eq.${encodeURIComponent(id)}&commission_status=in.(pending,failed)&commission_month=lte.${cm}&payment_method=in.(cash,qr,pis)&select=mtl_fee,mtl_fee_refunded`);
  return (rows || []).reduce((a, r) => a + Math.max(0, (Number(r.mtl_fee) || 0) - (Number(r.mtl_fee_refunded) || 0)), 0);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const userId = (req.body || {}).user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });

    // Kandidáti: kouč sám za sebe, jeho kluby, jeho organizace.
    const cands = [{ kind: 'coach', id: userId }];
    try {
      const gyms = await sbGet(`gyms?owner_id=eq.${encodeURIComponent(userId)}&deleted_at=is.null&select=id`);
      (gyms || []).forEach((g) => cands.push({ kind: 'gym', id: g.id }));
    } catch (e) {}
    try {
      const orgs = await sbGet(`organizations?owner_id=eq.${encodeURIComponent(userId)}&select=id`);
      (orgs || []).forEach((o) => cands.push({ kind: 'org', id: o.id }));
    } catch (e) {}

    // Vybere tu entitu, která dluží nejvíc. Víc dlužících entit naráz je výjimečné; zbytek
    // doplatí dalším kliknutím, protože pruh zůstane viset, dokud je co platit.
    let best = null;
    for (const c of cands) {
      const amt = await owes(c.kind, c.id);
      if (amt > 0 && (!best || amt > best.amt)) best = { ...c, amt };
    }
    if (!best) return res.status(200).json({ ok: true, settled: true });

    const ym = new Date().toISOString().slice(0, 7);
    return res.status(200).json({
      ok: true,
      url: `${APP}/pay-commission?token=${makePayToken(best.kind, best.id, ym)}`,
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
