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

    // Persist the Vercel-confirmed state on the founder profile (Vercel has no GET-state endpoint,
    // so the source of truth is the echo in the POST response, which we store + show with a timestamp).
    async function _storeWaf(enabled, at, until) {
      try {
        await fetch(`${SB}/rest/v1/profiles?id=eq.${FOUNDER_UUID}`, {
          method: 'PATCH',
          headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ waf_enabled: enabled, waf_set_at: at, waf_until: (until || null) }),
        });
      } catch (e) {}
    }

    if (b.action === 'set') {
      const want = !!b.enabled;
      // Vercel REQUIRES attackModeActiveUntil (epoch ms) when ENABLING — it auto-disables at that time.
      // 24h protection window; re-tap Enable to extend, or Off disables immediately (no until needed).
      const untilMs = want ? (Date.now() + 24 * 60 * 60 * 1000) : null;
      const payload = { projectId: V_PROJECT, attackModeEnabled: want };
      if (want) payload.attackModeActiveUntil = untilMs;
      const r = await fetch('https://api.vercel.com/v1/security/attack-mode' + qs, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + V_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ ok: false, error: (j && j.error && j.error.message) || ('vercel ' + r.status) });
      // Vercel echoes the resulting state (string "true"/"false" or bool) -> authoritative confirmation.
      const raw = j && j.attackModeEnabled;
      const hasEcho = (raw === true || raw === false || raw === 'true' || raw === 'false');
      const confirmed = hasEcho ? (raw === true || raw === 'true') : want;
      const at = new Date().toISOString();
      const untilIso = (confirmed && untilMs) ? new Date(untilMs).toISOString() : null;
      await _storeWaf(confirmed, at, untilIso);
      return res.status(200).json({ ok: true, configured: true, enabled: confirmed, confirmed: hasEcho, at, until: untilIso });
    }

    // get: there is NO Vercel GET-state endpoint, so return the last Vercel-confirmed state we stored.
    const pr = await fetch(`${SB}/rest/v1/profiles?id=eq.${FOUNDER_UUID}&select=waf_enabled,waf_set_at,waf_until`,
      { headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}` } });
    const pj = pr.ok ? await pr.json().catch(() => []) : [];
    const row = (pj && pj[0]) || {};
    let enabled = (typeof row.waf_enabled === 'boolean') ? row.waf_enabled : null;
    // Vercel auto-disables Attack Mode at attackModeActiveUntil, so never claim "on" past that time.
    const expired = !!(enabled && row.waf_until && Date.now() > new Date(row.waf_until).getTime());
    if (expired) enabled = false;
    return res.status(200).json({ ok: true, configured: true, enabled, at: row.waf_set_at || null, until: row.waf_until || null, expired, stored: true });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
