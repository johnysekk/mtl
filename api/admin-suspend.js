// /api/admin-suspend — RUČNÍ POZASTAVENÍ POSKYTOVATELE Z ADMINU (jen founder).
// POST { action:'suspend'|'restore', kind:'gym'|'coach'|'org', id, reason, howto, dsa?: { illegal, redress } }
// dsa: MTL zjistilo nezákonnou nabídku -> informuje kupující za posledních 6 měsíců (DSA čl. 32,
// _dsa-inform.js).
//
// Pozastavení = account_suspended (stejný příznak jako u neuhrazené provize: zmizí z decku
// a z hledání, nové rezervace, členství, lístky ani hotovost nejdou; už běžící předplatné kartou
// běží dál) + suspend_manual, aby ho úhrada provize (commission-cron, stripe-webhook) sama
// nezrušila. Důvod je povinný, „Jak pozastavení zrušit" nepovinné. Poskytovateli přijde
// notifikace v appce (proklik na vysvětlení) a e-mail -- koho, proč a jak se z toho dostat.
import { providerTarget, providerNotify, providerMail, sbWrite, esc, APP, FOUNDER_UUID } from './_provider-mail.js';
import { dsaInformBuyers } from './_dsa-inform.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

const KIND_CS = { gym: 'klub', coach: 'profil kouče', org: 'organizaci' };            // 4. pád (pozastavil koho)
const SUBJ_CS = { gym: ['Klub', 'pozastavený'], coach: ['Profil kouče', 'pozastavený'], org: ['Organizace', 'pozastavená'] };
const KIND_EN = { gym: 'club', coach: 'coach profile', org: 'organization' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const token = req.headers['x-access-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'no token' });
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const u = await ures.json();
    if ((u && (u.id || (u.user && u.user.id))) !== FOUNDER_UUID) return res.status(403).json({ error: 'forbidden' });

    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const kind = String(b.kind || ''), id = String(b.id || ''), action = String(b.action || '');
    if (!['gym', 'coach', 'org'].includes(kind) || !id || !['suspend', 'restore'].includes(action)) return res.status(400).json({ error: 'bad request' });
    const T = await providerTarget(kind, id);
    if (!T) return res.status(404).json({ error: 'not found' });
    const en = T.lang === 'en';
    const now = new Date();
    const when = now.toLocaleString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const link = `${APP}/?go=suspended&k=${q(kind)}&id=${q(id)}`;

    if (action === 'suspend') {
      const reason = String(b.reason || '').trim().slice(0, 600);
      const howto = String(b.howto || '').trim().slice(0, 1200);
      if (!reason) return res.status(400).json({ error: 'Důvod pozastavení je povinný.' });
      const dsa = b.dsa && String(b.dsa.illegal || '').trim() ? { illegal: String(b.dsa.illegal).trim().slice(0, 1500), redress: String(b.dsa.redress || '').trim().slice(0, 1500) } : null;
      if (dsa && !dsa.redress) return res.status(400).json({ error: 'U upozornění kupujícím vyplň i to, co můžou dělat (prostředky nápravy).' });
      const patch = { account_suspended: true, suspend_manual: true, suspend_reason: reason, suspend_howto: howto || null, suspended_at: now.toISOString() };
      // Dodavatel se v seznamu Dodavatelů řídí stavem 'approved' -- pozastavený se tam nesmí ukázat.
      if (kind === 'org' && T.orgKind === 'supplier') patch.status = 'suspended';
      await sbWrite('PATCH', `${T.table}?id=eq.${q(id)}`, patch);

      const S = SUBJ_CS[kind];
      const msg_cs = `⛔ ${S[0]} ${T.name} je ${S[1]} administrátorem MTL (${when}). Důvod: ${reason}.`
        + (howto ? ` Jak pozastavení zrušit: ${howto}` : ' Pro zrušení pozastavení se nám ozvi.')
        + ' Do té doby není vidět v appce a nejde u něj nic nového rezervovat ani koupit; už běžící předplatné kartou běží dál a data zůstávají.';
      const msg_en = `⛔ Your ${KIND_EN[kind]} ${T.name} has been suspended by the MTL administrator (${when}). Reason: ${reason}.`
        + (howto ? ` How to lift it: ${howto}` : ' Contact us to have it lifted.')
        + ' Until then it is hidden in the app and nothing new can be booked or bought; card subscriptions already running continue and your data stays.';
      await providerNotify(T.ownerId, { kind: 'admin_suspended', entity: kind, id, name: T.name, reason, howto: howto || null, at: now.toISOString(), msg_cs, msg_en });
      await providerMail(T.email,
        en ? `Suspended: ${T.name}` : `Pozastaveno: ${T.name}`,
        en
          ? [`Hello,`, `the MTL administrator suspended your ${esc(KIND_EN[kind])} <b>${esc(T.name)}</b> on <b>${esc(when)}</b>.`,
             `<b>Reason:</b> ${esc(reason)}`,
             howto ? `<b>How to lift the suspension:</b> ${esc(howto)}` : 'To have the suspension lifted, reply to this e-mail or contact us.',
             '<b>What it means:</b> it is hidden in the app and nothing new can be booked or bought there. Card subscriptions already running continue, and your data, schedule and members stay unchanged.']
          : [`Dobrý den,`, `administrátor MTL pozastavil ${esc(KIND_CS[kind])} <b>${esc(T.name)}</b>, a to <b>${esc(when)}</b>.`,
             `<b>Důvod:</b> ${esc(reason)}`,
             howto ? `<b>Jak pozastavení zrušit:</b> ${esc(howto)}` : 'Pro zrušení pozastavení odpověz na tento e-mail nebo nás kontaktuj.',
             '<b>Co to znamená:</b> v appce není vidět a nejde u něj nic nového rezervovat ani koupit. Už běžící předplatné kartou běží dál a data, rozvrh i členové zůstávají beze změny.'],
        { text: en ? 'Open in the app' : 'Otevřít v appce', url: link });
      let dsaOut = null;
      if (dsa) { try { dsaOut = await dsaInformBuyers({ kind, id, name: T.name, illegal: dsa.illegal, redress: dsa.redress, by: FOUNDER_UUID }); } catch (e) { dsaOut = { error: e.message }; } }
      return res.status(200).json({ ok: true, dsa: dsaOut });
    }

    // OBNOVENÍ. Když je u účtu zároveň neuhrazená provize po lhůtě, commission-cron ho při dalším
    // běhu pozastaví znovu -- to je správně (dluh trvá), jen už ne ručně.
    const cur = ((await (await fetch(`${SB}/rest/v1/${T.table}?id=eq.${q(id)}&select=*`, { headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` } })).json()) || [])[0] || {};
    const patch = { account_suspended: false, suspend_manual: false, suspend_reason: null, suspend_howto: null, suspended_at: null };
    if (kind === 'coach' && cur.coach_status === 'suspended') patch.coach_status = 'approved';   // dřívější pozastavení kouče
    if (kind === 'org' && T.orgKind === 'supplier' && cur.status === 'suspended') patch.status = 'approved';
    await sbWrite('PATCH', `${T.table}?id=eq.${q(id)}`, patch);
    const S = SUBJ_CS[kind];
    const msg_cs = `✅ ${S[0]} ${T.name} už není ${S[1]} — je znovu vidět a jde u něj rezervovat i kupovat.`;
    const msg_en = `✅ Your ${KIND_EN[kind]} ${T.name} is no longer suspended — it is visible again and open for bookings and purchases.`;
    await providerNotify(T.ownerId, { kind: 'admin_restored', entity: kind, id, name: T.name, msg_cs, msg_en });
    await providerMail(T.email, en ? `Suspension lifted: ${T.name}` : `Pozastavení zrušeno: ${T.name}`,
      [en ? 'Hello,' : 'Dobrý den,', esc(en ? msg_en : msg_cs)],
      { text: en ? 'Open MTL' : 'Otevřít MTL', url: APP });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[admin-suspend]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
