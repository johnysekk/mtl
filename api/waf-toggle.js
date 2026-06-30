// /api/waf-toggle — FOUNDER-ONLY: read / flip Vercel Attack Challenge Mode from the app.
// Env required: VERCEL_API_TOKEN, VERCEL_PROJECT_ID, (optional) VERCEL_TEAM_ID
const SB    = process.env.SUPABASE_URL;
const SKEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDER_UUID = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const V_TOKEN   = process.env.VERCEL_API_TOKEN;
const V_PROJECT = process.env.VERCEL_PROJECT_ID;
const V_TEAM    = process.env.VERCEL_TEAM_ID;

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

    if (!V_TOKEN || !V_PROJECT) return res.status(200).json({ ok: true, configured: false });

    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const qs = V_TEAM ? ('?teamId=' + encodeURIComponent(V_TEAM)) : '';

    if (b.action === 'set') {
      const enabled = !!b.enabled;
      const r = await fetch('https://api.vercel.com/v1/security/attack-mode' + qs, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + V_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: V_PROJECT, attackModeEnabled: enabled }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ ok: false, error: (j && j.error && j.error.message) || ('vercel ' + r.status) });
      return res.status(200).json({ ok: true, configured: true, enabled });
    }

    // get current state (best-effort; UI tolerates unknown)
    const r = await fetch('https://api.vercel.com/v1/security/attack-mode' + qs + (qs ? '&' : '?') + 'projectId=' + encodeURIComponent(V_PROJECT),
      { headers: { Authorization: 'Bearer ' + V_TOKEN } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(200).json({ ok: true, configured: true, enabled: null });
    const until = j && (j.attackModeEnabledUntil || j.attack_mode_enabled_until);
    const enabled = !!(j && (j.attackModeEnabled === true || (until && until > Date.now())));
    return res.status(200).json({ ok: true, configured: true, enabled });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
