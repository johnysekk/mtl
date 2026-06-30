// /api/gym-cohort — the demand cohort that was WAITING for this gym's sport nearby.
// GET  ?gymId  -> { ok, count, committed, disciplines }  (owner/founder only; aggregate, no PII)
// POST ?gymId  { discount_pct, expires_days } -> sends the waiting cohort a WELCOME-OFFER
//      notification (optional discount is the gym's choice) and logs hotspot_offers. -> { ok, notified }
// Server-side + service-role: the gym never reads others' signals or writes others' notifications client-side.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
const RADIUS_KM = 25;
const FRESH_DAYS = 120;
const THRESHOLD = 15; // the cohort surfaces to the gym only at 15+ unique people (meaningful + small-number privacy) // ignore demand older than this

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
function hav(la1, lo1, la2, lo2) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const _RL_SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _RL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
function _rlIp(req) { const xr = req.headers['x-real-ip']; if (xr) return String(xr).trim(); const p = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return p.length ? p[p.length - 1] : ((req.socket && req.socket.remoteAddress) || 'unknown'); }
async function _rlAllow(endpoint, ip, limit) {
  try {
    const win = Math.floor(Date.now() / 600000);
    const r = await fetch(_RL_SUPA + '/rest/v1/rpc/rl_hit', { method: 'POST', headers: { apikey: _RL_KEY, Authorization: 'Bearer ' + _RL_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: ip + ':' + endpoint + ':' + win, p_ip: ip, p_endpoint: endpoint, p_window: win, p_limit: limit }) });
    if (!r.ok) return true;
    let _j = await r.json();
    if (Array.isArray(_j)) _j = _j[0];
    else if (_j && typeof _j === 'object') _j = Object.values(_j)[0];
    return _j !== false && _j !== 'false';
  } catch (e) { return true; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!(await _rlAllow('gym-cohort', _rlIp(req), 60))) return res.status(429).json({ ok: false, error: 'Too many requests' });

  try {
    let b = {};
    if (req.method === 'POST') { try { b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (e) { b = {}; } }
    const gymId = req.query.gymId || b.gymId;
    const token = req.headers['x-access-token'] || b.token ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!gymId) return res.status(400).json({ error: 'no gymId' });
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    // verify caller
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });

    // load gym + ownership (founder may also act)
    const gres = await fetch(`${SB}/rest/v1/gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id,city_lat,city_lng,disciplines,name,city,country`, { headers: svc });
    const grows = gres.ok ? await gres.json() : [];
    if (!grows.length) return res.status(404).json({ error: 'no gym' });
    const gym = grows[0];
    let isFounder = false;
    if (gym.owner_id !== uid) {
      const pr = await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: svc });
      const prows = pr.ok ? await pr.json() : [];
      isFounder = prows.length && prows[0].role === 'founder';
      if (!isFounder) return res.status(403).json({ error: 'not owner' });
    }

    const glat = gym.city_lat != null ? +gym.city_lat : null;
    const glng = gym.city_lng != null ? +gym.city_lng : null;
    if (glat == null || glng == null || !isFinite(glat) || !isFinite(glng)) return res.status(200).json({ ok: true, count: 0, committed: 0, disciplines: [], note: 'gym has no coords' });
    const gymDisc = new Set((gym.disciplines || '').split(',').map(x => x.trim()).filter(Boolean));

    // pull recent demand in a bounding box, exact-filter by haversine + discipline intersection + strong signal
    const dLat = 0.32, dLng = 0.32 / Math.max(0.2, Math.cos(glat * Math.PI / 180));
    const fresh = new Date(Date.now() - FRESH_DAYS * 86400000).toISOString();
    const rows = await pagedGet(`demand_signals?select=user_id,disciplines,lat,lng,committed,source,opens&created_at=gte.${fresh}&lat=gte.${glat - dLat}&lat=lte.${glat + dLat}&lng=gte.${glng - dLng}&lng=lte.${glng + dLng}`);

    const matchUsers = new Set(), committedUsers = new Set(), discCount = {};
    for (const r of rows) {
      if (r.lat == null || r.lng == null) continue;
      if (hav(glat, glng, +r.lat, +r.lng) > RADIUS_KM) continue;
      const ds = (r.disciplines || '').split(',').map(x => x.trim()).filter(Boolean);
      const hit = gymDisc.size ? ds.some(d => gymDisc.has(d)) : ds.length > 0;
      if (!hit) continue;
      const strong = (r.source !== 'passive') || ((r.opens || 1) >= 3);
      if (!strong) continue;
      if (r.user_id) {
        matchUsers.add(r.user_id);
        if (r.committed) committedUsers.add(r.user_id);
      }
      ds.forEach(d => { if (!gymDisc.size || gymDisc.has(d)) discCount[d] = (discCount[d] || 0) + 1; });
    }
    const disciplines = Object.entries(discCount).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n }));

    if (req.method !== 'POST') {
      const enough = matchUsers.size >= THRESHOLD;
      return res.status(200).json(enough
        ? { ok: true, enough: true, threshold: THRESHOLD, count: matchUsers.size, committed: committedUsers.size, disciplines }
        : { ok: true, enough: false, threshold: THRESHOLD });   // below threshold: hide the small number entirely
    }
    if (matchUsers.size < THRESHOLD) return res.status(400).json({ error: 'not enough demand', threshold: THRESHOLD });

    // POST: send the waiting cohort a welcome-offer notification (discount optional)
    const pct = Math.max(0, Math.min(100, parseInt(b.discount_pct, 10) || 0));
    const days = Math.max(0, Math.min(365, parseInt(b.expires_days, 10) || 0));
    const expires = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    const topDisc = disciplines.length ? disciplines[0].v : null;

    await fetch(`${SB}/rest/v1/hotspot_offers`, { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' },
      body: JSON.stringify({ gym_id: gymId, disc: topDisc, discount_pct: pct || null, expires_at: expires }) });

    const ids = Array.from(matchUsers);
    const nm = gym.name || 'A gym';
    const where = gym.city ? (' v ' + gym.city) : '';
    const offerCz = pct ? (' a dává ti uvítací slevu ' + pct + '%' + (days ? (' (platí ' + days + ' dní)') : '')) : '';
    const offerEn = pct ? (' and is giving you a welcome discount of ' + pct + '%' + (days ? (' (valid ' + days + ' days)') : '')) : '';
    const msgCz = '\uD83C\uDF89 ' + nm + ' u\u010D\u00ED sport, kter\u00FD jsi hledal' + where + offerCz + '. Najde\u0161 ho v MTL appce.';
    const msgEn = '\uD83C\uDF89 ' + nm + ' teaches the sport you were looking for' + offerEn + '. Find it in the MTL app.';

    const payload = ids.map(u => ({
      user_id: u, type: 'system', read: false,
      data: JSON.stringify({ kind: 'welcome_offer', gym_id: gymId, disc: topDisc, discount_pct: pct || null, expires_at: expires }),
      message: msgCz + ' / ' + msgEn,
    }));
    let notified = 0;
    for (let i = 0; i < payload.length; i += 500) {
      const chunk = payload.slice(i, i + 500);
      const r = await fetch(`${SB}/rest/v1/notifications`, { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
      if (r.ok) notified += chunk.length;
    }
    return res.status(200).json({ ok: true, notified, count: matchUsers.size, committed: committedUsers.size, discount_pct: pct, expires_days: days });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
