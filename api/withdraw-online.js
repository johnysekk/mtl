// /api/withdraw-online — ODSTOUPENÍ OD SMLOUVY U ONLINE KOUČINGU (tlačítko „Odstoupit od smlouvy").
//
// Spotřebitel může od smlouvy o službě uzavřené online odstoupit do 14 dnů od uzavření (§ 1829 OZ,
// směrnice 2011/83/EU ve znění 2023/2673). Pravidla:
//   • JEDNORÁZOVÁ SLUŽBA (bookings, type = online): jen dokud ji kouč neoznačil jako dodanou --
//     úplným poskytnutím na výslovnou žádost studenta (souhlas při nákupu) právo zaniká (§ 1837).
//     Nedodaná služba = vrací se 100 %, bez poplatku.
//   • MĚSÍČNÍ PŘEDPLATNÉ (gym_memberships, gym_id = null, paid_to = coach): do 14 dnů od první
//     platby. Předplatné běží od zaplacení na žádost studenta, takže zaplatí poměrnou část za dny,
//     kdy běželo (§ 1834); zbytek se vrátí a předplatné se hned ukončí.
// Karta: vrátí se rovnou přes Stripe na účtu kouče (provize MTL podle _fee-window.js).
// Převod/QR: MTL peníze nedrží -- kouč dostane úkol vrátit převodem.
// Vždy: záznam odstoupení (withdrawal_requests), potvrzení se zněním a časem (cancel_confirmations)
// a notifikace oběma stranám s proklikem.
//
// POST { kind:'service'|'plan', id, statement }

import Stripe from 'stripe';
import { feeRefundableForPI } from './_fee-window.js';
import { prorata } from './_prorata.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
const DAY = 86400000;
const WINDOW_DAYS = 14;

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
const fmtEn = (minor, cur) => (Math.round(minor) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 }) + ' ' + String(cur || 'CZK').toUpperCase();
const notify = (user_id, data, message) => sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id, type: 'system', read: false, data: JSON.stringify(data), message }) });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const me = await whoami(req); if (!me) return res.status(401).json({ ok: false, error: 'Přihlas se.' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const kind = String(b.kind || ''); const id = String(b.id || ''); const statement = String(b.statement || '').trim().slice(0, 2000);
    if (!id || !statement || !['service', 'plan'].includes(kind)) return res.status(400).json({ ok: false, error: 'kind, id, statement required' });
    const nowIso = new Date().toISOString();

    let coachId, studentId, gross = 0, cur = 'CZK', label = '', start, pi = null, method = 'card', txId = null, refund = 0, keep = 0, usedDays = null, totalDays = null, subId = null, bookingKey;
    if (kind === 'service') {
      const bk = ((await sbGet(`bookings?id=eq.${q(id)}&select=id,type,student_id,paid_by,coach_id,coach_name,amount,currency,online_format,status,fulfilled,created_at,payment_intent,payment_method`)) || [])[0];
      if (!bk || bk.type !== 'online' || ![String(bk.student_id), String(bk.paid_by || '')].includes(String(me))) return res.status(404).json({ ok: false, error: 'Objednávka nenalezena.' });
      if (['cancelled', 'refunded'].includes(String(bk.status))) return res.status(400).json({ ok: false, error: 'Objednávka už je zrušená.' });
      if (bk.fulfilled) return res.status(400).json({ ok: false, error: 'Služba už byla dodána — od úplně poskytnuté služby odstoupit nelze. Pokud ti nebyla doručena, použij „Nedostal jsem feedback".' });
      start = new Date(bk.created_at).getTime();
      coachId = bk.coach_id; studentId = bk.student_id; cur = String(bk.currency || 'CZK').toUpperCase(); label = bk.online_format || 'Online koučing';
      pi = bk.payment_intent || null; bookingKey = String(bk.id);
      const tx = pi ? ((await sbGet(`transactions?payment_intent=eq.${q(pi)}&select=id,gross_amount,refund_amount,payment_method&limit=1`)) || [])[0] : null;
      gross = tx ? (Number(tx.gross_amount) || 0) : Math.round((Number(bk.amount) || 0) * 100);
      txId = tx ? tx.id : null;
      const pm = String((tx && tx.payment_method) || bk.payment_method || '');
      method = (pi && !String(pi).startsWith('pis') && !['cash', 'qr', 'pis'].includes(pm)) ? 'card' : 'transfer';
      refund = Math.max(0, gross - (tx ? (Number(tx.refund_amount) || 0) : 0));   // nedodáno -> celá částka
    } else {
      const m = ((await sbGet(`gym_memberships?id=eq.${q(id)}&select=id,gym_id,paid_to,coach_id,student_id,paid_by,plan_name,amount,currency,status,created_at,period_end,stripe_subscription`)) || [])[0];
      if (!m || m.gym_id || m.paid_to !== 'coach' || ![String(m.student_id), String(m.paid_by || '')].includes(String(me))) return res.status(404).json({ ok: false, error: 'Předplatné nenalezeno.' });
      if (!['active', 'cancelling'].includes(String(m.status))) return res.status(400).json({ ok: false, error: 'Předplatné už neběží.' });
      start = new Date(m.created_at).getTime();
      coachId = m.coach_id; studentId = m.student_id; cur = String(m.currency || 'CZK').toUpperCase(); label = m.plan_name || 'Online předplatné';
      subId = m.stripe_subscription || null; bookingKey = String(m.id);
      const tx = ((await sbGet(`transactions?coach_id=eq.${q(coachId)}&member_id=eq.${q(m.student_id)}&type=eq.membership&created_at=gte.${q(new Date(start - DAY).toISOString())}&order=created_at.asc&limit=1&select=id,gross_amount,refund_amount,payment_intent,created_at`)) || [])[0] || null;
      gross = tx ? (Number(tx.gross_amount) || 0) : Math.round((Number(m.amount) || 0) * 100);
      txId = tx ? tx.id : null; pi = tx ? tx.payment_intent : null;
      const end = m.period_end ? new Date(m.period_end).getTime() : start + 30 * DAY;
      const pr = prorata(gross, start, Math.max(end, start + DAY));
      if (pr) { refund = Math.max(0, pr.unused - (tx ? (Number(tx.refund_amount) || 0) : 0)); keep = pr.keep; usedDays = pr.usedDays; totalDays = pr.totalDays; }
      method = 'card';   // předplatné je jen kartou
    }
    if (!(Date.now() - start <= WINDOW_DAYS * DAY)) return res.status(400).json({ ok: false, error: 'Lhůta 14 dnů na odstoupení už uplynula.' });
    // Opakované odstoupení zastaví kontrola stavu výš (zrušená objednávka / ukončené předplatné).
    const coach = ((await sbGet(`profiles?id=eq.${q(coachId)}&select=id,name,legal_name,stripe_account`)) || [])[0] || {};
    const acct = coach.stripe_account ? String(coach.stripe_account).trim() : null;

    // PENÍZE
    let status = 'pending';
    if (refund <= 0) status = 'refunded';
    else if (method === 'card' && pi && acct) {
      await stripe.refunds.create({ payment_intent: pi, amount: refund, refund_application_fee: await feeRefundableForPI(pi, { dispute: true }) }, { stripeAccount: acct });
      status = 'refunded';
    }
    if (kind === 'plan' && subId && acct) { try { await stripe.subscriptions.cancel(subId, {}, { stripeAccount: acct }); } catch (e) { console.error('withdraw-online cancel sub', e.message); } }

    // STAV ŘÁDKU
    if (kind === 'service') await sb(`bookings?id=eq.${q(id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled', refund_pct: 100, refund_requested: false, refund_reason: '(ODSTOUPENÍ) ' + statement.slice(0, 300) }) });
    else await sb(`gym_memberships?id=eq.${q(id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'ended', cancelled_at: nowIso, period_end: nowIso }) });

    // ZÁZNAM + POTVRZENÍ (snímek, kreslí se jen z něj)
    const who = ((await sbGet(`profiles?id=eq.${q(me)}&select=name`)) || [])[0] || {};
    const row = ((await sb('withdrawal_requests', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({
      user_id: me, gym_id: null, membership_id: kind === 'plan' ? id : null, transaction_id: txId, statement,
      gross_amount: gross, used_days: usedDays, total_days: totalDays, keep_amount: keep, refund_amount: refund, currency: cur,
      method, status, refunded_at: status === 'refunded' ? nowIso : null }) })) || [])[0] || {};
    let confId = null;
    try {
      const cc = ((await sb('cancel_confirmations', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({
        booking_id: bookingKey, booking_kind: 'withdrawal', transaction_id: txId, student_id: studentId,
        participant_name: who.name || null, payer_name: who.name || null, cancelled_by: me, cancelled_by_name: who.name || null, cancelled_by_role: 'student',
        coach_id: coachId, provider_name: coach.legal_name || coach.name || null, class_name: label, session_at: new Date(start).toISOString().slice(0, 10),
        note: statement, amount_paid: gross / 100, refund_amount: refund / 100, currency: cur, payment_method: method === 'card' ? 'stripe' : 'transfer',
        keep_amount: keep / 100, used_days: usedDays, total_days: totalDays }) })) || [])[0];
      confId = cc && cc.id;
    } catch (e) { console.error('withdraw-online confirmation', e.message); }
    if (confId && row.id) { try { await sb(`withdrawal_requests?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ confirmation_id: confId }) }); } catch (e) {} }

    // NOTIFIKACE S PROKLIKEM
    const what = kind === 'plan' ? 'předplatného' : 'služby';
    const sCs = status === 'refunded'
      ? `↩️ Odstoupil/a jsi od ${what} „${label}" u kouče ${coach.name || ''}. ${kind === 'plan' ? `Za ${usedDays} z ${totalDays} dní se ponechává ${fmt(keep, cur)}, ` : ''}vráceno ti bylo ${fmt(refund, cur)}${method === 'card' ? ' na kartu' : ''}.`
      : `↩️ Odstoupil/a jsi od ${what} „${label}" u kouče ${coach.name || ''}. ${fmt(refund, cur)} ti kouč vrátí převodem do 14 dnů.`;
    const sEn = status === 'refunded'
      ? `↩️ You withdrew from "${label}" with coach ${coach.name || ''}. ${kind === 'plan' ? `For ${usedDays} of ${totalDays} days ${fmtEn(keep, cur)} is kept; ` : ''}${fmtEn(refund, cur)} has been refunded${method === 'card' ? ' to your card' : ''}.`
      : `↩️ You withdrew from "${label}" with coach ${coach.name || ''}. The coach will transfer ${fmtEn(refund, cur)} back to you within 14 days.`;
    try { await notify(me, { kind: 'withdrawal_done', withdrawal_id: row.id || null, conf_id: confId, transaction_id: txId, msg_cs: sCs, msg_en: sEn }, sCs); } catch (e) {}
    if (coachId) {
      const cCs = status === 'refunded'
        ? `↩️ ${who.name || 'Student'} odstoupil/a od ${what} „${label}" (zákonná lhůta 14 dnů). Studentovi se vrátilo ${fmt(refund, cur)}${kind === 'plan' ? ' a předplatné je ukončené' : ''}.`
        : `↩️ ${who.name || 'Student'} odstoupil/a od ${what} „${label}" (zákonná lhůta 14 dnů). Vrať mu prosím ${fmt(refund, cur)} převodem do 14 dnů.`;
      const cEn = status === 'refunded'
        ? `↩️ ${who.name || 'A student'} withdrew from "${label}" (14-day statutory period). ${fmtEn(refund, cur)} was refunded${kind === 'plan' ? ' and the subscription has ended' : ''}.`
        : `↩️ ${who.name || 'A student'} withdrew from "${label}" (14-day statutory period). Please transfer ${fmtEn(refund, cur)} back within 14 days.`;
      try { await notify(coachId, { kind: 'online_withdrawal', booking_id: kind === 'service' ? id : null, membership_id: kind === 'plan' ? id : null, conf_id: confId, pending: status !== 'refunded', msg_cs: cCs, msg_en: cEn }, cCs); } catch (e) {}
    }
    return res.status(200).json({ ok: true, status, refunded: refund / 100, keep: keep / 100, used_days: usedDays, total_days: totalDays, conf_id: confId });
  } catch (e) {
    console.error('withdraw-online', e);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
}
