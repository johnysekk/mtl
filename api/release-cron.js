// /api/release-cron.js
// Runs every ~10 min. Two passes:
//  (1) AUTO-RELEASE: gym_bookings with payment_method='qr' AND status='reserved'
//      (student has NOT tapped "I've paid") older than 30 min since reservation
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

// RELEASE_LEAD retired — drop-in now releases 30 min after reservation (Pass 1), matching the in-app countdown
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

  let released = 0, expired = 0, expired1h = 0, coverExpired = 0, pisExpired = 0, nudged = 0, escalated = 0;
  try {
    // ---- Pass 1: auto-release unpaid QR drop-in reservations 30 min after reservation --------------
    const yest = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = await sb(`gym_bookings?payment_method=eq.qr&status=eq.reserved&pis_payment_id=is.null&class_date=gte.${yest}&select=requeued_at,id,gym_id,student_id,student_name,class_name,class_date,class_time,created_at&limit=3000`);

    const gymIds = [...new Set((rows || []).map(r => r.gym_id).filter(Boolean))];
    const tzMap = {};
    if (gymIds.length) {
      const gs = await sb(`gyms?id=in.(${gymIds.join(',')})&select=id,timezone,owner_id,name`);
      (gs || []).forEach(g => { tzMap[g.id] = { tz: g.timezone || DEFAULT_TZ, owner: g.owner_id, name: g.name }; });
    }

    for (const b of (rows || [])) {
      const gm = tzMap[b.gym_id] || { tz: DEFAULT_TZ };
      // release 30 min after reservation (matches the in-app 30-min countdown + coach 1:1 Pass 3);
      // the old 45-min-before-class rule did not match what the student was shown.
      // POZOR: po odmítnutí ("nedorazilo") jde rezervace zpátky na 'reserved' a odpočet začíná
      // ZNOVU od requeued_at. Dřív se počítal od created_at, takže rezervace vrácená po dvou
      // hodinách vypršela hned při dalším průchodu -- student ani nestihl zaplatit znovu.
      const _from = b.requeued_at || b.created_at;
      if (!_from || new Date(_from).getTime() > Date.now() - 30 * 60 * 1000) continue;

      await sb(`gym_bookings?id=eq.${b.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'released' }) });
      try {
        await sb(`gym_class_reservations?gym_id=eq.${encodeURIComponent(b.gym_id)}&student_id=eq.${encodeURIComponent(b.student_id)}&class_date=eq.${encodeURIComponent(b.class_date)}&class_time=eq.${encodeURIComponent(b.class_time || '')}&class_name=eq.${encodeURIComponent(b.class_name || '')}`, { method: 'DELETE', prefer: 'return=minimal' });
      } catch (e) {}
      try {
        if (b.student_id) {
          const msg = `Tvá nezaplacená rezervace (${b.class_name || 'lekce'}) vypršela po 30 minutách a místo se uvolnilo. Pokud jsi zaplatil/a, klepni příště na „Zaplaceno“ hned po platbě, ať ti místo zůstane. / Your unpaid reservation expired after 30 minutes — tap “I’ve paid” right after paying next time.`;
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

    // ---- Pass 3: expire unpaid QR coach 1:1 reservations 30 min after booking --------------
    try {
      const cutoff30m = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min unpaid window
      // Stejné pravidlo jako u vstupů: po odmítnutí běží 30 minut znovu od requeued_at.
      // Filtr proto bere i řádky, které byly vrácené, a rozhodne se až v cyklu.
      const b1 = await sb(`bookings?payment_method=eq.qr&status=eq.reserved&or=(created_at.lt.${encodeURIComponent(cutoff30m)},requeued_at.not.is.null)&select=id,slot_id,student_id,coach_name,created_at,requeued_at&limit=3000`);
      for (const b of (b1 || [])) {
        const _from1 = b.requeued_at || b.created_at;
        if (!_from1 || new Date(_from1).getTime() > Date.now() - 30 * 60 * 1000) continue;
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

    // ---- Pass 4: expire unpaid QR event-ticket reservations 30 min after booking ----------
    try {
      const cutoff30mE = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30 min unpaid window
      const e1 = await sb(`event_tickets?payment_method=eq.qr&status=eq.reserved&created_at=lt.${encodeURIComponent(cutoff30mE)}&select=id&limit=3000`);
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
            body: JSON.stringify({ from: process.env.MAIL_FROM || process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>', to: [process.env.SECURITY_ALERT_EMAIL], subject: 'MTL security: ' + ((bans && bans.length) || 0) + ' bans, ' + ((loud && loud.length) || 0) + ' loud', html })
          }).catch(() => {});
        }
      }
    } catch (e) {}

    // housekeeping: drop stale rate-limit windows (>2h old)
    try { const _rlOld = new Date(Date.now() - 2*3600*1000).toISOString(); await sb('rate_limits?updated_at=lt.' + encodeURIComponent(_rlOld), { method: 'DELETE', prefer: 'return=minimal' }); } catch (e) {}

    // ---- Pass 6: ZAPLACENO, ALE NIKDO NEPOTVRDIL --------------------------------------------
    // Student klepl na "Zaplaceno", poskytovatel to nepotvrdil ani nezamítl. Rezervace se NERUŠÍ:
    // peníze šly převodem přímo poskytovateli a MTL je nedrží, takže o nich nemůže rozhodnout.
    // Po 24 h se poskytovateli připomene, po 72 h ještě jednou a dozví se to i student.
    // Founderovi se to NEHLÁSÍ: je to věc mezi dvěma lidmi a při tisícovce klubů by to byl šum,
    // ve kterém zanikne všechno ostatní. Student má u takové rezervace tlačítka Připomenout /
    // Vyřešit a nová rezervace mu nic neblokuje.
    try {
      const H24 = new Date(Date.now() - 24 * 3600e3).toISOString();
      const H72 = new Date(Date.now() - 72 * 3600e3).toISOString();
      const note = async (uid, kind, cs, en, extra) => {
        if (!uid) return;
        try {
          await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({
            user_id: uid, type: 'system', read: false,
            data: JSON.stringify(Object.assign({ kind }, extra || {}, { msg_en: en })), message: cs }) });
        } catch (e) {}
      };
      const stale = [
        { tbl: 'bookings', sel: 'id,student_id,coach_id,coach_name,training_date,training_time,amount,currency,claimed_at,claim_reminded', what: r => '1:1 ' + (r.training_date || '') },
        { tbl: 'gym_bookings', sel: 'id,student_id,gym_id,gym_name,class_name,class_date,class_time,amount,currency,claimed_at,claim_reminded', what: r => (r.class_name || 'lekce') + ' ' + (r.class_date || '') },
      ];
      for (const t of stale) {
        const rows2 = await sb(`${t.tbl}?payment_method=eq.qr&status=eq.paid_claimed&claimed_at=lt.${encodeURIComponent(H24)}&select=${t.sel}`);
        for (const r of (rows2 || [])) {
          const claimedAt = new Date(r.claimed_at || 0).getTime();
          const remindedAt = r.claim_reminded ? new Date(r.claim_reminded).getTime() : 0;
          // Komu to patří: kouč u 1:1, majitel klubu u vstupu.
          let target = r.coach_id || null;
          if (!target && r.gym_id) { try { const g = (await sb(`gyms?id=eq.${r.gym_id}&select=owner_id`))[0]; target = g && g.owner_id; } catch (e) {} }
          const amount = (Number(r.amount || 0)).toString() + ' ' + String(r.currency || 'CZK').toUpperCase();
          const what = t.what(r);
          if (claimedAt < Date.parse(H72)) {
            // Po třech dnech: ať o tom ví obě strany i my. Jednou -- claim_reminded se posune.
            if (remindedAt && remindedAt > Date.parse(H24)) continue;
            await note(target, 'qr_unconfirmed',
              `\u26a0\ufe0f U\u017e t\u0159i dny nen\u00ed potvrzen\u00e1 platba p\u0159evodem (${what}, ${amount}). Potvr\u010f ji, nebo odm\u00edtni \u2014 student na to \u010dek\u00e1.`,
              `\u26a0\ufe0f A bank payment has been waiting for your confirmation for three days (${what}, ${amount}). Confirm or reject it \u2014 the student is waiting.`, { tbl: t.tbl, row_id: String(r.id), for_provider: true });
            await note(r.student_id, 'qr_unconfirmed',
              `\u26a0\ufe0f Tvoje platba p\u0159evodem (${what}, ${amount}) nen\u00ed t\u0159i dny potvrzen\u00e1. V Nadch\u00e1zej\u00edc\u00edch ji m\u016f\u017ee\u0161 p\u0159ipomenout nebo uzav\u0159\u00edt s potvrzen\u00edm.`,
              `\u26a0\ufe0f Your bank payment (${what}, ${amount}) has not been confirmed for three days. In Upcoming you can remind them or close it with a confirmation.`, { tbl: t.tbl, row_id: String(r.id) });
            escalated++;
          } else {
            if (remindedAt) continue;   // po 24 h připomeneme jen jednou
            // Kde se potvrzuje: 1:1 v Přehledu kouče, vstup do klubu v Recepci. Notifikace tam vede.
            await note(target, 'qr_unconfirmed',
              (t.tbl === 'bookings'
                ? `\u23f3 \u010cek\u00e1 na potvrzen\u00ed platba p\u0159evodem (${what}, ${amount}). Potvr\u010f ji, nebo odm\u00edtni v P\u0159ehledu kou\u010de.`
                : `\u23f3 \u010cek\u00e1 na potvrzen\u00ed platba p\u0159evodem (${what}, ${amount}). Potvr\u010f ji, nebo odm\u00edtni v doch\u00e1zce u lekce.`),
              (t.tbl === 'bookings'
                ? `\u23f3 A bank payment is waiting for your confirmation (${what}, ${amount}). Confirm or reject it in your coach dashboard.`
                : `\u23f3 A bank payment is waiting for your confirmation (${what}, ${amount}). Confirm or reject it in the class attendance.`), { tbl: t.tbl, row_id: String(r.id), for_provider: true });
            nudged++;
          }
          try { await sb(`${t.tbl}?id=eq.${r.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ claim_reminded: new Date().toISOString() }) }); } catch (e) {}
        }
      }
    } catch (e) { console.error('release-cron pass6', e.message); }

    return res.status(200).json({ ok: true, released, expired, expired1h, coverExpired, pisExpired, nudged, escalated });
  } catch (e) {
    return res.status(500).json({ error: e.message, released, expired, expired1h, coverExpired, pisExpired });
  }
}
