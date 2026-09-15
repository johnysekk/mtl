// /api/meta-feed.js — katalog klubů pro reklamu na Metě.
//
// JAK TO FUNGUJE: Meta si tuhle adresu sama pravidelně stáhne (Commerce Manager → katalog
// → plánované načítání) a z položek skládá reklamy. Kampaň se tím staví jednou; nové kluby
// do ní naskakují samy a zrušené z ní vypadnou při dalším načtení.
//
// DVĚ POJISTKY, obě povinné:
//   1) hlavní vypínač programu (platform_settings.ads_program_on) — dokud je vypnutý,
//      feed je prázdný, ať se o adrese dozví kdokoli
//   2) souhlas klubu (gyms.ads_opt_in) — bez něj se klub do reklamy nedostane
//
// Odkaz v položce nese ?mtlads=1&club=<id>, takže se příchod z reklamy sám označí jako
// mtl_ads a účtuje se podle toho (viz _rate.js).
//
// Formát: CSV, protože ho Meta bere přímo a nepotřebuje k tomu nic dalšího.
// GET /api/meta-feed            → CSV
// GET /api/meta-feed?format=json → totéž jako JSON (na ladění)

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const APP = process.env.APP_URL || 'https://app.martialtraininglab.com';

const sbGet = async (path) => {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
    return r.ok ? r.json() : [];
  } catch (e) { return []; }
};

const firstPhoto = (photos) => {
  try {
    const raw = (typeof photos === 'string') ? JSON.parse(photos || '[]') : (photos || []);
    const arr = Array.isArray(raw) ? raw : [];
    for (const p of arr) {
      const u = (typeof p === 'string') ? p : (p && (p.url || p.src));
      if (u && /^https?:\/\//i.test(u)) return u;
    }
  } catch (e) {}
  return '';
};

// CSV podle pravidel Mety: uvozovky se zdvojují, pole s čárkou nebo koncem řádku se obalí.
const csvCell = (v) => {
  const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export default async function handler(req, res) {
  try {
    // 1) hlavní vypínač
    const ps = await sbGet('platform_settings?id=eq.1&select=ads_program_on');
    const on = !!(ps && ps[0] && ps[0].ads_program_on);

    // 2) kluby se souhlasem, schválené, neskryté
    let rows = [];
    if (on) {
      const gyms = await sbGet(
        'gyms?ads_opt_in=eq.true&status=eq.approved&deleted_at=is.null&suspended=eq.false' +
        '&select=id,name,city,country,description,photos,dropin_price,currency,account_suspended'
      );
      rows = (gyms || [])
        .filter(g => !g.account_suspended)         // pozastavený účet se nepropaguje
        .filter(g => firstPhoto(g.photos))         // bez fotky by reklama vypadala bídně
        .map(g => ({
          id: g.id,
          title: (g.name || 'Klub') + (g.city ? (' · ' + g.city) : ''),
          // Popis píše klub sám a ví, že ho uvidí cizí lidé (upozornění v nastavení).
          description: String(g.description || `Tréninky${g.city ? ' v ' + g.city : ''}. Rozvrh, ceny a rezervace v MTL.`).slice(0, 5000),
          availability: 'in stock',
          condition: 'new',
          // Cena je povinné pole katalogu. Bereme jednorázový vstup; bez něj symbolickou 0.
          price: `${((Number(g.dropin_price) || 0) / 100).toFixed(2)} ${(g.currency || 'CZK').toUpperCase()}`,
          link: `${APP}/api/club-public?club=${encodeURIComponent(g.id)}&mtlads=1`,
          image_link: firstPhoto(g.photos),
          brand: 'Martial Training Lab',
          city: g.city || '',
          country: g.country || '',
        }));
    }

    if ((req.query.format || '') === 'json') {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.status(200).json({ ok: true, program_on: on, count: rows.length, items: rows });
    }

    const cols = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand', 'city', 'country'];
    const csv = [cols.join(',')]
      .concat(rows.map(r => cols.map(c => csvCell(r[c])).join(',')))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).send(csv);
  } catch (e) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.status(200).send('id,title,description,availability,condition,price,link,image_link,brand,city,country\n');
  }
}
