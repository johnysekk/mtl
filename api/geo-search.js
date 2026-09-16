// /api/geo-search.js — hledání adres pro našeptávač.
//
// PROČ PŘES SERVER: appka volala nominatim.openstreetmap.org přímo z prohlížeče. OSM to podle
// svých podmínek omezuje — chce identifikující User-Agent nebo kontaktní e-mail, jinak
// požadavky odmítá (403) nebo přiškrtí (429). Z prohlížeče se User-Agent nastavit nedá, takže
// našeptávač „přestal fungovat" bez jakékoli změny v kódu.
//
// Tady se dotaz posílá jménem MTL s vlastní hlavičkou a výsledek se krátce drží v paměti,
// takže při psaní adresy neodejde dvacet dotazů, ale jeden nebo dva.
//
// GET /api/geo-search?q=Cejl%2068&city=Brno&lang=cs
// → [{ display_name, lat, lon, address:{...} }, ...]

const UA = process.env.GEO_USER_AGENT
  || 'MartialTrainingLab/1.0 (+https://app.martialtraininglab.com; info@martialtraininglab.com)';

// Paměť procesu. Vercel funkce žijí krátce, takže je to malá, ale účinná pojistka proti
// opakovaným dotazům při psaní. Bez limitu by tu při dlouhém běhu narůstal objem.
const CACHE = new Map();
const TTL = 10 * 60 * 1000;
const MAX = 300;

const cacheGet = (k) => {
  const v = CACHE.get(k);
  if (!v) return null;
  if (Date.now() - v.at > TTL) { CACHE.delete(k); return null; }
  return v.data;
};
const cacheSet = (k, data) => {
  if (CACHE.size >= MAX) { const first = CACHE.keys().next().value; CACHE.delete(first); }
  CACHE.set(k, { at: Date.now(), data });
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = String((req.query && req.query.q) || '').trim();
  // limit=1 posílají místa, kde appce stačí jeden nejlepší výsledek (geokódování města).
  const limit = Math.max(1, Math.min(12, parseInt((req.query && req.query.limit) || '12', 10) || 12));
  const city = String((req.query && req.query.city) || '').trim();
  const lang = String((req.query && req.query.lang) || 'cs').slice(0, 5);

  // Krátké dotazy nemá smysl posílat dál: vrátí půl města a stejně se přepisují.
  if (q.length < 3) { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json([]); }

  const full = q + (city && q.toLowerCase().indexOf(city.toLowerCase()) < 0 ? (', ' + city) : '');
  const key = lang + '|' + limit + '|' + full.toLowerCase();

  const hit = cacheGet(key);
  if (hit) {
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json(hit);
  }

  try {
    const url = 'https://nominatim.openstreetmap.org/search'
      + '?format=json&addressdetails=1&limit=' + limit
      + '&accept-language=' + encodeURIComponent(lang)
      + '&q=' + encodeURIComponent(full);

    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) {
      // Nesnažíme se to maskovat: appka pak nabídne ruční zadání.
      console.error('[geo-search] nominatim', r.status, full.slice(0, 80));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'geocoder_unavailable', status: r.status });
    }
    const d = await r.json();

    // Posíláme jen to, co našeptávač potřebuje. Menší odpověď, žádná cizí data v appce.
    const out = (Array.isArray(d) ? d : []).slice(0, limit).map((x) => ({
      display_name: x.display_name,
      lat: x.lat, lon: x.lon,
      address: x.address || {},
      type: x.type, class: x.class,
    }));

    cacheSet(key, out);
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json(out);
  } catch (e) {
    console.error('[geo-search]', (e && e.message) || e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'geocoder_unavailable' });
  }
}
