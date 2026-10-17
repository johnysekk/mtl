// POZASTAVENÍ A VÝMAZ ÚČTU / PROFILU -- společná logika (sql/entity-close.sql).
// Používá api/entity-close.js (žádost, obnova, pozastavení, náhled) a api/entity-close-cron.js
// (po 30 dnech: vypořádání a výmaz) a platební endpointy (saleBlocked: nic nového se neprodá).
//
// Druhy (kind): 'account' (celý účet, id = uživatel), 'coach' (profil kouče, id = uživatel),
// 'gym' (klub), 'org' (organizace i dodavatel).
// Vypořádání (mode): 'refund' = co platí až po datu výmazu, se vrátí (100 % nevyčerpané části),
// 'fulfil' = poskytovatel to splní mimo aplikaci, peníze se nevrací.
import Stripe from 'stripe';
import { feeRefundableForPI } from './_fee-window.js';

export const CLOSE_DAYS = 30;
const DAY = 86400000;
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
export const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const BANK = ['qr', 'pis', 'cash', 'transfer'];

export async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}) } });
  if (!r.ok) throw new Error(`SB ${r.status} ${(await r.text().catch(() => '')).slice(0, 240)}`);
  if (r.status === 204) return null;
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
export const get = (p) => sb(p).catch(() => []);
export const one = async (p) => ((await get(p)) || [])[0] || null;
export const patch = (p, body) => sb(p, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(body) });

export async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim(); if (!tok) return null;
  try { const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null; const u = await r.json(); return (u && u.id) || null; } catch (e) { return null; }
}

// ── NOVÝ PRODEJ U POZASTAVENÉHO / RUŠENÉHO POSKYTOVATELE ─────────────────────────────────
// null = prodává, jinak důvod. Chyba databáze prodej nezastaví (stejně jako kontrola ceny).
export async function saleBlocked({ gymId, coachId, orgId, eventId } = {}) {
  try {
    if (!SB || !KEY) return null;
    const r = await fetch(`${SB}/rest/v1/rpc/mtl_sale_blocked`, { method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_gym: gymId || null, p_coach: coachId || null, p_org: orgId || null, p_event: eventId || null }) });
    if (!r.ok) return null;
    const v = await r.json();
    return (typeof v === 'string' && v) ? v : null;
  } catch (e) { return null; }
}
export const SALE_BLOCKED_MSG = 'Tenhle poskytovatel teď v MTL nic neprodává (pozastavil nebo ruší profil).';
export const SALE_BLOCKED_MSG_EN = 'This provider is not selling anything in MTL right now (paused or closing).';

// ── ENTITA ────────────────────────────────────────────────────────────────────────────────
export async function loadEntity(kind, id) {
  if (!id) return null;
  if (kind === 'gym') {
    const g = await one(`gyms?id=eq.${q(id)}&select=id,name,owner_id,stripe_account,currency,deleted_at,paused_at,paused_by,close_mode,close_settled_at,purged_at`);
    return g && { kind, id: g.id, name: g.name || 'Klub', owner: g.owner_id, acct: g.stripe_account || null, closingAt: g.deleted_at, pausedAt: g.paused_at, pausedBy: g.paused_by, mode: g.close_mode, settledAt: g.close_settled_at, row: g };
  }
  if (kind === 'org') {
    const o = await one(`organizations?id=eq.${q(id)}&select=id,name,owner_id,kind,supplier_sub,stripe_account,deleted_at,paused_at,paused_by,close_mode,close_settled_at,purged_at`)
      || await one(`organizations?id=eq.${q(id)}&select=id,name,owner_id,kind,supplier_sub,deleted_at,paused_at,paused_by,close_mode,close_settled_at,purged_at`);
    return o && { kind, id: o.id, name: o.name || 'Organizace', owner: o.owner_id, acct: o.stripe_account || null, closingAt: o.deleted_at, pausedAt: o.paused_at, pausedBy: o.paused_by, mode: o.close_mode, settledAt: o.close_settled_at, row: o };
  }
  const p = await one(`profiles?id=eq.${q(id)}&select=id,name,email,lang,coach_status,stripe_account,gym_payout_account,partner_sub,deleted_at,deactivated_at,close_mode,coach_closing_at,coach_paused_at,coach_paused_by,coach_close_mode,coach_close_settled_at`);
  if (!p) return null;
  if (kind === 'coach') return { kind, id: p.id, name: p.name || 'Kouč', owner: p.id, acct: p.stripe_account || null, closingAt: p.coach_closing_at, pausedAt: p.coach_paused_at, pausedBy: p.coach_paused_by, mode: p.coach_close_mode, settledAt: p.coach_close_settled_at, row: p };
  return { kind: 'account', id: p.id, name: p.name || '', owner: p.id, acct: null, closingAt: p.deleted_at, pausedAt: p.deactivated_at, mode: p.close_mode, row: p };
}

// Co uživateli patří (pro výmaz / pozastavení celého účtu). Klub se spolumajitelem nejde zrušit
// spolu s účtem -- nejdřív převod vlastnictví (nebo zrušit klub zvlášť a nechat ho dojet).
export async function ownedEntities(uid) {
  const out = [];
  const p = await one(`profiles?id=eq.${q(uid)}&select=id,coach_status`);
  if (p && (p.coach_status === 'approved')) out.push({ kind: 'coach', id: uid });
  ((await get(`gyms?owner_id=eq.${q(uid)}&purged_at=is.null&select=id,name`)) || []).forEach((g) => out.push({ kind: 'gym', id: g.id, name: g.name }));
  ((await get(`organizations?owner_id=eq.${q(uid)}&select=id,name,purged_at`)) || []).filter((o) => !o.purged_at).forEach((o) => out.push({ kind: 'org', id: o.id, name: o.name }));
  return out;
}
export async function coOwnersOf(gymId) {
  return (await get(`gym_coaches?gym_id=eq.${q(gymId)}&status=eq.active&co_owner=eq.true&select=coach_id`)) || [];
}

// ── PENÍZE K ŘÁDKU ────────────────────────────────────────────────────────────────────────
// Kolik se za to zaplatilo (v haléřích, bez už vráceného) a jak: karta (payment intent na účtu
// poskytovatele) nebo převod / hotovost (vrací poskytovatel sám).
async function paidFor({ pi, sourceId, fallbackMajor }) {
  let tx = null;
  if (pi && !String(pi).startsWith('pis')) tx = await one(`transactions?payment_intent=eq.${q(pi)}&select=id,gross_amount,refund_amount,payment_method,payment_intent,payee_account,currency&limit=1`);
  if (!tx && sourceId != null) tx = await one(`transactions?source_booking_id=eq.${q(sourceId)}&select=id,gross_amount,refund_amount,payment_method,payment_intent,payee_account,currency&order=created_at.desc&limit=1`);
  // Vrací se jen to, co MTL opravdu eviduje jako přijaté (transakce). Nepotvrzený převod nebo
  // částka z rezervace bez platby se nevrací -- poskytovatel by vracel peníze, které nedostal.
  const gross = tx ? Math.max(0, (Number(tx.gross_amount) || 0) - (Number(tx.refund_amount) || 0)) : 0;
  const card = !!(tx && tx.payment_intent && !String(tx.payment_intent).startsWith('pis') && !BANK.includes(String(tx.payment_method || '')));
  return { tx, gross, card, pi: (tx && tx.payment_intent) || pi || null, acct: (tx && tx.payee_account) || null, currency: (tx && tx.currency) || null };
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const fmt = (minor, cur, en) => (Math.round(minor) / 100).toLocaleString(en ? 'en-GB' : 'cs-CZ', { maximumFractionDigits: 2 }) + ' ' + (String(cur || 'CZK').toUpperCase() === 'CZK' && !en ? 'Kč' : String(cur || 'CZK').toUpperCase());
export { fmt };

// ── CO PLATÍ AŽ PO DATU VÝMAZU ────────────────────────────────────────────────────────────
// Položky: { type, table, rowId, studentId, who, label, refund (haléře), currency, method
// 'card' | 'bank' | 'manual', pi, acct, sub }. 'manual' = kurz / poplatek organizace: částku
// nejde spočítat spolehlivě, vypořádá poskytovatel sám (dostane seznam).
export async function obligations(ent, deleteAt) {
  const D = new Date(deleteAt).getTime(), Dd = ymd(D), out = [];
  const cur0 = (ent.row && ent.row.currency) || 'CZK';
  const push = (x) => { if (x.refund > 0 || x.method === 'manual') out.push(x); };

  // Jednorázové vstupy klubu na termín po datu výmazu.
  if (ent.kind === 'gym') {
    for (const b of ((await get(`gym_bookings?gym_id=eq.${q(ent.id)}&status=in.(active,paid_claimed)&class_date=gt.${Dd}&select=id,student_id,student_name,child_name,guest_email,class_name,class_date,class_time,amount,currency,payment_intent,payment_method`)) || [])) {
      const m = await paidFor({ pi: BANK.includes(String(b.payment_method || '')) ? null : b.payment_intent, sourceId: b.id, fallbackMajor: b.amount });
      push({ type: 'dropin', table: 'gym_bookings', rowId: b.id, studentId: b.student_id, who: b.child_name || b.student_name || b.guest_email || '—',
        label: `${b.class_name || 'Vstup'} ${b.class_date}${b.class_time ? ' ' + String(b.class_time).slice(0, 5) : ''}`, refund: m.gross, currency: m.currency || b.currency || cur0,
        method: m.card ? 'card' : 'bank', pi: m.pi, acct: m.acct || ent.acct });
    }
  }
  // Soukromé lekce kouče po datu výmazu + online zpětná vazba, která ještě nebyla dodaná.
  if (ent.kind === 'coach') {
    const rows = (await get(`bookings?coach_id=eq.${q(ent.id)}&status=eq.active&select=id,student_id,student_name,type,training_date,training_time,amount,currency,payment_intent,payment_method,online_format`)) || [];
    for (const b of rows.filter((r) => r.type === 'online' || (r.training_date && String(r.training_date) > Dd))) {
      const m = await paidFor({ pi: BANK.includes(String(b.payment_method || '')) ? null : b.payment_intent, sourceId: b.id, fallbackMajor: b.amount });
      push({ type: b.type === 'online' ? 'online' : 'private', table: 'bookings', rowId: b.id, studentId: b.student_id, who: b.student_name || '—',
        label: b.type === 'online' ? `Online · ${b.online_format || 'zpětná vazba'}` : `Lekce 1:1 ${b.training_date}${b.training_time ? ' ' + String(b.training_time).slice(0, 5) : ''}`,
        refund: m.gross, currency: m.currency || b.currency || cur0, method: m.card ? 'card' : 'bank', pi: m.pi, acct: m.acct || (ent.row && ent.row.stripe_account) });
    }
  }
  // Členství / permanentky / online předplatné: poměrná část za dobu po datu výmazu.
  {
    const f = ent.kind === 'gym' ? `gym_id=eq.${q(ent.id)}` : ent.kind === 'coach' ? `coach_id=eq.${q(ent.id)}&gym_id=is.null` : null;
    if (f) {
      for (const mb of ((await get(`gym_memberships?${f}&status=in.(active,cancelling)&period_end=gt.${q(new Date(D).toISOString())}&select=id,student_id,student_name,child_name,plan_name,amount,currency,created_at,period_end,months,stripe_subscription,paid_to,coach_id,gym_id`)) || [])) {
        // Platba právě za TOHLE členství: podle zdrojového řádku; jinak poslední platba za členství,
        // ale jen když má student u poskytovatele jediné členství (jinak by se jedna platba vracela
        // dvakrát -- rodič se dvěma dětmi). Nejde-li to určit, vypořádá to poskytovatel sám.
        const _sel = 'select=id,gross_amount,refund_amount,payment_method,payment_intent,payee_account,currency,created_at';
        let tx = await one(`transactions?source_booking_id=eq.${q(mb.id)}&type=eq.membership&order=created_at.desc&limit=1&${_sel}`);
        if (!tx) {
          const sib = (await get(`gym_memberships?student_id=eq.${q(mb.student_id)}&${f}&status=in.(active,cancelling)&select=id`)) || [];
          if (sib.length === 1) tx = await one(`transactions?member_id=eq.${q(mb.student_id)}&type=eq.membership&${ent.kind === 'gym' ? `gym_id=eq.${q(ent.id)}` : `coach_id=eq.${q(ent.id)}`}&order=created_at.desc&limit=1&${_sel}`);
        }
        if (!tx) { out.push({ type: 'membership', table: 'gym_memberships', rowId: mb.id, studentId: mb.student_id, who: mb.child_name || mb.student_name || '—', label: `${mb.plan_name || 'Členství'} (do ${String(mb.period_end).slice(0, 10)})`, refund: 0, currency: mb.currency || cur0, method: 'manual', sub: mb.stripe_subscription || null }); continue; }
        const gross = Math.max(0, (Number(tx.gross_amount) || 0) - (Number(tx.refund_amount) || 0));
        const end = new Date(mb.period_end).getTime();
        const start = tx ? new Date(tx.created_at).getTime() : Math.max(new Date(mb.created_at).getTime(), end - (parseInt(mb.months, 10) || 1) * 30 * DAY);
        const frac = end > start ? Math.min(1, Math.max(0, (end - D) / (end - start))) : 0;
        const card = !!(tx && tx.payment_intent && !String(tx.payment_intent).startsWith('pis') && !BANK.includes(String(tx.payment_method || '')));
        push({ type: 'membership', table: 'gym_memberships', rowId: mb.id, studentId: mb.student_id, who: mb.child_name || mb.student_name || '—',
          label: `${mb.plan_name || 'Členství'} (do ${String(mb.period_end).slice(0, 10)})`, refund: Math.round(gross * frac), currency: (tx && tx.currency) || mb.currency || cur0,
          method: card ? 'card' : 'bank', pi: tx && tx.payment_intent, acct: (tx && tx.payee_account) || ent.acct || (ent.row && ent.row.gym_payout_account), sub: mb.stripe_subscription || null });
      }
    }
  }
  // Vstupenky na akce po datu výmazu.
  {
    const ef = ent.kind === 'gym' ? `gym_id=eq.${q(ent.id)}` : ent.kind === 'org' ? `organization_id=eq.${q(ent.id)}`
      : ent.kind === 'coach' ? `created_by=eq.${q(ent.id)}&gym_id=is.null&organization_id=is.null` : null;
    if (ef) {
      const evs = (await get(`events?${ef}&starts_at=gt.${q(new Date(D).toISOString())}&select=id,title,starts_at`)) || [];
      for (const ev of evs) {
        for (const t of ((await get(`event_tickets?event_id=eq.${q(ev.id)}&status=in.(paid,paid_claimed)&select=*`)) || [])) {
          const isCard = !!(t.stripe_ref && !BANK.includes(String(t.payment_method || '')));
          const m = await paidFor({ pi: isCard ? t.stripe_ref : null, sourceId: t.id, fallbackMajor: t.amount });
          // U objednávky s víc lístky má platba víc položek -- vrací se cena lístku, ne celá platba.
          const one1 = m.tx ? (Math.round((Number(t.amount) || 0) * 100) || m.gross) : 0;
          push({ type: 'ticket', table: 'event_tickets', rowId: t.id, studentId: t.buyer_id, who: t.buyer_name || t.buyer_email || '—', label: `${ev.title || 'Akce'} ${String(ev.starts_at).slice(0, 10)}`,
            refund: Math.min(one1, m.gross || one1), currency: m.currency || t.currency || cur0, method: isCard ? 'card' : 'bank', pi: m.pi, acct: m.acct || ent.acct });
        }
      }
    }
  }
  // Kurzy, které běží i po datu výmazu: vypořádá klub sám (dostane seznam účastníků).
  if (ent.kind === 'gym') {
    const cos = (await get(`gym_cohorts?gym_id=eq.${q(ent.id)}&end_date=gt.${Dd}&select=id,name,end_date,status`)) || [];
    for (const c of cos.filter((x) => !['cancelled', 'draft'].includes(String(x.status || '')))) {
      for (const cm of ((await get(`cohort_members?cohort_id=eq.${q(c.id)}&status=in.(enrolled,deposit_paid,deposit_claimed,active)&select=id,student_id,name,email`)) || [])) {
        out.push({ type: 'course', table: 'cohort_members', rowId: cm.id, studentId: cm.student_id, who: cm.name || cm.email || '—', label: `Kurz ${c.name || ''} (do ${c.end_date})`,
          refund: 0, currency: cur0, method: 'manual' });
      }
    }
  }
  return out;
}

export function summarize(items) {
  const s = { count: items.length, students: new Set(items.map((i) => i.studentId || i.who)).size, card: {}, bank: {}, manual: 0, byType: {} };
  items.forEach((i) => {
    s.byType[i.type] = (s.byType[i.type] || 0) + 1;
    if (i.method === 'manual') { s.manual++; return; }
    const bucket = i.method === 'card' ? s.card : s.bank;
    bucket[i.currency] = (bucket[i.currency] || 0) + i.refund;
  });
  return s;
}

// Běžící předplatná, která se po žádosti o výmaz nemají obnovovat (karta, účet poskytovatele).
export async function subscriptionsOf(ent) {
  const out = [];
  if (ent.kind === 'gym' || ent.kind === 'coach') {
    const f = ent.kind === 'gym' ? `gym_id=eq.${q(ent.id)}` : `coach_id=eq.${q(ent.id)}&gym_id=is.null`;
    for (const mb of ((await get(`gym_memberships?${f}&status=in.(active,cancelling)&stripe_subscription=not.is.null&select=id,student_id,stripe_subscription,paid_to,coach_id`)) || [])) {
      let acct = ent.acct;
      if (mb.paid_to === 'coach' && mb.coach_id) { const cp = await one(`profiles?id=eq.${q(mb.coach_id)}&select=gym_payout_account,stripe_account`); acct = (cp && (ent.kind === 'coach' ? cp.stripe_account : cp.gym_payout_account)) || acct; }
      if (ent.kind === 'coach') acct = acct || (ent.row && ent.row.stripe_account);
      out.push({ sub: mb.stripe_subscription, acct, membership: mb.id, studentId: mb.student_id });
    }
  }
  if (ent.kind === 'org' && ent.row && ent.row.supplier_sub) out.push({ sub: ent.row.supplier_sub, acct: null, platform: true });
  if (ent.kind === 'account') {
    if (ent.row && ent.row.partner_sub) out.push({ sub: ent.row.partner_sub, acct: null, platform: true });
    // Vlastní členství jako zákazník u jiných klubů (karta) -- po smazání účtu se nesmí dál strhávat.
    for (const mb of ((await get(`gym_memberships?student_id=eq.${q(ent.id)}&status=in.(active,cancelling)&stripe_subscription=not.is.null&select=id,gym_id,coach_id,paid_to,stripe_subscription`)) || [])) {
      let acct = null;
      if (mb.gym_id) { const g = await one(`gyms?id=eq.${q(mb.gym_id)}&select=stripe_account`); acct = g && g.stripe_account; }
      if (mb.paid_to === 'coach' && mb.coach_id) { const cp = await one(`profiles?id=eq.${q(mb.coach_id)}&select=gym_payout_account,stripe_account`); acct = (cp && (mb.gym_id ? cp.gym_payout_account : cp.stripe_account)) || acct; }
      out.push({ sub: mb.stripe_subscription, acct, membership: mb.id, own: true });
    }
  }
  return out;
}

// cancel_at_period_end = true / false; vrací seznam předplatných, která se opravdu přepnula.
export async function setRenew(subs, stop) {
  const done = [];
  if (!stripe) return done;
  for (const s of subs) {
    try {
      const opt = s.acct ? { stripeAccount: s.acct } : undefined;
      const cur = await stripe.subscriptions.retrieve(s.sub, opt);
      if (!cur || ['canceled', 'incomplete_expired'].includes(cur.status)) continue;
      if (!!cur.cancel_at_period_end === !!stop) continue;
      await stripe.subscriptions.update(s.sub, { cancel_at_period_end: !!stop }, opt);
      done.push(s);
    } catch (e) { console.error('[entity-close] renew', s.sub, e.message); }
  }
  return done;
}
export async function cancelNow(subs) {
  if (!stripe) return;
  for (const s of subs) {
    try { await stripe.subscriptions.cancel(s.sub, {}, s.acct ? { stripeAccount: s.acct } : undefined); } catch (e) {}
  }
}

export async function notify(userId, cs, en, data) {
  if (!userId) return;
  try {
    const p = await one(`profiles?id=eq.${q(userId)}&select=lang`);
    await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id: userId, type: 'system', read: false,
      data: JSON.stringify(Object.assign({ msg_cs: cs, msg_en: en }, data)), message: (p && p.lang === 'en') ? en : cs }) });
  } catch (e) { console.error('[entity-close] notify', e.message); }
}
export async function log(row) {
  try { await sb('entity_close_log', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(row) }); } catch (e) { console.error('[entity-close] log', e.message); }
}
export async function founderId() {
  const f = (process.env.FOUNDER_UUID || '').trim();
  if (f) return f;
  const p = await one(`profiles?role=eq.founder&select=id&limit=1`);
  return p && p.id;
}

// ── VYPOŘÁDÁNÍ V DEN VÝMAZU ───────────────────────────────────────────────────────────────
// refund: karta se vrací automaticky z účtu poskytovatele, převod / hotovost vrací poskytovatel
// (dostane seznam), kurzy a poplatky organizacím vypořádá sám. fulfil: nic se nevrací, řádky
// zůstávají (poskytovatel je splní mimo aplikaci).
// opts.keepRenew: poskytovatel si automatické obnovy zákazníků nechal běžet a řeší je ve svém
// Stripe účtu -- členství s předplatným se nevrací ani neruší, jen se odpojí od MTL (bez provize).
export async function settle(ent, deleteAt, opts = {}) {
  // Předplatná se sesbírají PŘEDEM -- po vypořádání jsou řádky členství 'ended' a už by se nenašla.
  const subs = await subscriptionsOf(ent);
  const keep = !!opts.keepRenew;
  const items = (await obligations(ent, deleteAt)).filter((it) => !(keep && it.table === 'gym_memberships' && it.sub));
  const res = { card: [], bank: [], manual: [], errors: [] };
  const name = ent.name;
  for (const it of items) {
    const money = fmt(it.refund, it.currency);
    if (ent.mode !== 'refund') continue;
    if (it.method === 'manual') { res.manual.push(it); continue; }
    // JEDNOU A DOST. Vrácení se zapíše do knihy (entity_close_log) hned po úspěchu; další běh cronu
    // ho podle ní přeskočí, i kdyby se nepovedlo přepsat řádek. Stripe navíc dostane idempotentní klíč.
    const key = `close:${it.table}:${it.rowId}`;
    const done = await one(`entity_close_log?kind=eq.${q(ent.kind)}&entity_id=eq.${q(ent.id)}&action=eq.refund&reason_key=eq.${q(key)}&select=id&limit=1`);
    if (done) continue;
    if (it.method === 'card' && it.pi && it.acct && stripe) {
      let rf = null;
      try {
        rf = await stripe.refunds.create({ payment_intent: it.pi, amount: it.refund, refund_application_fee: await feeRefundableForPI(it.pi) }, { stripeAccount: it.acct, idempotencyKey: key });
      } catch (e) {
        console.error('[entity-close] refund', key, e.message);
        res.errors.push(Object.assign({ error: String(e.message || e).slice(0, 160) }, it));
        continue;
      }
      await log({ kind: ent.kind, entity_id: String(ent.id), action: 'refund', reason_key: key, meta: { refund: rf && rf.id, amount: it.refund, currency: it.currency, method: 'card' } });
      res.card.push(it);
      await notify(it.studentId, `↩️ ${name} ukončil činnost v MTL. Za „${it.label}" ti vracíme ${money} na kartu — na účtu bývá do 5–10 dnů.`,
        `↩️ ${name} has left MTL. We are refunding ${money} for "${it.label}" to your card — it usually arrives within 5–10 days.`, { kind: 'provider_closed', go: 'bookings' });
    } else {
      await log({ kind: ent.kind, entity_id: String(ent.id), action: 'refund', reason_key: key, meta: { amount: it.refund, currency: it.currency, method: 'bank' } });
      res.bank.push(it);
      await notify(it.studentId, `↩️ ${name} ukončil činnost v MTL. Za „${it.label}" ti ${name} vrátí ${money} převodem. Kdyby se to nestalo, napiš nám přes Podporu.`,
        `↩️ ${name} has left MTL. ${name} will transfer ${money} back to you for "${it.label}". If that does not happen, contact us via Support.`, { kind: 'provider_closed', go: 'bookings' });
    }
    // Stav řádku zvlášť: když se nepovede, peníze už jsou vrácené a kniha to drží.
    try {
      const nowIso = new Date().toISOString();
      if (it.table === 'gym_bookings') await patch(`gym_bookings?id=eq.${q(it.rowId)}`, { status: 'cancelled', club_cancelled_at: nowIso, club_cancel_choice: 'refund' });
      else if (it.table === 'bookings') await patch(`bookings?id=eq.${q(it.rowId)}`, { status: 'cancelled' });
      else if (it.table === 'event_tickets') await patch(`event_tickets?id=eq.${q(it.rowId)}`, { status: 'refunded' });
      else if (it.table === 'gym_memberships') await patch(`gym_memberships?id=eq.${q(it.rowId)}`, { status: 'ended', cancelled_at: nowIso, period_end: new Date(deleteAt).toISOString() });
    } catch (e) { console.error('[entity-close] row', key, e.message); }
  }
  // Předplatná: zrušit hned (obnova už byla vypnutá při žádosti) -- nebo, když si je poskytovatel
  // nechal, odpojit od MTL: bez provize MTL a bez vazby na členství v appce (webhook je už nenajde).
  if (keep) {
    await cancelNow(subs.filter((x) => !x.studentId));
    for (const x of subs.filter((y) => y.studentId)) {
      try { if (stripe && x.acct) await stripe.subscriptions.update(x.sub, { application_fee_percent: 0 }, { stripeAccount: x.acct }); } catch (e) { console.error('[entity-close] detach fee', x.sub, e.message); }
      try { if (x.membership) await patch(`gym_memberships?id=eq.${q(x.membership)}`, { stripe_subscription: null, status: 'ended', cancelled_at: new Date().toISOString() }); } catch (e) {}
    }
  } else await cancelNow(subs);
  return res;
}
