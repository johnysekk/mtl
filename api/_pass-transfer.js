// /api/_pass-transfer.js — PERMANENTKY NA UKONČENOU LEKCI.
//
// Když klub ukončí opakovanou lekci, na kterou jsou napojené permanentky „jen na tyto lekce"
// (plan_classes obsahuje cid lekce), nesmí se jejich držitelé jen tak přesunout jinam ani o
// peníze přijít:
//   • klub vybere lekce, na které permanentky nabídne přesunout (to_cids);
//   • každý držitel si vybere: SOUHLAS s přesunem, nebo VRÁCENÍ poměrné části;
//   • kdo se do termínu nerozhodne, dostane peníze zpět (přesun bez souhlasu nejde);
//   • bez náhradní lekce se rovnou vrací.
// Vrácení: poměrná část za nevyčerpané dny od konce lekce (_prorata.js, celé dny). Kartou
// automaticky přes Stripe, převod / QR / hotovost vrací klub sám (úkol s proklikem).
// Rozhodnutí se ukládá jako neměnný záznam v pass_transfers (i se zněním, které student viděl).

import Stripe from 'stripe';
import { feeRefundableForPI } from './_fee-window.js';
import { prorata } from './_prorata.js';
import { sellKind } from './_sell-kind.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const q = encodeURIComponent;
const DAY = 86400000;
const BANK = ['qr', 'pis', 'cash'];

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}) } });
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return null; const _t = await r.text(); return _t ? JSON.parse(_t) : null;   // POST s return=minimal vrací 201 s prázdným tělem
}
const sbGet = (p) => sb(p).catch(() => []);
const parseArr = (v) => { try { const x = typeof v === 'string' ? JSON.parse(v || '[]') : v; return Array.isArray(x) ? x : []; } catch (e) { return []; } };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const dCz = (d) => { const x = new Date(String(d) + 'T12:00:00Z'); return `${x.getUTCDate()}. ${x.getUTCMonth() + 1}. ${x.getUTCFullYear()}`; };
const money = (minor, cur) => (Math.round(minor) / 100).toLocaleString('cs-CZ', { maximumFractionDigits: 2 }) + ' ' + (String(cur || 'CZK').toUpperCase() === 'CZK' ? 'Kč' : String(cur || '').toUpperCase());
const moneyEn = (minor, cur) => (Math.round(minor) / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 }) + ' ' + String(cur || 'CZK').toUpperCase();
// Začátek dne `from` v Praze (od té chvíle lekce už není).
const pragueStartMs = (d) => { const t = Date.parse(String(d) + 'T00:00:00Z'); const off = new Date(t).toLocaleString('en-US', { timeZone: 'Europe/Prague', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/); return t - (off ? Number(off[1]) : 1) * 3600000; };

async function notify(userId, kind, cs, en, data) {
  if (!userId) return;
  try {
    const lang = (((await sbGet(`profiles?id=eq.${q(userId)}&select=lang`)) || [])[0] || {}).lang;
    await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id: userId, type: 'system', read: false,
      data: JSON.stringify(Object.assign({ kind, msg_cs: cs, msg_en: en }, data)), message: lang === 'en' ? en : cs }) });
  } catch (e) { console.error('[pass-transfer] notify', e.message); }
}

// Termín na rozhodnutí: poslední den lekce, ale aspoň 3 dny od teď (ukončení „od zítra" by
// jinak nedalo čas nic zvolit).
export function deadlineFor(fromYmd, nowMs = Date.now()) {
  const last = ymd(Date.parse(String(fromYmd) + 'T12:00:00Z') - DAY);
  const min = ymd(nowMs + 3 * DAY);
  return last > min ? last : min;
}

// Běžící permanentky „jen na tyto lekce", které lekci cid obsahují a platí i po jejím konci.
export async function passHolders(gymId, cid, fromYmd) {
  const rows = (await sbGet(`gym_memberships?gym_id=eq.${q(gymId)}&status=in.(active,cancelling)&plan_classes=not.is.null`
    + `&select=id,student_id,student_name,child_name,plan_name,plan_classes,period_end,currency,amount,paid_to&limit=2000`)) || [];
  return rows.filter((m) => parseArr(m.plan_classes).indexOf(cid) >= 0 && (!m.period_end || String(m.period_end).slice(0, 10) >= String(fromYmd)));
}

// Vrácení poměrné části (kartou hned, jinak úkol pro klub) a konec permanentky ke dni konce lekce.
export async function settleRefund(row, { auto = false, text = null } = {}) {
  const nowIso = new Date().toISOString();
  // Nejdřív rozhodnutí zabrat (jen nerozhodnutý řádek) -- dvojí klik ani souběh s cronem nevrátí dvakrát.
  const claimed = ((await sb(`pass_transfers?id=eq.${q(row.id)}&decision=is.null`, { method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ decision: 'refund', decided_at: nowIso, decided_auto: !!auto, decision_text: text }) })) || [])[0];
  if (!claimed) return null;
  const st = { moneyMoved: false };
  try { return await _refundBody(row, { auto, nowIso }, st); }
  catch (e) {
    // Vrácení neprošlo (Stripe, síť) DŘÍV, než peníze odešly: rozhodnutí uvolnit, ať ho zopakuje
    // student nebo další běh cronu. Když už odešly, zůstává rozhodnuté (jinak by se vracelo znovu).
    if (!st.moneyMoved) { try { await sb(`pass_transfers?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ decision: null, decided_at: null, decided_auto: false, decision_text: null }) }); } catch (e2) {} }
    throw e;
  }
}
async function _refundBody(row, { auto, nowIso }, st) {
  const m = ((await sbGet(`gym_memberships?id=eq.${q(row.membership_id)}&select=id,gym_id,student_id,student_name,child_name,plan_name,months,amount,currency,status,created_at,period_end,stripe_subscription,paid_to,coach_id`)) || [])[0];
  const gym = ((await sbGet(`gyms?id=eq.${q(row.gym_id)}&select=id,name,owner_id,stripe_account,currency`)) || [])[0] || {};
  const endsMs = pragueStartMs(row.ends_from);
  let refund = 0, cur = (m && m.currency) || gym.currency || 'CZK', method = null, status = 'refunded';
  if (m && ['active', 'cancelling'].includes(String(m.status))) {
    // Platba PRÁVĚ TÉHLE permanentky. Platby nemají vazbu na řádek permanentky, takže: platby člena
    // v klubu za její období, ne použité jinou permanentkou (refund_tx_id), nejbližší její ceně --
    // dvě dětské permanentky téhož rodiče tak nesáhnou na stejnou platbu.
    const months = Math.max(1, parseInt(m.months, 10) || 1);
    const perEnd0 = m.period_end ? Date.parse(m.period_end) : 0;
    const perStart0 = Math.max(Date.parse(m.created_at) || 0, perEnd0 ? perEnd0 - (months * 31 + 2) * DAY : 0);
    const txs = (await sbGet(`transactions?gym_id=eq.${q(m.gym_id)}&member_id=eq.${q(m.student_id)}&type=eq.membership&created_at=gte.${q(new Date(perStart0 - 2 * DAY).toISOString())}&order=created_at.desc&limit=20`
      + '&select=id,gym_id,member_id,created_at,gross_amount,refund_amount,currency,payment_intent,payment_method')) || [];
    const others = (await sbGet(`pass_transfers?gym_id=eq.${q(row.gym_id)}&refund_tx_id=not.is.null&select=id,membership_id,refund_tx_id,refund_amount`)) || [];
    const usedTx = new Set(others.filter((x) => String(x.membership_id) !== String(m.id)).map((x) => x.refund_tx_id));
    const want = Math.round((Number(m.amount) || 0) * 100);
    const tx = txs.filter((t) => !usedTx.has(t.id)).sort((a, b) => Math.abs((Number(a.gross_amount) || 0) - want) - Math.abs((Number(b.gross_amount) || 0) - want))[0] || null;
    // Vrací se od konce lekce (ne od rozhodnutí): po něm už lekce není.
    let pr = null;
    if (tx) pr = prorata(tx.gross_amount, Date.parse(tx.created_at), Math.max(perEnd0, Date.parse(tx.created_at) + months * 30 * DAY), endsMs);
    else if (perEnd0 && m.created_at) pr = prorata(want, Date.parse(m.created_at), perEnd0, endsMs);
    // Už vráceno z téhle permanentky (jiná ukončená lekce téže permanentky, nebo zapsáno u platby).
    const prior = Math.round(others.filter((x) => String(x.membership_id) === String(m.id) && x.id !== row.id).reduce((a, x) => a + (Number(x.refund_amount) || 0), 0) * 100);
    refund = pr ? Math.max(0, pr.unused - Math.max(prior, (tx && Number(tx.refund_amount)) || 0)) : 0;
    if (tx) await sb(`pass_transfers?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ refund_tx_id: tx.id }) });
    if (tx && tx.currency) cur = tx.currency;
    const isCard = !!(tx && tx.payment_intent && !String(tx.payment_intent).startsWith('pis') && !BANK.includes(String(tx.payment_method || '')));
    method = isCard ? 'card' : ((tx && tx.payment_method) || 'transfer');
    let acct = gym.stripe_account || null;
    if (m.paid_to === 'coach' && m.coach_id) { const cp = ((await sbGet(`profiles?id=eq.${q(m.coach_id)}&select=gym_payout_account`)) || [])[0]; acct = (cp && cp.gym_payout_account) || acct; }
    if (refund > 0 && isCard) {
      if (!stripe || !acct) throw new Error('stripe not configured');
      await stripe.refunds.create({ payment_intent: tx.payment_intent, amount: refund, refund_application_fee: await feeRefundableForPI(tx.payment_intent) },
        { stripeAccount: acct, idempotencyKey: `pass-transfer-${row.id}` });
      st.moneyMoved = true;
    } else if (refund > 0) status = 'pending';                       // vrací klub převodem / hotově
    // Permanentka platí do konce lekce (nebo do rozhodnutí, když přišlo později -- ostatní lekce
    // permanentky do té doby běží dál), pak končí.
    const endMs = Math.max(endsMs, Date.now());
    const endIso = new Date(perEnd0 ? Math.min(endMs, perEnd0) : endMs).toISOString();
    await sb(`gym_memberships?id=eq.${q(m.id)}`, { method: 'PATCH', prefer: 'return=minimal',
      // stripe_subscription pryč: předplatné je zrušené a konec řádku pak hlídá membership-expiry-cron.
      body: JSON.stringify({ period_end: endIso, cancelled_at: nowIso, stripe_subscription: null, status: Date.parse(endIso) <= Date.now() ? 'ended' : 'cancelling' }) });
    // Předplatné zrušit až po zápisu (webhook o zrušení už řádek podle předplatného nenajde).
    if (m.stripe_subscription && acct && stripe) { try { await stripe.subscriptions.cancel(m.stripe_subscription, {}, { stripeAccount: acct }); } catch (e) {} }
  }
  await sb(`pass_transfers?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({
    refund_amount: refund / 100, refund_method: method, refund_status: status, currency: cur }) });

  const who = row.child_name ? ` (${row.child_name})` : '';
  const plan = row.plan_name ? ` „${row.plan_name}"` : '';
  const why = auto ? (row.to_cids && parseArr(row.to_cids).length ? ' Do termínu ses nerozhodl/a, takže ti vracíme peníze.' : '') : '';
  const whyEn = auto ? (row.to_cids && parseArr(row.to_cids).length ? ' You did not choose in time, so the money is coming back to you.' : '') : '';
  const sCs = refund > 0
    ? (status === 'refunded'
      ? `↩️ Permanentka${plan}${who} v ${gym.name || 'klubu'} končí s lekcí ${row.from_name || ''} (${dCz(row.ends_from)}).${why} Nevyčerpanou část ${money(refund, cur)} ti vracíme na kartu — na účtu bývá do 5–10 dnů.`
      : `↩️ Permanentka${plan}${who} v ${gym.name || 'klubu'} končí s lekcí ${row.from_name || ''} (${dCz(row.ends_from)}).${why} Nevyčerpanou část ${money(refund, cur)} ti klub vrátí převodem. Kdyby do 14 dnů nedorazila, napiš klubu.`)
    : `↩️ Permanentka${plan}${who} v ${gym.name || 'klubu'} končí s lekcí ${row.from_name || ''} (${dCz(row.ends_from)}).${why} Je celá vyčerpaná, není co vracet.`;
  const sEn = refund > 0
    ? (status === 'refunded'
      ? `↩️ Your pass${plan}${who} at ${gym.name || 'the club'} ends with the class ${row.from_name || ''} (${dCz(row.ends_from)}).${whyEn} The unused ${moneyEn(refund, cur)} is being refunded to your card — usually 5–10 days.`
      : `↩️ Your pass${plan}${who} at ${gym.name || 'the club'} ends with the class ${row.from_name || ''} (${dCz(row.ends_from)}).${whyEn} The club will transfer the unused ${moneyEn(refund, cur)} back to you. If it has not arrived within 14 days, contact the club.`)
    : `↩️ Your pass${plan}${who} at ${gym.name || 'the club'} ends with the class ${row.from_name || ''} (${dCz(row.ends_from)}).${whyEn} It is fully used, nothing to refund.`;
  await notify(row.student_id, 'pass_transfer_done', sCs, sEn, { transfer_id: row.id, gym_id: row.gym_id, gym_name: gym.name || '', choice: 'refund' });
  // Klub: u převodu úkol vrátit peníze (stejný proklik jako u odstoupení -- zápis vrácení).
  if (gym.owner_id) {
    const nm = row.student_name || 'Člen';
    const cCs = refund > 0 && status === 'pending'
      ? `↩️ ${nm}${who} ${auto ? 'se nerozhodl/a do termínu' : 'zvolil/a vrácení peněz'} — permanentka${plan} končí s lekcí ${row.from_name || ''}. Vrať mu/jí převodem ${money(refund, cur)} (nevyčerpané dny) a zapiš to.`
      : `↩️ ${nm}${who} ${auto ? 'se nerozhodl/a do termínu' : 'zvolil/a vrácení peněz'} — permanentka${plan} končí s lekcí ${row.from_name || ''}.${refund > 0 ? ` Na kartu se vrátilo ${money(refund, cur)} automaticky.` : ''}`;
    const cEn = refund > 0 && status === 'pending'
      ? `↩️ ${nm}${who} ${auto ? 'did not choose in time' : 'chose a refund'} — the pass${plan} ends with the class ${row.from_name || ''}. Transfer ${moneyEn(refund, cur)} (unused days) back and record it.`
      : `↩️ ${nm}${who} ${auto ? 'did not choose in time' : 'chose a refund'} — the pass${plan} ends with the class ${row.from_name || ''}.${refund > 0 ? ` ${moneyEn(refund, cur)} was refunded to the card automatically.` : ''}`;
    if (refund > 0 && status === 'pending') await notify(gym.owner_id, 'withdrawal_request', cCs, cEn, { membership_id: row.membership_id, gym_id: row.gym_id, student_id: row.student_id, member: row.student_name || '', amount: refund / 100, currency: cur, pending: true });
    else await notify(gym.owner_id, 'pass_transfer_decided', cCs, cEn, { transfer_id: row.id, gym_id: row.gym_id, student_id: row.student_id, member: row.student_name || '' });
  }
  return { refund: refund / 100, currency: cur, status, method };
}

// Permanentka / členství platí místo ukončené lekce na vybrané lekce (plan_classes).
async function movePlanClasses(membershipId, fromCid, to) {
  const m = ((await sbGet(`gym_memberships?id=eq.${q(membershipId)}&select=id,plan_classes`)) || [])[0];
  if (!m) throw new Error('membership not found');
  const wasString = typeof m.plan_classes === 'string';
  const cls = parseArr(m.plan_classes).filter((x) => x !== fromCid);
  to.forEach((x) => { if (cls.indexOf(x) < 0) cls.push(x); });
  await sb(`gym_memberships?id=eq.${q(m.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ plan_classes: wasString ? JSON.stringify(cls) : cls }) });
}

// Souhlas s přesunem: permanentka platí místo ukončené lekce na vybrané lekce.
export async function applyTransfer(row, text) {
  const nowIso = new Date().toISOString();
  const to = parseArr(row.to_cids);
  const m = ((await sbGet(`gym_memberships?id=eq.${q(row.membership_id)}&select=id,plan_classes,status,cancelled_at`)) || [])[0];
  if (!m) throw new Error('membership not found');
  if (!['active', 'cancelling'].includes(String(m.status)) || m.cancelled_at) throw new Error('Permanentka už skončila — přesunout ji nejde.');
  const claimed = ((await sb(`pass_transfers?id=eq.${q(row.id)}&decision=is.null`, { method: 'PATCH', prefer: 'return=representation',
    body: JSON.stringify({ decision: 'transfer', decided_at: nowIso, decided_auto: false, decision_text: text }) })) || [])[0];
  if (!claimed) return false;
  try { await movePlanClasses(m.id, row.from_cid, to); }
  catch (e) {
    // Permanentka se nepřepsala: rozhodnutí uvolnit, ať jde zvolit znovu (přesun i vrácení).
    try { await sb(`pass_transfers?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ decision: null, decided_at: null, decision_text: null }) }); } catch (e2) {}
    throw e;
  }
  const gym = ((await sbGet(`gyms?id=eq.${q(row.gym_id)}&select=name,owner_id`)) || [])[0] || {};
  const who = row.child_name ? ` (${row.child_name})` : '';
  const plan = row.plan_name ? ` „${row.plan_name}"` : '';
  await notify(row.student_id, 'pass_transfer_done',
    `✅ Permanentka${plan}${who} v ${gym.name || 'klubu'} teď platí na: ${row.to_names || ''}. Místo lekce ${row.from_name || ''}, která od ${dCz(row.ends_from)} končí.`,
    `✅ Your pass${plan}${who} at ${gym.name || 'the club'} now covers: ${row.to_names || ''}, instead of ${row.from_name || ''}, which ends on ${dCz(row.ends_from)}.`,
    { transfer_id: row.id, gym_id: row.gym_id, gym_name: gym.name || '', choice: 'transfer' });
  if (gym.owner_id) await notify(gym.owner_id, 'pass_transfer_decided',
    `🔁 ${row.student_name || 'Člen'}${who} souhlasí s přesunem permanentky${plan} z lekce ${row.from_name || ''} na: ${row.to_names || ''}.`,
    `🔁 ${row.student_name || 'A student'}${who} agreed to move the pass${plan} from ${row.from_name || ''} to: ${row.to_names || ''}.`,
    { transfer_id: row.id, gym_id: row.gym_id, student_id: row.student_id, member: row.student_name || '' });
  return true;
}

// Klub ukončil lekci: nabídky všem držitelům (bez náhradní lekce rovnou vrácení) a úprava
// nabídky permanentek klubu (plán na ukončenou lekci platí na náhradní, bez ní zmizí).
export async function offerForEndedClass({ gym, cid, fromName, fromYmd, toCids, toNames, note }) {
  const holders = await passHolders(gym.id, cid, fromYmd);
  const out = { offered: [], refunded: [], moved: [], kept: [], errors: [] };
  const deadline = deadlineFor(fromYmd);
  const orgForm = ((await sbGet(`gyms?id=eq.${q(gym.id)}&select=org_form`)) || [{}])[0]?.org_form || null;
  for (const m of holders) {
    const who = m.child_name ? `${m.child_name} (${m.student_name || ''})` : (m.student_name || 'Člen');
    try {
      // SPOLEK: členský příspěvek není platba za lekci -- členovi se nic nenabízí ani nevrací a ve
      // zprávě o vracení nic není. Členství se na vybrané lekce přesune samo. Vrátit příspěvek může
      // jen vedení klubu, ručně v kartě člena (Ukončit členství).
      if (sellKind({ orgForm, paidTo: m.paid_to }) === 'membership') {
        const txt = toCids.length
          ? `Lekce ${fromName} v ${gym.name} od ${dCz(fromYmd)} končí.${note ? ' Důvod: ' + note + '.' : ''} Tvoje členství${m.plan_name ? ' „' + m.plan_name + '"' : ''} teď místo ní platí na: ${toNames}.`
          : `Lekce ${fromName} v ${gym.name} od ${dCz(fromYmd)} končí.${note ? ' Důvod: ' + note + '.' : ''} Co bude dál po zrušení lekce, řeší klub.`;
        const txtEn = toCids.length
          ? `The class ${fromName} at ${gym.name} ends on ${dCz(fromYmd)}.${note ? ' Reason: ' + note + '.' : ''} Your membership${m.plan_name ? ' “' + m.plan_name + '”' : ''} now covers: ${toNames} instead.`
          : `The class ${fromName} at ${gym.name} ends on ${dCz(fromYmd)}.${note ? ' Reason: ' + note + '.' : ''} What happens next is up to the club.`;
        const ins0 = ((await sb('pass_transfers?on_conflict=membership_id,from_cid', { method: 'POST', prefer: 'return=representation,resolution=ignore-duplicates', body: JSON.stringify({
          gym_id: gym.id, membership_id: String(m.id), student_id: m.student_id, student_name: m.student_name || null, child_name: m.child_name || null, plan_name: m.plan_name || null,
          from_cid: cid, from_name: fromName, ends_from: fromYmd, to_cids: toCids, to_names: toNames || null, deadline, offer_text: txt, note: note || null,
          decision: toCids.length ? 'transfer' : 'kept', decided_at: new Date().toISOString(), decided_auto: true }) })) || [])[0];
        if (!ins0) continue;
        if (toCids.length) await movePlanClasses(m.id, cid, toCids);
        await notify(m.student_id, 'pass_transfer_done', `🔁 ${txt}`, `🔁 ${txtEn}`, { transfer_id: ins0.id, gym_id: gym.id, gym_name: gym.name || '', choice: toCids.length ? 'transfer' : 'kept' });
        (toCids.length ? out.moved : out.kept).push(who);
        continue;
      }
      const offerCs = toCids.length
        ? `Lekce ${fromName} v ${gym.name} od ${dCz(fromYmd)} končí.${note ? ' Důvod: ' + note + '.' : ''} Klub nabízí, že tvoje permanentka${m.plan_name ? ' „' + m.plan_name + '"' : ''} bude místo ní platit na: ${toNames}. Můžeš souhlasit s přesunem, nebo si nechat vrátit nevyčerpanou část. Když se do ${dCz(deadline)} nerozhodneš, peníze ti vrátíme.`
        : `Lekce ${fromName} v ${gym.name} od ${dCz(fromYmd)} končí a klub za ni nemá náhradu.`;
      const ins = ((await sb('pass_transfers?on_conflict=membership_id,from_cid', { method: 'POST', prefer: 'return=representation,resolution=ignore-duplicates', body: JSON.stringify({
        gym_id: gym.id, membership_id: String(m.id), student_id: m.student_id, student_name: m.student_name || null, child_name: m.child_name || null, plan_name: m.plan_name || null,
        from_cid: cid, from_name: fromName, ends_from: fromYmd, to_cids: toCids, to_names: toNames || null, deadline, offer_text: offerCs, note: note || null }) })) || [])[0];
      if (!ins) continue;                                             // nabídka už existuje
      if (!toCids.length) { const r = await settleRefund(ins, { auto: true }); if (r) out.refunded.push({ name: who, amount: r.refund, currency: r.currency, status: r.status }); continue; }
      await notify(m.student_id, 'pass_transfer_offer',
        `🔁 ${offerCs}`,
        `🔁 The class ${fromName} at ${gym.name} ends on ${dCz(fromYmd)}.${note ? ' Reason: ' + note + '.' : ''} The club offers to move your pass${m.plan_name ? ' “' + m.plan_name + '”' : ''} to: ${toNames}. You can agree to the move or get the unused part refunded. If you do not choose by ${dCz(deadline)}, you will get the money back.`,
        { transfer_id: ins.id, gym_id: gym.id, gym_name: gym.name || '', deadline });
      out.offered.push(who);
    } catch (e) { console.error('[pass-transfer] offer', m.id, e.message); out.errors.push({ name: who, error: String(e.message || e).slice(0, 160) }); }
  }
  // Nabídka klubu: plán „jen na tyto lekce" s ukončenou lekcí.
  try {
    const g = ((await sbGet(`gyms?id=eq.${q(gym.id)}&select=membership_plans`)) || [])[0];
    if (g && g.membership_plans) {
      const wasString = typeof g.membership_plans === 'string';
      const plans = parseArr(g.membership_plans);
      let changed = false;
      const next = plans.map((p) => {
        const cls = parseArr(p && p.classes);
        if (cls.indexOf(cid) < 0) return p;
        changed = true;
        const nc = cls.filter((x) => x !== cid); toCids.forEach((x) => { if (nc.indexOf(x) < 0) nc.push(x); });
        return nc.length ? Object.assign({}, p, { classes: nc }) : null;   // bez lekcí by platil na všechno -> pryč
      }).filter(Boolean);
      if (changed) await sb(`gyms?id=eq.${q(gym.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ membership_plans: wasString ? JSON.stringify(next) : next }) });
    }
  } catch (e) { console.error('[pass-transfer] plans', e.message); }
  return out;
}

// Cron: nerozhodnuté nabídky po termínu -> vrácení.
export async function expireOffers(todayYmd = ymd(Date.now())) {
  const rows = (await sbGet(`pass_transfers?decision=is.null&deadline=lt.${q(todayYmd)}&select=*&limit=500`)) || [];
  let n = 0;
  for (const r of rows) { try { if (await settleRefund(r, { auto: true })) n++; } catch (e) { console.error('[pass-transfer] expire', r.id, e.message); } }
  return n;
}
