import { sellKind } from './_sell-kind.js';
import Stripe from 'stripe';
import { attRenewalPass, attReq, attSummary } from './_att-disc.js';
import { expireOffers } from './_pass-transfer.js';
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

// Členství (spolek) / Permanentka (podnikatel) -- notifikace nese sk, appka podle něj volí tvary.
const _orgCache = {};
async function _skOf(m) {
  try {
    if (!(m.gym_id in _orgCache)) { const g = await sb(`gyms?id=eq.${m.gym_id}&select=org_form`); _orgCache[m.gym_id] = (g && g[0] && g[0].org_form) || null; }
    return sellKind({ orgForm: _orgCache[m.gym_id], paidTo: m.paid_to });
  } catch (e) { return 'membership'; }
}
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
  // POZOR: hlavicku x-vercel-cron umi poslat kdokoli -- Vercel ji z prichozich pozadavku
// neodstranuje, takze jako autorizace neplati. Jedine, co plati, je Authorization:
// Bearer <CRON_SECRET>, kterou Vercel k volani crona pridava sam.
  // It does NOT send `x-cron-secret`, and vercel.json carries no `?secret=`, so the previous
  // gate rejected every scheduled run with 401. Same shape as commission-cron.js.
  // ZAVRENO NAPEVNO: bez nastaveneho CRON_SECRET endpoint nebezi. Driv se kontrola delala
  // jen kdyz promenna existovala -- kdyz chybela, byl cron otevreny komukoli.
  {
    const _sec = process.env.CRON_SECRET;
    const _auth = req.headers.authorization || '';
    if (!_sec) return res.status(500).json({ error: 'CRON_SECRET not configured' });
    if (_auth !== `Bearer ${_sec}`) return res.status(401).json({ error: 'unauthorized' });
  }


  const now = new Date().toISOString();
  let ended = 0;
  const notified = [];

  try {
    // Expired = period_end in the past, still counted as live, and NOT a Stripe subscription.
    // `stripe_subscription=is.null` is the whole safety net here: it is exactly the set of
    // memberships nobody else can end.
    const rows = await sb(
      `gym_memberships?select=id,student_id,gym_id,gym_name,plan_name,period_end,months,paid_to` +
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
                kind: 'membership_expired', sk: await _skOf(m),
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
        `gym_memberships?select=id,student_id,gym_id,gym_name,plan_name,period_end,months,expiry_warned,paid_to` +
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
                kind: 'membership_expiring', sk: await _skOf(m),
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
        `gym_memberships?select=id,student_id,gym_id,gym_name,plan_name,amount,currency,period_end,renew_warned,paid_to` +
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
                kind: 'membership_renewing', sk: await _skOf(m),
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

    // ---- SLEVA ZA DOCHÁZKU u předplatného kartou (_att-disc.js) -----------------------------
    // 2 dny před obnovou: kdo splnil docházku u permanentky se zapnutou slevou, má příští platbu
    // nižší (záporná položka na faktuře ve Stripe). Zprávu dostane každý, komu pravidlo platí --
    // i ten, komu kousek chyběl, ať ví, kolik a proč.
    let att = null;
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      // Čtení při chybě vyhazuje (řádek se přeskočí a zkusí se zítra); zápis vrací, jestli řádek změnil.
      const sbGet = (path) => sb(path);
      const sbPatch = async (path, body) => { try { const r = await sb(path, { method: 'PATCH', body: JSON.stringify(body) }); return Array.isArray(r) && r.length > 0; } catch (e) { console.error('att patch', e.message); return false; } };
      const fmt = (v, cur, en) => Number(v).toLocaleString(en ? 'en-GB' : 'cs-CZ') + (String(cur || 'CZK').toUpperCase() === 'CZK' ? (en ? ' CZK' : ' Kč') : (String(cur).toUpperCase() === 'EUR' ? ' €' : ' ' + cur));
      const notify = async (m, g, r) => {
        const cur = m.currency || g.currency || 'CZK';
        const when = new Date(m.period_end).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' });
        const whenEn = new Date(m.period_end).toLocaleDateString('en-GB', { timeZone: 'Europe/Prague' });
        const who = m.child_name ? ` (${m.child_name})` : '';
        const plan = m.plan_name ? ` ${m.plan_name}` : '';
        // Co pravidlo chtělo a jak to dopadlo -- obě čísla celá, žádná procenta.
        const reqCs = attReq(r, false), reqEn = attReq(r, true);
        const gotCs = attSummary(r, false), gotEn = attSummary(r, true);
        const cs = r.amount
          ? `🎯 Docházka splněná${who}: ${gotCs}. Další platba${plan} v ${g.name || m.gym_name || 'klubu'} (${when}) bude o ${fmt(r.amount, cur)} nižší: ${fmt(Math.max(0, (Number(m.amount) || 0) - r.amount), cur)} místo ${fmt(m.amount, cur)}.`
          : `📊 Docházka${who}: ${gotCs}. Na slevu ${fmt(r.rule.amt * Math.max(1, parseInt(m.months, 10) || 1), cur)} v ${g.name || m.gym_name || 'klubu'} bylo potřeba ${reqCs} — příští platba (${when}) je v plné výši. V dalším období to jde znovu.`;
        const en = r.amount
          ? `🎯 Attendance target met${who}: ${gotEn}. Your next payment${plan} at ${g.name || m.gym_name || 'the club'} (${whenEn}) is ${fmt(r.amount, cur, true)} lower: ${fmt(Math.max(0, (Number(m.amount) || 0) - r.amount), cur, true)} instead of ${fmt(m.amount, cur, true)}.`
          : `📊 Attendance${who}: ${gotEn}. The ${fmt(r.rule.amt * Math.max(1, parseInt(m.months, 10) || 1), cur, true)} discount at ${g.name || m.gym_name || 'the club'} needed ${reqEn} — the next payment (${whenEn}) is in full. You can earn it next period.`;
        if (!r.amount && !r.expected && !r.visits) return;   // bez jediné proběhlé lekce nic neposílat
        await sb('notifications', { method: 'POST', body: JSON.stringify({ user_id: m.student_id, type: 'system', read: false, message: cs,
          data: JSON.stringify({ kind: 'memb_att_disc', gym_id: m.gym_id, membership_id: m.id, amount: r.amount || 0, visits: r.visits, absences: r.absences, msg_cs: cs, msg_en: en }) }) });
      };
      att = await attRenewalPass({ sbGet, sbPatch, stripe, notify });
    } catch (e) { console.error('att renewal pass', e.message); }
    // Permanentky na ukončenou lekci: kdo se do termínu nerozhodl, dostane peníze zpět.
    let passRefunds = 0;
    try { passRefunds = await expireOffers(); } catch (e) { console.error('pass transfer expiry', e.message); }

    return res.status(200).json({ ok: true, checked: (rows || []).length, ended, warned, renewWarned, notified: notified.length, att, passRefunds });
  } catch (e) {
    console.error('membership-expiry-cron', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
