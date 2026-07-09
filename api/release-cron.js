// /api/release-cron.js
// Runs every ~10 min. Two passes:
//  (1) AUTO-RELEASE: gym_bookings with payment_method='qr' AND status='reserved'
//      (student has NOT tapped "I've paid") whose class starts within RELEASE_LEAD (45) min
//      in the GYM's local timezone -> status='released' + free the gym_class_reservations
//      slot-hold + notify the student. Bookings in status 'paid_claimed' are NEVER touched
//      (the student claims they paid -> the owner must confirm/deny in Reception).
//  (3) 1:1 EXPIRY: bookings (coach 1:1) payment_method='qr' status='reserved' older than 30 min
//      -> status='expired' + free the held slot + notify. 'paid_claimed' is never touched.
//  (4) EVENT EXPIRY: event_tickets payment_method='qr' status='reserved' older than 30 min -> 'expired'.
//  (5) COVER EXPIRY: cover_requests status='open' whose class has already started -> 'expired'
//      (a substitute-cover request nobody accepted before the class start is dead).
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

  let released = 0, expired = 0, expired1h = 0, coverExpired = 0, pisExpired = 0;
  try {
    // ---- Pass 1: auto-release unpaid QR drop-in reservations near class start --------------
    const yest = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = await sb(`gym_bookings?payment_method=eq.qr&status=eq.reserved&pis_payment_id=is.null&class_date=gte.${yest}&select=id,gym_id,student_id,student_name,class_name,class_date,class_time,class_level&limit=3000`);

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

    // ---- Pass 3: expire unpaid QR coach 1:1 reservations 1 hour after booking --------------
    try {
      const cutoff1h = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min unpaid window
      const b1 = await sb(`bookings?payment_method=eq.qr&status=eq.reserved&created_at=lt.${encodeURIComponent(cutoff1h)}&select=id,slot_id,student_id,coach_name&limit=3000`);
      for (const b of (b1 || [])) {
        await sb(`bookings?id=eq.${b.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'expired' }) });
        if (b.slot_id) { try { await sb(`slots?id=eq.${encodeURIComponent(b.slot_id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ booked: false }) }); } catch (e) {} }
        try {
          if (b.student_id) {
            const msg = `Tvá nezaplacená rezervace (${b.coach_name || 'lekce'}) vypršela po 30 minutách a termín se uvolnil pro dalšího zájemce. / Your unpaid reservation expired after 30 minutes and the slot was freed.`;
            await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id: b.student_id, type: 'system', read: false, data: JSON.stringify({ kind: 'qr_reservation_expired' }), message: msg }) });
          }
        } catch (e) {}
        expired1h++;
      }
    } catch (e) { /* bookings pass non-fatal */ }

    // ---- Pass 4: expire unpaid QR event-ticket reservations 1 hour after booking ----------
    try {
      const cutoff1hE = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min unpaid window
      const e1 = await sb(`event_tickets?payment_method=eq.qr&status=eq.reserved&created_at=lt.${encodeURIComponent(cutoff1hE)}&select=id&limit=3000`);
      for (const t of (e1 || [])) {
        await sb(`event_tickets?id=eq.${t.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'expired' }) });
        expired1h++;
      }
    } catch (e) { /* events pass non-fatal */ }

    // ---- Pass 5: expire open cover (substitute) requests once the class has started ------
    // A 'Potrebuju zaskok' request that nobody accepted before the class start is dead;
    // mark it expired so it stops showing as an open request and can't be accepted late.
    try {
      const yc = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
      const crs = await sb(`cover_requests?status=eq.open&class_date=gte.${yc}&select=id,gym_id,class_date,class_time&limit=3000`);
      const cGymIds = [...new Set((crs || []).map(r => r.gym_id).filter(Boolean))];
      const cTz = {};
      if (cGymIds.length) { const cg = await sb(`gyms?id=in.(${cGymIds.join(',')})&select=id,timezone`); (cg || []).forEach(g => { cTz[g.id] = g.timezone || DEFAULT_TZ; }); }
      for (const r of (crs || [])) {
        const start = classStartNaive(r.class_date, r.class_time);
        if (!start) continue;
        const now = nowInTz(cTz[r.gym_id] || DEFAULT_TZ);
        if (now < start) continue; // class hasn't started yet
        await sb(`cover_requests?id=eq.${r.id}&status=eq.open`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'expired' }) });
        coverExpired++;
      }
    } catch (e) { /* cover pass non-fatal */ }

  // ---- Pass 6: expire abandoned/failed PIS gym-booking reservations after 2h -------------
  // PIS-in-progress is protected (Pass 1 skips pis_payment_id!=null). After 2h with no
  // confirmation we free the spot; pis-webhook STILL recovers it to 'active' if the payment
  // arrives late (Model A: money lands on the gym IBAN directly, so a late confirm = real money).
  try {
    const cutoffPis = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const pb = await sb(`gym_bookings?pis_payment_id=not.is.null&status=eq.reserved&created_at=lt.${encodeURIComponent(cutoffPis)}&select=id&limit=2000`);
    for (const b of (pb || [])) {
      await sb(`gym_bookings?id=eq.${b.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'expired' }) });
      pisExpired++;
    }
  } catch (e) { /* pis expiry pass non-fatal */ }

    // security: alert founder on auto-bans / loud offenders in the last window
    try {
      if (process.env.SECURITY_ALERT_EMAIL && process.env.RESEND_API_KEY) {
        const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        const bans = await sb('blocked_ips?blocked_at=gt.' + encodeURIComponent(since) + '&select=ip,reason,hits,expires_at&order=blocked_at.desc').catch(() => []);
        const loud = await sb('rate_limits?hits=gte.50&updated_at=gt.' + encodeURIComponent(since) + '&select=ip,endpoint,hits&order=hits.desc&limit=20').catch(() => []);
        if ((bans && bans.length) || (loud && loud.length)) {
          let html = '<h3>MTL security alert</h3>';
          if (bans && bans.length) html += '<p><b>Auto-banned (24h):</b></p><ul>' + bans.map(b => '<li>' + b.ip + ' &mdash; ' + (b.reason || '') + ' (' + b.hits + ' hits)</li>').join('') + '</ul>';
          if (loud && loud.length) html += '<p><b>Loud (throttled, not banned):</b></p><ul>' + loud.map(l => '<li>' + l.ip + ' &mdash; ' + l.endpoint + ' x' + l.hits + '</li>').join('') + '</ul>';
          html += '<p style="color:#888;font-size:12px">Unban: delete from blocked_ips where ip = \'...\';</p>';
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: process.env.MAIL_FROM || 'MTL Coaches <noreply@mtlcoaches.co>', to: [process.env.SECURITY_ALERT_EMAIL], subject: 'MTL security: ' + ((bans && bans.length) || 0) + ' bans, ' + ((loud && loud.length) || 0) + ' loud', html })
          }).catch(() => {});
        }
      }
    } catch (e) {}

    // housekeeping: drop stale rate-limit windows (>2h old)
    try { const _rlOld = new Date(Date.now() - 2*3600*1000).toISOString(); await sb('rate_limits?updated_at=lt.' + encodeURIComponent(_rlOld), { method: 'DELETE', prefer: 'return=minimal' }); } catch (e) {}

    return res.status(200).json({ ok: true, released, expired, expired1h, coverExpired, pisExpired });
  } catch (e) {
    return res.status(500).json({ error: e.message, released, expired, expired1h, coverExpired, pisExpired });
  }
}
