// /api/admin-security — FOUNDER-ONLY security console.
// Lists attackers + active bans and lets the founder ban/unban by IP.
// rate_limits / blocked_ips are RLS-locked to service_role, so the founder's
// browser can't read them directly — this endpoint is the gated window in.
const SB    = process.env.SUPABASE_URL;
const SKEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDER_UUID = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body,
  });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
  if (!r.ok) throw new Error('SB ' + r.status + ' ' + path);
  return j;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const token = req.headers['x-access-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'no token' });
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const u = await ures.json();
    const uid = u && (u.id || (u.user && u.user.id));
    if (uid !== FOUNDER_UUID) return res.status(403).json({ error: 'forbidden' });

    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const action = b.action || 'status';
    const nowIso = new Date().toISOString();

    if (action === 'ban') {
      if (!b.ip) return res.status(400).json({ error: 'no ip' });
      const days = Math.max(1, Math.min(365, parseInt(b.days || 1, 10)));
      const exp = new Date(Date.now() + days * 86400000).toISOString();
      await sb('blocked_ips', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify({ ip: b.ip, reason: 'manual', hits: 0, blocked_at: nowIso, expires_at: exp }) });
      return res.status(200).json({ ok: true });
    }
    if (action === 'unban') {
      if (!b.ip) return res.status(400).json({ error: 'no ip' });
      await sb('blocked_ips?ip=eq.' + encodeURIComponent(b.ip), { method: 'DELETE', prefer: 'return=minimal' });
      return res.status(200).json({ ok: true });
    }

    // ---- status ----
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const rows = await sb('rate_limits?updated_at=gt.' + encodeURIComponent(since) + '&select=ip,endpoint,hits,updated_at&order=hits.desc&limit=300').catch(() => []);
    const bans = await sb('blocked_ips?expires_at=gt.' + encodeURIComponent(nowIso) + '&select=ip,reason,hits,blocked_at,expires_at&order=blocked_at.desc').catch(() => []);

    const byIp = {};
    (rows || []).forEach(r => {
      if (!byIp[r.ip]) byIp[r.ip] = { ip: r.ip, hits: 0, endpoints: {}, last: r.updated_at };
      byIp[r.ip].hits += r.hits;
      byIp[r.ip].endpoints[r.endpoint] = (byIp[r.ip].endpoints[r.endpoint] || 0) + r.hits;
      if (r.updated_at > byIp[r.ip].last) byIp[r.ip].last = r.updated_at;
    });
    const offenders = Object.keys(byIp).map(k => byIp[k])
      .map(o => ({ ip: o.ip, hits: o.hits, endpoints: Object.keys(o.endpoints), last: o.last }))
      .filter(o => o.hits >= 10)
      .sort((a, b2) => b2.hits - a.hits).slice(0, 50);

    const totalHits = (rows || []).reduce((s, r) => s + r.hits, 0);
    const loudCount = offenders.filter(o => o.hits >= 50).length;
    let level = 'calm';
    if (totalHits >= 2000 || offenders.length >= 30) level = 'ddos';
    else if (loudCount >= 1 || (bans && bans.length >= 1)) level = 'attack';
    else if (offenders.length >= 1) level = 'elevated';

    return res.status(200).json({ ok: true, level, offenders, bans: bans || [],
      totals: { totalHits, offenderCount: offenders.length, banCount: (bans || []).length, loudCount } });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
