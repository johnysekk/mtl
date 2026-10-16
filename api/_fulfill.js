// ZAPLACENO -> ŘÁDEK V APPCE. Jediné místo, které po platbě kartou překlopí rezervaci, členství,
// lístek, zboží nebo doplatek na zaplacené. Dřív to po návratu ze Stripe dělal prohlížeč sám
// (update status:'active' / 'paid'), takže stačilo zavolat stejný zápis bez platby. Teď to dělá
// jen server a jen podle session, kterou Stripe potvrdil jako zaplacenou.
// Volá ho webhook (checkout.session.completed) i /api/session při návratu ze Stripe -- kdo dorazí
// první, zapíše; druhý nic nezmění (každý krok je podmíněný stavem, ze kterého se překlápí).
// Zápis transakce (recordTransaction) a notifikace zůstávají tam, kde byly.

import { pragueEndOfDay } from './_memb-term.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
const q = encodeURIComponent;

async function get(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H() }); return r.ok ? (await r.json()) : []; } catch (e) { return []; }
}
// PATCH s vrácením změněných řádků -- prázdné pole = nic se nezměnilo (už bylo zapsané).
async function patch(path, body) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...H(), Prefer: 'return=representation' }, body: JSON.stringify(body) });
    if (!r.ok) { console.error('[fulfill] patch', path.split('?')[0], r.status, (await r.text().catch(() => '')).slice(0, 200)); return []; }
    const j = await r.json().catch(() => []); return Array.isArray(j) ? j : [];
  } catch (e) { console.error('[fulfill] patch', e.message); return []; }
}
async function post(table, body) {
  try {
    const r = await fetch(`${SB}/rest/v1/${table}`, { method: 'POST', headers: { ...H(), Prefer: 'return=representation' }, body: JSON.stringify(body) });
    if (!r.ok) { console.error('[fulfill] post', table, r.status, (await r.text().catch(() => '')).slice(0, 200)); return null; }
    const j = await r.json().catch(() => []); return (Array.isArray(j) ? j[0] : j) || null;
  } catch (e) { console.error('[fulfill] post', e.message); return null; }
}
const idOf = (x) => (typeof x === 'string' ? x : (x && x.id)) || null;
export function sessionPaid(s) {
  return !!(s && s.status === 'complete' && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required'));
}

// s = Checkout Session (potvrzená Stripe), account = připojený účet (direct charge) nebo null.
// Vrací { kind, row?, rows?, created? } -- co se překlopilo (nebo co už překlopené bylo).
export async function fulfillCheckout(s, account, stripe) {
  if (!sessionPaid(s)) return { kind: null, skipped: 'not paid' };
  const m = s.metadata || {};
  const pi = idOf(s.payment_intent);
  const t = m.mtl_payment_type || '';

  // 1:1 LEKCE / ONLINE U KOUČE -- rezervace vzniká až tady (ne v prohlížeči).
  if (m.booking_type === 'inperson' || m.booking_type === 'online') {
    if (pi) { const ex = (await get(`bookings?payment_intent=eq.${q(pi)}&select=*&limit=1`))[0]; if (ex) return { kind: 'booking', row: ex }; }
    const amount = parseInt(m.base_amount || '0', 10) || 0, currency = m.booking_currency || 'CZK';
    const common = { student_id: m.student_id || null, coach_name: m.coach_name || 'Kouč', payment_intent: pi, amount, currency,
      discipline: m.discipline || null, student_name: m.student_name || null, paid_by: m.paid_by || null, paid_by_name: m.paid_by_name || null,
      minor_booking: !!(m.paid_by && m.student_id && m.paid_by !== m.student_id) };
    if (m.booking_type === 'inperson' && m.slot_id) {
      const slot = (await get(`slots?id=eq.${q(m.slot_id)}&select=*`))[0];
      if (!slot) return { kind: 'booking', skipped: 'slot not found' };
      await patch(`slots?id=eq.${q(slot.id)}`, { booked: true, student: m.student_id || null });
      const row = await post('bookings', { ...common, slot_id: slot.id, coach_id: slot.coach_profile_id, training_date: slot.date, training_time: slot.time,
        status: 'active', type: 'inperson', ...((Number(slot.capacity) || 1) > 1 ? { capacity: Number(slot.capacity) } : {}) });
      return { kind: 'booking', row, created: !!row, slot };
    }
    if (m.booking_type === 'online' && m.coach_profile_id) {
      const row = await post('bookings', { ...common, slot_id: null, coach_id: m.coach_profile_id, training_date: new Date().toISOString().slice(0, 10), training_time: null,
        status: 'active', type: 'online', online_format: m.online_fmt || null, qty: Math.max(1, parseInt(m.online_qty || '1', 10) || 1) });
      return { kind: 'booking', row, created: !!row };
    }
    return { kind: 'booking', skipped: 'incomplete metadata' };
  }

  // JEDNORÁZOVÝ VSTUP (i host bez účtu a vstup na recepci) -- rezervace čekala jako 'pending'.
  if (t === 'drop_in' && m.mtl_grace !== '1' && m.mtl_booking_id) {
    const cd = s.customer_details || {};
    const flt = `gym_bookings?id=eq.${q(m.mtl_booking_id)}` + (m.gym_id ? `&gym_id=eq.${q(m.gym_id)}` : '');
    const cur = (await get(`${flt}&select=id,student_id,status`))[0];
    if (!cur) return { kind: 'gym_booking', skipped: 'booking not found' };
    const body = { status: 'active', payment_intent: pi };
    if (!cur.student_id) { if (cd.email) body.guest_email = String(cd.email).trim().toLowerCase(); if (cd.name) { body.guest_name = cd.name; body.student_name = cd.name; } }
    const rows = await patch(`${flt}&status=in.(pending,reserved)`, body);
    const row = rows[0] || (await get(`${flt}&select=*`))[0];
    return { kind: 'gym_booking', row, created: !!rows.length };
  }

  // DOPLATEK ZA TOLEROVANÉ PŘÍCHODY -- vyrovná vyúčtované návštěvy toho člověka v tom klubu.
  if (t === 'drop_in' && m.mtl_grace === '1') {
    if (!m.gym_id || !m.student_id) return { kind: 'grace', skipped: 'no gym/student' };
    const rows = await patch(`grace_visits?gym_id=eq.${q(m.gym_id)}&student_id=eq.${q(m.student_id)}&settled=eq.false&settlement=eq.billed`,
      { settled: true, settlement: 'charged', settled_at: new Date().toISOString() });
    return { kind: 'grace', rows, created: !!rows.length };
  }

  // ZBOŽÍ -- objednávka vzniká až po zaplacení, cena a název ze zboží v databázi. Sklad se
  // odečte jen jednou (když objednávka opravdu vznikla).
  if (t === 'merch') {
    if (pi) { const ex = (await get(`merch_orders?stripe_ref=eq.${q(pi)}&select=*&limit=1`))[0]; if (ex) return { kind: 'merch', row: ex }; }
    const prod = m.mtl_merch_id ? (await get(`gym_merch?id=eq.${q(m.mtl_merch_id)}&select=*`))[0] : null;
    if (!prod) return { kind: 'merch', skipped: 'item not found' };
    const qty = Math.max(1, parseInt(m.mtl_qty || '1', 10) || 1);
    let buyer = '';
    try { if (m.student_id) buyer = ((await get(`profiles?id=eq.${q(m.student_id)}&select=name`))[0] || {}).name || ''; } catch (e) {}
    const row = await post('merch_orders', { gym_id: m.gym_id || prod.gym_id || null, coach_id: prod.coach_id || null, merch_id: prod.id, student_id: m.student_id || null,
      item_name: prod.name, qty, variant: m.mtl_variant || null, amount: (Number(prod.price) || 0) * qty, currency: prod.currency || 'CZK', status: 'paid',
      buyer_name: buyer || null, category: prod.category || null, stripe_ref: pi, attr_src: m.mtl_attr || null });
    if (row && prod.stock != null) await patch(`gym_merch?id=eq.${q(prod.id)}`, { stock: Math.max(0, (Number(prod.stock) || 0) - qty) });
    return { kind: 'merch', row, created: !!row, item: prod };
  }

  // ČLENSTVÍ / PERMANENTKA (jednorázově na N měsíců i předplatné).
  if (t === 'membership' && m.membership_id) {
    const flt = `gym_memberships?id=eq.${q(m.membership_id)}`;
    if (m.mtl_membership_kind === 'one_time') {
      const mo = Math.max(1, parseInt(m.mtl_months || '1', 10) || 1);
      let end = new Date(); end.setMonth(end.getMonth() + mo);
      if (m.mtl_ends_on) { const fx = pragueEndOfDay(m.mtl_ends_on); if (!isNaN(fx.getTime()) && fx > new Date()) end = fx; }
      const rows = await patch(`${flt}&status=not.in.(active,cancelling)`, { status: 'active', payment_status: 'paid', months: mo, period_end: end.toISOString(), cancelled_at: null });
      return { kind: 'membership', row: rows[0] || (await get(`${flt}&select=*`))[0], created: !!rows.length };
    }
    const sub = idOf(s.subscription);
    let periodEnd = null;
    try { if (sub && stripe) { const so = await stripe.subscriptions.retrieve(sub, account ? { stripeAccount: account } : undefined);
      const cpe = so && (so.current_period_end || (so.items && so.items.data && so.items.data[0] && so.items.data[0].current_period_end));
      if (cpe) periodEnd = new Date(cpe * 1000).toISOString(); } } catch (e) { console.error('[fulfill] period_end', e.message); }
    const rows = await patch(`${flt}&status=not.in.(active,cancelling)`, { status: 'active', ...(sub ? { stripe_subscription: sub } : {}), ...(periodEnd ? { period_end: periodEnd } : {}) });
    // Už aktivní (druhý průchod): jen doplnit předplatné, když chybí.
    if (!rows.length && sub) await patch(`${flt}&stripe_subscription=is.null`, { stripe_subscription: sub, ...(periodEnd ? { period_end: periodEnd } : {}) });
    return { kind: 'membership', row: rows[0] || (await get(`${flt}&select=*`))[0], created: !!rows.length };
  }

  // LÍSTKY NA AKCI -- celá objednávka naráz (víc lístků na jednu platbu).
  if (t === 'event_ticket' && m.ticket_id) {
    let scope = `id=eq.${q(m.ticket_id)}`;
    const t0 = (await get(`event_tickets?id=eq.${q(m.ticket_id)}&select=order_id`))[0];
    if (t0 && t0.order_id) scope = `order_id=eq.${q(t0.order_id)}`;
    const rows = await patch(`event_tickets?${scope}&status=neq.paid`, { status: 'paid', stripe_ref: pi });
    const all = await get(`event_tickets?${scope}&select=*`);
    return { kind: 'event_ticket', rows: all, row: all.find((x) => String(x.id) === String(m.ticket_id)) || all[0] || null, created: !!rows.length };
  }
  return { kind: null };
}
