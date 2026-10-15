// /api/pairing — PÁROVÁNÍ PLATEB PŘEVODEM (Finbricks Payment Pairing).
//
// Student zaplatí QR převodem, Finbricks hlídá výpis účtu příjemce a jakmile platba s naším
// variabilním symbolem a částkou dorazí, MTL ji potvrdí samo (stejné zaúčtování jako platba
// z účtu: pisSettle s kolejí 'qr'). Klub / kouč nemusí nic odklikávat. Páruje se KAŽDÁ CZK QR
// platba, jejíž příjemce má zapnuté „Automaticky potvrzovat platbu přes vygenerovaný QR kód"
// (pairing_on, výchozí zapnuto). Účet příjemce se připojuje ve Finbricks; MTL ho neeviduje.
//
// POST { action, ... }
//   reserve  { iban, amount, currency }        přihlášený: VS do QR (Finbricks se nevolá, nic
//                                               se neplatí). Vrací { vs } nebo { vs: null }.
//   attach   { vs, tbl, id }                    přihlášený: „Zaplaceno" -- ověří řádek, cenu
//                                               a příjemce, pošle Finbricks požadavek na párování
//                                               a zapíše pairing_id na řádek platby
//   test_incoming { vs }                        jen Testovací režim, autor platby (nebo founder):
//                                               sandboxová platba z účtu (Mock Cobs, 1 Kč) s tímhle
//                                               VS na účet příjemce -- test bez skutečných peněz
//   check { vs }                                autor platby (nebo founder): stav párování hned
//
// TESTOVACÍ REŽIM: sandbox má strop 1 Kč, takže se párování posílá na 1 Kč (QR v Testovacím
// režimu je taky na 1 Kč). V ostrém provozu vždy se skutečnou částkou.
// POST ?notify=1    notifikace od Finbricks (adresa se nastavuje v jejich administraci). Tělu
//                   nevěříme -- bere se z něj jen id párování a stav si server zjistí sám
//                   podepsaným dotazem na Finbricks.
// GET  ?cron=1      (CRON_SECRET) dotaz na stav otevřených párování a úklid.
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { fbxConf, fbxNow, fbxCall, psuIpFrom, FBX_MAX_SANDBOX } from './_fbx.js';
import { isTestMode } from './_config.js';
import { checkRowPrice } from './_price-check.js';
import { cohortPisPlan } from './_cohort-pis.js';
import { pisSettle } from './pis-return.js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const FOUNDER = process.env.FOUNDER_UUID || '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const TABLES = ['gym_bookings', 'gym_memberships', 'bookings', 'event_tickets', 'cohort_members', 'merch_orders'];
const PAID = ['paid', 'active', 'deposit_paid', 'enrolled', 'converted', 'completed'];
const GONE = ['released', 'expired', 'cancelled', 'refunded', 'ended', 'removed', 'declined'];
const FINISH_DAYS = 4;          // převod může trvat přes víkend
const iban = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;

async function who(req) {
  const tok = String(req.headers['x-access-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  try { const r = await sb.auth.getUser(tok); return (r && r.data && r.data.user && r.data.user.id) || null; } catch (e) { return null; }
}

// Příjemce řádku VŽDY z databáze (komu platba patří), nikdy z prohlížeče: jeho IBANy a jestli
// má zapnuté „Automaticky potvrzovat platbu přes vygenerovaný QR kód" (pairing_on, výchozí zapnuto).
async function payeeOf(tbl, row) {
  const out = []; let on = true;
  const add = (v) => { const x = iban(v); if (x && out.indexOf(x) < 0) out.push(x); };
  const gym = async (id) => { const g = (await sb.from('gyms').select('receiver_id_value,pairing_on').eq('id', id).maybeSingle()).data; if (g) { add(g.receiver_id_value); on = g.pairing_on !== false; } };
  const coach = async (id) => { const c = (await sb.from('profiles').select('receiver_id_value,payout_receiver_id_value,pairing_on').eq('id', id).maybeSingle()).data; if (c) { add(c.receiver_id_value); add(c.payout_receiver_id_value); on = c.pairing_on !== false; } };
  if (tbl === 'event_tickets') {
    const ev = (await sb.from('events').select('gym_id,payout_coach_id,organization_id').eq('id', row.event_id).maybeSingle()).data;
    if (ev && ev.payout_coach_id) await coach(ev.payout_coach_id);
    else if (ev && ev.gym_id) await gym(ev.gym_id);
    else if (ev && ev.organization_id) { const o = (await sb.from('organizations').select('receiver_id_value,pairing_on').eq('id', ev.organization_id).maybeSingle()).data; if (o) { add(o.receiver_id_value); on = o.pairing_on !== false; } }
  } else if (tbl === 'cohort_members') {
    const co = (await sb.from('gym_cohorts').select('gym_id').eq('id', row.cohort_id).maybeSingle()).data;
    if (co && co.gym_id) await gym(co.gym_id);
  } else if (tbl === 'merch_orders' && row.coach_id) await coach(row.coach_id);   // merch kouče jde kouči (jako v pis-return)
  else if (row.gym_id) await gym(row.gym_id);
  else if (row.coach_id) await coach(row.coach_id);
  return { ibans: out, on };
}

// Částka, kterou má student za řádek zaplatit -- z ceníku / řádku, stejně jako u platby z účtu.
async function rowAmount(tbl, row, wanted) {
  if (tbl === 'cohort_members') {
    const plan = await cohortPisPlan(sb, row, wanted);
    if (plan.error) return { error: plan.error };
    return { amount: r2(plan.amount), currency: plan.currency || 'CZK', plan };
  }
  const pc = await checkRowPrice({ SB: process.env.SUPABASE_URL, KEY: process.env.SUPABASE_SERVICE_ROLE_KEY, tbl, row });
  if (!pc.ok) return { error: pc.error || 'Cena neodpovídá nabídce' };
  if (tbl === 'event_tickets' && row.order_id) {
    const sib = (await sb.from('event_tickets').select('amount').eq('order_id', row.order_id)).data || [];
    return { amount: r2(sib.reduce((a, t) => a + Number(t.amount || 0), 0)), currency: row.currency || 'CZK' };
  }
  return { amount: r2(row.amount), currency: row.currency || 'CZK' };
}

// Odpověď Finbricks má v dokumentaci dva tvary (pole / { payments: [...] }).
const firstPay = (d) => (Array.isArray(d) ? d[0] : (d && Array.isArray(d.payments) ? d.payments[0] : d)) || null;

// Párování skončilo bez peněz (vypršelo, zrušeno, chyba): značka z řádku pryč. Student pak zase
// vidí „čeká na potvrzení", poskytovatel dostane od release-cronu připomínku a potvrzuje ručně.
async function unmark(p) {
  if (!p || !p.tbl || !p.row_id || !TABLES.includes(p.tbl)) return;
  try {
    await sb.from(p.tbl).update({ pairing_id: null }).eq('pairing_id', p.id);   // i ostatní lístky objednávky
    if (p.tbl === 'cohort_members') await sb.from('cohort_members').update({ pis_payment_id: null, pis_provider: null }).eq('id', p.row_id).eq('pis_payment_id', 'pair-' + p.id);
  } catch (e) { console.error('[pairing] unmark', p.id, e && e.message); }
}

// ── ZAÚČTOVÁNÍ SPÁROVANÉ PLATBY ─────────────────────────────────────────────────────────
async function settle(p) {
  // Jen jednou: notifikace i cron můžou přijít naráz.
  const cl = await sb.from('payment_pairings').update({ status: 'paired', paired_at: new Date().toISOString() }).eq('id', p.id).eq('status', 'scheduled').select('id');
  if (!(cl.data && cl.data.length)) return 'already';
  const row = (await sb.from(p.tbl).select('*').eq('id', p.row_id).maybeSingle()).data;
  if (!row) { await sb.from('payment_pairings').update({ last_error: 'row not found' }).eq('id', p.id); return 'no_row'; }
  await pisSettle(row, p.tbl, 'paired', 'qr');
  return 'paired';
}

// Stav jednoho párování přímo od Finbricks (podepsaný dotaz) -- jediný zdroj pravdy.
async function checkOne(p) {
  const C = fbxConf(p.fbx_env === 'production' ? 'production' : 'sandbox');
  const r = await fbxCall(C, 'GET', `/payment/pairing/status?uniquePaymentPairingId=${encodeURIComponent(String(p.id))}&merchantId=${encodeURIComponent(C.merchant)}`, null);
  await sb.from('payment_pairings').update({ checked_at: new Date().toISOString() }).eq('id', p.id);
  if (!r.ok || !r.data) { await sb.from('payment_pairings').update({ last_error: 'status HTTP ' + r.status }).eq('id', p.id); return 'error'; }
  const st = String(r.data.paymentPairingStatus || '').toUpperCase();
  if (st === 'PAIRED') {
    // Pojistka: dorazilo v CZK a aspoň tolik, kolik mělo.
    const f = Array.isArray(r.data.foundPaymentData) ? r.data.foundPaymentData[0] : null;
    const fa = f && f.amount; if (!p.test_mode && fa && (String(fa.currency || 'CZK').toUpperCase() !== 'CZK' || Number(fa.value) + 0.005 < Number(p.amount))) {
      await sb.from('payment_pairings').update({ status: 'failed', last_error: 'amount/currency mismatch ' + JSON.stringify(fa) }).eq('id', p.id); await unmark(p); return 'mismatch';
    }
    return settle(p);
  }
  if (st === 'EXPIRED' || st === 'CANCELLED' || st === 'FAILED') {
    await sb.from('payment_pairings').update({ status: st.toLowerCase(), last_error: st === 'FAILED' ? JSON.stringify(r.data.reason || null) : null }).eq('id', p.id).eq('status', 'scheduled');
    await unmark(p);
    return st.toLowerCase();
  }
  return 'unpaired';
}

async function cancelAtFbx(p, why) {
  try {
    const C = fbxConf(p.fbx_env === 'production' ? 'production' : 'sandbox');
    await fbxCall(C, 'DELETE', `/payment/pairing/schedule?merchantId=${encodeURIComponent(C.merchant)}&uniquePaymentPairingId=${encodeURIComponent(String(p.id))}`, null);
  } catch (e) { console.error('[pairing] cancel', e && e.message); }
  await sb.from('payment_pairings').update({ status: 'cancelled', last_error: why || null }).eq('id', p.id).in('status', ['scheduled', 'reserved']);
  await unmark(p);
}

// Všechna id párování v těle notifikace (tvar notifikace Finbricks zatím neznáme -- hledá se
// klíč uniquePaymentPairingId kdekoli v těle).
function idsIn(x, out) {
  if (!x || typeof x !== 'object') return out;
  if (Array.isArray(x)) { x.forEach((y) => idsIn(y, out)); return out; }
  Object.keys(x).forEach((k) => { if (k === 'uniquePaymentPairingId' && /^\d+$/.test(String(x[k]))) out.add(String(x[k])); else idsIn(x[k], out); });
  return out;
}

// ── CRON ──────────────────────────────────────────────────────────────────────────────────
async function cron() {
  const now = Date.now(), res = { checked: 0, paired: 0, cancelled: 0, cleaned: 0 };
  // 1) Otevřená párování: čím déle čekají, tím řidčeji (notifikace od Finbricks je hlavní cesta).
  const open = (await sb.from('payment_pairings').select('*').eq('status', 'scheduled').order('checked_at', { ascending: true, nullsFirst: true }).limit(200)).data || [];
  for (const p of open) {
    const age = now - new Date(p.scheduled_at || p.created_at).getTime();
    const every = age < 3600e3 ? 15 * 60e3 : (age < 86400e3 ? 120 * 60e3 : 720 * 60e3);
    // Řádek mezitím zaplacený ručně, zrušený nebo smazaný -> párování pryč.
    const row = (await sb.from(p.tbl).select('id,status').eq('id', p.row_id).maybeSingle()).data;
    if (!row || GONE.includes(String(row.status || ''))) { await cancelAtFbx(p, row ? ('row ' + row.status) : 'row deleted'); res.cancelled++; continue; }
    if (PAID.includes(String(row.status || '')) && p.tbl !== 'cohort_members') { await cancelAtFbx(p, 'confirmed by hand'); res.cancelled++; continue; }
    if (p.checked_at && now - new Date(p.checked_at).getTime() < every) continue;
    const o = await checkOne(p); res.checked++; if (o === 'paired') res.paired++;
  }
  // 2) VS přidělené k QR, za které nikdo neklikl „Zaplaceno" -- po dvou dnech pryč.
  const old = new Date(now - 2 * 86400e3).toISOString();
  const cl = await sb.from('payment_pairings').delete().eq('status', 'reserved').lt('created_at', old).select('id');
  res.cleaned = (cl.data || []).length;
  return res;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const q = req.query || {};
    if (String(q.cron || '') === '1') {
      const sec = process.env.CRON_SECRET;
      if (!sec) return res.status(500).json({ error: 'CRON_SECRET not configured' });
      if ((req.headers.authorization || '') !== `Bearer ${sec}`) return res.status(401).json({ error: 'unauthorized' });
      return res.status(200).json({ ok: true, ...(await cron()) });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }

    // NOTIFIKACE OD FINBRICKS: jen spouštěč, pravdu si server zjistí sám.
    if (String(q.notify || '') === '1') {
      const ids = [...idsIn(b, new Set())].slice(0, 50);
      for (const id of ids) {
        const p = (await sb.from('payment_pairings').select('*').eq('id', id).eq('status', 'scheduled').maybeSingle()).data;
        if (p) { try { await checkOne(p); } catch (e) { console.error('[pairing] notify', id, e && e.message); } }
      }
      return res.status(200).json({ ok: true });
    }

    const me = await who(req);
    if (!me) return res.status(401).json({ error: 'not signed in' });
    const action = String(b.action || '');

    // ── VS DO QR ────────────────────────────────────────────────────────────────────────
    if (action === 'reserve') {
      const ib = iban(b.iban), amount = r2(b.amount), cur = String(b.currency || 'CZK').toUpperCase();
      if (cur !== 'CZK' || !(amount > 0) || !/^CZ\d{22}$/.test(ib)) return res.status(200).json({ ok: true, vs: null });
      // Pojistka proti zahlcení: nejvýš 20 nepoužitých VS na člověka za hodinu.
      const since = new Date(Date.now() - 3600e3).toISOString();
      const n = await sb.from('payment_pairings').select('id', { count: 'exact', head: true }).eq('user_id', me).eq('status', 'reserved').gte('created_at', since);
      if ((n.count || 0) >= 20) return res.status(200).json({ ok: true, vs: null });
      let test = false; try { test = await isTestMode(); } catch (e) {}
      const ins = await sb.from('payment_pairings').insert({ status: 'reserved', iban: ib, amount, currency: 'CZK', user_id: me, test_mode: test }).select('id').single();
      if (ins.error) { console.error('[pairing] reserve', ins.error.message); return res.status(200).json({ ok: true, vs: null }); }
      return res.status(200).json({ ok: true, vs: String(ins.data.id) });
    }

    // ── „ZAPLACENO" -> POŽADAVEK NA PÁROVÁNÍ ─────────────────────────────────────────────
    if (action === 'attach') {
      const vs = String(b.vs || ''), tbl = String(b.tbl || ''), id = String(b.id || '');
      if (!/^\d+$/.test(vs) || !TABLES.includes(tbl) || !id) return res.status(400).json({ error: 'bad request' });
      const p = (await sb.from('payment_pairings').select('*').eq('id', vs).maybeSingle()).data;
      if (!p || String(p.user_id) !== String(me)) return res.status(404).json({ error: 'pairing not found' });
      if (p.status === 'scheduled' && p.tbl === tbl && String(p.row_id) === id) return res.status(200).json({ ok: true, status: 'scheduled' });
      if (p.status !== 'reserved') return res.status(409).json({ error: 'pairing ' + p.status });
      const row = (await sb.from(tbl).select('*').eq('id', id).maybeSingle()).data;
      if (!row) return res.status(404).json({ error: 'row not found' });
      const mine = [row.student_id, row.buyer_id, row.paid_by, row.member_id].some((x) => x && String(x) === String(me));
      if (!mine) return res.status(403).json({ error: 'forbidden' });
      if (PAID.includes(String(row.status || '')) && tbl !== 'cohort_members') return res.status(200).json({ ok: true, status: 'already_paid' });
      const amt = await rowAmount(tbl, row, p.amount);
      if (amt.error) return res.status(400).json({ error: amt.error });
      if (String(amt.currency).toUpperCase() !== 'CZK' || Math.abs(amt.amount - Number(p.amount)) > 0.005) return res.status(400).json({ error: 'Částka v QR neodpovídá platbě' });
      const payee = await payeeOf(tbl, row);
      if (!payee.ibans.includes(iban(p.iban))) return res.status(400).json({ error: 'Účet v QR nepatří příjemci platby' });
      // Příjemce si automatické potvrzování vypnul -> potvrzuje ručně.
      if (!payee.on) {
        await sb.from('payment_pairings').update({ status: 'cancelled', tbl, row_id: id, last_error: 'payee turned pairing off' }).eq('id', p.id);
        return res.status(200).json({ ok: true, status: 'off' });
      }

      const C = await fbxNow();
      if (!C.ok) return res.status(500).json({ error: 'Finbricks ' + C.env + ' nemá nastavené klíče' });
      const finish = new Date(Date.now() + FINISH_DAYS * 86400e3).toISOString();
      const r = await fbxCall(C, 'POST', '/payment/pairing/schedule', { merchantId: C.merchant, payments: [{
        uniquePaymentPairingId: String(p.id),
        // Sandbox: 1 Kč (strop sandboxu, stejně jako QR v Testovacím režimu a platba z Mock Cobs).
        amount: { value: C.sandbox ? Number(FBX_MAX_SANDBOX) : Number(p.amount), currency: 'CZK' },
        creditor: { accountIdentification: { value: iban(p.iban), type: 'IBAN' } },
        remittanceInformation: { structured: { reference: 'VS:' + String(p.id) } },
        finishPairingAt: finish,
      }] });
      const f = firstPay(r.data);
      // Co Finbricks vrací: dokumentace má u schedule `scheduleStatus` SCHEDULED / FAILED, ale
      // zároveň píše, že schedule „vrací UNPAIRED", když platba hned nenašel -- tedy
      // `paymentPairingStatus`. Dřív se bralo jen SCHEDULED, takže párování, které Finbricks
      // přijal (UNPAIRED), MTL zapsalo jako 'failed': student dostal „klub potvrdí", klub
      // „potvrď" a cron se na stav nikdy nezeptal. Teď: přijato je všechno kromě chyby.
      const sst = String((f && (f.scheduleStatus || f.paymentPairingStatus)) || '').toUpperCase();
      const ok = r.ok && !!f && ['SCHEDULED', 'UNPAIRED', 'PAIRED'].includes(sst);
      await sb.from('payment_pairings').update({ tbl, row_id: id, fbx_env: C.env, finish_at: finish,
        status: ok ? 'scheduled' : 'failed', scheduled_at: ok ? new Date().toISOString() : null,
        last_error: ok ? null : (JSON.stringify((f && f.reason) || r.data || { http: r.status }).slice(0, 500)) }).eq('id', p.id);
      if (!ok) { console.error('[pairing] schedule', r.status, JSON.stringify(r.data)); return res.status(200).json({ ok: true, status: 'failed' }); }
      // Značka na řádku platby: appka podle ní mluví o automatickém potvrzení a cron nepřipomíná.
      // Kurz navíc: co se platí (záloha / doplatek / měsíce) si zaúčtování čte z přihlášky -- stejně
      // jako u platby z účtu (pis-create). pis_payment_id drží id párování, aby se zaúčtovalo jen jednou.
      const mark = { pairing_id: p.id };
      if (tbl === 'cohort_members' && amt.plan) Object.assign(mark, { pis_payment_id: 'pair-' + p.id, pis_provider: 'pairing', pis_status: null,
        pis_purpose: amt.plan.purpose, pis_months: amt.plan.months, pis_amount: amt.plan.amount });
      const mk = await sb.from(tbl).update(mark).eq('id', id);
      // Lístky jedné objednávky jsou jedna platba -- značku dostanou všechny.
      if (tbl === 'event_tickets' && row.order_id) await sb.from('event_tickets').update({ pairing_id: p.id }).eq('order_id', row.order_id);
      if (mk.error) console.error('[pairing] mark', tbl, id, mk.error.message);
      // Platba už na účtu je (zaplaceno dřív, než klikl „Zaplaceno") -> potvrdit hned.
      if (sst === 'PAIRED') { const p2 = (await sb.from('payment_pairings').select('*').eq('id', p.id).maybeSingle()).data; if (p2) await checkOne(p2); }
      return res.status(200).json({ ok: true, status: 'scheduled' });
    }

    // ── TEST BEZ PENĚZ A OKAMŽITÝ STAV (jen vlastní platba) ──────────────────────────────
    if (action === 'test_incoming' || action === 'check') {
      if (!/^\d+$/.test(String(b.vs || ''))) return res.status(400).json({ error: 'bad request' });
      const p = (await sb.from('payment_pairings').select('*').eq('id', String(b.vs)).maybeSingle()).data;
      if (!p || (String(p.user_id) !== String(me) && String(me) !== FOUNDER)) return res.status(404).json({ error: 'Párování neexistuje' });
      if (action === 'check') {
        const out = p.status === 'scheduled' ? await checkOne(p) : p.status;
        const now = (await sb.from('payment_pairings').select('status,last_error').eq('id', p.id).maybeSingle()).data || {};
        return res.status(200).json({ ok: true, result: out, status: now.status, tbl: p.tbl || null, last_error: now.last_error || null });
      }
      if (!(await isTestMode())) return res.status(400).json({ error: 'Jen v Testovacím režimu' });
      if (p.status !== 'scheduled') return res.status(400).json({ error: 'Párování není ve stavu „čeká“ (' + p.status + ')' });
      if (p.fbx_env !== 'sandbox') return res.status(400).json({ error: 'Párování běží v ostrém Finbricks — test jen v sandboxu' });
      const C = fbxConf('sandbox');
      if (!C.ok) return res.status(500).json({ error: 'Finbricks sandbox nemá nastavené klíče' });
      const APP = process.env.APP_URL || 'https://app.martialtraininglab.com';
      const payload = { merchantId: C.merchant, merchantTransactionId: crypto.randomUUID(), amount: FBX_MAX_SANDBOX,
        creditorAccountIban: iban(p.iban), creditorName: 'MTL test', variableSymbol: String(p.id),
        description: 'MTL test parovani ' + p.id, initiatorName: 'Martial Training Lab', instructionPriority: 'INST',
        callbackUrl: APP + '/?pairtest=' + p.id, shoppingCartUrl: APP + '/', paymentProvider: 'MOCK_COBS' };
      const opts = { psuIp: psuIpFrom(req), psuUa: req.headers['user-agent'] || 'MTL/1.0', lang: 'cs' };
      let r = await fbxCall(C, 'POST', '/ecommerce/transaction/init', payload, opts);
      if (!r.ok && r.data && [308, 300, 302].includes(r.data.code)) {
        const p2 = { ...payload, totalPrice: payload.amount }; delete p2.amount; delete p2.shoppingCartUrl;
        r = await fbxCall(C, 'POST', '/transaction/platform/init', p2, opts);
      }
      if (!r.ok || !r.data || !r.data.redirectUrl) return res.status(400).json({ error: 'Finbricks: ' + JSON.stringify(r.data || { http: r.status }).slice(0, 300) });
      return res.status(200).json({ ok: true, url: r.data.redirectUrl });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[pairing]', e && e.message);
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
