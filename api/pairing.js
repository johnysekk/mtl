// /api/pairing — PÁROVÁNÍ PLATEB PŘEVODEM (Finbricks Payment Pairing).
//
// Student zaplatí QR převodem, Finbricks hlídá výpis účtu příjemce a jakmile platba s naším
// variabilním symbolem a částkou dorazí, MTL ji potvrdí samo (stejné zaúčtování jako platba
// z účtu: pisSettle s kolejí 'qr'). Klub / kouč nemusí nic odklikávat.
//
// PÁRUJE SE JEN, KDYŽ: platba je v CZK a příjemce má zapnuté „Automaticky potvrzovat platbu přes
// vygenerovaný QR kód" (pairing_on). Účet musí být připojený k párování ve Finbricks Backoffice
// („Přidat účet" -- souhlas + přihlášení do banky). Připojení přes AIS API (/v2/auth/authenticate)
// párování NEBERE (ověřeno 15. 10. 2026) a veřejné API pro „Přidat účet" není. Nepřipojený účet
// Finbricks sám odmítne (chyba 10000) -> 'failed' -> QR + ruční potvrzení jako dosud.
//
// PŘIPOJENÍ ÚČTU Z APPKY (link_*, pairing_links) -- ROZPRACOVANÉ, TESTUJE SE: klub se přihlásí
// do banky přes AIS API. Párování takové připojení zatím nebere (10000), proto na něm párování
// NEZÁVISÍ -- rozhoduje odpověď Finbricks. Až bude známé správné volání, mění se jen link_start.
//
// POST { action, ... }   (přihlášený)
//   reserve      { iban, amount, currency }     VS do QR (Finbricks se nevolá). { vs } / { vs: null }
//   attach       { vs, tbl, id }                „Zaplaceno" -- ověří řádek, cenu a příjemce
//                                               a pošle Finbricks požadavek na párování
//   link_status  { kind, id }                   stav připojení účtu subjektu (gym / coach / org)
//   link_banks   { kind, id }                   banky, přes které jde účet připojit
//   link_start   { kind, id, provider }         -> { url } přihlášení do banky (Finbricks)
//   link_check   { kind, id }                   po návratu z banky: platnost a účty z Finbricks
//
// TESTOVACÍ REŽIM: QR i párování jsou na 1 Kč. Mock Cobs Finbricks pro párování NEPODPORUJE
// (chyba 10003), takže se testuje skutečným převodem 1 Kč na skutečný účet připojený
// v sandboxu Finbricks (sandbox pracuje s živými daty). V ostrém provozu vždy plná částka.
// POST ?notify=1    notifikace od Finbricks (adresa se nastavuje v jejich administraci). Tělu
//                   nevěříme -- bere se z něj jen id párování a stav si server zjistí sám
//                   podepsaným dotazem na Finbricks.
// GET  ?cron=1      (CRON_SECRET) stav otevřených párování, úklid, jednou denně obnova
//                   připojení účtů z Finbricks + upozornění před koncem a po konci platnosti.
import { createClient } from '@supabase/supabase-js';
import { fbxConf, fbxNow, fbxCall, psuIpFrom, FBX_MAX_SANDBOX } from './_fbx.js';
import { isTestMode } from './_config.js';
import { checkRowPrice } from './_price-check.js';
import { cohortPisPlan } from './_cohort-pis.js';
import { pisSettle } from './pis-return.js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TABLES = ['gym_bookings', 'gym_memberships', 'bookings', 'event_tickets', 'cohort_members', 'merch_orders'];
const PAID = ['paid', 'active', 'deposit_paid', 'enrolled', 'converted', 'completed'];
const GONE = ['released', 'expired', 'cancelled', 'refunded', 'ended', 'removed', 'declined'];
const FINISH_DAYS = 4;          // převod může trvat přes víkend
const LINK_WARN_DAYS = 14;      // upozornění před koncem připojení účtu
const APP = (process.env.APP_URL || 'https://app.martialtraininglab.com').replace(/\/+$/, '');
const KINDS = ['gym', 'coach', 'org'];
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

// ── PŘIPOJENÍ ÚČTU K PÁROVÁNÍ (pairing_links) ──────────────────────────────────────────
const nowIso = () => new Date().toISOString();
// Subjekt, jeho majitel, název a výplatní účty. Null, když ho přihlášený nespravuje.
async function entityOf(kind, id, me) {
  if (!KINDS.includes(kind) || !id) return null;
  const add = (arr, v) => { const x = iban(v); if (x && arr.indexOf(x) < 0) arr.push(x); return arr; };
  if (kind === 'gym') {
    const g = (await sb.from('gyms').select('id,name,owner_id,receiver_id_value,pairing_on').eq('id', id).maybeSingle()).data;
    if (!g || (me && String(g.owner_id) !== String(me))) return null;
    return { kind, id: String(g.id), owner: g.owner_id, name: g.name || 'Klub', ibans: add([], g.receiver_id_value), on: g.pairing_on !== false };
  }
  if (kind === 'coach') {
    const c = (await sb.from('profiles').select('id,name,receiver_id_value,payout_receiver_id_value,pairing_on').eq('id', id).maybeSingle()).data;
    if (!c || (me && String(c.id) !== String(me))) return null;
    return { kind, id: String(c.id), owner: c.id, name: c.name || 'Kouč', ibans: add(add([], c.receiver_id_value), c.payout_receiver_id_value), on: c.pairing_on !== false };
  }
  const o = (await sb.from('organizations').select('id,name,owner_id,receiver_id_value,pairing_on').eq('id', id).maybeSingle()).data;
  if (!o || (me && String(o.owner_id) !== String(me))) return null;
  return { kind, id: String(o.id), owner: o.owner_id, name: o.name || 'Organizace', ibans: add([], o.receiver_id_value), on: o.pairing_on !== false };
}
// Stav pro appku: none | pending | active | mismatch (připojený účet není výplatní) | expired | error
function linkView(l, e) {
  if (!l) return { state: 'none', need: e.ibans };
  const live = l.status === 'active' && l.valid_to && new Date(l.valid_to).getTime() > Date.now();
  const state = live ? (e.ibans.some((x) => (l.ibans || []).includes(x)) ? 'active' : 'mismatch')
    : (l.status === 'active' ? 'expired' : l.status);
  return { state, provider: l.provider, bank: l.bank_name, valid_to: l.valid_to, ibans: l.ibans || [], need: e.ibans, error: l.last_error || null };
}
// Platnost a účty VŽDY z Finbricks: /auth/token (validTo), /account/list (IBANy).
async function linkRefresh(l, psu) {
  const C = fbxConf(l.fbx_env);
  const q = `merchantId=${encodeURIComponent(C.merchant)}&clientId=${encodeURIComponent(l.client_id)}`;
  const t = await fbxCall(C, 'GET', `/auth/token?${q}&provider=${encodeURIComponent(l.provider || '')}`, null);
  const upd = { checked_at: nowIso(), updated_at: nowIso() };
  if (!t.ok) { upd.last_error = 'token HTTP ' + t.status + ' ' + JSON.stringify(t.data || '').slice(0, 300); await sb.from('pairing_links').update(upd).eq('ent_kind', l.ent_kind).eq('ent_id', l.ent_id).eq('fbx_env', l.fbx_env); return { ...l, ...upd }; }
  const recs = (Array.isArray(t.data) ? t.data : []).filter((x) => String(x.scope || '').indexOf('AISP') >= 0);
  const best = recs.sort((a, b) => String(b.validTo).localeCompare(String(a.validTo)))[0];
  if (!best || new Date(best.validTo).getTime() <= Date.now()) {
    // Žádné platné přihlášení: buď ho banka / uživatel zrušil nebo vypršelo, nebo se nedokončilo.
    upd.status = (l.status === 'active' || l.status === 'expired') ? 'expired' : 'error';
    upd.last_error = l.status === 'pending' ? 'Přihlášení do banky se nedokončilo' : null;
  } else {
    upd.status = 'active'; upd.valid_to = best.validTo; upd.last_error = null;
    const a = await fbxCall(C, 'GET', `/account/list?${q}&paymentProvider=${encodeURIComponent(l.provider || best.provider || '')}`, null,
      { psuIp: (psu && psu.ip) || '88.205.47.1', psuUa: (psu && psu.ua) || 'MTL/1.0' });
    if (a.ok && a.data && Array.isArray(a.data.accounts)) {
      upd.ibans = a.data.accounts.map((x) => iban(x && x.identification && x.identification.iban)).filter(Boolean);
    } else upd.last_error = 'account/list HTTP ' + a.status + ' ' + JSON.stringify(a.data || '').slice(0, 300);
    // Nové připojení / obnova: upozornění se zase pošlou až u nového konce.
    if (!l.valid_to || String(l.valid_to) !== String(best.validTo)) { upd.warned_at = null; upd.expired_noted_at = null; }
  }
  await sb.from('pairing_links').update(upd).eq('ent_kind', l.ent_kind).eq('ent_id', l.ent_id).eq('fbx_env', l.fbx_env);
  return { ...l, ...upd };
}
// Notifikace majiteli: před koncem a po konci připojení. Proklik rovnou do Nastavení plateb.
async function linkNote(l, e, kind) {
  if (!e || !e.owner) return;
  const until = l.valid_to ? new Date(l.valid_to) : null;
  const dCs = until ? until.toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' }) : '';
  const dEn = until ? until.toLocaleDateString('en-GB', { timeZone: 'Europe/Prague' }) : '';
  const who = (e.kind === 'gym' ? 'klubu ' : e.kind === 'org' ? 'organizace ' : '') + e.name;
  const whoEn = (e.kind === 'gym' ? 'club ' : e.kind === 'org' ? 'organisation ' : '') + e.name;
  const acc = (l.ibans || [])[0] || '';
  const cs = kind === 'expiring'
    ? `🏦 Připojení účtu ${acc} k párování plateb (${who}) vyprší ${dCs}. Obnov ho v Nastavení plateb (přihlásíš se do banky, zabere to minutu) — jinak budeš QR platby zase potvrzovat ručně.`
    : `⚠️ Připojení účtu ${acc} k párování plateb (${who}) vypršelo${dCs ? ' ' + dCs : ''}. QR platby se teď potvrzují ručně, dokud účet v Nastavení plateb znovu nepřipojíš.`;
  const en = kind === 'expiring'
    ? `🏦 The connection of account ${acc} for payment matching (${whoEn}) expires on ${dEn}. Renew it in Payment settings (log in to your bank, takes a minute) — otherwise you will confirm QR payments by hand again.`
    : `⚠️ The connection of account ${acc} for payment matching (${whoEn}) has expired${dEn ? ' on ' + dEn : ''}. QR payments are confirmed by hand until you reconnect the account in Payment settings.`;
  await sb.from('notifications').insert({ user_id: e.owner, type: 'system', read: false, message: cs,
    data: JSON.stringify({ kind: 'pairing_link', state: kind, ent_kind: e.kind, ent_id: e.id, until: l.valid_to || null, msg_cs: cs, msg_en: en }) });
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
  // Dokumentace má odpověď ploše ({ paymentPairingStatus }), ale příklad chyby v poli payments[] --
  // bere se obojí.
  const d = firstPay(r.data) || {};
  const st = String(d.paymentPairingStatus || '').toUpperCase();
  if (st === 'PAIRED') {
    // Pojistka: dorazilo v CZK a aspoň tolik, kolik mělo.
    const f = Array.isArray(d.foundPaymentData) ? d.foundPaymentData[0] : (d.foundPaymentData || null);
    const fa = f && f.amount; if (!p.test_mode && fa && (String(fa.currency || 'CZK').toUpperCase() !== 'CZK' || Number(fa.value) + 0.005 < Number(p.amount))) {
      await sb.from('payment_pairings').update({ status: 'failed', last_error: 'amount/currency mismatch ' + JSON.stringify(fa) }).eq('id', p.id); await unmark(p); return 'mismatch';
    }
    return settle(p);
  }
  if (st === 'EXPIRED' || st === 'CANCELLED' || st === 'FAILED') {
    await sb.from('payment_pairings').update({ status: st.toLowerCase(), last_error: st === 'FAILED' ? JSON.stringify(d.reason || null) : null }).eq('id', p.id).eq('status', 'scheduled');
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
  // 3) PŘIPOJENÍ ÚČTŮ: jednou denně platnost a účty z Finbricks, upozornění 14 dní před koncem
  //    a po konci (každé jednou za období platnosti).
  res.links = 0; res.linkNotes = 0;
  const day = new Date(now - 20 * 3600e3).toISOString();
  const links = (await sb.from('pairing_links').select('*').in('status', ['active', 'pending']).or(`checked_at.is.null,checked_at.lt."${day}"`).limit(200)).data || [];
  for (const l0 of links) {
    if (l0.status === 'pending' && now - new Date(l0.updated_at).getTime() < 3600e3) continue;   // ještě se vrací z banky
    try { await linkRefresh(l0); res.links++; } catch (e) { console.error('[pairing] link', l0.ent_kind, l0.ent_id, e && e.message); }
  }
  const warnLim = new Date(now + LINK_WARN_DAYS * 86400e3).toISOString();
  const soon = (await sb.from('pairing_links').select('*').eq('status', 'active').is('warned_at', null).lte('valid_to', warnLim).gt('valid_to', new Date(now).toISOString())).data || [];
  for (const l of soon) {
    const e = await entityOf(l.ent_kind, l.ent_id, null);
    if (e && e.on) { await linkNote(l, e, 'expiring'); res.linkNotes++; }
    await sb.from('pairing_links').update({ warned_at: nowIso() }).eq('ent_kind', l.ent_kind).eq('ent_id', l.ent_id).eq('fbx_env', l.fbx_env);
  }
  const gone = (await sb.from('pairing_links').select('*').is('expired_noted_at', null).or(`status.eq.expired,and(status.eq.active,valid_to.lte."${new Date(now).toISOString()}")`)).data || [];
  for (const l of gone) {
    const e = await entityOf(l.ent_kind, l.ent_id, null);
    if (e && e.on) { await linkNote(l, e, 'expired'); res.linkNotes++; }
    await sb.from('pairing_links').update({ status: 'expired', expired_noted_at: nowIso() }).eq('ent_kind', l.ent_kind).eq('ent_id', l.ent_id).eq('fbx_env', l.fbx_env);
  }
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
      const C = await fbxNow();
      if (!C.ok) return res.status(500).json({ error: 'Finbricks ' + C.env + ' nemá nastavené klíče' });
      // Příjemce si automatické potvrzování vypnul -> potvrzuje ručně. (Nepřipojený účet odmítne
      // až Finbricks chybou 10000 -> 'failed' níž.)
      if (!payee.on) {
        await sb.from('payment_pairings').update({ status: 'cancelled', tbl, row_id: id, last_error: 'payee turned pairing off' }).eq('id', p.id);
        return res.status(200).json({ ok: true, status: 'off' });
      }
      const finish = new Date(Date.now() + FINISH_DAYS * 86400e3).toISOString();
      const r = await fbxCall(C, 'POST', '/payment/pairing/schedule', { merchantId: C.merchant, payments: [{
        uniquePaymentPairingId: String(p.id),
        // Sandbox: 1 Kč -- stejně jako QR v Testovacím režimu (skutečný převod 1 Kč na připojený účet).
        amount: { value: C.sandbox ? Number(FBX_MAX_SANDBOX) : Number(p.amount), currency: 'CZK' },
        creditor: { accountIdentification: { value: iban(p.iban), type: 'IBAN' } },
        remittanceInformation: { structured: { reference: 'VS:' + String(p.id) } },
        finishPairingAt: finish,
      }] });
      const f = firstPay(r.data);
      // Co Finbricks vrací: dokumentace má u schedule `scheduleStatus` SCHEDULED / FAILED, ale
      // u /status píše, že schedule „vrací UNPAIRED", když platbu hned nenajde -- tedy
      // `paymentPairingStatus`. Přijaté je proto SCHEDULED, UNPAIRED i PAIRED; FAILED a chyba
      // (např. 10003 nepodporovaná banka) ne -> platba se potvrzuje ručně.
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

    // ── PŘIPOJENÍ ÚČTU K PÁROVÁNÍ (Nastavení plateb klubu / kouče / organizace) ───────────
    if (action === 'link_status' || action === 'link_banks' || action === 'link_start' || action === 'link_check') {
      const e = await entityOf(String(b.kind || ''), String(b.id || ''), me);
      if (!e) return res.status(403).json({ error: 'forbidden' });
      const C = await fbxNow();
      if (!C.ok) return res.status(500).json({ error: 'Finbricks ' + C.env + ' nemá nastavené klíče' });
      const key = { ent_kind: e.kind, ent_id: e.id, fbx_env: C.env };
      const cur = async () => (await sb.from('pairing_links').select('*').match(key).maybeSingle()).data;
      const psu = { ip: psuIpFrom(req), ua: req.headers['user-agent'] || 'MTL/1.0' };

      if (action === 'link_status') return res.status(200).json({ ok: true, env: C.env, ...linkView(await cur(), e) });

      if (action === 'link_check') {
        const l = await cur();
        if (!l) return res.status(200).json({ ok: true, env: C.env, ...linkView(null, e) });
        return res.status(200).json({ ok: true, env: C.env, ...linkView(await linkRefresh(l, psu), e) });
      }

      if (action === 'link_banks') {
        const r = await fbxCall(C, 'GET', `/status/bankInfo?merchantId=${encodeURIComponent(C.merchant)}&countryCode=CZ&enabledForMerchant=true`, null);
        if (!r.ok) return res.status(400).json({ error: 'Finbricks ' + r.status + ': ' + JSON.stringify(r.data || '').slice(0, 200) });
        // Banka výplatního účtu nahoru (podle kódu banky v IBANu -> BIC).
        const BIC = { '0100': 'KOMB', '0300': 'CEKO', '0600': 'AGBA', '0800': 'GIBA', '2010': 'FIOB', '2250': 'CTAS', '2700': 'BACX', '3030': 'AIRA', '5500': 'RZBC', '5800': 'JTBP', '6100': 'EQBK', '6210': 'BREX' };
        const mine = e.ibans.map((x) => BIC[x.slice(4, 8)]).filter(Boolean);
        const banks = (Array.isArray(r.data) ? r.data : []).filter((x) => x && x.paymentProvider && String(x.paymentProvider).toUpperCase() !== 'MOCK_COBS')
          .map((x) => ({ provider: x.paymentProvider, name: x.bankName || x.paymentProvider, logo: x.logoUrl ? (String(x.logoUrl).startsWith('http') ? x.logoUrl : (C.base.replace('api.', 'cdn.') + x.logoUrl)) : null,
            mine: mine.includes(String(x.bic || '').slice(0, 4).toUpperCase()) }))
          .sort((a, c) => (Number(c.mine) - Number(a.mine)) || a.name.localeCompare(c.name, 'cs'));
        return res.status(200).json({ ok: true, env: C.env, banks, need: e.ibans });
      }

      // link_start: přihlášení do banky (AISP = jen čtení pohybů), clientId = subjekt.
      const provider = String(b.provider || '').trim();
      if (!/^[A-Z0-9_]{2,50}$/.test(provider)) return res.status(400).json({ error: 'Vyber banku' });
      const clientId = e.kind + '-' + e.id;
      // POKUS (15. 10. 2026): Backoffice „Přidat účet" volá POST /backoffice/v3/merchants/{merchantId}/
      // bank-accounts/authenticate (s přihlášením uživatele Backoffice, Bearer) a jen takhle
      // připojený účet párování bere. Zkouší se, jestli ho brána vezme i s naším podpisem (JWS).
      // Odpověď se uloží do last_error, ať je vidět, co Finbricks řekl. Když ne -> AIS jako dosud.
      const bo = await fbxCall(C, 'POST', `/backoffice/v3/merchants/${encodeURIComponent(C.merchant)}/bank-accounts/authenticate`,
        { paymentProvider: provider }, { psuIp: psu.ip, psuUa: psu.ua, lang: 'cs' });
      const boNote = 'backoffice ' + bo.status + ' ' + JSON.stringify(bo.data || '').slice(0, 300);
      console.log('[pairing] backoffice authenticate', boNote);
      const viaBo = bo.ok && bo.data && bo.data.redirectUrl;
      const r = viaBo ? bo : await fbxCall(C, 'POST', '/v2/auth/authenticate', { merchantId: C.merchant, clientId, paymentProvider: provider, scope: 'AISP',
        callbackUrl: APP + '/?pairlink=' + encodeURIComponent(e.kind + '.' + e.id) }, { psuIp: psu.ip, psuUa: psu.ua, lang: 'cs' });
      if (!r.ok || !r.data || !r.data.redirectUrl) return res.status(400).json({ error: 'Finbricks: ' + JSON.stringify(r.data || { http: r.status }).slice(0, 300), backoffice: boNote });
      const prev = await cur();
      await sb.from('pairing_links').upsert({ ...key, client_id: viaBo ? 'backoffice' : clientId, provider, bank_name: String(b.bank_name || provider).slice(0, 80),
        // Obnova platného připojení: dokud se nevrátí z banky, staré platí dál.
        status: (prev && prev.status === 'active') ? 'active' : 'pending', last_error: boNote, updated_at: nowIso() }, { onConflict: 'ent_kind,ent_id,fbx_env' });
      return res.status(200).json({ ok: true, url: r.data.redirectUrl, via: viaBo ? 'backoffice' : 'ais', backoffice: boNote });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[pairing]', e && e.message);
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
