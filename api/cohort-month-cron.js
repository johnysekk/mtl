// /api/cohort-month-cron — the monthly "collect the next month" reminder for multi-month courses.
//
// The course payment model is: deposit + first-month remainder settles month 1; each further month
// is a full monthly (tier) payment, collected like an on-site payer buying one more month. Nothing
// was reminding anyone to collect months 2..N, so this cron does it.
//
// For each enrolled member of a running, multi-month course it works out which month the course is
// in now (from start_date) and compares to months_paid. If a month is due (and not the final-month
// overrun), it nudges:
//   - the STUDENT in-app when they have a profile (student_id), with a deep link to pay;
//   - and always the GYM OWNER, so accountless (ad-sourced) members still get collected.
// A per-member+month stamp (cohort_month_nudges) keeps it to one nudge per member per month.
//
// Runs daily. Add to vercel.json:
//   { "path": "/api/cohort-month-cron", "schedule": "0 6 * * *" }

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts && opts.headers),
    },
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// Which month's payment should be DUE by now. We don't wait for the full calendar month to elapse:
// the reminder for month N fires ~25 days (REMIND_DAY) into month N-1, i.e. before that month runs
// out, so the member pays ahead rather than in arrears. days since start = D; the highest N whose
// window start ((N-1)*MONTH_DAYS + REMIND_DAY days) has passed is the month currently due.
const MONTH_DAYS = 30;
const REMIND_DAY = 25; // ~3.5 weeks into the running month
function dueMonth(startISO, now) {
  const s = new Date(startISO + 'T00:00:00');
  if (isNaN(s.getTime())) return 1;
  const days = Math.floor((now - s) / 86400000);
  // month 2 becomes due at day 25, month 3 at day 55, month N at (N-2)*30 + 25
  let n = 1;
  while (days >= (n - 1) * MONTH_DAYS + REMIND_DAY) n += 1;
  return n; // 1 = nothing beyond month 1 due yet
}

export default async function handler(req, res) {
  const secret = req.headers['x-cron-secret'] || (req.query && req.query.secret);
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const now = new Date();
  const stamp = now.toISOString();
  let nudged = 0, skipped = 0;

  try {
    // running, multi-month courses only
    const cohorts = await sb(
      `gym_cohorts?select=id,gym_id,owner_id,name,months,start_date,status` +
      `&status=in.(open,running)&months=gt.1&limit=500`
    );

    for (const c of cohorts || []) {
      if (!c.start_date) continue;
      const totalMonths = Number(c.months || 1);
      const curMonth = Math.min(totalMonths, dueMonth(c.start_date, now)); // 1-based month whose payment is due now
      if (curMonth < 2) continue; // month 1 is the deposit+remainder, handled elsewhere

      // enrolled members who have paid fewer months than the course is currently in
      const members = await sb(
        `cohort_members?cohort_id=eq.${encodeURIComponent(c.id)}` +
        `&status=in.(enrolled,deposit_paid,converted)` +
        `&select=id,student_id,name,email,months_paid`
      );
      for (const mem of members || []) {
        const paid = Number(mem.months_paid || 0);
        if (paid >= curMonth) { skipped++; continue; } // already settled this month
        if (paid >= totalMonths) { skipped++; continue; } // course fully paid

        // one nudge per member per month index
        const key = `${mem.id}:${curMonth}`;
        const seen = await sb(`cohort_month_nudges?nudge_key=eq.${encodeURIComponent(key)}&select=id`);
        if (seen && seen.length) { skipped++; continue; }

        const payLink = `https://app.martialtraininglab.com/?cohortpay=${encodeURIComponent(mem.id)}`;

        // student in-app nudge (only if they have a profile)
        if (mem.student_id) {
          try {
            await sb('notifications', {
              method: 'POST',
              body: JSON.stringify({
                user_id: mem.student_id, type: 'system', read: false,
                data: JSON.stringify({ kind: 'cohort_month_due', cohort_id: c.id, cohort_member_id: mem.id, month: curMonth, total: totalMonths }),
                message: `🥊 Kurz „${c.name || 'kurz'}\" — je čas doplatit ${curMonth}. měsíc z ${totalMonths}.`,
              }),
            });
          } catch (e) { console.error('student nudge', mem.id, e.message); }
        }

        // gym owner reminder (always — covers accountless members)
        if (c.owner_id) {
          try {
            await sb('notifications', {
              method: 'POST',
              body: JSON.stringify({
                user_id: c.owner_id, type: 'system', read: false,
                data: JSON.stringify({ kind: 'cohort_month_collect', cohort_id: c.id, cohort_member_id: mem.id, member_name: mem.name || '', month: curMonth, total: totalMonths }),
                message: `💸 Kurz „${c.name || 'kurz'}\": vyber ${curMonth}. měsíc od ${mem.name || 'účastníka'} (${curMonth}/${totalMonths}).`,
              }),
            });
          } catch (e) { console.error('owner nudge', mem.id, e.message); }
        }

        // stamp so we don't nudge again this month
        try { await sb('cohort_month_nudges', { method: 'POST', body: JSON.stringify({ nudge_key: key, cohort_member_id: mem.id, month: curMonth, created_at: stamp }) }); } catch (e) {}
        nudged++;
      }
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  return res.status(200).json({ ok: true, nudged, skipped });
}
