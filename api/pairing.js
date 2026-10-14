// /api/pairing — PÁROVÁNÍ PLATEB PŘEVODEM (Finbricks Payment Pairing).
//
// Student zaplatí QR převodem, Finbricks hlídá výpis účtu příjemce a jakmile platba s naším
// variabilním symbolem a částkou dorazí, MTL ji potvrdí samo (stejné zaúčtování jako platba
// z účtu: pisSettle s kolejí 'qr'). Klub / kouč nemusí nic odklikávat. Jen CZK, jen u příjemce
// se zapnutým „Automaticky potvrzovat platby převodem" (pairing_on, výchozí zapnuto) a jen na
// účet zapnutý v pairing_accounts (připojený ve Finbricks, platnost 180 dní).
//
// POST { action, ... }
//   reserve  { iban, amount, currency }        přihlášený: VS do QR (Finbricks se nevolá, nic
//                                               se neplatí). Vrací { vs } nebo { vs: null }.
//   attach   { vs, tbl, id }                    přihlášený: „Zaplaceno" -- ověří řádek, cenu
//                                               a účet a pošle Finbricks požadavek na párování
//   accounts {}                                 founder: účty s párováním + kdo je používá
//   account_save { iban, active, valid_until, note }   founder
// POST ?notify=1    notifikace od Finbricks (adresa se nastavuje v jejich administraci). Tělu
//                   nevěříme -- bere se z něj jen id párování a stav si server zjistí sám
//                   podepsaným dotazem na Finbricks.
// GET  ?cron=1      (CRON_SECRET) dotaz na stav otevřených párování, úklid, upozornění na
//                   konec platnosti připojení účtu.
import { createClient } from '@supabase/supabase-js';
import { fbxConf, fbxNow, fbxCall } from './_fbx.js';
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
const WARN_DAYS = 14;           // upozornění před koncem platnosti připojení účtu
const iban = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();
const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;
const czD = (d) => { try { return new Date(d).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' }); } catch (e) { return String(d || ''); } };

async function who(req) {
  const tok = String(req.headers['x-access-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  try { const r = await sb.auth.getUser(tok); return (r && r.data && r.data.user && r.data.user.id) || null; } catch (e) { return null; }
}

// Účet, na který se zaplatilo: zapnutý a s platným připojením.
async function accountOn(ib) {
  if (!ib) return false;
  const a = (await sb.from('pairing_accounts').select('active,valid_until').eq('iban', ib).maybeSingle()).data;
  return !!(a && a.active && String(a.valid_until) >= new Date().toISOString().slice(0, 10));
}

// Příjemce řádku VŽDY z databáze (komu platba patří), nikdy z prohlížeče: jeho IBANy a jestli
// má zapnuté „Automaticky potvrzovat platby převodem" (pairing_on, výchozí zapnuto).
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
    const fa = f && f.amount; if (fa && (String(fa.currency || 'CZK').toUpperCase() !== 'CZK' || Number(fa.value) + 0.005 < Number(p.amount))) {
      await sb.from('payment_pairings').update({ status: 'failed', last_error: 'amount/currency mismatch ' + JSON.stringify(fa) }).eq('id', p.id); return 'mismatch';
    }
    return settle(p);
  }
  if (st === 'EXPIRED' || st === 'CANCELLED' || st === 'FAILED') {
    await sb.from('payment_pairings').update({ status: st.toLowerCase(), last_error: st === 'FAILED' ? JSON.stringify(r.data.reason || null) : null }).eq('id', p.id).eq('status', 'scheduled');
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
  const now = Date.now(), res = { checked: 0, paired: 0, cancelled: 0, cleaned: 0, warned: 0 };
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
  // 3) Konec platnosti připojení účtu: founder (obnoví ve Finbricks) i majitel účtu (ví, že
  //    potvrzování převodů bude zase ruční).
  const lim = new Date(now + WARN_DAYS * 86400e3).toISOString().slice(0, 10);
  const acc = (await sb.from('pairing_accounts').select('*').eq('active', true).lte('valid_until', lim).is('warned_at', null)).data || [];
  for (const a of acc) {
    const owners = await accountOwners(a.iban);
    const fCs = `🏦 Připojení účtu ${a.iban} k párování plateb končí ${czD(a.valid_until)}` + (owners.length ? ` (${owners.map((o) => o.name).join(', ')})` : '') + '. Obnov ho v administraci Finbricks a pak v Adminu MTL prodluž platnost — jinak se platby převodem zase budou potvrzovat ručně.';
    await sb.from('notifications').insert({ user_id: FOUNDER, type: 'system', read: false, message: fCs, data: JSON.stringify({ kind: 'pairing_expiring', target: 'admin', iban: a.iban, until: a.valid_until, msg_cs: fCs }) });
    for (const o of owners) {
      if (!o.owner) continue;
      const cs = `🏦 Automatické potvrzování plateb převodem pro účet ${a.iban} (${o.name}) končí ${czD(a.valid_until)}. Potom budeš platby převodem zase potvrzovat ručně, dokud MTL připojení účtu neobnoví — banka k tomu bude chtít tvoje potvrzení.`;
      const en = `🏦 Automatic confirmation of bank-transfer payments for account ${a.iban} (${o.name}) ends ${new Date(a.valid_until).toLocaleDateString('en-GB')}. After that you confirm transfers by hand again until MTL renews the account connection — your bank will ask you to approve it.`;
      await sb.from('notifications').insert({ user_id: o.owner, type: 'system', read: false, message: cs, data: JSON.stringify({ kind: 'pairing_expiring', target: 'owner', iban: a.iban, until: a.valid_until, msg_cs: cs, msg_en: en }) });
    }
    await sb.from('pairing_accounts').update({ warned_at: new Date().toISOString() }).eq('iban', a.iban);
    res.warned++;
  }
  return res;
}

// Kdo má účet nastavený jako výplatní (klub, kouč, organizace) -- jméno a majitel.
async function accountOwners(ib) {
  const out = [];
  const g = (await sb.from('gyms').select('name,owner_id,receiver_id_value').not('receiver_id_value', 'is', null).limit(5000)).data || [];
  g.forEach((x) => { if (iban(x.receiver_id_value) === ib) out.push({ name: x.name || 'Klub', owner: x.owner_id, kind: 'gym' }); });
  const p = (await sb.from('profiles').select('id,name,receiver_id_value,payout_receiver_id_value').or('receiver_id_value.not.is.null,payout_receiver_id_value.not.is.null').limit(5000)).data || [];
  p.forEach((x) => { if (iban(x.receiver_id_value) === ib || iban(x.payout_receiver_id_value) === ib) out.push({ name: x.name || 'Kouč', owner: x.id, kind: 'coach' }); });
  const o = (await sb.from('organizations').select('name,owner_id,receiver_id_value').not('receiver_id_value', 'is', null).limit(5000)).data || [];
  o.forEach((x) => { if (iban(x.receiver_id_value) === ib) out.push({ name: x.name || 'Organizace', owner: x.owner_id, kind: 'org' }); });
  return out;
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
      if (cur !== 'CZK' || !(amount > 0) || !(await accountOn(ib))) return res.status(200).json({ ok: true, vs: null });
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
      // Příjemce si automatické potvrzování vypnul, nebo účet není připojený -> potvrzuje ručně.
      if (!payee.on || !(await accountOn(iban(p.iban)))) {
        await sb.from('payment_pairings').update({ status: 'cancelled', tbl, row_id: id, last_error: payee.on ? 'account not connected' : 'payee turned pairing off' }).eq('id', p.id);
        return res.status(200).json({ ok: true, status: 'off' });
      }

      const C = await fbxNow();
      if (!C.ok) return res.status(500).json({ error: 'Finbricks ' + C.env + ' nemá nastavené klíče' });
      const finish = new Date(Date.now() + FINISH_DAYS * 86400e3).toISOString();
      const r = await fbxCall(C, 'POST', '/payment/pairing/schedule', { merchantId: C.merchant, payments: [{
        uniquePaymentPairingId: String(p.id),
        amount: { value: Number(p.amount), currency: 'CZK' },
        creditor: { accountIdentification: { value: iban(p.iban), type: 'IBAN' } },
        remittanceInformation: { structured: { reference: 'VS:' + String(p.id) } },
        finishPairingAt: finish,
      }] });
      const f = firstPay(r.data);
      const ok = r.ok && f && String(f.scheduleStatus || '').toUpperCase() === 'SCHEDULED';
      await sb.from('payment_pairings').update({ tbl, row_id: id, fbx_env: C.env, finish_at: finish,
        status: ok ? 'scheduled' : 'failed', scheduled_at: ok ? new Date().toISOString() : null,
        last_error: ok ? null : (JSON.stringify((f && f.reason) || r.data || { http: r.status }).slice(0, 500)) }).eq('id', p.id);
      if (!ok) { console.error('[pairing] schedule', r.status, JSON.stringify(r.data)); return res.status(200).json({ ok: true, status: 'failed' }); }
      // Kurz: co se platí (záloha / doplatek / měsíce) si zaúčtování čte z přihlášky -- stejně
      // jako u platby z účtu (pis-create). pis_payment_id drží id párování, aby se zaúčtovalo jen jednou.
      if (tbl === 'cohort_members' && amt.plan) {
        await sb.from('cohort_members').update({ pis_payment_id: 'pair-' + p.id, pis_provider: 'pairing', pis_status: null,
          pis_purpose: amt.plan.purpose, pis_months: amt.plan.months, pis_amount: amt.plan.amount }).eq('id', id);
      }
      return res.status(200).json({ ok: true, status: 'scheduled' });
    }

    // ── ADMIN: ÚČTY S PÁROVÁNÍM ──────────────────────────────────────────────────────────
    if (action === 'accounts' || action === 'account_save') {
      if (String(me) !== FOUNDER) return res.status(403).json({ error: 'forbidden' });
      if (action === 'account_save') {
        const ib = iban(b.iban);
        if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(ib)) return res.status(400).json({ error: 'Neplatný IBAN' });
        const vu = /^\d{4}-\d{2}-\d{2}$/.test(String(b.valid_until || '')) ? String(b.valid_until) : new Date(Date.now() + 180 * 86400e3).toISOString().slice(0, 10);
        const up = await sb.from('pairing_accounts').upsert({ iban: ib, active: b.active !== false, valid_until: vu, note: b.note ? String(b.note).slice(0, 200) : null,
          ...(b.renew ? { connected_at: new Date().toISOString().slice(0, 10) } : {}), warned_at: null, updated_at: new Date().toISOString() }, { onConflict: 'iban' });
        if (up.error) return res.status(400).json({ error: up.error.message });
      }
      const list = (await sb.from('pairing_accounts').select('*').order('valid_until', { ascending: true })).data || [];
      for (const a of list) a.owners = (await accountOwners(a.iban)).map((o) => ({ name: o.name, kind: o.kind }));
      const stats = (await sb.from('payment_pairings').select('status').gte('created_at', new Date(Date.now() - 30 * 86400e3).toISOString()).limit(10000)).data || [];
      const cnt = {}; stats.forEach((s) => { cnt[s.status] = (cnt[s.status] || 0) + 1; });
      return res.status(200).json({ ok: true, accounts: list, last30: cnt });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[pairing]', e && e.message);
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
