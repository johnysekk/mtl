// Vercel Cron: připomínka "Doplň docházku" koučovi, který lekci vedl.
// Běží na serveru i když nikdo nemá appku otevřenou → realtime (cca +2 h od začátku lekce).
// Vyžaduje env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. (CRON_SECRET nastaví Vercel automaticky.)
// Naplánování: vercel.json → crons (každých 30 min). Pozor: Hobby plán povoluje cron jen 1×/den;
// frekventovaný cron funguje až na Pro. Do té doby běží client-side fallback v appce.
// Dedup je sdílený s client-side přes tabulku attend_reminders (unique gym/class/date) → žádné duplikáty.
// + Druhý pass: připomínka studentovi ~4 h před začátkem GYM lekce / drop-inu (TZ gymu). Dedup přes reminder_sent na řádku.
//   1:1 lekce (coach + student) řeší tenhle cron přes profiles.timezone (TZ kouče) + client-side fallback. Respektuje mute_class_reminder / mute_coach_lesson_reminder.

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

export default async function handler(req, res) {
  // Ověření, že volá Vercel cron (nebo externí scheduler se správným tajemstvím)
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const gyms = await sbGet('gyms?status=eq.approved&select=id,name,owner_id,schedule,timezone');
    const mutedRem = new Set(((await sbGet('profiles?mute_class_reminder=eq.true&select=id')) || []).map(pp => pp.id));
    let created = 0;
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

      // ── Class reminders (~4 h before start): gym classes & drop-ins, gym-local time ──
      try {
        const win = (cm) => { const d = cm - mins; return d >= 360 && d <= 600; }; // 6–10 h ahead (before the 6h cancel deadline)
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
    // ── 1:1 lesson reminders (~4 h before): student + coach, in the coach's timezone ──
    try {
      const dISO = (d) => d.toISOString().slice(0, 10);
      const nowD = new Date();
      const lo = dISO(new Date(nowD.getTime() - 86400000)), hi = dISO(new Date(nowD.getTime() + 2 * 86400000));
      const bks = await sbGet(`bookings?type=neq.online&status=eq.active&training_date=gte.${lo}&training_date=lte.${hi}&or=(reminder_sent.eq.false,coach_reminder_sent.eq.false)&select=id,coach_id,student_id,student_name,coach_name,training_date,training_time,reminder_sent,coach_reminder_sent`);
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
          if (isNaN(cm)) continue; const diff = cm - mins; if (diff < 180 || diff > 300) continue;
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

    res.status(200).json({ ok: true, gyms: gyms.length, created });
  } catch (err) {
    console.error('cron-attendance error:', err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
}
