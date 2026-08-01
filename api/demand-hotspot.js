// /api/demand-hotspot — FOUNDER-ONLY. Server-side aggregation of demand_signals by city.
// Returns ranked acquisition targets (where people want gyms) + the disciplines they want.
// Never scanned client-side; founder reads pre-aggregated numbers, so it scales to 10M rows.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
import { LOCAL_KM, commitLive, discList as _discList } from './_geo.js';

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

    const rows = await pagedGet(`demand_signals?select=user_id,city,country,disciplines,created_at,last_seen_at,lat,lng,source,opens,committed,committed_at,form_at,windows,levels,reasons,wanted_gyms&source=neq.resolved`);

    // Resolved rows are the CONVERSION numerator: people who asked and have since started training
    // somewhere. resolve_demand() flips them rather than deleting, so the evidence stays. Note this
    // reads created_at, not last_seen_at -- somebody who found a club three months ago and stopped
    // opening the app is still a conversion, and filtering them on last-seen would lose exactly the
    // successes we are trying to count.
    const resolvedRows = await pagedGet(`demand_signals?select=user_id,disciplines,lat,lng,created_at&source=eq.resolved`);

    // SUPPLY side: approved gyms with coords + the disciplines they teach.
    const gymRows = await pagedGet(`gyms?status=eq.approved&select=id,name,disciplines,city_lat,city_lng`);
    const gymPts = gymRows
      .filter(g => g.city_lat != null && g.city_lng != null && isFinite(+g.city_lat) && isFinite(+g.city_lng))
      .map(g => ({ lat: +g.city_lat, lng: +g.city_lng, disc: new Set(_discList(g.disciplines)) }));
    // id -> name, so the founder reads club names rather than UUIDs in the 'people picked these'
    // list. Cheap: the gyms are already loaded for the supply calculation.
    const gymName = {}; (gymRows || []).forEach(g => { gymName[g.id] = g.name || ''; });

    // Cluster by PROXIMITY (~30 km), not exact city string, so 'Brno' + 'Brno-stred'
    // + nearby villages collapse into one real hotspot. Greedy nearest-centroid pass.
    const CLUSTER_KM = LOCAL_KM;   // how demand signals group into one hotspot
    const SUPPLY_KM = LOCAL_KM;    // gym-coverage radius (matches what the deck showed the student)
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
        else { c = { lat, lng, n: 0, users: new Map(), exU: new Set(), pasU: new Set(), strongU: new Set(), comU: new Set(), formU: new Set(), wantG: {}, namedU: new Set(), unnamedU: new Set(), win: {}, lvl: {}, why: {}, resolvedU: new Set(), disc: {}, cities: {}, country, last: '' }; clusters.push(c); }
        c.lat = (c.lat * c.n + lat) / (c.n + 1);
        c.lng = (c.lng * c.n + lng) / (c.n + 1);
        c.n++;
        if (r.user_id) { const _ts = new Date(r.last_seen_at || r.created_at || 0).getTime(); if (_ts > (c.users.get(r.user_id) || 0)) c.users.set(r.user_id, _ts); (r.source==='passive'?c.pasU:c.exU).add(r.user_id); if((r.source!=='passive')||((r.opens||1)>=3)) c.strongU.add(r.user_id); if(commitLive(r.committed, r.committed_at)) c.comU.add(r.user_id); }
        if (country && !c.country) c.country = country;
        if (city) c.cities[city] = (c.cities[city] || 0) + 1;
        if (r.created_at > c.last) c.last = r.created_at;
        addDisc(c.disc, r.disciplines);
        if (r.form_at && r.user_id) {
          c.formU.add(r.user_id);
          // Which clubs people said they would go to. The founder needs this even below the club
          // threshold: it is the earliest sign that demand is forming around a specific gym, and
          // it says whether the market has a candidate or is genuinely unserved.
          const _wl = (r.wanted_gyms || '').split(',').map(x => x.trim()).filter(Boolean);
          _wl.forEach(g => { (c.wantG[g] = c.wantG[g] || new Set()).add(r.user_id); });
          // Named somebody vs named nobody. The second group is the honest "none of these will do".
          (_wl.length ? c.namedU : c.unnamedU).add(r.user_id);
          addDisc(c.win, r.windows);
          addDisc(c.lvl, r.levels);
          addDisc(c.why, r.reasons);
        }
      } else {
        const key = country + '|' + (city || '(unknown)');
        if (!noCoord[key]) noCoord[key] = { city: city || '(unknown)', country, users: new Map(), exU: new Set(), pasU: new Set(), strongU: new Set(), comU: new Set(), formU: new Set(), disc: {}, last: '' };
        const m = noCoord[key];
        if (r.user_id) { const _ts = new Date(r.last_seen_at || r.created_at || 0).getTime(); if (_ts > (m.users.get(r.user_id) || 0)) m.users.set(r.user_id, _ts); (r.source==='passive'?m.pasU:m.exU).add(r.user_id); if((r.source!=='passive')||((r.opens||1)>=3)) m.strongU.add(r.user_id); if(commitLive(r.committed, r.committed_at)) m.comU.add(r.user_id); }
        if (r.created_at > m.last) m.last = r.created_at;
        addDisc(m.disc, r.disciplines);
      }
    });

    // Attach each resolved person to the nearest cluster, same CLUSTER_KM rule that built them.
    for (const r of resolvedRows || []) {
      if (r.lat == null || r.lng == null || !r.user_id) continue;
      let best = null, bestD = Infinity;
      for (const c of clusters) { const d = hav(+r.lat, +r.lng, c.lat, c.lng); if (d < bestD) { bestD = d; best = c; } }
      if (best && bestD <= CLUSTER_KM) best.resolvedU.add(r.user_id);
    }

    const discList = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n }));
    const supplyNear = (lat, lng, topDisc) => {
      let near = 0, nearDisc = 0;
      for (const g of gymPts) {
        if (hav(lat, lng, g.lat, g.lng) <= SUPPLY_KM) { near++; if (topDisc && g.disc.has(topDisc)) nearDisc++; }
      }
      return { near, nearDisc };
    };
    // Three queues, split by the ACTION they need rather than by the shape of the data. "No club"
    // and "club that repels people" both end in "go recruit a club", but they are different sales
    // conversations -- greenfield versus going in against an incumbent -- so they stay apart.
    //
    // "Weak conversion" used to be inferred from resolved/(live+resolved), which measured the wrong
    // thing: fresh demand has had no time to convert, so every new market came out weak and landed
    // in the acquisition queue even when people had plainly chosen a local club.
    //
    // The direct evidence was there all along: whether form-fillers NAMED a club. Somebody who
    // filled the form and picked nobody has looked at what exists and rejected all of it. That is
    // what "the supply repels people" actually looks like -- an answer, not an inference from a
    // ratio that is low simply because nothing has happened yet.
    const REJECT_SHARE = 0.6;   // most form-fillers named nobody -> supply is the problem
    const REJECT_MIN = 5;       // below this the share is noise
    const fromClusters = clusters.map(c => {
      const dl = discList(c.disc);
      const topDisc = dl.length ? dl[0].v : null;
      const sup = supplyNear(c.lat, c.lng, topDisc);
      const pp = peopleScore(c.users, c.strongU);
      const resolved = c.resolvedU.size;
      const base = pp.people + resolved;
      const CONV_MIN_SAMPLE = 8;   // below this the ratio is noise, so show nothing
      const conversion = base >= CONV_MIN_SAMPLE ? +(resolved / base).toFixed(3) : null;
      const _named = c.namedU.size, _unnamed = c.unnamedU.size, _both = _named + _unnamed;
      const rejected = _both >= REJECT_MIN ? +(_unnamed / _both).toFixed(3) : null;
      const queue = (sup.nearDisc === 0)
        ? 'none'
        : ((rejected != null && rejected >= REJECT_SHARE) ? 'conv' : 'add');
      return {
        queue, resolved, conversion, rejected, named: _named, unnamed: _unnamed,
        forms: c.formU.size,
        windows: discList(c.win), levels: discList(c.lvl), reasons: discList(c.why),
        wanted: Object.entries(c.wantG).map(([g, set]) => ({ gym: g, name: gymName[g] || '', n: set.size })).sort((a, b) => b.n - a.n).slice(0, 8),
        city: (Object.entries(c.cities).sort((a, b) => b[1] - a[1])[0] || ['(area)'])[0],
        country: c.country, people: pp.people, score: pp.score, explicit: c.exU.size, passive: c.pasU.size, committed: c.comU.size, disciplines: dl, last: c.last,
        lat: +c.lat.toFixed(3), lng: +c.lng.toFixed(3),
        cluster_key: Math.round(c.lat / 0.25) + '_' + Math.round(c.lng / 0.25),
        gyms_near: sup.near, gyms_near_disc: sup.nearDisc,
        underserved: sup.nearDisc === 0,   // nobody within SUPPLY_KM (20km) teaches what they most want
      };
    });
    const fromNoCoord = Object.values(noCoord).map(m => { const pp = peopleScore(m.users, m.strongU); return {
      city: m.city, country: m.country, people: pp.people, score: pp.score, explicit: m.exU.size, passive: m.pasU.size, committed: m.comU.size, disciplines: discList(m.disc), last: m.last,
      gyms_near: null, gyms_near_disc: null, underserved: false,
      queue: 'none', resolved: 0, conversion: null, rejected: null, named: 0, unnamed: 0, forms: m.formU ? m.formU.size : 0,
      windows: [], levels: [], reasons: [],
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
