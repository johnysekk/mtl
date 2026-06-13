// /api/stripe-webhook.js — Stripe webhook (záchranná síť, ať neunikne žádná platba)
// Vyžaduje env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Nastavení ve Stripe Dashboard → Developers → Webhooks → Add endpoint:
//   URL: https://app.muaythailab.co/api/stripe-webhook
//   Events: checkout.session.completed, charge.refunded, charge.dispute.created
//   Signing secret → ulož do env STRIPE_WEBHOOK_SECRET
//
// DŮLEŽITÉ: webhook musí číst RAW body (proto bodyParser:false), jinak selže ověření podpisu.

import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: false } };

const SB = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders });
  return r.ok ? r.json() : [];
}
async function sbPost(table, row) {
  await fetch(`${SB}/rest/v1/${table}`, { method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
}
async function sbPatch(table, filter, patch) {
  await fetch(`${SB}/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
}

// MTL Ambassador 0,5% — pošle 0,5 % základu ambassadorovi dané disciplíny (z provize MTL).
// Aktivuje se, jakmile existuje ambassador (profil s verify_disciplines + stripe_account).
// MTL Ambassador 0,5 % z GYM skupinových lekcí (z čisté provize MTL — gym nese Stripe fee).
// Gym jede direct charge na účtu gymu; application_fee MTL končí na platform balance,
// odkud pošleme 0,5 % základu ambassadorovi dané disciplíny (transfer mezi účty = bez Stripe fee).
// Vyžaduje: webhook nasazený + naslouchání Connect eventům (event.account je u gym plateb).
async function payGymAmbassador(discCsv, base, currency, idemKey) {
  try {
    if (!base || base <= 0) return;
    const discs = (discCsv || '').split(',').filter(Boolean);
    if (!discs.length) return;
    const ambs = await sbGet(`profiles?select=id,stripe_account,verify_disciplines`);
    const amb = (ambs || []).find(a => a.stripe_account && (() => {
      try { const v = a.verify_disciplines ? (typeof a.verify_disciplines === 'string' ? JSON.parse(a.verify_disciplines) : a.verify_disciplines) : []; return Array.isArray(v) && v.some(x => discs.includes(x)); } catch (e) { return false; }
    })());
    if (!amb) return;
    const cut = Math.round(base * 0.005 * 100); // 0,5 % základu v minor units
    if (cut > 0) await stripe.transfers.create(
      { amount: cut, currency: (currency || 'czk').toLowerCase(), destination: amb.stripe_account, description: 'MTL Ambassador 0.5% (gym)' },
      idemKey ? { idempotencyKey: 'gymamb_' + idemKey } : undefined
    );
  } catch (e) { console.error('payGymAmbassador', e); }
}
async function payAmbassador(coachId, amount, currency, disc, idemKey) {
  try {
    if (!coachId || !amount || amount <= 0) return;
    let discs = [];
    if (disc) { discs = [disc]; }
    else {
      const cps = await sbGet(`profiles?id=eq.${encodeURIComponent(coachId)}&select=disciplines`);
      try { const cp = cps[0]; discs = cp && cp.disciplines ? (typeof cp.disciplines === 'string' ? JSON.parse(cp.disciplines) : cp.disciplines) : []; } catch (e) {}
      // jen pokud má kouč JEDINOU disciplínu (jinak neznáme atribuci)
      if (Array.isArray(discs) && discs.length > 1) return;
    }
    if (!Array.isArray(discs) || !discs.length) return;
    // NOTE: při škále filtrovat na straně DB; zatím prosté načtení profilů.
    const ambs = await sbGet(`profiles?select=id,stripe_account,verify_disciplines`);
    const amb = (ambs || []).find(a => a.id !== coachId && a.stripe_account && (() => {
      try { const v = a.verify_disciplines ? (typeof a.verify_disciplines === 'string' ? JSON.parse(a.verify_disciplines) : a.verify_disciplines) : []; return Array.isArray(v) && v.some(x => discs.includes(x)); } catch (e) { return false; }
    })());
    if (!amb) return;
    const cut = Math.round(amount * 0.005 * 100); // 0,5 % základu v minor units
    if (cut > 0) await stripe.transfers.create({ amount: cut, currency: (currency || 'CZK').toLowerCase(), destination: amb.stripe_account, description: 'MTL Ambassador 0.5%' }, idemKey ? { idempotencyKey: 'amb_' + idemKey } : undefined);
  } catch (e) { console.error('payAmbassador', e); }
}

// Přepíše application_fee_percent na VŠECH aktivních membership subscriptions
// gymů vlastněných daným uživatelem (Partner: 4 %, jinak 5 %). Aplikuje se na
// BUDOUCÍ faktury; minulé zůstávají. Nemění, co platí člen — jen MTL cut.
async function rerateGymMemberships(ownerId, pct) {
  try {
    const gyms = await sbGet(`gyms?owner_id=eq.${encodeURIComponent(ownerId)}&select=id,stripe_account`);
    for (const g of gyms || []) {
      if (!g.stripe_account) continue;
      const mems = await sbGet(`gym_memberships?gym_id=eq.${encodeURIComponent(g.id)}&status=in.(active,cancelling)&select=stripe_subscription`);
      for (const m of mems || []) {
        if (!m.stripe_subscription) continue;
        try {
          await stripe.subscriptions.update(m.stripe_subscription, { application_fee_percent: pct }, { stripeAccount: g.stripe_account });
        } catch (e) { console.error('rerate sub', m.stripe_subscription, e.message); }
      }
    }
  } catch (e) { console.error('rerateGymMemberships', e); }
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

// ── Event ticket email (Resend). Needs env: RESEND_API_KEY, optional TICKET_EMAIL_FROM, PUBLIC_URL ──
async function sendTicketEmail(s, m) {
  const key = process.env.RESEND_API_KEY; if (!key) return;
  const email = (s.customer_details && s.customer_details.email) || s.customer_email; if (!email) return;
  const qtok = m.qr_token || ''; const evId = m.mtl_event_id || ''; if (!qtok || !evId) return;
  const origin = process.env.PUBLIC_URL || 'https://app.muaythailab.co';
  const checkinUrl = `${origin}/?evcheckin=1&ev=${encodeURIComponent(evId)}&tok=${encodeURIComponent(qtok)}`;
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=${encodeURIComponent(checkinUrl)}`;
  const title = m.mtl_event || 'your event';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#111;">`
    + `<h2 style="margin:0 0 6px;">\uD83C\uDF9F\uFE0F ${title}</h2>`
    + `<p style="color:#444;">Your ticket is confirmed. Show this QR code at the door:</p>`
    + `<p style="text-align:center;margin:18px 0;"><img src="${qrImg}" width="240" height="240" alt="Ticket QR" style="border:1px solid #eee;border-radius:12px;"></p>`
    + `<p style="text-align:center;color:#888;font-size:13px;">You can also open your ticket anytime in the MTL Coaches app under My events.</p>`
    + `<p style="text-align:center;"><a href="${origin}" style="color:#E8001D;font-weight:bold;text-decoration:none;">Open MTL Coaches \u2192</a></p></div>`;
  const from = process.env.TICKET_EMAIL_FROM || 'MTL Coaches <tickets@muaythailab.co>';
  await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: email, subject: `\uD83C\uDF9F\uFE0F Your ticket \u2014 ${title}`, html }) });
}

// Records ONE row per Stripe payment into the transactions ledger, with EXACT fees from the charge's balance_transaction.
async function recordTransaction(acct, pi, fields) {
  if (!pi) return;
  try {
    const ex = await sbGet(`transactions?payment_intent=eq.${encodeURIComponent(pi)}&select=id`);
    if (ex && ex.length) return;
    let gross = fields.gross != null ? fields.gross : null, stripeFee = null, mtlFee = null, net = null, currency = fields.currency || null, chargeId = null;
    if (acct) {
      try {
        const intent = await stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge.balance_transaction'] }, { stripeAccount: acct });
        const ch = intent && intent.latest_charge;
        if (ch) {
          chargeId = ch.id; gross = ch.amount; currency = ch.currency; mtlFee = ch.application_fee_amount || 0;
          const bt = ch.balance_transaction;
          if (bt) { stripeFee = bt.fee; net = bt.net - mtlFee; } else if (gross != null) { net = gross - mtlFee; }
        }
      } catch (e) { console.error('recordTransaction fee', e.message); }
    }
    await sbPost('transactions', {
      payment_intent: pi, charge_id: chargeId, payee_account: acct || null, type: fields.type,
      member_id: fields.member_id || null, coach_id: fields.coach_id || null, gym_id: fields.gym_id || null, plan: fields.plan || null,
      gross_amount: gross, stripe_fee: stripeFee, mtl_fee: mtlFee, net_amount: net, currency,
      status: 'paid', created_at: new Date().toISOString(),
    });
  } catch (e) { console.error('recordTransaction', e.message); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  let event;
  try {
    const buf = await rawBody(req);
    const sig = req.headers['stripe-signature'];
    // Dva endpointy (tvůj účet + connected/gym) = dva podpisové klíče. Zkus oba.
    const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_WEBHOOK_SECRET_CONNECT].filter(Boolean);
    let lastErr = null;
    for (const sec of secrets) {
      try { event = stripe.webhooks.constructEvent(buf, sig, sec); lastErr = null; break; }
      catch (e) { lastErr = e; }
    }
    if (!event) throw (lastErr || new Error('No webhook secret configured'));
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const m = s.metadata || {};
      // jen lekce koučů (gym jede direct-charge na účet gymu, ne přes platformu)
      if (m.booking_type === 'inperson' || m.booking_type === 'online') {
        const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id);
        // IDEMPOTENCE: existuje už booking pro tento payment_intent?
        const existing = pi ? await sbGet(`bookings?payment_intent=eq.${encodeURIComponent(pi)}&select=id`) : [];
        if (!existing.length) {
          const amount = parseInt(m.base_amount || '0', 10);
          const currency = m.booking_currency || 'CZK';
          if (m.booking_type === 'inperson' && m.slot_id) {
            const slots = await sbGet(`slots?id=eq.${encodeURIComponent(m.slot_id)}&select=*`);
            const slot = slots[0];
            if (slot) {
              await sbPatch('slots', `id=eq.${encodeURIComponent(m.slot_id)}`, { booked: true, student: m.student_id || null });
              await sbPost('bookings', {
                slot_id: slot.id, student_id: m.student_id || null, coach_id: slot.coach_profile_id,
                coach_name: m.coach_name || 'Kouč', payment_intent: pi, amount,
                training_date: slot.date, training_time: slot.time,
                status: 'active', type: 'inperson', currency, discipline: m.discipline || null,
              });
              if (slot.coach_profile_id) await sbPost('notifications', {
                user_id: slot.coach_profile_id, type: 'booking', read: false,
                message: `📅 Nová rezervace (potvrzeno platbou) na ${slot.date} ${slot.time}.`,
              });
              await payAmbassador(slot.coach_profile_id, amount, currency, m.discipline, pi);
              await recordTransaction(event.account, pi, { type: 'coach_inperson', member_id: m.student_id, coach_id: slot.coach_profile_id, plan: 'Lekce 1:1', gross: amount, currency });
            }
          } else if (m.booking_type === 'online' && m.coach_profile_id) {
            await sbPost('bookings', {
              slot_id: null, student_id: m.student_id || null, coach_id: m.coach_profile_id,
              coach_name: m.coach_name || 'Kouč', payment_intent: pi, amount,
              training_date: new Date().toISOString().slice(0, 10), training_time: null,
              status: 'active', type: 'online', currency, online_format: m.online_fmt || null, discipline: m.discipline || null,
            });
            await sbPost('notifications', {
              user_id: m.coach_profile_id, type: 'booking', read: false,
              message: `🌐 Nová online objednávka (potvrzeno platbou).`,
            });
            await payAmbassador(m.coach_profile_id, amount, currency, m.discipline, pi);
            await recordTransaction(event.account, pi, { type: 'coach_online', member_id: m.student_id, coach_id: m.coach_profile_id, plan: m.online_fmt || 'Online', gross: amount, currency });
          }
        }
      } else if (m.mtl_payment_type === 'drop_in' || m.mtl_payment_type === 'membership') {
        // GYM skupinová lekce (direct charge na účtu gymu) → 0,5 % ambassadorovi disciplíny
        await payGymAmbassador(m.mtl_disc, parseInt(m.mtl_base || '0', 10), m.mtl_currency || 'CZK', s.id);
        if (m.mtl_payment_type === 'drop_in') { const dpi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id); if (dpi) await recordTransaction(event.account, dpi, { type: 'drop_in', member_id: m.student_id || m.member_id, gym_id: m.gym_id, coach_id: m.coach_profile_id || m.coach_id, plan: m.mtl_plan || 'Drop-in', currency: m.mtl_currency || 'CZK' }); }
      } else if (m.mtl_payment_type === 'partner_sub') {
        // Exclusive MTL Partner subscription zaplacena → zapni partner sazby
        const uid = m.user_id || s.client_reference_id;
        const sub = typeof s.subscription === 'string' ? s.subscription : (s.subscription && s.subscription.id);
        const cust = typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id);
        if (uid) {
          await sbPatch('profiles', `id=eq.${encodeURIComponent(uid)}`, { partner: true, partner_sub: sub || null, stripe_customer: cust || null });
          await rerateGymMemberships(uid, 3); // existující členství → 3 % od příští faktury (Exclusive Partner)
          await sbPost('notifications', { user_id: uid, type: 'system', read: false, data: JSON.stringify({ kind: 'partner_granted' }), message: '⭐ Teď jsi Exclusive MTL Partner! Z lekcí si necháváš 99 %, student platí jen +3 %, a u gymu si necháváš 99 % z jednorázovek a 97 % z členství. 🥊' });
          await sbPost('notifications', { user_id: '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c', type: 'system', read: false, message: `⭐ Nový Exclusive MTL Partner (user ${uid}).` });
        }
      } else if (m.mtl_payment_type === 'event_ticket') {
        // Event ticket (direct charge on payee account) — backstop confirm if user closed tab before redirect
        if (m.ticket_id) {
          const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id);
          await sbPatch('event_tickets', `id=eq.${encodeURIComponent(m.ticket_id)}`, { status: 'paid', stripe_ref: pi });
          await recordTransaction(event.account, pi, { type: 'event_ticket', member_id: m.student_id || m.buyer_id, gym_id: m.gym_id, coach_id: m.payout_coach_id, plan: m.mtl_event || 'Event', currency: m.mtl_currency || 'CZK' });
          await payGymAmbassador(m.mtl_disc, parseInt(m.mtl_base || '0', 10), m.mtl_currency || 'CZK', s.id);
          try { await sendTicketEmail(s, m); } catch (e) { console.error('ticket email', e.message); }
        }
      }
    } else if (event.type === 'charge.refunded') {
      const ch = event.data.object;
      const pi = typeof ch.payment_intent === 'string' ? ch.payment_intent : (ch.payment_intent && ch.payment_intent.id);
      if (pi) {
        const full = ch.amount_refunded >= ch.amount_captured;
        const pct = ch.amount_captured ? Math.round((ch.amount_refunded / ch.amount_captured) * 100) : 100;
        await sbPatch('bookings', `payment_intent=eq.${encodeURIComponent(pi)}`, full ? { status: 'cancelled', refund_pct: pct } : { refund_pct: pct });
        let mtlFeeRefunded = 0;
        try { if (ch.application_fee) { const afId = typeof ch.application_fee === 'string' ? ch.application_fee : ch.application_fee.id; const af = await stripe.applicationFees.retrieve(afId); mtlFeeRefunded = af.amount_refunded || 0; } } catch (e) { console.error('appfee refund', e.message); }
        try { await sbPatch('transactions', `payment_intent=eq.${encodeURIComponent(pi)}`, { status: full ? 'refunded' : 'partial_refund', refund_amount: ch.amount_refunded, mtl_fee_refunded: mtlFeeRefunded }); } catch (e) {}
      }
    } else if (event.type === 'customer.subscription.deleted') {
      // Exclusive MTL Partner zrušen / neuhrazen → vypni partner sazby
      const sub = event.data.object;
      const rows = await sbGet(`profiles?partner_sub=eq.${encodeURIComponent(sub.id)}&select=id`);
      const uid = rows[0] && rows[0].id;
      if (uid) {
        await sbPatch('profiles', `id=eq.${encodeURIComponent(uid)}`, { partner: false, partner_sub: null });
        await rerateGymMemberships(uid, 5); // zpět na 5 % od příští faktury
        await sbPost('notifications', { user_id: uid, type: 'system', read: false, data: JSON.stringify({ kind: 'partner_ended' }), message: '⭐ Teď už nejsi Exclusive MTL Partner. Děkujeme za tvoji přízeň! Sazby se vrátily na standard (kouč 95 % / student +5 %, gym jednorázovky 97 %, členství 95 %).' });
      }
    } else if (event.type === 'charge.dispute.created') {
      const d = event.data.object;
      const pi = typeof d.payment_intent === 'string' ? d.payment_intent : (d.payment_intent && d.payment_intent.id);
      if (pi) await sbPatch('bookings', `payment_intent=eq.${encodeURIComponent(pi)}`, { refund_requested: true, refund_reason: '(DISPUTE přes Stripe)' });
    } else if (event.type === 'invoice.paid') {
      // Renewal of a membership subscription on a connected (gym) account -> extend the period
      const inv = event.data.object;
      const sub = typeof inv.subscription === 'string' ? inv.subscription : (inv.subscription && inv.subscription.id);
      if (sub) {
        let periodEnd = null;
        try { const line = inv.lines && inv.lines.data && inv.lines.data[0]; if (line && line.period && line.period.end) periodEnd = new Date(line.period.end * 1000).toISOString(); } catch (e) {}
        const patch = { status: 'active' };
        if (periodEnd) patch.period_end = periodEnd;
        await sbPatch('gym_memberships', `stripe_subscription=eq.${encodeURIComponent(sub)}`, patch);
        try { const ipi = (typeof inv.payment_intent === 'string' ? inv.payment_intent : (inv.payment_intent && inv.payment_intent.id)) || (typeof inv.charge === 'string' ? inv.charge : (inv.charge && inv.charge.id)); const mem = (await sbGet(`gym_memberships?stripe_subscription=eq.${encodeURIComponent(sub)}&select=*`))[0]; if (ipi && mem) await recordTransaction(event.account, ipi, { type: 'membership', member_id: mem.student_id || mem.member_id, gym_id: mem.gym_id, coach_id: mem.coach_id, plan: mem.plan_name || 'Membership', currency: inv.currency }); } catch (e) { console.error('record membership', e.message); }
      }
    } else if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object;
      const sub = typeof inv.subscription === 'string' ? inv.subscription : (inv.subscription && inv.subscription.id);
      if (sub) await sbPatch('gym_memberships', `stripe_subscription=eq.${encodeURIComponent(sub)}`, { status: 'past_due' });
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(200).json({ received: true, error: err.message }); // 200, ať Stripe neretryuje donekonečna na našich chybách
  }
}
