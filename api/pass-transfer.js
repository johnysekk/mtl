// /api/pass-transfer — DRŽITEL PERMANENTKY NA UKONČENOU LEKCI SE ROZHODNE.
//
// Klub ukončil lekci a nabídl přesun permanentky na jiné lekce (viz _pass-transfer.js). Přesun
// platí jen se souhlasem držitele; místo něj si může nechat vrátit nevyčerpanou část.
//
//   POST { id, choice:'transfer'|'refund', text }   text = znění, které potvrdil (snímek)

import { settleRefund, applyTransfer } from './_pass-transfer.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim(); if (!tok) return null;
  try { const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null; const u = await r.json(); return (u && u.id) || null; } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const me = await whoami(req); if (!me) return res.status(401).json({ ok: false, error: 'Přihlas se.' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(b.id || ''), choice = String(b.choice || ''), text = String(b.text || '').slice(0, 2000);
    if (!id || !['transfer', 'refund'].includes(choice) || !text) return res.status(400).json({ ok: false, error: 'id + choice + text required' });
    const r = await fetch(`${SB}/rest/v1/pass_transfers?id=eq.${q(id)}&select=*`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    const row = r.ok ? ((await r.json()) || [])[0] : null;
    if (!row || String(row.student_id) !== String(me)) return res.status(404).json({ ok: false, error: 'Nabídka nenalezena.' });
    if (row.decision) return res.status(409).json({ ok: false, error: 'Už je rozhodnuto.', decision: row.decision });
    if (choice === 'transfer') {
      let to = row.to_cids; try { if (typeof to === 'string') to = JSON.parse(to); } catch (e) { to = []; }
      if (!Array.isArray(to) || !to.length) return res.status(400).json({ ok: false, error: 'Klub přesun nenabízí.' });
      const ok = await applyTransfer(row, text);
      return res.status(ok ? 200 : 409).json({ ok, decision: 'transfer' });
    }
    const out = await settleRefund(row, { auto: false, text });
    if (!out) return res.status(409).json({ ok: false, error: 'Už je rozhodnuto.' });
    return res.status(200).json({ ok: true, decision: 'refund', refund: out.refund, currency: out.currency, status: out.status, method: out.method });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
}
