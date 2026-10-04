// /api/withdraw-membership — ODSTOUPENÍ OD SMLOUVY DO 14 DNŮ (permanentka od podnikatele).
//
// Spotřebitel může od smlouvy uzavřené online odstoupit do 14 dnů (§ 1829 OZ). Když na jeho
// žádost služba začala hned, zaplatí poměrnou část za dobu, kdy běžela (§ 1834 OZ); zbytek mu
// prodávající vrátí do 14 dnů od odstoupení (§ 1831 OZ). U členství ve spolku se nepoužije.
//
// Co endpoint udělá:
//   • ověří, že permanentka patří volajícímu, prodával ji podnikatel a je do 14 dnů od začátku
//   • spočítá poměrnou část a částku k vrácení
//   • uloží odstoupení se zněním prohlášení a vazbou na platbu/doklad (withdrawal_requests)
//   • ukončí permanentku (a Stripe předplatné hned)
//   • karta: vrátí peníze rovnou přes Stripe; převod/hotovost: klub dostane úkol vrátit převodem
//   • notifikace studentovi (proklik na doklad) a klubu (proklik na zápis vrácení)
//
// POST { membership_id, statement }

import Stripe from 'stripe';
import { sellKindFor } from './_sell-kind.js';
import { feeRefundableForPI } from './_fee-window.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
const DAY = 86400000;

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}) } });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}
const sbGet = (p) => sb(p).catch(() => []);
async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim(); if (!tok) return null;
  try { const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null; const u = await r.json(); return (u && u.id) || null; } catch (e) { return null; }
}
const fmt = (minor, cur) => (Math.round(minor) / 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2 }) + ' ' + (String(cur || 'CZK').toUpperCase() === 'CZK' ? 'Kč' : String(cur || '').toUpperCase());

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const me = await whoami(req); if (!me) return res.status(401).json({ ok: false, error: 'Přihlas se.' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const mid = String(b.membership_id || ''); const statement = String(b.statement || '').slice(0, 2000);
    if (!mid || !statement) return res.status(400).json({ ok: false, error: 'membership_id + statement required' });

    const m = ((await sbGet(`gym_memberships?id=eq.${q(mid)}&select=id,gym_id,gym_name,student_id,plan_name,months,amount,currency,status,created_at,stripe_subscription,paid_to,coach_id`)) || [])[0];
    if (!m || String(m.student_id) !== String(me)) return res.status(404).json({ ok: false, error: 'Permanentka nenalezena.' });
    if (!['active', 'cancelling'].includes(String(m.status))) return res.status(400).json({ ok: false, error: 'Permanentka už neběží.' });
    if ((await sellKindFor(sbGet, { gymId: m.gym_id, paidTo: m.paid_to })) !== 'pass') return res.status(400).json({ ok: false, error: 'U členství ve spolku se odstoupení do 14 dnů nepoužije — vrácení řeší stanovy.' });
    const start = new Date(m.created_at).getTime();
    if (!(Date.now() - start <= 14 * DAY)) return res.status(400).json({ ok: false, error: 'Lhůta 14 dnů na odstoupení už uplynula — ukončení se řídí pravidly klubu.' });
    const dup = await sbGet(`withdrawal_requests?membership_id=eq.${q(mid)}&select=id&limit=1`);
    if (dup && dup.length) return res.status(409).json({ ok: false, error: 'Od téhle permanentky už jsi odstoupil/a.' });

    // Platba za permanentku (poslední po jejím založení).
    const tx = ((await sbGet(`transactions?gym_id=eq.${q(m.gym_id)}&member_id=eq.${q(me)}&type=eq.membership&created_at=gte.${q(new Date(start - DAY).toISOString())}&order=created_at.desc&limit=1&select=id,gross_amount,refund_amount,currency,payment_intent,payment_method,mtl_fee,mtl_fee_refunded,commission_status,created_at`)) || [])[0] || null;
    const gross = tx ? (Number(tx.gross_amount) || 0) : Math.round((Number(m.amount) || 0) * 100);
    const already = tx ? (Number(tx.refund_amount) || 0) : 0;
    const cur = (tx && tx.currency) || m.currency || 'CZK';
    const totalDays = Math.max(1, (parseInt(m.months, 10) || 1) * 30);
    const usedDays = Math.min(totalDays, Math.max(1, Math.ceil((Date.now() - start) / DAY)));
    const keep = Math.round(gross * usedDays / totalDays);
    const refund = Math.max(0, gross - keep - already);
    let doklad = null; if (tx) { const d = ((await sbGet(`doklady?transaction_id=eq.${q(tx.id)}&select=doklad_no&limit=1`)) || [])[0]; doklad = d ? d.doklad_no : null; }

    const gym = ((await sbGet(`gyms?id=eq.${q(m.gym_id)}&select=owner_id,name,stripe_account`)) || [])[0] || {};
    let acct = gym.stripe_account || null;
    if (m.paid_to === 'coach' && m.coach_id) { const cp = ((await sbGet(`profiles?id=eq.${q(m.coach_id)}&select=gym_payout_account`)) || [])[0]; acct = (cp && cp.gym_payout_account) || acct; }

    // Karta: vrátit hned. Převod/hotovost: úkol pro klub.
    const isCard = !!(tx && tx.payment_intent && !String(tx.payment_intent).startsWith('pis') && !['cash', 'qr', 'pis'].includes(String(tx.payment_method || '')));
    let status = 'pending', refundedNow = 0;
    if (isCard && refund > 0 && acct) {
      await stripe.refunds.create({ payment_intent: tx.payment_intent, amount: refund, refund_application_fee: await feeRefundableForPI(tx.payment_intent) }, { stripeAccount: acct });
      status = 'refunded'; refundedNow = refund;
    } else if (refund <= 0) status = 'refunded';
    if (m.stripe_subscription && acct) { try { await stripe.subscriptions.cancel(m.stripe_subscription, {}, { stripeAccount: acct }); } catch (e) {} }

    const nowIso = new Date().toISOString();
    const row = ((await sb('withdrawal_requests', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({
      user_id: me, gym_id: m.gym_id, membership_id: m.id, transaction_id: tx ? tx.id : null, doklad_no: doklad,
      statement, gross_amount: gross, used_days: usedDays, total_days: totalDays, keep_amount: keep, refund_amount: refund, currency: cur,
      method: isCard ? 'card' : 'transfer', status, refunded_at: status === 'refunded' ? nowIso : null }) })) || [])[0] || {};
    await sb(`gym_memberships?id=eq.${q(m.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'ended', cancelled_at: nowIso, period_end: nowIso }) });

    // Notifikace: student (proklik na doklad k platbě), klub (u převodu proklik na zápis vrácení).
    const plan = m.plan_name ? (' „' + m.plan_name + '"') : '';
    const sCs = status === 'refunded'
      ? `↩️ Odstoupil/a jsi od smlouvy o permanentce${plan} v ${gym.name || m.gym_name || 'klubu'}. Za ${usedDays} z ${totalDays} dní si klub ponechává ${fmt(keep, cur)}, vráceno ti bylo ${fmt(refund, cur)}${isCard ? ' na kartu' : ''}.`
      : `↩️ Odstoupil/a jsi od smlouvy o permanentce${plan} v ${gym.name || m.gym_name || 'klubu'}. Za ${usedDays} z ${totalDays} dní si klub ponechává ${fmt(keep, cur)}; ${fmt(refund, cur)} ti klub vrátí převodem do 14 dnů.`;
    const sEn = status === 'refunded'
      ? `↩️ You withdrew from your pass${plan} at ${gym.name || 'the club'}. For ${usedDays} of ${totalDays} days the club keeps ${fmt(keep, cur)}; ${fmt(refund, cur)} has been refunded${isCard ? ' to your card' : ''}.`
      : `↩️ You withdrew from your pass${plan} at ${gym.name || 'the club'}. For ${usedDays} of ${totalDays} days the club keeps ${fmt(keep, cur)}; the club will transfer ${fmt(refund, cur)} back to you within 14 days.`;
    try { await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id: me, type: 'system', read: false,
      data: JSON.stringify({ kind: 'withdrawal_done', withdrawal_id: row.id || null, transaction_id: tx ? tx.id : null, gym_id: m.gym_id, msg_cs: sCs, msg_en: sEn }), message: sCs }) }); } catch (e) {}
    if (gym.owner_id) {
      const who = ((await sbGet(`profiles?id=eq.${q(me)}&select=name`)) || [])[0] || {};
      const cCs = status === 'refunded'
        ? `↩️ ${who.name || 'Student'} odstoupil/a od smlouvy o permanentce${plan} (do 14 dnů). Za ${usedDays} z ${totalDays} dní zůstává klubu ${fmt(keep, cur)}, ${fmt(refund, cur)} se vrátilo automaticky na kartu.`
        : `↩️ ${who.name || 'Student'} odstoupil/a od smlouvy o permanentce${plan} (do 14 dnů). Vrať mu převodem ${fmt(refund, cur)} do 14 dnů (§ 1831 OZ) a zapiš to — klubu zůstává ${fmt(keep, cur)} za ${usedDays} z ${totalDays} dní.`;
      const cEn = status === 'refunded'
        ? `↩️ ${who.name || 'A student'} withdrew from their pass${plan} (within 14 days). The club keeps ${fmt(keep, cur)} for ${usedDays} of ${totalDays} days; ${fmt(refund, cur)} was refunded to the card automatically.`
        : `↩️ ${who.name || 'A student'} withdrew from their pass${plan} (within 14 days). Transfer ${fmt(refund, cur)} back within 14 days and record it — the club keeps ${fmt(keep, cur)} for ${usedDays} of ${totalDays} days.`;
      try { await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id: gym.owner_id, type: 'system', read: false,
        data: JSON.stringify({ kind: 'withdrawal_request', withdrawal_id: row.id || null, membership_id: m.id, gym_id: m.gym_id, student_id: me, member: who.name || '', amount: refund / 100, currency: cur, pending: status !== 'refunded', msg_cs: cCs, msg_en: cEn }), message: cCs }) }); } catch (e) {}
    }
    return res.status(200).json({ ok: true, status, refund: refund / 100, keep: keep / 100, used_days: usedDays, total_days: totalDays, currency: cur, refunded_now: refundedNow / 100 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
}
