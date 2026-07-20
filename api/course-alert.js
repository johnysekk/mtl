// /api/course-alert — organic MTL channel for new courses.
//
// When a club publishes a course, everyone who tapped "tell me when this club opens a new course"
// on the club profile gets an in-app notification whose click-through lands on the SAME
// ?cohort=<id> signup form the club's Meta ads point at — tagged src=mtl_alert so the roster can
// prove how many signups the platform brought vs how many the club paid Meta for.
//
// POST { cohort_id, token }  ->  { ok, notified, skipped }
//
// Fan-out runs SERVER-SIDE on purpose: a club with a few thousand followers would need thousands
// of inserts, and the browser is the wrong place for that (slow, dies on navigation, and the
// client is RLS-subject). Same rule as every other heavy job in MTL.
//
// Idempotency: gym_cohorts.alert_sent_at is stamped BEFORE the fan-out, so re-saving or
// double-clicking a course can never spam the same followers twice.
//
// Security: the caller must be the OWNER of the cohort's gym. Without that check anyone could
// make a club blast its followers.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { ...svc, Prefer: opts.prefer || 'return=representation' },
    body: opts.body,
  });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = txt; }
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method' });

  try {
    if (!SB || !KEY) return res.status(500).json({ ok: false, error: 'server not configured' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const cohortId = b.cohort_id;
    const token = req.headers['x-access-token'] || b.token ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!cohortId) return res.status(400).json({ ok: false, error: 'no cohort_id' });
    if (!token) return res.status(401).json({ ok: false, error: 'no token' });

    // 1) who is calling
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ ok: false, error: 'bad token' });
    const uid = (await ures.json() || {}).id;
    if (!uid) return res.status(401).json({ ok: false, error: 'no user' });

    // 2) the cohort
    const cr = await sb(`gym_cohorts?id=eq.${encodeURIComponent(cohortId)}&select=id,gym_id,owner_id,name,discipline,start_date,status,alert_sent_at&limit=1`);
    const c = cr && cr[0];
    if (!c) return res.status(404).json({ ok: false, error: 'cohort not found' });
    if (c.status !== 'open') return res.status(200).json({ ok: true, notified: 0, skipped: 'not open' });
    if (c.alert_sent_at) return res.status(200).json({ ok: true, notified: 0, skipped: 'already sent' });

    // 3) caller must own the club (or be the cohort owner)
    const gr = await sb(`gyms?id=eq.${encodeURIComponent(c.gym_id)}&select=id,name,owner_id&limit=1`);
    const gym = gr && gr[0];
    if (!gym) return res.status(404).json({ ok: false, error: 'gym not found' });
    if (gym.owner_id !== uid && c.owner_id !== uid) return res.status(403).json({ ok: false, error: 'not owner' });

    // 4) stamp FIRST — a crash mid-fan-out must never re-blast on the next attempt
    await sb(`gym_cohorts?id=eq.${encodeURIComponent(cohortId)}`, {
      method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify({ alert_sent_at: new Date().toISOString() }),
    });

    // 5) followers. A NULL discipline on the alert row means "any course from this club";
    //    a set discipline only matches courses in that discipline, so a BJJ-only follower is not
    //    pinged about the kids' boxing course.
    const subs = await sb(`course_alerts?gym_id=eq.${encodeURIComponent(c.gym_id)}&select=user_id,discipline&limit=20000`);
    const seen = new Set();
    const targets = [];
    for (const srow of (subs || [])) {
      if (!srow.user_id) continue;
      if (srow.user_id === gym.owner_id) continue;              // never notify the club about itself
      if (srow.discipline && c.discipline && srow.discipline !== c.discipline) continue;
      if (seen.has(srow.user_id)) continue;
      seen.add(srow.user_id);
      targets.push(srow.user_id);
    }
    if (!targets.length) return res.status(200).json({ ok: true, notified: 0 });

    // 6) insert in chunks — one giant POST body is how you get a 413 on a popular club
    const data = JSON.stringify({
      kind: 'course_new', cohort_id: c.id, gym_id: c.gym_id,
      gym_name: gym.name || '', name: c.name || '', start_date: c.start_date || null,
    });
    const message = `\u{1F94B} ${gym.name || 'Klub'} vypsal nov\u00fd kurz: ${c.name || ''}${c.start_date ? (' \u00b7 za\u010d\u00e1tek ' + c.start_date) : ''}. P\u0159ihl\u00e1\u0161ky jsou otev\u0159en\u00e9.`;
    const CHUNK = 200;
    let notified = 0;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const batch = targets.slice(i, i + CHUNK).map(u => ({ user_id: u, type: 'system', read: false, data, message }));
      try {
        await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(batch) });
        notified += batch.length;
      } catch (e) { console.error('course-alert chunk', e.message); }
    }

    return res.status(200).json({ ok: true, notified });
  } catch (e) {
    console.error('course-alert', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
