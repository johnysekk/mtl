// /api/orphan-accounts-cron — denní úklid účtů, které nikdy nedokončily registraci.
//
// PROČ EXISTUJE
// Účet v auth.users vzniká hned po odeslání registračního formuláře, tedy PŘED kroky
// země / datum narození / jméno. Profil v public.profiles zapisuje až _finishReg na konci.
// Kdo registraci nedokončí, nechá po sobě účet bez profilu. Dřív se to maskovalo tím, že
// checkAuth() profil dopsala sama -- jenže tím se nedokončená registrace prohlásila za
// hotovou a chybějící údaje už nešlo získat. Po opravě se profil nedopisuje a osiřelé
// účty se hromadí. Tenhle cron je uklízí.
//
// Nejde jen o pořádek: je to e-mailová adresa držená bez účelu a bez omezení, což je
// přesně to, co má řešit doba uchování podle GDPR. Obdobu už má provider-apply-prune.js.
//
// LHŮTY (rozhodnuto se zakladatelem)
//   nepotvrzený e-mail ..... 7 dní   Přihlásit se nemůže (Supabase odmítne "Email not
//                                    confirmed") a registrovat se znovu taky ne (appka
//                                    hlásí "už je registrovaný"). Takový člověk je
//                                    zaseknutý a adresu jen blokuje -- čím dřív se
//                                    uvolní, tím líp.
//   potvrzený e-mail ...... 90 dní   Tenhle se přihlásit MŮŽE a _regIncomplete() ho vrátí
//                                    do registrace, kde ji dokončí. Proto dlouhá lhůta:
//                                    smazat mu účet dřív znamená začínat od nuly.
//
// CO SE NIKDY NESMAŽE
//   1) účet, který MÁ profil -- to je živý uživatel, ať je registrace jakkoli stará,
//   2) pozvaný člen klubu -- invite-members.js zakládá účet přes createUser s rovnou
//      potvrzeným e-mailem a profil mu vznikne až při prvním přihlášení. Klub, který
//      naimportuje sto členů a rozešle pozvánky, by jinak po 90 dnech přišel o všechny,
//      kdo ještě nezareagovali, a jejich magic linky by přestaly platit. Poznají se podle
//      řádku v imported_members se stavem jiným než 'claimed'.
//
// Mazání jde přes admin API (auth.admin.deleteUser), ne přes DELETE na auth.users --
// Supabase u toho uklidí i navázané identity a relace.
//
// vercel.json: { "path": "/api/orphan-accounts-cron", "schedule": "20 3 * * *" }
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; volitelně CRON_SECRET.

import { createClient } from '@supabase/supabase-js';

const UNCONFIRMED_DAYS = 7;
const CONFIRMED_DAYS = 90;
const PAGE = 200;        // stránka auth.admin.listUsers
const MAX_PAGES = 50;    // strop, ať jeden běh neběží donekonečna
const MAX_DELETE = 500;  // strop na jeden běh; zbytek dojede zítra

export default async function handler(req, res) {
  // Vercel Cron posílá Authorization: Bearer <CRON_SECRET> a hlavičku x-vercel-cron.
  // Stejný tvar jako commission-cron.js.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (!(auth === `Bearer ${process.env.CRON_SECRET}` || req.headers['x-vercel-cron'])) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  }

  const SB = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SB || !KEY) return res.status(500).json({ ok: false, error: 'env not set' });

  const supa = createClient(SB, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const now = Date.now();
  const cutUnconfirmed = now - UNCONFIRMED_DAYS * 86400000;
  const cutConfirmed = now - CONFIRMED_DAYS * 86400000;

  const out = { scanned: 0, candidates: 0, deleted: 0, keptInvited: 0, errors: [] };

  try {
    // 1) projít účty po stránkách a vybrat ty, které jsou dost staré
    const aged = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, error } = await supa.auth.admin.listUsers({ page, perPage: PAGE });
      if (error) throw error;
      const users = (data && data.users) || [];
      if (!users.length) break;
      out.scanned += users.length;

      for (const u of users) {
        const created = new Date(u.created_at).getTime();
        if (!isFinite(created)) continue;
        const confirmed = !!(u.email_confirmed_at || u.confirmed_at);
        const cut = confirmed ? cutConfirmed : cutUnconfirmed;
        if (created < cut) aged.push({ id: u.id, email: (u.email || '').toLowerCase(), confirmed });
      }
      if (users.length < PAGE) break;
    }
    if (!aged.length) return res.status(200).json({ ok: true, ...out });

    // 2) kdo z nich MÁ profil -> živý uživatel, nechat být.
    //    Ptáme se po dávkách, aby URL nepřerostla.
    const withProfile = new Set();
    for (let i = 0; i < aged.length; i += 100) {
      const ids = aged.slice(i, i + 100).map(a => a.id);
      const { data, error } = await supa.from('profiles').select('id').in('id', ids);
      if (error) throw error;
      (data || []).forEach(r => withProfile.add(r.id));
    }

    const orphans = aged.filter(a => !withProfile.has(a.id));
    out.candidates = orphans.length;
    if (!orphans.length) return res.status(200).json({ ok: true, ...out });

    // 3) pozvaní členové klubu se nemažou -- profil jim vznikne až prvním přihlášením.
    const invited = new Set();
    const emails = [...new Set(orphans.map(o => o.email).filter(Boolean))];
    for (let i = 0; i < emails.length; i += 100) {
      const chunk = emails.slice(i, i + 100);
      const { data, error } = await supa
        .from('imported_members').select('email,status').in('email', chunk);
      if (error) throw error;
      (data || []).forEach(r => {
        if (String(r.status || '') !== 'claimed') invited.add(String(r.email || '').toLowerCase());
      });
    }

    // 4) smazat
    for (const o of orphans) {
      if (out.deleted >= MAX_DELETE) break;
      if (o.email && invited.has(o.email)) { out.keptInvited++; continue; }
      try {
        const { error } = await supa.auth.admin.deleteUser(o.id);
        if (error) throw error;
        out.deleted++;
      } catch (e) {
        out.errors.push(`${o.id}: ${(e && e.message) || e}`);
      }
    }

    return res.status(200).json({ ok: true, ...out, errors: out.errors.slice(0, 20) });
  } catch (e) {
    console.error('orphan-accounts-cron', e);
    return res.status(500).json({ ok: false, error: (e && e.message) || String(e), ...out });
  }
}
