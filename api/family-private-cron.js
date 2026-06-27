// /api/family-private-cron.js
// Runs every ~5 min. Two passes over active 1:N family privates that include a minor (bookings.minor_present=true):
//  (1) REMINDER: a lesson starting in ~REMIND_LEAD min -> ping the COACH (show your check-in QR) + the booking adult/guardian (reminder to scan).
//  (2) NO-SHOW REFUND: a lesson whose start + GRACE_MIN has passed with NO guardian QR scan (bookings.checked_in_at IS NULL)
//      -> auto-refund REFUND_PCT (95%) of the gross to the student, on the coach's connected account. The coach bears the no-show risk (decided).
//
// QR scan (the booking adult / legal guardian scanning the coach's ?coachcheckin QR, which sets checked_in_at) is the ONLY truth.
// There is NO "did the lesson happen" judgement, no rating without a scan, and MTL never arbitrates a dispute.
// Coach recourse for a no-show family = block that student (separate feature).
//
// vercel.json: { "crons": [ { "path": "/api/family-private-cron", "schedule": "*/5 * * * *" } ] }
// Needs env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY ; optional CRON_SECRET.

import Stripe from 'stripe';

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const REFUND_PCT  = 0.95;   // student gets 95% of the gross back on a no-show. The remaining 5% covers irreversible costs; coach bears the loss.
const GRACE_MIN   = 150;    // minutes after lesson start before a missing scan counts as a no-show
const REMIND_LEAD = 7;      // minutes before start to ping coach + guardian (cron runs every ~5 min, so a 7-min window catches it)

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body,
  });
  const txt = await r.text(); let j; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = txt; }
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
}
const notify = (user_id, kind, message, extra = {}) =>
  sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id, type: 'system', read: false, data: JSON.stringify({ kind, ...extra }), message }) });

function startOf(b) { try { return new Date(`${b.training_date}T${(b.training_time || '00:00')}:00`); } catch (e) { return null; } }

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (!(auth === `Bearer ${process.env.CRON_SECRET}` || req.headers['x-vercel-cron'])) return res.status(401).json({ error: 'unauthorized' });
  }

  const now = Date.now();
  const out = { reminded: 0, refunded: 0, errors: [] };

  try {
    const rows = await sb(`bookings?select=id,coach_id,student_id,payment_intent,amount,currency,training_date,training_time,checked_in_at,minor_present,family_reminded,family_refunded,status&minor_present=eq.true&status=eq.active`);

    for (const b of (rows || [])) {
      const st = startOf(b); if (!st) continue;
      const startMs = st.getTime();

      // (1) 5-min reminder
      if (!b.family_reminded && startMs > now && (startMs - now) <= REMIND_LEAD * 60000) {
        try {
          const when = b.training_time || '';
          await notify(b.coach_id, 'family_qr_coach', `Za chvili zacina rodinna soukromka (${when}). Ukaz zakonnemu zastupci svuj check-in QR.`, { occ: { date: b.training_date, time: b.training_time, name: 'Rodinna soukromka' } });
          await notify(b.student_id, 'family_qr_guardian', `Za chvili zacina tvoje rodinna soukromka (${when}). Nezapomen naskenovat check-in QR od kouce.`, {});
          await sb(`bookings?id=eq.${b.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ family_reminded: true }) });
          out.reminded++;
        } catch (e) { out.errors.push(`remind ${b.id}: ${e.message}`); }
      }

      // (2) no-show 95% refund
      if (!b.family_refunded && !b.checked_in_at && (startMs + GRACE_MIN * 60000) < now) {
        try {
          if (!b.payment_intent) { out.errors.push(`refund ${b.id}: no payment_intent`); continue; }
          const prof = (await sb(`profiles?id=eq.${b.coach_id}&select=stripe_account`))[0] || {};
          const acct = prof.stripe_account;
          if (!acct) { out.errors.push(`refund ${b.id}: coach has no stripe_account`); continue; }
          const amt = Math.round((parseFloat(b.amount) || 0) * REFUND_PCT * 100); // minor units, 95% of gross
          if (amt > 0) {
            // Direct charge -> refund on the coach's connected account. App fee intentionally NOT refunded (MTL keeps its fee; coach bears the no-show). Accountant can refine.
            await stripe.refunds.create({ payment_intent: b.payment_intent, amount: amt }, { stripeAccount: acct });
          }
          await sb(`bookings?id=eq.${b.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ family_refunded: true, status: 'refunded' }) });
          await notify(b.student_id, 'family_refund', `Rodinna soukromka (${b.training_date}) nebyla potvrzena check-in QR zastupce - vratili jsme ti 95 %.`, { ok: true });
          await notify(b.coach_id, 'family_refund', `Rodinna soukromka (${b.training_date}) bez check-in QR zastupce - studentovi se automaticky vratilo 95 %. Nespolehliveho studenta muzes zablokovat.`, { ok: false });
          out.refunded++;
        } catch (e) { out.errors.push(`refund ${b.id}: ${e.message}`); }
      }
    }

    return res.status(200).json(out);
  } catch (err) {
    console.error('family-private-cron error:', err);
    return res.status(500).json({ error: err.message });
  }
}
