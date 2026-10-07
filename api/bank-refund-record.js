// /api/bank-refund-record — POSKYTOVATEL VRÁTIL PENÍZE PŘEVODEM / HOTOVĚ.
//
// MTL u plateb převodem/QR/hotově peníze nedrží -- vrací je poskytovatel sám. Tady se to jen
// ZAPÍŠE k transakci: vrácená částka (pro přehledy a doklady) a poměrná provize MTL, pokud
// ještě není stržená (pravidlo _fee-window.js: po stržení / vystavení dokladu se nevrací).
//
// POST { kind:'membership'|'private'|'drop_in', id, amount }   (amount v hlavní měně, např. 1500)

import { bankFeeRefundable, sessionConsumed } from './_fee-window.js';
import { prorata, membershipPeriodForTx } from './_prorata.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}) } });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}
async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim(); if (!tok) return null;
  try { const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null; const u = await r.json(); return (u && u.id) || null; } catch (e) { return null; }
}
async function isGymBoss(gymId, me) {
  const g = ((await sb(`gyms?id=eq.${q(gymId)}&select=owner_id`)) || [])[0];
  if (g && String(g.owner_id) === String(me)) return true;
  const gc = (await sb(`gym_coaches?gym_id=eq.${q(gymId)}&coach_id=eq.${q(me)}&status=eq.active&select=co_owner`)) || [];
  return gc.some((x) => x.co_owner);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const me = await whoami(req); if (!me) return res.status(401).json({ ok: false, error: 'no token' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const kind = String(b.kind || ''); const id = String(b.id || '');
    const amt = Math.round((parseFloat(b.amount) || 0) * 100);
    if (!id || !(amt > 0)) return res.status(400).json({ ok: false, error: 'id + amount required' });

    let tx = null, consumed = false;
    if (kind === 'membership') {
      const m = ((await sb(`gym_memberships?id=eq.${q(id)}&select=gym_id,student_id,created_at`)) || [])[0];
      if (!m) return res.status(404).json({ ok: false, error: 'membership not found' });
      if (!(await isGymBoss(m.gym_id, me))) return res.status(403).json({ ok: false, error: 'forbidden' });
      tx = ((await sb(`transactions?gym_id=eq.${q(m.gym_id)}&member_id=eq.${q(m.student_id)}&type=eq.membership&payment_method=in.(cash,qr,pis)&order=created_at.desc&limit=1&select=id,gym_id,member_id,created_at,gross_amount,refund_amount,mtl_fee,mtl_fee_refunded,commission_status`)) || [])[0];
    } else if (kind === 'private') {
      const bk = ((await sb(`bookings?id=eq.${q(id)}&select=coach_id,training_date,training_time,type,fulfilled,checked_in_at,student_confirmed`)) || [])[0];
      if (!bk || String(bk.coach_id) !== String(me)) return res.status(403).json({ ok: false, error: 'forbidden' });
      consumed = await sessionConsumed('private', bk);
      tx = ((await sb(`transactions?source_booking_id=eq.${q(id)}&payment_method=in.(cash,qr,pis)&limit=1&select=id,gross_amount,refund_amount,mtl_fee,mtl_fee_refunded,commission_status`)) || [])[0];
    } else if (kind === 'drop_in') {
      const gb = ((await sb(`gym_bookings?id=eq.${q(id)}&select=gym_id,student_id,class_date,class_time,date,time,reception_checkin`)) || [])[0];
      if (!gb || !(await isGymBoss(gb.gym_id, me))) return res.status(403).json({ ok: false, error: 'forbidden' });
      consumed = await sessionConsumed('drop_in', gb);
      tx = ((await sb(`transactions?source_booking_id=eq.${q(id)}&payment_method=in.(cash,qr,pis)&limit=1&select=id,gross_amount,refund_amount,mtl_fee,mtl_fee_refunded,commission_status`)) || [])[0];
    } else if (kind === 'tx') {
      // Libovolná platba převodem/hotově studenta v klubu (např. zrušený jednorázový vstup).
      const t0 = ((await sb(`transactions?id=eq.${q(id)}&select=gym_id`)) || [])[0];
      if (!t0 || !t0.gym_id || !(await isGymBoss(t0.gym_id, me))) return res.status(403).json({ ok: false, error: 'forbidden' });
      tx = ((await sb(`transactions?id=eq.${q(id)}&payment_method=in.(cash,qr,pis)&select=id,gross_amount,refund_amount,mtl_fee,mtl_fee_refunded,commission_status`)) || [])[0];
    } else return res.status(400).json({ ok: false, error: 'unknown kind' });

    if (!tx) return res.status(200).json({ ok: true, recorded: false });   // platba v evidenci není (např. před MTL)
    const gross = Number(tx.gross_amount) || 0;
    const already = Number(tx.refund_amount) || 0;
    const back = Math.max(0, Math.min(amt, gross - already));
    if (!back) return res.status(200).json({ ok: true, recorded: false, reason: 'already refunded' });
    const patch = { refund_amount: already + back, status: (already + back >= gross) ? 'refunded' : 'partial_refund' };
    // Provize se vrací jen z části, kterou student nevyčerpal: u jednorázové lekce nic, když už
    // začala; u členství nejvýš z poměrné části za nevyužité dny. Peníze, které poskytovatel vrátí
    // navíc, se zapíšou, ale provizi nesnižují (_fee-window.js, _prorata.js).
    let feeBase = consumed ? 0 : back;
    if (kind === 'membership' && !b.withdrawal_id) {   // odstoupení do 14 dnů už je spočítané poměrně
      const per = await membershipPeriodForTx(sb, tx);
      const pr = per ? prorata(gross, per.startMs, per.endMs) : null;
      if (pr) feeBase = Math.min(back, Math.max(0, pr.unused - already));
    }
    let feeBack = 0;
    if (bankFeeRefundable(tx) && gross > 0 && feeBase > 0) {
      feeBack = Math.round((Number(tx.mtl_fee) || 0) * feeBase / gross);
      patch.mtl_fee_refunded = Math.min(Number(tx.mtl_fee) || 0, (Number(tx.mtl_fee_refunded) || 0) + feeBack);
    }
    await sb(`transactions?id=eq.${q(tx.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
    // Vrácení po odstoupení od smlouvy: odstoupení je tím vyřízené.
    if (b.withdrawal_id) { try { await sb(`withdrawal_requests?id=eq.${q(String(b.withdrawal_id))}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'refunded', refunded_at: new Date().toISOString() }) }); } catch (e) {} }
    return res.status(200).json({ ok: true, recorded: true, refunded: back / 100, fee_returned: feeBack / 100 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
}
