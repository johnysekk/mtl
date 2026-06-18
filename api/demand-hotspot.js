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

    const rows = await pagedGet(`demand_signals?select=user_id,city,country,disciplines,created_at,lat,lng,source,opens,committed`);

    // SUPPLY side: approved gyms with coords + the disciplines they teach.
    const gymRows = await pagedGet(`gyms?status=eq.approved&select=id,disciplines,city_lat,city_lng`);
    const gymPts = gymRows
      .filter(g => g.city_lat != null && g.city_lng != null && isFinite(+g.city_lat) && isFinite(+g.city_lng))
      .map(g => ({ lat: +g.city_lat, lng: +g.city_lng, disc: new Set((g.disciplines || '').split(',').map(x => x.trim()).filter(Boolean)) }));

    // Cluster by PROXIMITY (~30 km), not exact city string, so 'Brno' + 'Brno-stred'
    // + nearby villages collapse into one real hotspot. Greedy nearest-centroid pass.
    const CLUSTER_KM = 25;
    // recency decay: a person's signal loses half its weight every 90 days and is ignored past 180.
    const NOW = Date.now(), HALFLIFE = 60, MAXAGE = 120;
    const recW = ms => { const a = (NOW - ms) / 86400000; return a > MAXAGE ? 0 : Math.pow(0.5, a / HALFLIFE); };
    const peopleScore = (umap, strongSet) => { let people = 0, score = 0; umap.forEach((ts, uid) => { const w = recW(ts); if (w > 0) { people++; score += w * ((strongSet && strongSet.has(uid)) ? 1 : 0.4); } }); return { people, score: +score.toFixed(2) }; };
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
        else { c = { lat, lng, n: 0, users: new Map(), exU: new Set(), pasU: new Set(), strongU: new Set(), comU: new Set(), disc: {}, cities: {}, country, last: '' }; clusters.push(c); }
        c.lat = (c.lat * c.n + lat) / (c.n + 1);
        c.lng = (c.lng * c.n + lng) / (c.n + 1);
        c.n++;
        if (r.user_id) { const _ts = new Date(r.created_at || 0).getTime(); if (_ts > (c.users.get(r.user_id) || 0)) c.users.set(r.user_id, _ts); (r.source==='passive'?c.pasU:c.exU).add(r.user_id); if((r.source!=='passive')||((r.opens||1)>=3)) c.strongU.add(r.user_id); if(r.committed) c.comU.add(r.user_id); }
        if (country && !c.country) c.country = country;
        if (city) c.cities[city] = (c.cities[city] || 0) + 1;
        if (r.created_at > c.last) c.last = r.created_at;
        addDisc(c.disc, r.disciplines);
      } else {
        const key = country + '|' + (city || '(unknown)');
        if (!noCoord[key]) noCoord[key] = { city: city || '(unknown)', country, users: new Map(), exU: new Set(), pasU: new Set(), strongU: new Set(), comU: new Set(), disc: {}, last: '' };
        const m = noCoord[key];
        if (r.user_id) { const _ts = new Date(r.created_at || 0).getTime(); if (_ts > (m.users.get(r.user_id) || 0)) m.users.set(r.user_id, _ts); (r.source==='passive'?m.pasU:m.exU).add(r.user_id); if((r.source!=='passive')||((r.opens||1)>=3)) m.strongU.add(r.user_id); if(r.committed) m.comU.add(r.user_id); }
        if (r.created_at > m.last) m.last = r.created_at;
        addDisc(m.disc, r.disciplines);
      }
    });

    const discList = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n }));
    const supplyNear = (lat, lng, topDisc) => {
      let near = 0, nearDisc = 0;
      for (const g of gymPts) {
        if (hav(lat, lng, g.lat, g.lng) <= CLUSTER_KM) { near++; if (topDisc && g.disc.has(topDisc)) nearDisc++; }
      }
      return { near, nearDisc };
    };
    const fromClusters = clusters.map(c => {
      const dl = discList(c.disc);
      const topDisc = dl.length ? dl[0].v : null;
      const sup = supplyNear(c.lat, c.lng, topDisc);
      const pp = peopleScore(c.users, c.strongU);
      return {
        city: (Object.entries(c.cities).sort((a, b) => b[1] - a[1])[0] || ['(area)'])[0],
        country: c.country, people: pp.people, score: pp.score, explicit: c.exU.size, passive: c.pasU.size, committed: c.comU.size, disciplines: dl, last: c.last,
        lat: +c.lat.toFixed(3), lng: +c.lng.toFixed(3),
        cluster_key: Math.round(c.lat / 0.25) + '_' + Math.round(c.lng / 0.25),
        gyms_near: sup.near, gyms_near_disc: sup.nearDisc,
        underserved: sup.nearDisc === 0,   // nobody within 30km teaches what they most want
      };
    });
    const fromNoCoord = Object.values(noCoord).map(m => { const pp = peopleScore(m.users, m.strongU); return {
      city: m.city, country: m.country, people: pp.people, score: pp.score, explicit: m.exU.size, passive: m.pasU.size, committed: m.comU.size, disciplines: discList(m.disc), last: m.last,
      gyms_near: null, gyms_near_disc: null, underserved: false,
      cluster_key: 'city:' + (m.city || '').toLowerCase(),
    }; });
    const hotspots = fromClusters.concat(fromNoCoord).filter(h => h.people > 0).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 100);
    // attach acquisition-pipeline status (new | contacted | won | lost)
    try {
      const stat = await pagedGet(`hotspot_status?select=cluster_key,status`);
      const smap = {}; (stat || []).forEach(r => { smap[r.cluster_key] = r.status; });
      hotspots.forEach(h => { h.status = smap[h.cluster_key] || 'new'; });
    } catch (e) {}

    return res.status(200).json({ ok: true, hotspots, total: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
