// MTL — /api/come-of-age-cron
//
// is_minor se nastavilo jednou při registraci a nikdy nepřepočítalo. Klient to od TBC řeší při
// vstupu, jenže kdo appku neotevře, zůstane v databázi mladistvý — a serverové cesty
// (guardian-consent.js a spol.) se řídí databází, ne tím, co si myslí prohlížeč. Proto i tady.
//
// Běží jednou v noci. Najde účty, které mají is_minor a datum narození starší osmnácti let,
// a překlopí je: příznak pryč, žádosti o úhradu pryč, aktivní vazba na zástupce ukončená.
// Souhlasy zůstávají — jsou to záznamy o tom, co se stalo, ne aktivní stav.
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

async function sb(path, opts) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    }
  }, opts || {}));
  const t = await r.text();
  let j = null;
  try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
  if (!r.ok) throw new Error((j && (j.message || j.error)) || ('HTTP ' + r.status));
  return j;
}

// Narozeniny: jednou za rok popřát. Běží ve stejném cronu, ať nepřibývá další.
// Dedup drží sloupec last_birthday_year -- bez něj by se při dvou spuštěních poslalo dvakrát.
async function greetBirthdays() {
  try {
    const now = new Date();
    const md = String(now.getUTCMonth() + 1).padStart(2, '0') + '-' + String(now.getUTCDate()).padStart(2, '0');
    const year = now.getUTCFullYear();
    const rows = await sb(
      'profiles?select=id,name,birthdate,last_birthday_year&birthdate=not.is.null' +
      '&or=(last_birthday_year.is.null,last_birthday_year.lt.' + year + ')&limit=2000'
    );
    const today = (rows || []).filter(r => String(r.birthdate || '').slice(5, 10) === md);
    if (!today.length) return 0;

    await sb('notifications', {
      method: 'POST',
      body: JSON.stringify(today.map(r => ({
        user_id: r.id,
        type: 'system',
        read: false,
        data: JSON.stringify({ kind: 'birthday' }),
        message: '\u{1F382} Všechno nejlepší k narozeninám! Ať ti to na tréninku jde.'
      })))
    });
    await sb('profiles?id=in.(' + today.map(r => r.id).join(',') + ')', {
      method: 'PATCH',
      body: JSON.stringify({ last_birthday_year: year })
    });
    return today.length;
  } catch (e) {
    console.log('[birthday]', e && e.message);
    return 0;
  }
}

module.exports = async (req, res) => {
  // Vercel cron posílá Authorization: Bearer <CRON_SECRET>. Bez něj endpoint nikoho nepřeklápí.
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (CRON_SECRET && auth !== 'Bearer ' + CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'missing supabase env' });
  }

  try {
    // Hranice: kdo se narodil před 18 lety nebo dřív, je dnes dospělý. Počítáme na den, ne
    // na rok, ať se to neláme na přestupných letech.
    const now = new Date();
    const cutoff = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()))
      .toISOString().slice(0, 10);

    const rows = await sb(
      'profiles?select=id,name,birthdate&is_minor=eq.true&birthdate=not.is.null&birthdate=lte.' +
      cutoff + '&limit=500'
    );

    if (!rows || !rows.length) {
      return res.status(200).json({ ok: true, cutoff, promoted: 0 });
    }

    const ids = rows.map(r => r.id);
    const inList = '(' + ids.join(',') + ')';

    await sb('profiles?id=in.' + inList, {
      method: 'PATCH',
      body: JSON.stringify({ is_minor: false })
    });

    // Vazba na zástupce zůstává. Je to rodina, ne administrativní vztah -- rušit ji za člověka
    // by mu vzalo přehled o dětech nebo o rodičích. Mění se jen to, že si o platbu už neřekne;
    // zrušit si ji může sám v Rodině.

    // Ať to člověk nezjistí až tím, že se mu appka chová jinak.
    try {
      await sb('notifications', {
        method: 'POST',
        body: JSON.stringify(rows.map(r => ({
          user_id: r.id,
          type: 'system',
          read: false,
          message: '\u{1F382} Všechno nejlepší k osmnáctinám! Účet máš teď plnohodnotný — nic už nepotřebuje souhlas zástupce. Rodinná vazba zůstává a o úhradu tréninku ho můžeš pořád požádat; zrušit si ji můžeš kdykoli v Rodině.'
        })))
      });
    } catch (e) {
      console.log('[come-of-age] notifikace:', e && e.message);
    }

    const greeted = await greetBirthdays();

    return res.status(200).json({
      ok: true,
      cutoff,
      promoted: ids.length,
      birthdays: greeted,
      names: rows.map(r => r.name).filter(Boolean).slice(0, 20)
    });
  } catch (e) {
    console.log('[come-of-age] chyba:', e && e.message);
    return res.status(500).json({ error: (e && e.message) || 'failed' });
  }
};
