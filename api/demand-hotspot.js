// /api/demand-hotspot — FOUNDER-ONLY. Server-side aggregation of demand_signals by city.
// Returns ranked acquisition targets (where people want gyms) + the disciplines they want.
// Never scanned client-side; founder reads pre-aggregated numbers, so it scales to 10M rows.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

async function pagedGet(path) {
  let out = [], PAGE = 1000;
  for (let off = 0; off <= 1000000; off += PAGE) {
    const r = await fetch(`${SB}/rest/v1/${path}&limit=${PAGE}&offset=${off}`, { headers: svc });
    if (!r.ok) break;
    const page = await r.json();
    if (!Array.isArray(page) || page.length === 0) break;
    out = out.concat(page);
    if (page.length < PAGE) break;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = req.headers['x-access-token'] ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    // verify caller is a FOUNDER
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });
    const pr = await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: svc });
    const prows = pr.ok ? await pr.json() : [];
    if (!prows.length || prows[0].role !== 'founder') return res.status(403).json({ error: 'founder only' });

    const rows = await pagedGet(`demand_signals?select=user_id,city,country,disciplines,created_at,lat,lng`);

    // Cluster by PROXIMITY (~30 km), not exact city string, so 'Brno' + 'Brno-stred'
    // + nearby villages collapse into one real hotspot. Greedy nearest-centroid pass.
    const CLUSTER_KM = 30;
    const hav = (la1, lo1, la2, lo2) => {
      const R = 6371, toR = x => x * Math.PI / 180;
      const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
      const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    };
    const addDisc = (obj, csv) => (csv || '').split(',').map(x => x.trim()).filter(Boolean).forEach(d => { obj[d] = (obj[d] || 0) + 1; });

    const clusters = [];
    const noCoord = {}; // signals without coords -> exact city|country buckets
    rows.forEach(r => {
      const lat = r.lat != null ? +r.lat : null, lng = r.lng != null ? +r.lng : null;
      const city = (r.city || '').trim();
      const country = (r.country || '').trim();
      if (lat != null && lng != null && isFinite(lat) && isFinite(lng)) {
        let best = null, bestD = Infinity;
        for (const c of clusters) { const d = hav(lat, lng, c.lat, c.lng); if (d < bestD) { bestD = d; best = c; } }
        let c;
        if (best && bestD <= CLUSTER_KM) { c = best; }
        else { c = { lat, lng, n: 0, users: new Set(), disc: {}, cities: {}, country, last: '' }; clusters.push(c); }
        c.lat = (c.lat * c.n + lat) / (c.n + 1);
        c.lng = (c.lng * c.n + lng) / (c.n + 1);
        c.n++;
        if (r.user_id) c.users.add(r.user_id);
        if (country && !c.country) c.country = country;
        if (city) c.cities[city] = (c.cities[city] || 0) + 1;
        if (r.created_at > c.last) c.last = r.created_at;
        addDisc(c.disc, r.disciplines);
      } else {
        const key = country + '|' + (city || '(unknown)');
        if (!noCoord[key]) noCoord[key] = { city: city || '(unknown)', country, users: new Set(), disc: {}, last: '' };
        const m = noCoord[key];
        if (r.user_id) m.users.add(r.user_id);
        if (r.created_at > m.last) m.last = r.created_at;
        addDisc(m.disc, r.disciplines);
      }
    });

    const discList = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n }));
    const fromClusters = clusters.map(c => ({
      city: (Object.entries(c.cities).sort((a, b) => b[1] - a[1])[0] || ['(area)'])[0],
      country: c.country, people: c.users.size, disciplines: discList(c.disc), last: c.last,
      lat: +c.lat.toFixed(3), lng: +c.lng.toFixed(3),
    }));
    const fromNoCoord = Object.values(noCoord).map(m => ({
      city: m.city, country: m.country, people: m.users.size, disciplines: discList(m.disc), last: m.last,
    }));
    const hotspots = fromClusters.concat(fromNoCoord).sort((a, b) => b.people - a.people).slice(0, 100);

    return res.status(200).json({ ok: true, hotspots, total: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
