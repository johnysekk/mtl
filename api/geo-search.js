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
// GET /api/geo-search?q=Cejl%2068&city=Brno&lang=cs&cc=cz&kind=address|place
// → [{ display_name, lat, lon, address:{...}, boundingbox, precision, provider }, ...]
// kind=place: jen obce, městské části a čtvrti (výběr města / místa v poptávce).
// Kdo odpovídá (OpenStreetMap, LocationIQ, Mapbox, Google), určuje _geo-provider.js.
import { geoSearch, providerName } from './_geo-provider.js';

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
  // TVRDÉ OMEZENÍ NA ZEMI. Dřív se země přilepovala k dotazu („Paris, Czechia") -- Nominatim
  // to bere jako nápovědu, ne podmínku, a vrátil Paříž ve Francii. Appka pak měla město
  // z jedné země a country_code z druhé. countrycodes je podmínka: co v té zemi není,
  // se nevrátí vůbec. Bere i seznam oddělený čárkou („cz,sk").
  const cc = String((req.query && req.query.cc) || '')
    .toLowerCase().replace(/[^a-z,]/g, '').slice(0, 64);
  const kind = (req.query && req.query.kind) === 'place' ? 'place' : null;
  const nlat = parseFloat(req.query && req.query.lat), nlng = parseFloat(req.query && req.query.lon);
  const near = (isFinite(nlat) && isFinite(nlng)) ? { lat: nlat, lng: nlng } : null;

  // Krátké dotazy nemá smysl posílat dál: vrátí půl města a stejně se přepisují.
  if (q.length < 3) { res.setHeader('Cache-Control', 'no-store'); return res.status(200).json([]); }

  const full = q + (city && q.toLowerCase().indexOf(city.toLowerCase()) < 0 ? (', ' + city) : '');
  const key = providerName() + '|' + lang + '|' + limit + '|' + cc + '|' + (kind || '') + '|' + (near ? Math.round(near.lat) + ',' + Math.round(near.lng) : '') + '|' + full.toLowerCase();

  const hit = cacheGet(key);
  if (hit) {
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json(hit);
  }

  try {
    // Posíláme jen to, co appka potřebuje (tvar Nominatimu + přesnost a poskytovatel).
    const out = (await geoSearch(full, { cc, lang, limit, kind, near })).slice(0, limit);
    cacheSet(key, out);
    res.setHeader('Cache-Control', 'public, max-age=120');
    return res.status(200).json(out);
  } catch (e) {
    // Nesnažíme se to maskovat: appka pak nabídne ruční zadání.
    console.error('[geo-search]', providerName(), (e && e.status) || '', (e && e.message) || e, full.slice(0, 80));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'geocoder_unavailable', status: (e && e.status) || null });
  }
}
