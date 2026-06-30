// /api/gym-conversions — server-side aggregation of a gym's MTL conversion funnel.
// Returns only computed numbers (not raw rows), so it's light regardless of volume.
// Security: caller sends their Supabase access token; we verify it and confirm gym ownership.
// viewer_id (gym_views) === student_id (purchases) === profiles.id, so we can attribute
// "discovered organically in MTL, then bought" without exposing any per-person data.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

async function pagedGet(path) {
  // PostgREST caps a page; page through so big gyms still aggregate fully.
  let out = [], PAGE = 1000;
  for (let off = 0; off <= 200000; off += PAGE) {
    const r = await fetch(`${SB}/rest/v1/${path}&limit=${PAGE}&offset=${off}`, { headers: svc });
    if (!r.ok) break;
    const page = await r.json();
    if (!Array.isArray(page) || page.length === 0) break;
    out = out.concat(page);
    if (page.length < PAGE) break;
  }
  return out;
}

const _RL_SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _RL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
function _rlIp(req) { const xr = req.headers['x-real-ip']; if (xr) return String(xr).trim(); const p = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return p.length ? p[p.length - 1] : ((req.socket && req.socket.remoteAddress) || 'unknown'); }
async function _rlAllow(endpoint, ip, limit, banMult) {
  try {
    const win = Math.floor(Date.now() / 600000);
    const r = await fetch(_RL_SUPA + '/rest/v1/rpc/rl_hit', { method: 'POST', headers: { apikey: _RL_KEY, Authorization: 'Bearer ' + _RL_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: ip + ':' + endpoint + ':' + win, p_ip: ip, p_endpoint: endpoint, p_window: win, p_limit: limit, p_ban_mult: banMult || 0 }) });
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

  try {
    const q = req.query || {};
    const b = (typeof req.body === 'object' && req.body) || {};
    const gymId = q.gymId || b.gymId;
    const token = req.headers['x-access-token'] || b.token ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

    if (!gymId) return res.status(400).json({ error: 'no gymId' });
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    // verify caller + ownership
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });
    if (!(await _rlAllow('gym-conversions', 'u:' + uid, 60))) return res.status(429).json({ ok: false, error: 'Too many requests' });

    const gres = await fetch(`${SB}/rest/v1/gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id,currency`, { headers: svc });
    const grows = gres.ok ? await gres.json() : [];
    if (!grows.length || grows[0].owner_id !== uid) return res.status(403).json({ error: 'not owner' });
    const currency = grows[0].currency || 'CZK';

    // data (service role)
    const gid = encodeURIComponent(gymId);
    const [views, books, mems] = await Promise.all([
      pagedGet(`gym_views?gym_id=eq.${gid}&select=viewer_id,view_date,source,engaged`),
      pagedGet(`gym_bookings?gym_id=eq.${gid}&select=student_id,created_at,status,amount,acq_source`),
      pagedGet(`gym_memberships?gym_id=eq.${gid}&select=student_id,created_at,status,amount,acq_source`),
    ]);

    const now = new Date();
    const ym = d => (d || '').slice(0, 7);
    const thisM = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const pd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const prevM = `${pd.getUTCFullYear()}-${String(pd.getUTCMonth() + 1).padStart(2, '0')}`;

    // opens / engaged (unique viewers per month) + source mix
    const openThis = new Set(), openPrev = new Set(), engThis = new Set();
    const sources = { deck: 0, search: 0, app: 0 };
    const organicByViewer = {}; // viewer -> earliest organic (deck/search) view_date
    views.forEach(v => {
      const m = ym(v.view_date);
      if (m === thisM) {
        openThis.add(v.viewer_id);
        if (v.engaged) engThis.add(v.viewer_id);
        const s = (v.source === 'deck' || v.source === 'search') ? v.source : 'app';
        sources[s] = (sources[s] || 0) + 1;
      } else if (m === prevM) {
        openPrev.add(v.viewer_id);
      }
      if (v.source === 'deck' || v.source === 'search') {
        const d = v.view_date || '';
        if (!organicByViewer[v.viewer_id] || d < organicByViewer[v.viewer_id]) organicByViewer[v.viewer_id] = d;
      }
    });

    // purchases (exclude refunded/cancelled)
    const purchases = [];
    books.forEach(x => { if (x.student_id && x.status !== 'refunded' && x.status !== 'cancelled') purchases.push({ sid: x.student_id, at: x.created_at || '', type: 'dropin', amt: Number(x.amount) || 0, acq: x.acq_source || '' }); });
    mems.forEach(x => { if (x.student_id && x.status !== 'refunded' && x.status !== 'cancelled') purchases.push({ sid: x.student_id, at: x.created_at || '', type: 'membership', amt: Number(x.amount) || 0, acq: x.acq_source || '' }); });

    const firstBy = {};
    purchases.forEach(p => { if (!firstBy[p.sid] || p.at < firstBy[p.sid].at) firstBy[p.sid] = p; });
    const memStudents = new Set(purchases.filter(p => p.type === 'membership').map(p => p.sid));

    // drop-in -> membership: of students whose FIRST purchase was a drop-in, how many ever got a membership
    let d2mBase = 0, d2mConv = 0;
    Object.values(firstBy).forEach(fp => { if (fp.type === 'dropin') { d2mBase++; if (memStudents.has(fp.sid)) d2mConv++; } });
    const d2mRate = d2mBase > 0 ? Math.round((d2mConv / d2mBase) * 100) : null;

    // new via MTL (this month): FIRST purchase this month whose acquisition source (captured
    // at join) is 'mtl_discovery'. Same field the per-member label reads => the number and the
    // labels always agree. Falls back to an organic gym_views match for legacy rows (no acq_source).
    let newCount = 0, newRevenue = 0;
    Object.values(firstBy).forEach(fp => {
      if (ym(fp.at) !== thisM) return;
      let isMtl = (fp.acq === 'mtl_discovery');
      if (!fp.acq) { const ov = organicByViewer[fp.sid]; if (ov && ov <= (fp.at.slice(0, 10) || fp.at)) isMtl = true; }
      if (isMtl) { newCount++; newRevenue += fp.amt; }
    });

    return res.status(200).json({
      ok: true,
      currency,
      opens: { this: openThis.size, prev: openPrev.size },
      engaged: { this: engThis.size },
      sources,
      dropinToMembership: { base: d2mBase, converted: d2mConv, rate: d2mRate },
      newViaMtl: { count: newCount, revenue: newRevenue },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
