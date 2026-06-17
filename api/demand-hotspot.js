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

    const rows = await pagedGet(`demand_signals?select=user_id,city,country,disciplines,created_at`);

    // aggregate by country|city
    const map = {};
    rows.forEach(r => {
      const city = (r.city || '').trim() || '(unknown)';
      const country = (r.country || '').trim();
      const key = country + '|' + city;
      if (!map[key]) map[key] = { city, country, count: 0, users: new Set(), disc: {}, last: '' };
      const m = map[key];
      m.count++;
      if (r.user_id) m.users.add(r.user_id);
      if (r.created_at > m.last) m.last = r.created_at;
      (r.disciplines || '').split(',').map(x => x.trim()).filter(Boolean).forEach(d => { m.disc[d] = (m.disc[d] || 0) + 1; });
    });

    const hotspots = Object.values(map).map(m => ({
      city: m.city, country: m.country,
      people: m.users.size,
      disciplines: Object.entries(m.disc).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n })),
      last: m.last,
    })).sort((a, b) => b.people - a.people).slice(0, 100);

    return res.status(200).json({ ok: true, hotspots, total: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
