// /api/membership-expiry-cron — end memberships whose paid period has run out.
//
// WHY THIS EXISTS
// A monthly Stripe subscription takes care of itself: Stripe bills it, and when it fails or is
// cancelled the webhook flips the row. Nothing else does.
//
//   - a ONE-TIME 3/6/12-month membership has NO subscription at all, and
//   - a bank / QR / cash / PIS membership has no subscription either.
//
// Both were left with status='active' forever once period_end passed, and every access check in
// the app only looks at `status` — so an expired yearly pass kept opening the doors for free.
//
// This cron closes that: any membership that is past its period_end and is NOT a live Stripe
// subscription gets status='ended'. Stripe subscriptions are deliberately skipped: their
// period_end is a RENEWAL date that moves forward on every invoice, and ending them here would
// cancel paying members.
//
// Idempotent, safe to run as often as you like. Daily is plenty.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, init) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init && init.headers),
    },
  });
  if (!r.ok) throw new Error(`${path} ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method' });
  }
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` plus an `x-vercel-cron` header.
  // It does NOT send `x-cron-secret`, and vercel.json carries no `?secret=`, so the previous
  // gate rejected every scheduled run with 401. Same shape as commission-cron.js.
  if (process.env.CRON_SECRET) {
    const _auth = req.headers.authorization || '';
    if (!(_auth === `Bearer ${process.env.CRON_SECRET}` || req.headers['x-vercel-cron'])) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const now = new Date().toISOString();
  let ended = 0;
  const notified = [];

  try {
    // Expired = period_end in the past, still counted as live, and NOT a Stripe subscription.
    // `stripe_subscription=is.null` is the whole safety net here: it is exactly the set of
    // memberships nobody else can end.
    const rows = await sb(
      `gym_memberships?select=id,student_id,gym_id,gym_name,plan_name,period_end,months` +
        `&status=in.(active,cancelling)` +
        `&stripe_subscription=is.null` +
        `&period_end=lt.${encodeURIComponent(now)}` +
        `&limit=500`
    );

    for (const m of rows || []) {
      try {
        await sb(`gym_memberships?id=eq.${encodeURIComponent(m.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'ended', cancelled_at: m.period_end }),
        });
        ended++;

        // Tell the member their pass ran out, and point them at the club so they can renew.
        if (m.student_id) {
          const term = Number(m.months) > 1 ? `${m.months} m` : null;
          await sb('notifications', {
            method: 'POST',
            body: JSON.stringify({
              user_id: m.student_id,
              type: 'system',
              read: false,
              data: JSON.stringify({
                kind: 'membership_expired',
                gym_id: m.gym_id,
                gym_name: m.gym_name || '',
                plan: m.plan_name || '',
                months: m.months || 1,
              }),
              message: `⌛ Tvé členství${m.plan_name ? ` (${m.plan_name})` : ''}${
                m.gym_name ? ` v ${m.gym_name}` : ''
              } vypršelo${term ? ` po ${term}` : ''}. Můžeš si ho obnovit.`,
            }),
          });
          notified.push(m.student_id);
        }
      } catch (e) {
        console.error('expire membership', m.id, e.message);
      }
    }

    // ---- REMINDERS: warn BEFORE the pass runs out, while it can still be renewed -------------
    // This matters on every non-renewing membership, which on the bank rails (PIS / QR / cash) is
    // ALL of them — even the "monthly" plan has no subscription behind it, so the member simply
    // stops being a member unless someone tells them. A silent expiry is lost revenue.
    // Fires once at ~7 days out and once at ~1 day out; `expiry_warned` on the row keeps it idempotent.
    let warned = 0;
    try {
      const soon = new Date(Date.now() + 7 * 86400000).toISOString();
      const due = await sb(
        `gym_memberships?select=id,student_id,gym_id,gym_name,plan_name,period_end,months,expiry_warned` +
          `&status=in.(active,cancelling)` +
          `&stripe_subscription=is.null` +
          `&period_end=gte.${encodeURIComponent(now)}` +
          `&period_end=lte.${encodeURIComponent(soon)}` +
          `&limit=500`
      );

      for (const m of due || []) {
        const days = Math.max(0, Math.ceil((new Date(m.period_end).getTime() - Date.now()) / 86400000));
        const stage = days <= 1 ? 1 : 7;             // only two nudges, ever
        if (Number(m.expiry_warned) === stage || Number(m.expiry_warned) === 1) continue;

        try {
          const when = days <= 1 ? 'zítra' : `za ${days} d`;
          await sb('notifications', {
            method: 'POST',
            body: JSON.stringify({
              user_id: m.student_id,
              type: 'system',
              read: false,
              data: JSON.stringify({
                kind: 'membership_expiring',
                gym_id: m.gym_id,
                gym_name: m.gym_name || '',
                plan: m.plan_name || '',
                days,
              }),
              message: `⏳ Tvé členství${m.plan_name ? ` (${m.plan_name})` : ''}${
                m.gym_name ? ` v ${m.gym_name}` : ''
              } končí ${when}. Obnov si ho, ať nepřijdeš o tréninky.`,
            }),
          });

          await sb(`gym_memberships?id=eq.${encodeURIComponent(m.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ expiry_warned: stage }),
          });
          warned++;
        } catch (e) {
          console.error('warn membership', m.id, e.message);
        }
      }
    } catch (e) {
      console.error('expiry reminders', e.message);
    }

    // ---- RENEWAL HEADS-UP for LIVE Stripe subscriptions ---------------------------------------
    // The opposite case to everything above: these DO renew, automatically, and the card gets
    // charged without the member lifting a finger. Telling them ~4 days ahead is basic courtesy
    // (and heads off the "what is this charge?" dispute). period_end is the next billing date and
    // invoice.paid pushes it forward on every cycle, so it stays accurate.
    // `renew_warned` holds the period_end we already warned about, so each cycle nudges once.
    let renewWarned = 0;
    try {
      const RENEW_DAYS = 4;
      const horizon = new Date(Date.now() + RENEW_DAYS * 86400000).toISOString();
      const subs = await sb(
        `gym_memberships?select=id,student_id,gym_id,gym_name,plan_name,amount,currency,period_end,renew_warned` +
          `&status=eq.active` +
          `&stripe_subscription=not.is.null` +
          `&cancelled_at=is.null` +
          `&period_end=gte.${encodeURIComponent(now)}` +
          `&period_end=lte.${encodeURIComponent(horizon)}` +
          `&limit=500`
      );

      for (const m of subs || []) {
        // already nudged for THIS billing cycle?
        if (m.renew_warned && new Date(m.renew_warned).getTime() === new Date(m.period_end).getTime()) continue;
        try {
          const when = new Date(m.period_end).toLocaleDateString('cs-CZ');
          await sb('notifications', {
            method: 'POST',
            body: JSON.stringify({
              user_id: m.student_id,
              type: 'system',
              read: false,
              data: JSON.stringify({
                kind: 'membership_renewing',
                gym_id: m.gym_id,
                gym_name: m.gym_name || '',
                plan: m.plan_name || '',
                date: m.period_end,
                amount: m.amount || 0,
                currency: m.currency || 'CZK',
              }),
              message: `🔄 Tvé členství${m.plan_name ? ` (${m.plan_name})` : ''}${
                m.gym_name ? ` v ${m.gym_name}` : ''
              } se obnoví ${when} a částka se automaticky strhne z tvojí karty.`,
            }),
          });
          await sb(`gym_memberships?id=eq.${encodeURIComponent(m.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ renew_warned: m.period_end }),
          });
          renewWarned++;
        } catch (e) {
          console.error('renew warn', m.id, e.message);
        }
      }
    } catch (e) {
      console.error('renewal reminders', e.message);
    }

    return res.status(200).json({ ok: true, checked: (rows || []).length, ended, warned, renewWarned, notified: notified.length });
  } catch (e) {
    console.error('membership-expiry-cron', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
