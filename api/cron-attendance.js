// Vercel Cron: připomínka "Doplň docházku" koučovi, který lekci vedl.
// Běží na serveru i když nikdo nemá appku otevřenou → realtime (cca +2 h od začátku lekce).
// Vyžaduje env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. (CRON_SECRET nastaví Vercel automaticky.)
// Naplánování: vercel.json → crons (každých 30 min). Pozor: Hobby plán povoluje cron jen 1×/den;
// frekventovaný cron funguje až na Pro. Do té doby běží client-side fallback v appce.
// Dedup je sdílený s client-side přes tabulku attend_reminders (unique gym/class/date) → žádné duplikáty.
// + Druhý pass: připomínka studentovi ~4 h před začátkem GYM lekce / drop-inu (TZ gymu). Dedup přes reminder_sent na řádku.
//   1:1 lekce (coach + student) řeší tenhle cron přes profiles.timezone (TZ kouče) + client-side fallback. Respektuje mute_class_reminder / mute_coach_lesson_reminder.

import Stripe from 'stripe';
import { ladderRate as _mtlLadder } from './_rate.js';

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
function gymNow(tz, at) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at || new Date());
  const g = {}; parts.forEach(p => g[p.type] = p.value);
  return {
    date: `${g.year}-${g.month}-${g.day}`,
    dow: DOW[g.weekday],
    mins: parseInt(g.hour, 10) * 60 + parseInt(g.minute, 10),
  };
}

// Připomíná se jen lekce, která v rozvrhu OPRAVDU BYLA, když měla začít (stejné pravidlo jako
// _classRemindable v appce). Lekce přidaná večer na dnešní den s už uplynulým časem proběhnout
// nemohla. Čas vytvoření se převádí do časové zóny klubu, stejně jako "teď".
function remindable(c, date, startMins, tz) {
  if (!c || c.once) return false;
  if (c.since && date < String(c.since)) return false;
  if (c.until && date > String(c.until)) return false;
  if (c.created_at) {
    const at = new Date(c.created_at);
    if (!isNaN(at)) { const cr = gymNow(tz, at); if (cr.date > date || (cr.date === date && cr.mins > startMins)) return false; }
  } else if (c.since && String(c.since) === date) {
    return false;   // starší záznam bez času vytvoření přidaný dnes: nevíme, jestli před lekcí
  }
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
        return diff >= 2 && diff <= 12 && remindable(c, date, h * 60 + m, gym.timezone); // lekce začala 2–12 h zpět a v rozvrhu tehdy byla
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
      const od = await sbGet(`bookings?dispute_handler=eq.coach&dispute_status=eq.open&dispute_deadline=lt.${encodeURIComponent(nowISO)}&select=id,coach_id,student_id,payment_intent,amount`);
      for (const b of (od || [])) {
        let acct = null;
        if (b.gym_id) { const g = await sbGet(`gyms?id=eq.${b.gym_id}&select=stripe_account`); acct = g[0] && g[0].stripe_account; }
        if (!acct && b.coach_id) { const c = await sbGet(`profiles?id=eq.${b.coach_id}&select=stripe_account`); acct = c[0] && c[0].stripe_account; }
        if (acct && b.payment_intent) { try { await stripe.refunds.create({ payment_intent: b.payment_intent }, { stripeAccount: acct }); } catch (e) { console.error('dispute refund', b.id, e.message); } }
        await sbPatch('bookings', `id=eq.${b.id}`, { dispute_status: 'refunded', status: 'refunded', refund_requested: false, dispute_auto: true });
        if (b.student_id) await sbPost('notifications', { user_id: b.student_id, type: 'system', read: false, data: JSON.stringify({ kind: 'dispute_auto_refunded', id: b.id, msg_en: `\u21a9\ufe0f Dispute #${b.id}: you were refunded in full.` }), message: `\u21a9\ufe0f Spor #${b.id}: pen\u00edze se ti vr\u00e1tily v pln\u00e9 v\u00fd\u0161i.` });
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

    // ── Účty a kluby po 30 dnech od smazání: skryjí se, ale HISTORIE ZŮSTÁVÁ ────────────────
    // Nemaže se nic. Přepíše se jen to, co je osobní údaj a živě se zobrazuje: jméno v profilu,
    // fotka, popis, kontakty. Doklady, transakce, docházka, vstupenky, výsledky zápasů, souhlasy
    // a členství v organizaci se nedotknou -- klub i kouč se k nim musí dostat po celou dobu
    // archivace, a jméno na už vystaveném dokladu je součást snímku, ne živý údaj.
    // Sloupec "photo" v profiles neexistuje (je to photo_url) -- PATCH proto celý padal na 400
    // a neanonymizoval se ani jeden účet.
    try {
      const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
      const delProfiles = await sbGet(`profiles?deleted_at=lt.${encodeURIComponent(cutoff)}&purged_at=is.null&select=id`);
      for (const pr of (delProfiles || [])) {
        const pk = await sbPatch('profiles', `id=eq.${pr.id}`, {
          name: 'Smazaný uživatel', photo_url: null, bio: null, emoji: null,
          phone: null, contact_phone: null, contact_email: null, billing_phone: null, invoice_email: null,
          health_note: null, guardian_email: null, guardian_name: null, guardian_phone: null,
          children: null, coach_status: 'deleted', purged_at: new Date().toISOString(),
        });
        if (!pk.ok) { console.error('purge profile', pr.id, pk.status); continue; }
        // Přihlášení se ruší, e-mail v auth zůstat nesmí. Řádek v profiles zůstává kvůli vazbám
        // z dokladů a docházky -- bez něj by historie klubu ztratila, ke komu patřila.
        try { await fetch(`${SB}/auth/v1/admin/users/${pr.id}`, { method: 'DELETE', headers: sbHeaders }); } catch (e) {}
        purged++;
      }
      const delGyms = await sbGet(`gyms?deleted_at=lt.${encodeURIComponent(cutoff)}&purged_at=is.null&select=id`);
      for (const g of (delGyms || [])) {
        // Klub: skryje se z vyhledávání a zmizí obsah profilu. Fakturační identita (právní název,
        // IČO, adresa) ZŮSTÁVÁ -- je na dokladech, které klub i studenti musí mít dohledatelné,
        // a je potřeba pro dodanění provizí. Stejně tak rozvrh, ceny a smluvní texty.
        const gk = await sbPatch('gyms', `id=eq.${g.id}`, {
          // Název klubu zůstává: je v dokladech, docházce i v historii členství v organizaci
          // a bez něj by student neměl jak poznat, kde trénoval.
          photos: null, facility_photos: null, description: null, contact_phone: null, contact_email: null,
          contact_public: false, contact_phone_public: false, contact_email_public: false,
          status: 'deleted', suspended: true, purged_at: new Date().toISOString(),
        });
        if (!gk.ok) { console.error('purge gym', g.id, gk.status); continue; }
        purgedG++;
      }
    } catch (e) { console.error('cron purge', e.message); }

    // ODSTRANENO: blok "welcome 0 % skoncilo -> preved predplatna na zakladni sazbu".
    // Uvitaci okno bylo zruseno, takze neexistuje stav, ze by predplatne viselo na 0 % a cekalo,
    // az ho nekdo vrati zpet. Sazbu resi sub-rate-cron.js kazdou noc a stripe-webhook.js pri
    // kazde zaplacene fakture; tenhle blok byl treti cesta ke stejnemu cili a existoval jen kvuli
    // welcome.

    res.status(200).json({ ok: true, gyms: gyms.length, created, purged, purgedG, autoRefunded });
  } catch (err) {
    console.error('cron-attendance error:', err.message);
    res.status(200).json({ ok: false, error: err.message });
  }
}

// Výchozí export MUSÍ být handler. Dřív tu viselo "export default" nad komentářem, takže se exportovala
// první následující funkce (subRateFor) a Vercel každých 30 minut volal ji -- celý cron se nikdy neprovedl.
// subRateFor/applySubRate tu nikdo nevolal (sazbu řeší sub-rate-cron.js a stripe-webhook.js), smazány.
export default handler;
