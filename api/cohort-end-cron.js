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
// the owner forgets is not to convert — it is to ASK. So the notification says exactly that.
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
  const secret = req.headers['x-cron-secret'] || (req.query && req.query.secret);
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const today = new Date().toISOString().slice(0, 10);
  let closed = 0;
  let completed = 0;
  const notified = [];

  try {
    // Cohorts that have finished but are still marked open.
    const cohorts = await sb(
      `gym_cohorts?select=id,gym_id,owner_id,name,end_date,status` +
        `&status=eq.open` +
        `&end_date=not.is.null` +
        `&end_date=lt.${today}` +
        `&limit=200`
    );

    for (const c of cohorts || []) {
      try {
        // Everyone still `enrolled` saw the course through.
        const done = await sb(
          `cohort_members?cohort_id=eq.${encodeURIComponent(c.id)}&status=eq.enrolled&select=id`
        );
        if ((done || []).length) {
          await sb(
            `cohort_members?cohort_id=eq.${encodeURIComponent(c.id)}&status=eq.enrolled`,
            { method: 'PATCH', body: JSON.stringify({ status: 'completed' }) }
          );
          completed += done.length;
        }

        await sb(`gym_cohorts?id=eq.${encodeURIComponent(c.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'closed' }),
        });
        closed++;

        // How many finished WITHOUT buying a membership — those are the ones to talk to.
        const openN = await sb(
          `cohort_members?cohort_id=eq.${encodeURIComponent(c.id)}` +
            `&status=in.(completed,enrolled,deposit_paid)&select=id`
        );
        const n = (openN || []).length;

        if (c.owner_id && n > 0) {
          await sb('notifications', {
            method: 'POST',
            body: JSON.stringify({
              user_id: c.owner_id,
              type: 'system',
              read: false,
              data: JSON.stringify({
                kind: 'cohort_ended',
                cohort_id: c.id,
                gym_id: c.gym_id,
                cohort_name: c.name || '',
                count: n,
              }),
              message: `🎓 Kurz „${c.name || 'kurz'}" skončil. ${n} ${
                n === 1 ? 'účastník' : n < 5 ? 'účastníci' : 'účastníků'
              } bez členství — oslov je s nabídkou, dokud jsou rozjetí.`,
            }),
          });
          notified.push(c.id);
        }
      } catch (e) {
        console.error('cohort', c.id, e.message);
      }
    }

    return res.status(200).json({ ok: true, closed, completed, notified: notified.length });
  } catch (e) {
    console.error('cohort-end-cron', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
