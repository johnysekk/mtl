// /api/geo-reverse.js — ze souřadnic město a zemi.
//
// Stejný důvod jako u /api/geo-search: OSM vyžaduje identifikující User-Agent, který
// z prohlížeče nastavit nejde, takže přímé dotazy odmítá (403) nebo přiškrtí (429).
// Appka to používá při určení polohy z GPS a v Adminu při dopočítávání měst u koučů.
//
// GET /api/geo-reverse?lat=49.19&lon=16.6&zoom=10&lang=cs
// → { address:{...}, display_name, lat, lon }
//
// Souřadnice se zaokrouhlují na dvě desetinná místa (~1 km). Na město to stačí a výrazně
// to zvyšuje zásah keše: deset lidí ze stejné čtvrti se zeptá jednou.

const UA = process.env.GEO_USER_AGENT
  || 'MartialTrainingLab/1.0 (+https://app.martialtraininglab.com; info@martialtraininglab.com)';

const CACHE = new Map();
const TTL = 24 * 60 * 60 * 1000;   // město se nestěhuje, den je bezpečný
const MAX = 500;

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

  const q = req.query || {};
  const lat = Number(q.lat), lon = Number(q.lon);
  if (!isFinite(lat) || !isFinite(lon)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'bad_coords' });
  }
  const zoom = Math.max(3, Math.min(18, parseInt(q.zoom || '10', 10) || 10));
  const lang = String(q.lang || 'cs').slice(0, 5);

  const rlat = Math.round(lat * 100) / 100;
  const rlon = Math.round(lon * 100) / 100;
  const key = lang + '|' + zoom + '|' + rlat + '|' + rlon;

  const hit = cacheGet(key);
  if (hit) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json(hit);
  }

  try {
    const url = 'https://nominatim.openstreetmap.org/reverse'
      + '?format=json&addressdetails=1&zoom=' + zoom
      + '&accept-language=' + encodeURIComponent(lang)
      + '&lat=' + rlat + '&lon=' + rlon;

    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) {
      console.error('[geo-reverse] nominatim', r.status, rlat, rlon);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'geocoder_unavailable', status: r.status });
    }
    const d = await r.json();
    const out = {
      display_name: d && d.display_name,
      address: (d && d.address) || {},
      lat: rlat, lon: rlon,
    };
    cacheSet(key, out);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json(out);
  } catch (e) {
    console.error('[geo-reverse]', (e && e.message) || e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'geocoder_unavailable' });
  }
}
