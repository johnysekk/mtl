// /api/release-cron.js
// Runs every ~10 min. Two passes:
//  (1) AUTO-RELEASE: gym_bookings with payment_method='qr' AND status='reserved'
//      (student has NOT tapped "I've paid") whose class starts within RELEASE_LEAD (45) min
//      in the GYM's local timezone -> status='released' + free the gym_class_reservations
//      slot-hold + notify the student. Bookings in status 'paid_claimed' are NEVER touched
//      (the student claims they paid -> the owner must confirm/deny in Reception).
//  (2) CLEANUP: gym_memberships with status='pending_offline' older than STALE_HOURS (48)
//      -> status='ended'. These are abandoned online membership intents where the student
//      opened the QR but never paid and nobody confirmed; expiring them clears the owner's
//      "QR payments to confirm" list and stops them piling up.
//
// vercel.json:  { "path": "/api/release-cron", "schedule": "*/10 * * * *" }
// Needs env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ; optional CRON_SECRET.

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RELEASE_LEAD = 45;   // minutes before class start to release an unpaid reservation
const STALE_HOURS  = 48;   // pending_offline membership intents older than this are expired
const DEFAULT_TZ   = 'Europe/Prague';

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

// current wall-clock time in a given IANA tz, returned as a naive Date whose fields equal the tz-local time
function nowInTz(tz) { try { return new Date(new Date().toLocaleString('en-US', { timeZone: tz || DEFAULT_TZ })); } catch (e) { return new Date(); } }
// scheduled class start as a naive Date (same "wall-clock as local" basis as nowInTz, so the two compare correctly)
function classStartNaive(date, time) { try { return new Date(`${date}T${(time || '00:00')}:00`); } catch (e) { return null; } }

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (!(auth === `Bearer ${process.env.CRON_SECRET}` || req.headers['x-vercel-cron'])) return res.status(401).json({ error: 'unauthorized' });
  }

  let released = 0, expired = 0;
  try {
    // ---- Pass 1: auto-release unpaid QR drop-in reservations near class start --------------
    const yest = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = await sb(`gym_bookings?payment_method=eq.qr&status=eq.reserved&class_date=gte.${yest}&select=id,gym_id,student_id,student_name,class_name,class_date,class_time,class_level&limit=3000`);

    const gymIds = [...new Set((rows || []).map(r => r.gym_id).filter(Boolean))];
    const tzMap = {};
    if (gymIds.length) {
      const gs = await sb(`gyms?id=in.(${gymIds.join(',')})&select=id,timezone,owner_id,name`);
      (gs || []).forEach(g => { tzMap[g.id] = { tz: g.timezone || DEFAULT_TZ, owner: g.owner_id, name: g.name }; });
    }

    for (const b of (rows || [])) {
      const gm = tzMap[b.gym_id] || { tz: DEFAULT_TZ };
      const start = classStartNaive(b.class_date, b.class_time);
      if (!start) continue;
      const now = nowInTz(gm.tz);
      const releaseAt = new Date(start.getTime() - RELEASE_LEAD * 60000);
      if (now < releaseAt) continue;

      await sb(`gym_bookings?id=eq.${b.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'released' }) });
      try {
        await sb(`gym_class_reservations?gym_id=eq.${encodeURIComponent(b.gym_id)}&student_id=eq.${encodeURIComponent(b.student_id)}&class_date=eq.${encodeURIComponent(b.class_date)}&class_time=eq.${encodeURIComponent(b.class_time || '')}&class_name=eq.${encodeURIComponent(b.class_name || '')}`, { method: 'DELETE', prefer: 'return=minimal' });
      } catch (e) {}
      try {
        if (b.student_id) {
          const msg = `Tvá nezaplacená rezervace (${b.class_name || 'lekce'}) byla uvolněna 45 min před začátkem. Pokud jsi zaplatil/a, klepni příště na „Zaplaceno“ hned po platbě, ať ti místo zůstane. / Your unpaid reservation was released 45 min before start — tap “I’ve paid” right after paying next time.`;
          await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id: b.student_id, type: 'system', read: false, data: JSON.stringify({ kind: 'qr_released', gym: b.gym_id, class: b.class_name || null }), message: msg }) });
        }
      } catch (e) {}
      released++;
    }

    // ---- Pass 2: expire abandoned pending_offline membership intents -----------------------
    const cutoff = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString();
    const stale = await sb(`gym_memberships?status=eq.pending_offline&created_at=lt.${encodeURIComponent(cutoff)}&select=id&limit=3000`);
    for (const m of (stale || [])) {
      await sb(`gym_memberships?id=eq.${m.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'ended' }) });
      expired++;
    }

    return res.status(200).json({ ok: true, released, expired });
  } catch (e) {
    return res.status(500).json({ error: e.message, released, expired });
  }
}
