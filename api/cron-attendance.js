// Vercel Cron: připomínka "Doplň docházku" koučovi, který lekci vedl.
// Běží na serveru i když nikdo nemá appku otevřenou → realtime (cca +2 h od začátku lekce).
// Vyžaduje env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. (CRON_SECRET nastaví Vercel automaticky.)
// Naplánování: vercel.json → crons (každých 30 min). Pozor: Hobby plán povoluje cron jen 1×/den;
// frekventovaný cron funguje až na Pro. Do té doby běží client-side fallback v appce.
// Dedup je sdílený s client-side přes tabulku attend_reminders (unique gym/class/date) → žádné duplikáty.

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
    }
    res.status(200).json({ ok: true, gyms: gyms.length, created });
  } catch (err) {
    console.error('cron-attendance error:', err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
}
