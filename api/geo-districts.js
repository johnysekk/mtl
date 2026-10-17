// /api/geo-districts — ČÁSTI OBCE (městské části, obvody, čtvrti) pro výběr místa.
//
// Po výběru obce v poptávce appka nabídne rozbalovací seznam jejích částí, aby bod byl přesný
// (Brno → Brno-střed, Královo Pole, Líšeň…). Seznam bere z mapových dat OpenStreetMap přes
// Overpass API (zdarma), nezávisle na tom, kdo dělá našeptávání (_geo-provider.js):
//   * obec s hranicí v OSM (osm_type=relation): všechno UVNITŘ hranice -- správní části
//     (admin_level 8–11) a pojmenovaná místa typu čtvrť / sídliště (place=suburb, quarter…),
//   * jinak (bod, nebo poskytovatel bez OSM id): pojmenované čtvrti do 10 km od středu obce.
// Kde OSM části nemá, vrátí se prázdný seznam a zůstane jen celá obec (její střed).
//
// GET /api/geo-districts?osm_type=relation&osm_id=438171&lat=49.19&lon=16.61&city=Brno&lang=cs
// → [{ name, lat, lng }]   (seřazeno podle abecedy, bez samotné obce)

const UA = process.env.GEO_USER_AGENT
  || 'MartialTrainingLab/1.0 (+https://app.martialtraininglab.com; info@martialtraininglab.com)';
const OVERPASS = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter').trim();

const CACHE = new Map();
const TTL = 24 * 60 * 60 * 1000;
const MAX = 300;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};
  const type = String(q.osm_type || '').toLowerCase();
  const id = parseInt(q.osm_id, 10);
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  const city = String(q.city || '').trim().slice(0, 120);
  const lang = String(q.lang || 'cs').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
  const byArea = (type === 'relation' || type === 'r') && id > 0;
  if (!byArea && !(isFinite(lat) && isFinite(lon))) return res.status(400).json({ error: 'bad_request' });

  const key = byArea ? `r${id}|${lang}` : `p${Math.round(lat * 100)}|${Math.round(lon * 100)}|${lang}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) { res.setHeader('Cache-Control', 'public, max-age=3600'); return res.status(200).json(hit.data); }

  const PLACE = '^(suburb|quarter|borough|city_district|neighbourhood)$';
  const ql = byArea
    ? `[out:json][timeout:20];area(${3600000000 + id})->.a;(relation(area.a)["boundary"="administrative"]["admin_level"~"^(8|9|10|11)$"]["name"];node(area.a)["place"~"${PLACE}"]["name"];);out center tags 400;`
    : `[out:json][timeout:20];(node(around:10000,${lat},${lon})["place"~"${PLACE}"]["name"];);out center tags 400;`;
  try {
    const r = await fetch(OVERPASS, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'data=' + encodeURIComponent(ql) });
    if (!r.ok) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ error: 'districts_unavailable', status: r.status }); }
    const d = await r.json();
    const seen = {};
    const out = [];
    const cityN = city.toLowerCase();
    for (const el of (d && d.elements) || []) {
      const t = el.tags || {};
      const name = String(t['name:' + lang] || t.name || '').trim();
      const la = el.lat != null ? el.lat : (el.center && el.center.lat);
      const lo = el.lon != null ? el.lon : (el.center && el.center.lon);
      if (!name || la == null || lo == null) continue;
      if (cityN && name.toLowerCase() === cityN) continue;
      const k = name.toLowerCase();
      if (seen[k]) continue;
      seen[k] = 1;
      out.push({ name, lat: Math.round(la * 1e5) / 1e5, lng: Math.round(lo * 1e5) / 1e5 });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, lang || 'cs'));
    if (CACHE.size >= MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(key, { at: Date.now(), data: out });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json(out);
  } catch (e) {
    console.error('[geo-districts]', (e && e.message) || e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'districts_unavailable' });
  }
}
