// /api/pis-webhook.js — Enable Banking payment-status webhook (the reliable async confirmation).
// Enable signs the webhook with a JWT: header {alg:RS256, x5u:<https url to X.509 pubkey on enablebanking.com>},
// payload { sub:<appId>, environment:'PRODUCTION'|'SANDBOX', msgi:'sha256-<base64 digest of the raw body>' }.
// Handler MUST verify: (1) x5u is https + enablebanking.com host, (2) JWT signature against that cert,
// (3) msgi matches the sha256 of the raw request body, (4) sub === our app id.
//
// IMPORTANT (Vercel): msgi is computed over the RAW body bytes, so disable JSON body-parsing for this route:
//   export const config = { api: { bodyParser: false } };
// and read the raw body yourself (below). Then JSON.parse it after verification.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const APP_ID = process.env.ENABLE_APP_ID;
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const APP_URL = process.env.APP_URL || 'https://app.martialtraininglab.com';

// Mirror Stripe on PIS confirm: record the transaction (dashboard + commission) via the shared
// record-cash logic (single source of truth), idempotently, then notify the gym owner.
async function pisSideEffects(rec, tbl) {
  const _coach1 = (tbl === 'bookings');
  const _event  = (tbl === 'event_tickets');
  // events: derive the payee (coach if the event has a payout coach, else the gym) — mirrors _evtQrConfirm
  let _evProvider = 'gym', _evGym = null, _evCoach = null;
  if (_event) {
    try { const ev = await sb.from('events').select('gym_id,payout_coach_id').eq('id', rec.event_id).maybeSingle();
      if (ev.data) { if (ev.data.payout_coach_id) { _evProvider = 'coach'; _evCoach = ev.data.payout_coach_id; } else { _evGym = ev.data.gym_id; } } } catch (e) {}
  }
  const _cohort = (tbl === 'cohort_members');
  let _cohGym = null, _cohDep = 0, _cohCur = 'CZK';
  if (_cohort) {
    try { const co = await sb.from('gym_cohorts').select('gym_id,deposit_amount,currency').eq('id', rec.cohort_id).maybeSingle();
      if (co.data) { _cohGym = co.data.gym_id; _cohDep = co.data.deposit_amount || 0; _cohCur = co.data.currency || 'CZK'; } } catch (e) {}
  }
  try {
    const ex = await sb.from('transactions').select('id').eq('source_booking_id', rec.id).limit(1);
    if (!(ex.data && ex.data.length)) {
      const _body = _event
        ? { internal: true, intSecret: process.env.PIS_INTERNAL_SECRET, provider: _evProvider, gym_id: _evGym, coach_id: _evCoach, member_id: rec.buyer_id || null, gross_amount: Math.round((rec.amount || 0) * 100), currency: rec.currency || 'CZK', type: 'event_ticket', payment_method: 'pis', acq_source: 'direct', source_booking_id: rec.id }
        : _coach1
        ? { internal: true, intSecret: process.env.PIS_INTERNAL_SECRET, provider: 'coach', coach_id: rec.coach_id, member_id: rec.student_id || null, gross_amount: Math.round((rec.amount || 0) * 100), currency: rec.currency || 'CZK', type: 'coach_1to1', payment_method: 'pis', acq_source: rec.acq_source || 'direct', source_booking_id: rec.id }
        : _cohort
        ? { internal: true, intSecret: process.env.PIS_INTERNAL_SECRET, provider: 'gym', gym_id: _cohGym, member_id: rec.student_id || null, gross_amount: Math.round(_cohDep * 100), currency: _cohCur, type: 'course', payment_method: 'pis', cash_payer_name: rec.name || null, acq_source: rec.attribution || 'direct', source_booking_id: rec.id }
        : { internal: true, intSecret: process.env.PIS_INTERNAL_SECRET, provider: 'gym', gym_id: rec.gym_id, coach_id: rec.coach_id || null, member_id: rec.student_id || null, gross_amount: Math.round((rec.amount || 0) * 100), type: (tbl === 'gym_memberships' ? 'membership' : 'drop_in'), payment_method: 'pis', acq_source: rec.acq_source || 'direct', source_booking_id: rec.id };
      await fetch(APP_URL + '/api/record-cash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_body) });
    }
  } catch (e) { /* non-fatal */ }
  // events: fire the ticket email (same as the manual confirm)
  if (_event) { try { await fetch(APP_URL + '/api/ticket-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticketId: rec.id }) }); } catch (e) {} }
  try {
    if (_event) {
      const organizer = (_evProvider === 'coach') ? _evCoach : null;
      let target = organizer;
      if (!target && _evGym) { const g = await sb.from('gyms').select('owner_id').eq('id', _evGym).maybeSingle(); target = g.data && g.data.owner_id; }
      if (target) await sb.from('notifications').insert({ user_id: target, type: 'booking', read: false, message: '\ud83c\udf9f\ufe0f Nov\u00fd prodej vstupenky (p\u0159evodem): ' + (rec.buyer_name || 'Z\u00e1kazn\u00edk'), data: JSON.stringify({ kind: 'pis_payment_in', event_id: rec.event_id }) });
    } else if (_coach1) {
      await sb.from('notifications').insert({ user_id: rec.coach_id, type: 'booking', read: false, message: '\ud83d\udcb3 Nov\u00e1 1:1 platba (p\u0159evodem)', data: JSON.stringify({ kind: 'pis_payment_in', coach_id: rec.coach_id, booking_id: rec.id }) });
    } else if (_cohort) {
      if (_cohGym) { const g = await sb.from('gyms').select('owner_id').eq('id', _cohGym).maybeSingle(); const ownerId = g.data && g.data.owner_id; if (ownerId) await sb.from('notifications').insert({ user_id: ownerId, type: 'booking', read: false, message: '\ud83c\udf93 Nov\u00e1 z\u00e1loha kurzu (p\u0159evodem): ' + (rec.name || 'Z\u00e1jemce'), data: JSON.stringify({ kind: 'pis_payment_in', cohort_id: rec.cohort_id }) }); }
    } else {
      const g = await sb.from('gyms').select('owner_id').eq('id', rec.gym_id).maybeSingle();
      const ownerId = g.data && g.data.owner_id;
      if (ownerId) {
        const what = (tbl === 'gym_memberships') ? (rec.plan_name || 'permanentka') : (rec.class_name || 'drop-in');
        const who = rec.student_name || 'Student';
        const msg = (tbl === 'gym_memberships') ? ('\ud83c\udf9f\ufe0f Nov\u00fd \u010dlen (p\u0159evodem): ' + who + ' \u00b7 ' + what) : ('\ud83d\udcc5 Nov\u00e1 rezervace (p\u0159evodem): ' + who + ' \u00b7 ' + what);
        await sb.from('notifications').insert({ user_id: ownerId, type: 'booking', read: false, message: msg, data: JSON.stringify({ kind: 'pis_payment_in', gym_id: rec.gym_id, what, student: who }) });
      }
    }
  } catch (e) { /* non-fatal */ }
}

export const config = { api: { bodyParser: false } };

// statuses Enable/ASPSP report as FINAL SUCCESS — CONFIRM the exact set for CZ banks in sandbox.
const PAID_STATUSES = new Set(['ACCP', 'ACTC', 'ACSP', 'ACSC', 'ACCC', 'ACWC', 'ACFC', 'SETLD', 'SETTLED']);

const certCache = {}; // x5u -> pem (public certs rotate rarely; cache to avoid a fetch per webhook)

async function readRaw(req) {
  return await new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); req.on('error', reject);
  });
}

async function verify(req, rawBody) {
  const token = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const [h64, p64, s64] = token.split('.');
  if (!h64 || !p64 || !s64) throw new Error('malformed jwt');
  const header  = JSON.parse(Buffer.from(h64, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p64, 'base64url').toString());

  // (1) x5u must be https on an enablebanking.com host
  const u = new URL(header.x5u || '');
  if (u.protocol !== 'https:' || !/(^|\.)enablebanking\.com$/.test(u.hostname)) throw new Error('bad x5u host');

  // (2) fetch public cert + verify RS256 signature over header.payload
  let pem = certCache[header.x5u];
  if (!pem) { pem = await (await fetch(header.x5u)).text(); certCache[header.x5u] = pem; }
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h64 + '.' + p64), pem, Buffer.from(s64, 'base64url'));
  if (!ok) throw new Error('bad signature');

  // (3) msgi = digest of the RAW body
  const digest = 'sha256-' + crypto.createHash('sha256').update(rawBody).digest('base64');
  if (payload.msgi !== digest) throw new Error('body digest mismatch');

  // (4) it's for our application
  if (payload.sub !== APP_ID) throw new Error('wrong app');
  return payload;
}

export default async function handler(req, res) {
  try {
    const raw = await readRaw(req);
    await verify(req, raw);
    const evt = JSON.parse(raw || '{}');

    // TODO confirm the webhook body shape in sandbox. Likely carries the payment id + status somewhere like:
    const paymentId = evt.payment_id || evt.paymentId || (evt.data && (evt.data.payment_id || evt.data.paymentId));
    const status    = evt.status     || (evt.data && evt.data.status);
    if (!paymentId) return res.status(200).json({ ok: true, note: 'no payment_id' });

    // reconcile against gym_bookings OR gym_memberships (PIS can pay either)
    let tbl = 'gym_bookings';
    let rec = (await sb.from('gym_bookings').select('id,status,student_id,gym_id,class_name,amount,coach_id,acq_source,student_name').eq('pis_payment_id', paymentId).maybeSingle()).data;
    if (!rec) { const m = await sb.from('gym_memberships').select('id,status,student_id,gym_id,plan_name,amount,coach_id,acq_source,student_name').eq('pis_payment_id', paymentId).maybeSingle(); if (m.data) { rec = m.data; tbl = 'gym_memberships'; } }
    if (!rec) { const c = await sb.from('bookings').select('id,status,student_id,coach_id,amount,currency,coach_name,slot_id,acq_source').eq('pis_payment_id', paymentId).maybeSingle(); if (c.data) { rec = c.data; tbl = 'bookings'; } }
    if (!rec) { const e = await sb.from('event_tickets').select('id,status,buyer_id,event_id,amount,currency,buyer_name').eq('pis_payment_id', paymentId).maybeSingle(); if (e.data) { rec = e.data; tbl = 'event_tickets'; } }
    if (!rec) { const co = await sb.from('cohort_members').select('id,status,student_id,cohort_id,name,attribution').eq('pis_payment_id', paymentId).maybeSingle(); if (co.data) { rec = co.data; tbl = 'cohort_members'; } }
    if (!rec) return res.status(200).json({ ok: true, note: 'no matching record' });

    const _paidStatus = (tbl === 'event_tickets') ? 'paid' : (tbl === 'cohort_members') ? 'deposit_paid' : 'active';
    if (PAID_STATUSES.has(String(status)) && rec.status !== _paidStatus) {
      // idempotent: mark paid + fire the SAME payment_confirmed notification QR_bank fires on owner confirm
      await sb.from(tbl).update({ status: _paidStatus, pis_status: status }).eq('id', rec.id);
      if (tbl === 'bookings' && rec.slot_id) { try { await sb.from('slots').update({ booked: true }).eq('id', rec.slot_id); } catch (e) {} }
      try {
        const _buyerId = (tbl === 'event_tickets') ? rec.buyer_id : rec.student_id;
        const notifData = (tbl === 'gym_memberships')
          ? { kind: 'payment_confirmed', auto: true, gym_id: rec.gym_id }
          : (tbl === 'bookings')
          ? { kind: 'payment_confirmed', auto: true, goto: 'bookings' }
          : (tbl === 'event_tickets')
          ? { kind: 'payment_confirmed', auto: true, goto: 'tickets', event_id: rec.event_id }
          : (tbl === 'cohort_members')
          ? { kind: 'payment_confirmed', auto: true, goto: 'courses', cohort_id: rec.cohort_id }
          : { kind: 'payment_confirmed', auto: true, goto: 'dropin', gym_id: rec.gym_id, class_name: rec.class_name };
        await sb.from('notifications').insert({ user_id: _buyerId, type: 'booking', read: false, data: JSON.stringify(notifData) });
      } catch (e) { /* non-fatal */ }
      await pisSideEffects(rec, tbl);
    } else {
      await sb.from(tbl).update({ pis_status: status }).eq('id', rec.id);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    // return 4xx so Enable retries on transient issues; but don't leak details
    return res.status(400).json({ error: e.message });
  }
}
