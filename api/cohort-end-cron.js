// /api/cohort-end-cron — closes cohorts whose end_date has passed.
//
// Two things went unfinished before this existed:
//   1. `completed` was counted in the owner's funnel but NOTHING ever set it. Everyone who finished
//      a course stayed `enrolled` forever, so the owner could not tell who saw it through.
//   2. A cohort's status never changed. Once end_date passed it stayed `open`, and the public page
//      happily kept selling non-refundable deposits into a course that had already finished.
//
// And the part that actually earns money: conversion to a membership is AUTOMATIC (buying a
// membership matches the cohort_member by student_id or email and flips it to `converted`). What
// the owner forgets is not to convert — it is to ASK. And asking AFTER the course has finished is
// too late: the group has scattered and the momentum is gone. So the nudges land 14 and 7 days
// BEFORE the end date, while everyone is still in the room and can be prepared for what comes
// next. Plenty of them will raise it themselves once it has been mentioned.
//
// Runs daily. Add to vercel.json:
//   { "path": "/api/cohort-end-cron", "schedule": "0 5 * * *" }

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

export default async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` plus an `x-vercel-cron` header.
  // It does NOT send `x-cron-secret`, and vercel.json carries no `?secret=`, so the previous
  // gate rejected every scheduled run with 401. Same shape as commission-cron.js.
  if (process.env.CRON_SECRET) {
    const _auth = req.headers.authorization || '';
    if (!(_auth === `Bearer ${process.env.CRON_SECRET}` || req.headers['x-vercel-cron'])) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const now = new Date();
  const day = (n) => new Date(now.getTime() + n * 86400000).toISOString().slice(0, 10);
  const todayStr = now.toISOString().slice(0, 10);
  const plural = (n) => (n === 1 ? 'účastník' : n < 5 ? 'účastníci' : 'účastníků');

  // Who to talk to: in the course, no membership yet.
  const warmCount = async (cohortId) => {
    const rows = await sb(
      `cohort_members?cohort_id=eq.${encodeURIComponent(cohortId)}` +
        `&status=in.(deposit_paid,enrolled,completed)&select=id`
    );
    return (rows || []).length;
  };
  const ownerOf = async (c) => {
    if (c.owner_id) return c.owner_id;
    try {
      const g = await sb(`gyms?id=eq.${encodeURIComponent(c.gym_id)}&select=owner_id`);
      return (g && g[0] && g[0].owner_id) || null;
    } catch (e) { return null; }
  };

  let warned = 0, closed = 0, completed = 0;

  // ---- 1. PRE-END NUDGES: 14 days out, then 7 -------------------------------------------------
  // Each milestone fires once, tracked by gym_cohorts.end_warned. The guard is `end_warned > 0 &&
  // end_warned <= days`, so the 7-day nudge still goes out after the 14-day one, but neither
  // repeats and 14 can never re-fire once 7 has been sent.
  for (const days of [14, 7]) {
    try {
      const due = await sb(
        `gym_cohorts?select=id,gym_id,owner_id,name,end_date,end_warned` +
          `&status=in.(open,running)&end_date=eq.${day(days)}&limit=200`
      );
      for (const c of due || []) {
        if (Number(c.end_warned || 0) > 0 && Number(c.end_warned) <= days) continue;
        const owner = await ownerOf(c);
        const n = await warmCount(c.id);
        if (!owner || !n) continue;
        try {
          await sb('notifications', {
            method: 'POST',
            body: JSON.stringify({
              user_id: owner,
              type: 'system',
              read: false,
              data: JSON.stringify({
                kind: 'cohort_ending', cohort_id: c.id, gym_id: c.gym_id,
                cohort_name: c.name || '', count: n, days,
              }),
              message: `🎓 Kurz „${c.name || 'kurz'}" končí ${days === 14 ? 'za 2 týdny' : 'za týden'}. ${n} ${plural(n)} zatím bez členství — začni je připravovat na to, co bude dál.`,
            }),
          });
          await sb(`gym_cohorts?id=eq.${encodeURIComponent(c.id)}`, {
            method: 'PATCH', body: JSON.stringify({ end_warned: days }),
          });
          warned++;
        } catch (e) { console.error('nudge', c.id, e.message); }
      }
    } catch (e) { console.error('pre-end', days, e.message); }
  }

  // ---- 2. SIGNUPS CLOSE ~2 DAYS AFTER THE COURSE STARTS -----------------------------------
  // Nobody should be paying a deposit into a course that is already running. Two days of slack
  // covers the genuine late joiner; after that the only way in is as a WALK-IN the club adds by
  // hand. `running` and `done` already existed in the UI's status map (Běží / Dokončený) — nothing
  // ever set them. cohort-pay and cohort-public whitelist `open`, so the gate holds even before
  // this cron runs; flipping the status just makes it visible to the owner and stops the public
  // page pretending the course is still taking signups.
  const SIGNUPS_GRACE_DAYS = 2;
  let running = 0;
  try {
    const started = await sb(
      `gym_cohorts?select=id,name,start_date` +
        `&status=eq.open&start_date=not.is.null&start_date=lt.${day(-SIGNUPS_GRACE_DAYS)}&limit=200`
    );
    for (const c of started || []) {
      try {
        await sb(`gym_cohorts?id=eq.${encodeURIComponent(c.id)}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'running' }),
        });
        running++;
      } catch (e) { console.error('running', c.id, e.message); }
    }
  } catch (e) { console.error('start cutoff', e.message); }

  // ---- 3. FINISH COHORTS PAST THEIR END DATE ------------------------------------------------
  // Must accept BOTH open and running: a cohort whose signups already closed is `running`, and
  // filtering on `open` alone would leave it hanging forever with nobody ever marked completed.
  try {
    const done = await sb(
      `gym_cohorts?select=id,gym_id,owner_id,name,end_date` +
        `&status=in.(open,running)&end_date=not.is.null&end_date=lt.${todayStr}&limit=200`
    );
    for (const c of done || []) {
      try {
        const fin = await sb(`cohort_members?cohort_id=eq.${encodeURIComponent(c.id)}&status=eq.enrolled&select=id`);
        if ((fin || []).length) {
          await sb(`cohort_members?cohort_id=eq.${encodeURIComponent(c.id)}&status=eq.enrolled`, {
            method: 'PATCH', body: JSON.stringify({ status: 'completed' }),
          });
          completed += fin.length;
        }
        await sb(`gym_cohorts?id=eq.${encodeURIComponent(c.id)}`, {
          method: 'PATCH', body: JSON.stringify({ status: 'done' }),
        });
        closed++;
      } catch (e) { console.error('finish', c.id, e.message); }
    }
  } catch (e) { console.error('finishing', e.message); }

  return res.status(200).json({ ok: true, warned, running, finished: closed, completed });
}
