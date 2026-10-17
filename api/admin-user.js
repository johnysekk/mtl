// /api/admin-user — POZASTAVENÍ / BAN / OBNOVENÍ ÚČTU UŽIVATELE Z ADMINU (jen zakladatel).
// POST { action:'suspend'|'ban'|'restore', user_id, reason }
//
// Pozastavení: účet zůstane přihlášený, ale nic nového nezaloží -- nerezervuje, neplatí, nepíše,
//   nevytváří akce ani kluby (hlídá databáze: profiles.suspended + mtl_active_user v rls-3-guards).
// Ban: navíc zablokované přihlášení v Supabase Auth (ban_duration). Otevřené přihlášení dožije
//   nejpozději do vypršení tokenu (hodina) -- do té doby ho drží stejná pojistka v databázi.
// Obnovení: obojí zruší.
// Důvod je u pozastavení i banu povinný. Uživateli přijde notifikace v appce (proklik na
// vysvětlení) a e-mail -- co se stalo, proč a jak se ozvat.
import { providerNotify, providerMail, sbGet, sbWrite, esc, APP, FOUNDER_UUID } from './_provider-mail.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

async function authBan(userId, duration) {
  const r = await fetch(`${SB}/auth/v1/admin/users/${q(userId)}`, {
    method: 'PUT',
    headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ban_duration: duration }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`auth ${r.status} ${t.slice(0, 160)}`); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const token = req.headers['x-access-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'no token' });
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const u = await ures.json();
    if (!FOUNDER_UUID || (u && u.id) !== FOUNDER_UUID) return res.status(403).json({ error: 'forbidden' });

    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const action = String(b.action || ''), id = String(b.user_id || '');
    if (!['suspend', 'ban', 'restore'].includes(action) || !id) return res.status(400).json({ error: 'bad request' });
    if (id === FOUNDER_UUID) return res.status(400).json({ error: 'Vlastní účet zakladatele zablokovat nejde.' });
    const p = ((await sbGet(`profiles?id=eq.${q(id)}&select=id,name,email,lang,suspended,banned`)) || [])[0];
    if (!p) return res.status(404).json({ error: 'Účet nenalezen.' });
    const en = p.lang === 'en';
    const now = new Date();
    const when = now.toLocaleString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const link = `${APP}/?go=blocked`;

    if (action === 'suspend' || action === 'ban') {
      const reason = String(b.reason || '').trim().slice(0, 600);
      if (!reason) return res.status(400).json({ error: 'Důvod je povinný.' });
      const ban = action === 'ban';
      if (ban) await authBan(id, '876000h');
      else if (p.banned) await authBan(id, 'none');            // z banu na mírnější pozastavení
      await sbWrite('PATCH', `profiles?id=eq.${q(id)}`, { suspended: true, banned: ban, suspend_reason: reason, blocked_at: now.toISOString() });

      const msg_cs = ban
        ? `⛔ Tvůj účet v MTL je zablokovaný administrátorem (${when}). Důvod: ${reason}. Do appky se už nepřihlásíš. Pokud jde o omyl, odpověz na e-mail, který ti přišel.`
        : `⛔ Tvůj účet v MTL je pozastavený administrátorem (${when}). Důvod: ${reason}. Dokud pozastavení trvá, nemůžeš rezervovat, platit, psát ani nic vytvářet. Rezervace a členství, které už máš, zůstávají. Pro zrušení se nám ozvi přes Podporu.`;
      const msg_en = ban
        ? `⛔ Your MTL account has been blocked by the administrator (${when}). Reason: ${reason}. You can no longer sign in. If this is a mistake, reply to the e-mail we sent you.`
        : `⛔ Your MTL account has been suspended by the administrator (${when}). Reason: ${reason}. While it lasts you cannot book, pay, send messages or create anything. Bookings and memberships you already have stay. Contact Support to have it lifted.`;
      await providerNotify(id, { kind: 'account_blocked', ban, reason, at: now.toISOString(), msg_cs, msg_en });
      await providerMail(p.email,
        en ? (ban ? 'Your MTL account is blocked' : 'Your MTL account is suspended') : (ban ? 'Tvůj účet v MTL je zablokovaný' : 'Tvůj účet v MTL je pozastavený'),
        en
          ? ['Hello,', `the MTL administrator ${ban ? 'blocked' : 'suspended'} your account on <b>${esc(when)}</b>.`, `<b>Reason:</b> ${esc(reason)}`,
             ban ? '<b>What it means:</b> you can no longer sign in to MTL.' : '<b>What it means:</b> you stay signed in, but you cannot book, pay, send messages or create anything until it is lifted. Bookings and memberships you already have stay.',
             'If you think this is a mistake, reply to this e-mail.']
          : ['Dobrý den,', `administrátor MTL ${ban ? 'zablokoval' : 'pozastavil'} tvůj účet, a to <b>${esc(when)}</b>.`, `<b>Důvod:</b> ${esc(reason)}`,
             ban ? '<b>Co to znamená:</b> do MTL se už nepřihlásíš.' : '<b>Co to znamená:</b> zůstaneš přihlášený, ale dokud pozastavení trvá, nemůžeš rezervovat, platit, psát ani nic vytvářet. Rezervace a členství, které už máš, zůstávají.',
             'Pokud jde podle tebe o omyl, odpověz na tento e-mail.'],
        ban ? null : { text: en ? 'Open MTL' : 'Otevřít MTL', url: link });
      return res.status(200).json({ ok: true });
    }

    if (p.banned) await authBan(id, 'none');
    await sbWrite('PATCH', `profiles?id=eq.${q(id)}`, { suspended: false, banned: false, suspend_reason: null, blocked_at: null });
    const msg_cs = '✅ Tvůj účet v MTL už není pozastavený ani zablokovaný — můžeš ho zase normálně používat.';
    const msg_en = '✅ Your MTL account is no longer suspended or blocked — you can use it normally again.';
    await providerNotify(id, { kind: 'account_restored', msg_cs, msg_en });
    await providerMail(p.email, en ? 'Your MTL account is active again' : 'Tvůj účet v MTL je znovu aktivní',
      [en ? 'Hello,' : 'Dobrý den,', esc(en ? msg_en : msg_cs)], { text: en ? 'Open MTL' : 'Otevřít MTL', url: APP });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[admin-user]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
