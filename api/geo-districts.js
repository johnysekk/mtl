// /api/geo-districts — MĚSTSKÉ ČÁSTI obce pro výběr místa. Nic jiného (žádné čtvrti, sídliště,
// osady, sousední obce).
//
// Po výběru města v poptávce appka nabídne seznam jeho městských částí, aby bod byl přesný
// (Brno → Brno-střed, Královo Pole…; Praha → Praha 1–22; Ostrava → městské obvody).
// Zdroj: správní hranice v OpenStreetMap přes Overpass API (zdarma), nezávisle na tom, kdo dělá
// našeptávání (_geo-provider.js).
//
// Jak se části vybírají:
//   * Z celků pod městem se vezme NEJHRUBŠÍ úroveň správního členění (admin_level), která má
//     aspoň 2 části -- to je „městská část" v dané zemi (CZ obvody/MČ, DE Stadtbezirke,
//     FR arrondissements, AT Bezirke, USA boroughs u New Yorku…). Jemnější úrovně se nikdy neberou.
//   * Víc než MAX_PARTS částí = to není městská část, ale něco jemnějšího → nic, jen celé město.
//
// Rychlost (Overpass je pomalý, dotaz na velké město trvá i desítky sekund):
//   1) trvalá cache v databázi (public.geo_district_cache) -- každé město se počítá jednou
//      za CACHE_DAYS, pak je odpověď okamžitá pro všechny a přežije i nové nasazení,
//   2) rychlá cesta: části zapsané přímo v relaci města (role „subarea") -- jeden malý dotaz,
//   3) pomalá cesta jen když 2) nic nedá: hranice uvnitř města s geometrickou kontrolou, že
//      střed části leží v hranici města (sousední obce vypadnou),
//   4) Vercel CDN drží odpověď (s-maxage) a appka si ji pamatuje do zavření.
// Když poskytovatel nepošle OSM id (Mapbox, Google), relace města se dohledá podle bodu a názvu.
//
// GET /api/geo-districts?osm_type=relation&osm_id=438171&lat=49.19&lon=16.61&city=Brno&lang=cs
// → [{ name, lat, lng }]   (seřazeno podle abecedy, čísla přirozeně: Praha 2 před Praha 10)

const UA = process.env.GEO_USER_AGENT
  || 'MartialTrainingLab/1.0 (+https://app.martialtraininglab.com; info@martialtraininglab.com)';
const OVERPASS = (process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter').trim();
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AREA = 3600000000;
const MAX_PARTS = 80;
const CACHE_DAYS = 90;

const MEM = new Map();
const MEM_TTL = 24 * 60 * 60 * 1000;
const MEM_MAX = 300;

async function overpass(ql, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || 25000);
  try {
    const r = await fetch(OVERPASS, {
      method: 'POST', signal: ac.signal,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: 'data=' + encodeURIComponent(ql),
    });
    if (!r.ok) { const e = new Error('overpass_' + r.status); e.status = r.status; throw e; }
    return r.json();
  } finally { clearTimeout(t); }
}

async function dbGet(key) {
  if (!SB || !KEY) return null;
  try {
    const r = await fetch(`${SB}/rest/v1/geo_district_cache?key=eq.${encodeURIComponent(key)}&select=data,at`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    if (!r.ok) return null;
    const row = (await r.json())[0];
    if (!row || !Array.isArray(row.data)) return null;
    if (Date.now() - Date.parse(row.at) > CACHE_DAYS * 86400000) return null;
    return row.data;
  } catch (e) { return null; }
}
async function dbPut(key, data) {
  if (!SB || !KEY) return;
  try {
    await fetch(`${SB}/rest/v1/geo_district_cache?on_conflict=key`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key, data, at: new Date().toISOString() }),
    });
  } catch (e) { /* cache je jen zrychlení */ }
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

// Z kandidátů vybere nejhrubší úroveň pod městem s aspoň 2 částmi.
function pickLevel(cands, cityLevel, city, lang) {
  const byLevel = {};
  for (const el of cands) {
    if (!el.center) continue;
    const t = el.tags || {};
    if (t.boundary !== 'administrative') continue;
    const lv = parseInt(t.admin_level, 10);
    if (!(lv > cityLevel && lv <= 11)) continue;
    const name = String(t['name:' + lang] || t.name || '').trim();
    if (!name || (city && name.toLowerCase() === city.toLowerCase())) continue;
    (byLevel[lv] = byLevel[lv] || []).push({ name, lat: Math.round(el.center.lat * 1e5) / 1e5, lng: Math.round(el.center.lon * 1e5) / 1e5 });
  }
  const lv = Object.keys(byLevel).map(Number).sort((a, b) => a - b).find((l) => byLevel[l].length >= 2);
  if (!lv) return [];
  const seen = {};
  const out = byLevel[lv].filter((p) => { const k = p.name.toLowerCase(); if (seen[k]) return false; seen[k] = 1; return true; });
  if (out.length > MAX_PARTS) return [];
  out.sort((a, b) => a.name.localeCompare(b.name, lang || 'cs', { numeric: true }));
  return out;
}

async function findCityRel(lat, lon, city) {
  if (!city) return 0;
  const d = await overpass(`[out:json][timeout:15];is_in(${lat},${lon})->.x;area.x["boundary"="administrative"]["name"];out tags;`, 15000);
  const hit = ((d && d.elements) || []).filter((e) => e.id > AREA && sameName(e.tags, city))
    .sort((a, b) => (parseInt(b.tags.admin_level, 10) || 0) - (parseInt(a.tags.admin_level, 10) || 0))[0];
  return hit ? hit.id - AREA : 0;
}

async function compute(id, city, lang) {
  // RYCHLÁ CESTA: části zapsané v relaci města.
  const d1 = await overpass(`[out:json][timeout:15];rel(${id})->.c;.c out tags;rel(r.c:"subarea");out center tags;`, 15000);
  const e1 = (d1 && d1.elements) || [];
  const c1 = e1.find((e) => e.type === 'relation' && e.id === id);
  if (!c1) return [];
  const cityLevel = parseInt((c1.tags || {}).admin_level, 10) || 8;
  const fast = pickLevel(e1.filter((e) => e !== c1), cityLevel, city, lang);
  if (fast.length) return fast;

  // POMALÁ CESTA: hranice uvnitř města, s kontrolou polohy.
  const d2 = await overpass(`[out:json][timeout:25];rel(${id})->.c;.c out tags geom;`
    + `area(${AREA + id})->.a;rel(area.a)["boundary"="administrative"]["admin_level"~"^(${cityLevel + 1}|${cityLevel + 2}|${cityLevel + 3})$"]["name"];out center tags;`, 25000);
  const e2 = (d2 && d2.elements) || [];
  const c2 = e2.find((e) => e.type === 'relation' && e.id === id && Array.isArray(e.members));
  if (!c2) return [];
  const segs = ringSegments(c2);
  if (segs.length < 3) return [];
  return pickLevel(e2.filter((e) => e !== c2 && e.id !== id && e.center && inside(segs, e.center.lon, e.center.lat)), cityLevel, city, lang);
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

  const pKey = `p${Math.round(lat * 100)}|${Math.round(lon * 100)}|${city.toLowerCase()}`;
  const send = (data) => {
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800');
    return res.status(200).json(data);
  };
  const remember = (k, data) => { if (MEM.size >= MEM_MAX) MEM.delete(MEM.keys().next().value); MEM.set(k, { at: Date.now(), data }); };

  try {
    if (!byRel) {
      const m = MEM.get(pKey);
      if (m && Date.now() - m.at < MEM_TTL) { id = m.data; }
      else { id = await findCityRel(lat, lon, city); remember(pKey, id); }
    }
    if (!(id > 0)) return send([]);

    const key = `r${id}|${lang}`;
    const m = MEM.get(key);
    if (m && Date.now() - m.at < MEM_TTL) return send(m.data);
    const stored = await dbGet(key);
    if (stored) { remember(key, stored); return send(stored); }

    const out = await compute(id, city, lang);
    remember(key, out);
    await dbPut(key, out);
    return send(out);
  } catch (e) {
    console.error('[geo-districts]', (e && e.message) || e);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'districts_unavailable' });
  }
}
