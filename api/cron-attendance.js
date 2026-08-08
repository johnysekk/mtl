// Vercel Cron: připomínka "Doplň docházku" koučovi, který lekci vedl.
// Běží na serveru i když nikdo nemá appku otevřenou → realtime (cca +2 h od začátku lekce).
// Vyžaduje env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. (CRON_SECRET nastaví Vercel automaticky.)
// Naplánování: vercel.json → crons (každých 30 min). Pozor: Hobby plán povoluje cron jen 1×/den;
// frekventovaný cron funguje až na Pro. Do té doby běží client-side fallback v appce.
// Dedup je sdílený s client-side přes tabulku attend_reminders (unique gym/class/date) → žádné duplikáty.
// + Druhý pass: připomínka studentovi ~4 h před začátkem GYM lekce / drop-inu (TZ gymu). Dedup přes reminder_sent na řádku.
//   1:1 lekce (coach + student) řeší tenhle cron přes profiles.timezone (TZ kouče) + client-side fallback. Respektuje mute_class_reminder / mute_coach_lesson_reminder.

import Stripe from 'stripe';

const FOUNDER_ID = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = process.env.SUPABASE_URL;
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders });
  return r.ok ? r.json() : [];
}
async function sbPost(table, row) {
  return fetch(`${SB}/rest/v1/${table}`, { method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
}
async function sbPatch(table, query, row) {
  return fetch(`${SB}/rest/v1/${table}?${query}`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Aktuální čas v timezone gymu → {date 'YYYY-MM-DD', dow 0-6, mins od půlnoci}
function gymNow(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = {}; parts.forEach(p => g[p.type] = p.value);
  return {
    date: `${g.year}-${g.month}-${g.day}`,
    dow: DOW[g.weekday],
    mins: parseInt(g.hour, 10) * 60 + parseInt(g.minute, 10),
  };
}

export default 
// ---------------------------------------------------------------------------
// THE ONE RULE for what application_fee_percent a membership subscription carries.
//
// This field was being set from THREE places that knew nothing about each other:
//   * pay.js at creation        -> welcome 0% / acquisition 10% (5% EP) / ladder
//   * cron-attendance when the welcome window ended -> ALWAYS base, which silently threw
//     away an acquisition window that was still running
//   * gym-rerate when the owner crossed a tier -> ALWAYS the ladder rate, which blew away
//     BOTH a running welcome window (breaking a 0% promise made to the provider) and an
//     open acquisition window (MTL losing its own finder's fee)
// and nothing at all ever ended an acquisition window, so an MTL-sourced membership was
// billed 10% forever. mtl_acq had one writer and zero readers.
//
// PRECEDENCE: welcome (0) beats acquisition (10 / 5) beats the provider's ladder rate.
// Welcome wins because it is a promise made to the provider; when it ends, the sub lands
// on whatever is correct AT THAT MOMENT (still inside the 2 months -> acquisition; else ladder).
//
// Returns null when it cannot decide (Stripe call failed) -> the caller must CHANGE NOTHING.
// Never guess with someone's money.
async function subRateFor(stripe, acct, subId, sub, ladderPct, welcomeActive) {
  if (welcomeActive) return 0;
  const md = (sub && sub.metadata) || {};
  if (md.mtl_acq === '1') {
    const pct = parseFloat(md.mtl_acq_pct || '0') || 0;
    if (pct > 0) {
      let paid;
      try {
        const invs = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 3 }, { stripeAccount: acct });
        paid = ((invs && invs.data) || []).length;
      } catch (e) { return null; }            // cannot count -> do not touch the rate
      // CHANGED: was `paid < 2` -- the acquisition rate rode the first TWO paid invoices.
      // Acquisition is now a single 20% (10% EP) charge on the first month only, so it comes
      // off after one. The rule lives in _rate.js; this is the subscription mirror of it.
      if (paid < 1) return pct;               // first month only -> the acquisition rate
    }
  }
  return ladderPct;
}

// Apply it. Returns true if the rate actually changed.
async function applySubRate(stripe, acct, subId, sub, ladderPct, welcomeActive) {
  const want = await subRateFor(stripe, acct, subId, sub, ladderPct, welcomeActive);
  if (want === null) return false;                                  // undecidable -> leave alone
  const cur = (sub.application_fee_percent != null) ? Number(sub.application_fee_percent) : null;
  if (cur === want) return false;
  const md = Object.assign({}, (sub && sub.metadata) || {});
  if (md.mtl_acq === '1' && want !== 0 && want === ladderPct) md.mtl_acq = 'done';   // window closed
  await stripe.subscriptions.update(subId, { application_fee_percent: want, metadata: md }, { stripeAccount: acct });
  return true;
}

async function handler(req, res) {
  // Ověření, že volá Vercel cron (nebo externí scheduler se správným tajemstvím)
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const gyms = await sbGet('gyms?status=eq.approved&select=id,name,owner_id,schedule,timezone');
    const mutedRem = new Set(((await sbGet('profiles?mute_class_reminder=eq.true&select=id')) || []).map(pp => pp.id));
    let created = 0; let purged = 0; let purgedG = 0; let autoRefunded = 0;
    for (const gym of gyms) {
      let sch = [];
      try { sch = gym.schedule ? (typeof gym.schedule === 'string' ? JSON.parse(gym.schedule) : gym.schedule) : []; } catch (e) {}
      if (!sch.length) continue;

      const { date, dow, mins } = gymNow(gym.timezone);
      const due = sch.filter(c => {
        if (Number(c.day) !== dow) return false;
        const t = String(c.time || '').split(':');
        const h = Number(t[0]), m = Number(t[1] || 0);
        if (isNaN(h)) return false;
        const diff = (mins - (h * 60 + m)) / 60;
        return diff >= 2 && diff <= 12; // lekce začala 2–12 h zpět
      });
      if (!due.length) continue;

      const att = await sbGet(`gym_attendance?gym_id=eq.${gym.id}&class_date=eq.${date}&select=class_name,class_time`);
      const attSet = new Set((att || []).map(a => `${a.class_time}|${a.class_name || ''}`));
      const rem = await sbGet(`attend_reminders?gym_id=eq.${gym.id}&class_date=eq.${date}&select=class_name,class_time`);
      const remSet = new Set((rem || []).map(r => `${r.class_time}|${r.class_name || ''}`));

      for (const c of due) {
        const key = `${c.time}|${c.name || ''}`;
        if (attSet.has(key) || remSet.has(key)) continue;
        const coachId = c.coach || gym.owner_id;
        // marker (unique) → sdílený dedup s client-side; konflikt = už připomenuto
        const mk = await sbPost('attend_reminders', { gym_id: gym.id, coach_id: coachId, class_name: c.name || null, class_date: date, class_time: c.time || null });
        if (!mk.ok) continue;
        await sbPost('notifications', {
          user_id: coachId, type: 'system', read: false,
          data: JSON.stringify({ kind: 'attend_reminder', gym_id: gym.id, gym_name: gym.name || '', className: c.name || '', date, time: c.time || '', day: dow }),
          message: `📋 Doplň docházku na proběhlou lekci ${c.name || ''} (${c.time || ''}).`,
        });
        created++;
      }

      // ── Class reminders (~8 h before start): gym classes & drop-ins, gym-local time ──
      try {
        const win = (cm) => { const d = cm - mins; return d >= 450 && d <= 510; }; // ~8h ahead (7.5–8.5h): matches the 8h client no-remind threshold and clears the 6h Stripe cancel deadline; 60-min wide so the 30-min cron never skips it
        const resv = await sbGet(`gym_class_reservations?gym_id=eq.${gym.id}&class_date=eq.${date}&reminder_sent=eq.false&select=id,student_id,class_name,class_time,status`);
        for (const r of (resv || [])) {
          if (!r.student_id || mutedRem.has(r.student_id) || r.status === 'released' || r.status === 'cancelled') continue;
          const t = String(r.class_time || '').split(':'); const cm = Number(t[0]) * 60 + Number(t[1] || 0);
          if (isNaN(cm) || !win(cm)) continue;
          const pk = await sbPatch('gym_class_reservations', `id=eq.${r.id}&reminder_sent=eq.false`, { reminder_sent: true });
          if (!pk.ok) continue;
          await sbPost('notifications', { user_id: r.student_id, type: 'system', read: false, data: JSON.stringify({ kind: 'class_reminder', label: r.class_name || 'Your class', time: r.class_time || '' }), message: `⏰ Připomínka: ${r.class_name || 'tvůj trénink'} brzy začíná (${r.class_time || ''}). Máš zdravotní omezení? Řekni ho v profilu, uvidí jen tvůj kouč.` });
          created++;
        }
        const drops = await sbGet(`gym_bookings?gym_id=eq.${gym.id}&class_date=eq.${date}&reminder_sent=eq.false&status=eq.active&select=id,student_id,class_name,class_time,coach_id`);
        const _coachNm = {};
        for (const b of (drops || [])) {
          if (!b.student_id || mutedRem.has(b.student_id)) continue;
          const t = String(b.class_time || '').split(':'); const cm = Number(t[0]) * 60 + Number(t[1] || 0);
          if (isNaN(cm) || !win(cm)) continue;
          const pk = await sbPatch('gym_bookings', `id=eq.${b.id}&reminder_sent=eq.false`, { reminder_sent: true });
          if (!pk.ok) continue;
          let _cn = '';
          if (b.coach_id) { if (_coachNm[b.coach_id] === undefined) { try { const cp = await sbGet(`profiles?id=eq.${b.coach_id}&select=name`); _coachNm[b.coach_id] = (cp[0] && cp[0].name) || ''; } catch (e) { _coachNm[b.coach_id] = ''; } } _cn = _coachNm[b.coach_id]; }
          const _lbl = (b.class_name || 'tvůj trénink') + (_cn ? ' s koučem ' + _cn : '');
          await sbPost('notifications', { user_id: b.student_id, type: 'system', read: false, data: JSON.stringify({ kind: 'class_reminder', label: _lbl, time: b.class_time || '' }), message: `⏰ Připomínka: ${_lbl} brzy začíná (${b.class_time || ''}). Máš zdravotní omezení? Řekni ho v profilu, uvidí jen tvůj kouč.` });
          created++;
        }
      } catch (e) { console.error('cron reminder', e.message); }
    }
    // ── 1:1 lesson reminders (~8 h before): student + coach, in the coach's timezone ──
    try {
      const dISO = (d) => d.toISOString().slice(0, 10);
      const nowD = new Date();
      const lo = dISO(new Date(nowD.getTime() - 86400000)), hi = dISO(new Date(nowD.getTime() + 2 * 86400000));
      const bks = await sbGet(`bookings?type=neq.online&status=eq.active&training_date=gte.${lo}&training_date=lte.${hi}&or=(reminder_sent.eq.false,coach_reminder_sent.eq.false)&select=id,coach_id,student_id,coach_name,training_date,training_time,reminder_sent,coach_reminder_sent`);
      if (bks && bks.length) {
        const coachIds = [...new Set(bks.map(b => b.coach_id).filter(Boolean))];
        const tzMap = {};
        if (coachIds.length) { const profs = await sbGet(`profiles?id=in.(${coachIds.join(',')})&select=id,timezone`); (profs || []).forEach(p => tzMap[p.id] = p.timezone || 'UTC'); }
        const coachMuted = new Set(((await sbGet('profiles?mute_coach_lesson_reminder=eq.true&select=id')) || []).map(p => p.id));
        for (const b of bks) {
          if (!b.training_date || !b.coach_id) continue;
          const { date, mins } = gymNow(tzMap[b.coach_id] || 'UTC');
          if (b.training_date !== date) continue;
          const t = String(b.training_time || '').split(':'); const cm = Number(t[0]) * 60 + Number(t[1] || 0);
          if (isNaN(cm)) continue; const diff = cm - mins; if (diff < 450 || diff > 510) continue; // ~8h ahead, aligned with the group-class window
          if (b.reminder_sent === false && b.student_id && !mutedRem.has(b.student_id)) {
            const pk = await sbPatch('bookings', `id=eq.${b.id}&reminder_sent=eq.false`, { reminder_sent: true });
            if (pk.ok) { await sbPost('notifications', { user_id: b.student_id, type: 'system', read: false, data: JSON.stringify({ kind: 'class_reminder', label: (b.coach_name ? ('Lekce s ' + b.coach_name) : 'Tvoje lekce'), time: b.training_time || '' }), message: `⏰ Připomínka: lekce${b.coach_name ? (' s ' + b.coach_name) : ''} brzy začíná (${b.training_time || ''}). Máš zdravotní omezení? Řekni ho v profilu, uvidí jen tvůj kouč.` }); created++; }
          }
          if (b.coach_reminder_sent === false && !coachMuted.has(b.coach_id)) {
            const pk = await sbPatch('bookings', `id=eq.${b.id}&coach_reminder_sent=eq.false`, { coach_reminder_sent: true });
            if (pk.ok) { await sbPost('notifications', { user_id: b.coach_id, type: 'system', read: false, data: JSON.stringify({ kind: 'coach_lesson_reminder', student: b.student_name || 'student', date: b.training_date, time: b.training_time || '' }), message: `⏰ Lekce s ${b.student_name || 'studentem'} brzy (${b.training_date} ${b.training_time || ''}).` }); created++; }
          }
        }
      }
    } catch (e) { console.error('cron 1:1 reminder', e.message); }

    // ── Dispute auto-refund: online disputes routed to the coach, past the 3-day deadline, still open => refund student 100% and close ──
    try {
      const nowISO = new Date().toISOString();
      // The refund now happens the moment a dispute is filed, so this sweep is only a safety net
      // for reports whose refund call failed at the time -- dispute_status still 'open' past the
      // deadline. Without the guard it would refund a second time.
      const od = await sbGet(`bookings?dispute_handler=eq.coach&dispute_status=eq.open&dispute_deadline=lt.${encodeURIComponent(nowISO)}&select=id,coach_id,student_id,payment_intent,gym_id,amount`);
      for (const b of (od || [])) {
        let acct = null;
        if (b.gym_id) { const g = await sbGet(`gyms?id=eq.${b.gym_id}&select=stripe_account`); acct = g[0] && g[0].stripe_account; }
        if (!acct && b.coach_id) { const c = await sbGet(`profiles?id=eq.${b.coach_id}&select=stripe_account`); acct = c[0] && c[0].stripe_account; }
        if (acct && b.payment_intent) { try { await stripe.refunds.create({ payment_intent: b.payment_intent }, { stripeAccount: acct }); } catch (e) { console.error('dispute refund', b.id, e.message); } }
        await sbPatch('bookings', `id=eq.${b.id}`, { dispute_status: 'refunded', status: 'refunded', refund_requested: false, dispute_auto: true });
        if (b.student_id) await sbPost('notifications', { user_id: b.student_id, type: 'system', read: false, data: JSON.stringify({ kind: 'dispute_auto_refunded', id: b.id }), message: `\u21a9\ufe0f Spor #${b.id}: pen\u00edze se ti vr\u00e1tily v pln\u00e9 v\u00fd\u0161i.` });
        autoRefunded++;
      }

      // Flagging runs on REPORTS, not on refunds, and it runs on BOTH sides. Counting auto-refunds
      // stopped working once the money moves immediately, and only the student was ever watched --
      // so the side that is usually in the right was the only one being policed.
      try {
        const recent = await sbGet(`bookings?dispute_status=in.(open,refunded)&select=id,student_id,coach_id,refund_reason`);
        const byStudent = {}, byCoach = {};
        for (const b of (recent || [])) {
          if (b.student_id) byStudent[b.student_id] = (byStudent[b.student_id] || 0) + 1;
          if (b.coach_id) byCoach[b.coach_id] = (byCoach[b.coach_id] || 0) + 1;
        }
        const flag = async (id, cnt, what) => {
          const pr = await sbGet(`profiles?id=eq.${encodeURIComponent(id)}&select=risk_flag,name`);
          if (!pr[0] || pr[0].risk_flag) return;
          await sbPatch('profiles', `id=eq.${encodeURIComponent(id)}`, { risk_flag: true, risk_note: `auto: ${cnt} ${what}` });
          await sbPost('notifications', { user_id: FOUNDER_ID, type: 'dispute', read: false, data: JSON.stringify({ kind: 'risk_autoflag', who: id, count: cnt, what }), message: `\ud83d\udea9 ${pr[0].name || id}: ${cnt}\u00d7 ${what} \u2014 oznaceno k posouzeni.` });
        };
        for (const id in byStudent) if (byStudent[id] >= 3) await flag(id, byStudent[id], 'nahlasenych sporu');
        for (const id in byCoach) if (byCoach[id] >= 3) await flag(id, byCoach[id], 'sporu proti nemu');
      } catch (e) { console.error('risk flagging', e.message); }
    } catch (e) { console.error('cron dispute auto-refund', e.message); }

    // ── Purge accounts/gyms past the 30-day deletion grace (anonymize PII, keep rows for booking/accounting FK integrity) ──
    try {
      const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
      const delProfiles = await sbGet(`profiles?deleted_at=lt.${encodeURIComponent(cutoff)}&purged_at=is.null&select=id`);
      for (const pr of (delProfiles || [])) {
        await sbPatch('profiles', `id=eq.${pr.id}`, { name: 'Deleted user', photo: null, bio: null, coach_status: 'deleted', purged_at: new Date().toISOString() });
        try { await fetch(`${SB}/auth/v1/admin/users/${pr.id}`, { method: 'DELETE', headers: sbHeaders }); } catch (e) {}
        purged++;
      }
      const delGyms = await sbGet(`gyms?deleted_at=lt.${encodeURIComponent(cutoff)}&purged_at=is.null&select=id`);
      for (const g of (delGyms || [])) {
        await sbPatch('gyms', `id=eq.${g.id}`, { name: 'Deleted gym', photos: null, description: null, status: 'deleted', purged_at: new Date().toISOString() });
        purgedG++;
      }
    } catch (e) { console.error('cron purge', e.message); }

    // --- Welcome 0% -> base rate: once a provider's welcome window ends, bump their still-0% subscriptions to base ---
    let welcomeRerated = 0;
    try {
      const nowIso = new Date().toISOString();
      const ended = await sbGet(`profiles?welcome_free_until=lt.${encodeURIComponent(nowIso)}&welcome_rerated=is.false&select=id,stripe_account,partner,coach_ref_score,bankai_eligible`);
      for (const p of (Array.isArray(ended) ? ended : [])) {
        try {
          // The owner's CURRENT ladder rate, computed live - not mtl_acq_base from metadata,
          // which was stamped when the subscription was created and is stale the moment the
          // owner crosses a tier. Stripe track (this only ever touches Stripe subscriptions).
          const _sc = p.coach_ref_score || 0;
          const ladderPct = p.partner ? 1 : ((_sc >= 5 && p.bankai_eligible) ? 2 : (_sc >= 2 ? 2.5 : 3));
          // gyms has no gym_payout_account column -- that lives on profiles. Naming it here made
          // PostgREST reject the whole query, so this block silently did nothing.
          const pGyms = await sbGet(`gyms?owner_id=eq.${p.id}&select=id,stripe_account`);
          for (const g of (Array.isArray(pGyms) ? pGyms : [])) {
            const acct = g.gym_payout_account || g.stripe_account;
            if (!acct) continue;
            const subs = await sbGet(`gym_memberships?gym_id=eq.${g.id}&status=eq.active&or=(paid_to.is.null,paid_to.eq.gym)&select=stripe_subscription`);
            for (const m of (Array.isArray(subs) ? subs : [])) {
              if (!m.stripe_subscription) continue;
              try {
                const sub = await stripe.subscriptions.retrieve(m.stripe_subscription, { stripeAccount: acct });
                // Was: only ever fired at 0% and always restored the BASE rate - which threw the
                // acquisition fee away for any gym that happened to be in its welcome window, and
                // never dropped a 10% acquisition sub back at all. Now it simply puts every sub on
                // whatever rate is correct right now (acquisition inside the 2-month window, base after).
                // welcome has ENDED for this provider, so welcomeActive=false: the sub lands on
                // the acquisition rate on their first month only, else the ladder. (Was: first 2 months.)
                if (await applySubRate(stripe, acct, m.stripe_subscription, sub, ladderPct, false)) welcomeRerated++;
              } catch (e) { console.error('welcome rerate sub', m.stripe_subscription, e.message); }
            }
          }
          // coach-owned subscriptions: paid directly to the coach (paid_to='coach') on the coach's own Stripe account
          if (p.stripe_account) {
            const cSubs = await sbGet(`gym_memberships?coach_id=eq.${p.id}&status=eq.active&paid_to=eq.coach&select=stripe_subscription`);
            for (const m of (Array.isArray(cSubs) ? cSubs : [])) {
              if (!m.stripe_subscription) continue;
              try {
                const sub = await stripe.subscriptions.retrieve(m.stripe_subscription, { stripeAccount: p.stripe_account });
                if (await applySubRate(stripe, p.stripe_account, m.stripe_subscription, sub, ladderPct, false)) welcomeRerated++;
              } catch (e) { console.error('welcome rerate coach sub', m.stripe_subscription, e.message); }
            }
          }
          await sbPatch('profiles', `id=eq.${p.id}`, { welcome_rerated: true });
        } catch (e) { console.error('welcome rerate provider', p.id, e.message); }
      }
    } catch (e) { console.error('cron welcome rerate', e.message); }

    res.status(200).json({ ok: true, gyms: gyms.length, created, purged, purgedG, autoRefunded, welcomeRerated });
  } catch (err) {
    console.error('cron-attendance error:', err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
}
