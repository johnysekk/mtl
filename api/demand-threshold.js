// /api/demand-threshold — when enough UNIQUE people in an area want the SAME discipline,
// notify (a) the founder(s) — a hot acquisition target for that discipline — and (b) the
// people who asked for that discipline — a re-engagement nudge. Server-side + service-role:
// the client never reads others' signals or writes others' notifications. Deduped per
// ~30 km cluster + discipline via demand_alerts (cooldown).

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
async function sbGet(path) { try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc }); return r.ok ? r.json() : []; } catch (e) { return []; } }
async function sbPost(path, body) { try { const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(body) }); return r.ok; } catch (e) { return false; } }

import { LOCAL_KM, DEMAND_THRESHOLD } from './_geo.js';
const THRESHOLD = DEMAND_THRESHOLD;   // unique people wanting the SAME discipline within the radius
const RADIUS_KM = LOCAL_KM;           // was 25 -- the deck only ever showed the student 20
const COOLDOWN_DAYS = 45;

function hav(la1, lo1, la2, lo2) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export default async function handler(req, res) {
  try {
    const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
    if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'bad coords' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'not configured' });

    // bounding box (~30 km) then exact haversine filter
    const dLat = 0.32, dLng = 0.32 / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    const fresh = new Date(Date.now() - 120 * 86400000).toISOString(); // recency: ignore signals older than 120 days
    const rows = await sbGet(`demand_signals?select=user_id,city,country,disciplines,lat,lng,source,opens&created_at=gte.${fresh}&lat=gte.${lat - dLat}&lat=lte.${lat + dLat}&lng=gte.${lng - dLng}&lng=lte.${lng + dLng}&limit=8000`);
    const near = rows.filter(r => r.lat != null && r.lng != null && hav(lat, lng, +r.lat, +r.lng) <= RADIUS_KM);

    // unique people PER discipline + a representative city/country
    const byDisc = {};          // disc -> { users:Set, cities:{} }
    const cities = {};
    let country = '';
    near.forEach(r => {
      const c = (r.city || '').trim(); if (c) cities[c] = (cities[c] || 0) + 1;
      if (r.country && !country) country = r.country;
      const _strong = (r.source !== 'passive') || ((r.opens || 1) >= 3);
      (r.disciplines || '').split(',').map(x => x.trim()).filter(Boolean).forEach(d => {
        if (!byDisc[d]) byDisc[d] = { users: new Set(), cities: {} };
        if (r.user_id && _strong) byDisc[d].users.add(r.user_id);
        if (c) byDisc[d].cities[c] = (byDisc[d].cities[c] || 0) + 1;
      });
    });

    const grid = Math.round(lat / 0.25) + '_' + Math.round(lng / 0.25);
    const since = new Date(Date.now() - COOLDOWN_DAYS * 86400000).toISOString();
    const cityAll = (Object.entries(cities).sort((a, b) => b[1] - a[1])[0] || [''])[0];

    const fired = [];
    const founders = await sbGet(`profiles?role=eq.founder&select=id`);

    for (const disc of Object.keys(byDisc)) {
      const people = byDisc[disc].users.size;
      if (people < THRESHOLD) continue;

      const clusterKey = grid + '|' + disc;
      const prev = await sbGet(`demand_alerts?cluster_key=eq.${encodeURIComponent(clusterKey)}&notified_at=gte.${since}&select=cluster_key`);
      if (prev.length) continue;

      const city = (Object.entries(byDisc[disc].cities).sort((a, b) => b[1] - a[1])[0] || [cityAll])[0] || cityAll;
      await sbPost('demand_alerts', { cluster_key: clusterKey, city, country, people, notified_at: new Date().toISOString() });

      // (a) founder(s): hot acquisition target for THIS discipline
      const fmsg = `🔥 ${people} people near ${city || 'an area'}${country ? (', ' + country) : ''} want ${disc} — hot acquisition target.`;
      for (const f of founders || []) {
        await sbPost('notifications', { user_id: f.id, type: 'system', read: false, data: JSON.stringify({ kind: 'demand_hotspot', city, country, lat, lng, people, disc }), message: fmsg });
      }
      // (b) the people who asked for THIS discipline: re-engagement nudge
      const dmsg = `🙌 Lots of people near ${city || 'you'} want the same training — we're prioritising your area and will let you know the moment a gym joins MTL.`;
      for (const uid of byDisc[disc].users) {
        await sbPost('notifications', { user_id: uid, type: 'system', read: false, data: JSON.stringify({ kind: 'demand_priority', city, country, disc }), message: dmsg });
      }
      fired.push({ disc, people });
    }

    return res.status(200).json({ ok: true, fired });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
