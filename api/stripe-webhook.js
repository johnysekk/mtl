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

// MTL Ambassador 1% — pošle 1 % základu ambassadorovi dané disciplíny (z provize MTL).
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
async function payAmbassador(coachId, amount, currency, disc) {
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
    const cut = Math.round(amount * 0.01 * 100); // 1 % základu v minor units
    if (cut > 0) await stripe.transfers.create({ amount: cut, currency: (currency || 'CZK').toLowerCase(), destination: amb.stripe_account, description: 'MTL Ambassador 1%' });
  } catch (e) { console.error('payAmbassador', e); }
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
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
              await payAmbassador(slot.coach_profile_id, amount, currency, m.discipline);
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
            await payAmbassador(m.coach_profile_id, amount, currency, m.discipline);
          }
        }
      } else if (m.mtl_payment_type === 'drop_in' || m.mtl_payment_type === 'membership') {
        // GYM skupinová lekce (direct charge na účtu gymu) → 0,5 % ambassadorovi disciplíny
        await payGymAmbassador(m.mtl_disc, parseInt(m.mtl_base || '0', 10), m.mtl_currency || 'CZK', s.id);
      }
    } else if (event.type === 'charge.refunded') {
      const ch = event.data.object;
      const pi = typeof ch.payment_intent === 'string' ? ch.payment_intent : (ch.payment_intent && ch.payment_intent.id);
      if (pi) {
        const full = ch.amount_refunded >= ch.amount_captured;
        const pct = ch.amount_captured ? Math.round((ch.amount_refunded / ch.amount_captured) * 100) : 100;
        await sbPatch('bookings', `payment_intent=eq.${encodeURIComponent(pi)}`, full ? { status: 'cancelled', refund_pct: pct } : { refund_pct: pct });
      }
    } else if (event.type === 'charge.dispute.created') {
      const d = event.data.object;
      const pi = typeof d.payment_intent === 'string' ? d.payment_intent : (d.payment_intent && d.payment_intent.id);
      if (pi) await sbPatch('bookings', `payment_intent=eq.${encodeURIComponent(pi)}`, { refund_requested: true, refund_reason: '(DISPUTE přes Stripe)' });
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(200).json({ received: true, error: err.message }); // 200, ať Stripe neretryuje donekonečna na našich chybách
  }
}
