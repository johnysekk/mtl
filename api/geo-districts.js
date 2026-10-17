// /api/geo-districts — MĚSTSKÉ ČÁSTI obce pro výběr místa. Nic jiného (žádné čtvrti, sídliště,
// osady, sousední obce).
//
// Po výběru města v poptávce appka nabídne seznam jeho městských částí, aby bod byl přesný
// (Brno → Brno-střed, Královo Pole…; Praha → Praha 1–22; Ostrava → městské obvody).
// Zdroj: správní hranice v OpenStreetMap přes Overpass API (zdarma), nezávisle na tom, kdo dělá
// našeptávání (_geo-provider.js).
//   * Vezme se hranice města (OSM relace) a jeho úroveň správního členění (admin_level).
//   * Z hranic UVNITŘ města se vezme NEJBLIŽŠÍ NIŽŠÍ úroveň, která má aspoň 2 části -- to je
//     „městská část" v dané zemi (CZ obvody/MČ, DE Stadtbezirke, FR arrondissements, AT Bezirke…).
//   * „Uvnitř" se ověřuje geometricky: střed části musí ležet v hranici města. Sousední obce, které
//     se městu jen dotýkají hranicí, tím vypadnou.
//   * Když poskytovatel nepošle OSM id, relace města se dohledá podle bodu a názvu.
// Město bez městských částí → prázdný seznam, zůstane jen celé město (jeho střed).
//
// GET /api/geo-districts?osm_type=relation&osm_id=438171&lat=49.19&lon=16.61&city=Brno&lang=cs
// → [{ name, lat, lng }]   (seřazeno podle abecedy)

const UA = process.env.GEO_USER_AGENT
  || 'MartialTrainingLab/1.0 (+https://app.martialtraininglab.com; info@martialtraininglab.com)';
const OVERPASS = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter').trim();
const AREA = 3600000000;

const CACHE = new Map();
const TTL = 24 * 60 * 60 * 1000;
const MAX = 300;

async function overpass(ql) {
  const r = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'data=' + encodeURIComponent(ql),
  });
  if (!r.ok) { const e = new Error('overpass_' + r.status); e.status = r.status; throw e; }
  return r.json();
}

// Úsečky vnějších hranic města. Pořadí cest v relaci nehraje roli: test bodu paprskem
// počítá průsečíky se všemi úsečkami.
function ringSegments(rel) {
  const segs = [];
  for (const m of (rel && rel.members) || []) {
    if (m.type !== 'way' || !Array.isArray(m.geometry)) continue;
    if (m.role && m.role !== 'outer') continue;
    const g = m.geometry;
    for (let i = 1; i < g.length; i++) segs.push([g[i - 1].lon, g[i - 1].lat, g[i].lon, g[i].lat]);
  }
  return segs;
}

function inside(segs, x, y) {
  let c = false;
  for (const [x1, y1, x2, y2] of segs) {
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) c = !c;
  }
  return c;
}

function sameName(tags, city) {
  const n = city.toLowerCase();
  for (const k in tags || {}) {
    if ((k === 'name' || k.startsWith('name:') || k === 'official_name' || k === 'alt_name') && String(tags[k]).toLowerCase() === n) return true;
  }
  return false;
}

// Relace města podle bodu a názvu (pro poskytovatele bez OSM id).
async function findCityRel(lat, lon, city) {
  if (!city) return 0;
  const d = await overpass(`[out:json][timeout:15];is_in(${lat},${lon})->.x;area.x["boundary"="administrative"]["name"];out tags;`);
  const hit = ((d && d.elements) || []).filter((e) => e.id > AREA && sameName(e.tags, city))
    .sort((a, b) => (parseInt(b.tags.admin_level, 10) || 0) - (parseInt(a.tags.admin_level, 10) || 0))[0];
  return hit ? hit.id - AREA : 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const q = req.query || {};
  const type = String(q.osm_type || '').toLowerCase();
  let id = parseInt(q.osm_id, 10);
  const lat = parseFloat(q.lat), lon = parseFloat(q.lon);
  const city = String(q.city || '').trim().slice(0, 120);
  const lang = String(q.lang || 'cs').toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
  const byRel = (type === 'relation' || type === 'r') && id > 0;
  if (!byRel && !(isFinite(lat) && isFinite(lon))) return res.status(400).json({ error: 'bad_request' });

  const key = byRel ? `r${id}|${lang}` : `p${Math.round(lat * 100)}|${Math.round(lon * 100)}|${city.toLowerCase()}|${lang}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < TTL) { res.setHeader('Cache-Control', 'public, max-age=3600'); return res.status(200).json(hit.data); }
  const save = (data) => {
    if (CACHE.size >= MAX) CACHE.delete(CACHE.keys().next().value);
    CACHE.set(key, { at: Date.now(), data });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json(data);
  };

  try {
    if (!byRel) id = await findCityRel(lat, lon, city);
    if (!(id > 0)) return save([]);

    const d = await overpass(`[out:json][timeout:25];rel(${id})->.c;.c out tags geom;`
      + `area(${AREA + id})->.a;rel(area.a)["boundary"="administrative"]["admin_level"]["name"];out center tags;`);
    const els = (d && d.elements) || [];
    const cityRel = els.find((e) => e.type === 'relation' && e.id === id && Array.isArray(e.members));
    if (!cityRel) return save([]);
    const cityLevel = parseInt((cityRel.tags || {}).admin_level, 10) || 8;
    const segs = ringSegments(cityRel);
    if (segs.length < 3) return save([]);

    const byLevel = {};
    for (const el of els) {
      if (el === cityRel || el.id === id || !el.center) continue;
      const t = el.tags || {};
      const lv = parseInt(t.admin_level, 10);
      if (!(lv > cityLevel && lv <= 10)) continue;
      if (!inside(segs, el.center.lon, el.center.lat)) continue;
      const name = String(t['name:' + lang] || t.name || '').trim();
      if (!name || (city && name.toLowerCase() === city.toLowerCase())) continue;
      (byLevel[lv] = byLevel[lv] || []).push({ name, lat: Math.round(el.center.lat * 1e5) / 1e5, lng: Math.round(el.center.lon * 1e5) / 1e5 });
    }
    const lv = Object.keys(byLevel).map(Number).sort((a, b) => a - b).find((l) => byLevel[l].length >= 2);
    const seen = {};
    const out = (lv ? byLevel[lv] : []).filter((p) => { const k = p.name.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
    out.sort((a, b) => a.name.localeCompare(b.name, lang || 'cs', { numeric: true }));
    return save(out);
  } catch (e) {
    console.error('[geo-districts]', (e && e.message) || e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'districts_unavailable' });
  }
}
