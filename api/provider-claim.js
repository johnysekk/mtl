// /api/provider-claim — links a staged provider_applications row to a just-registered user.
// The client holds the application id (a random UUID it received when it submitted, stored in
// localStorage) = a capability token. We claim on valid-id + not-already-claimed; email match is
// recorded as a bonus signal. Returns the staged data so the client can prefill the EXISTING
// coach/gym onboarding (no new onboarding is built — the applicant lands in the normal flow).

const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbGet(path) {
  try { const r = await fetch(_SUPA + '/rest/v1/' + path, { headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY } }); return r.ok ? await r.json() : []; } catch (e) { return []; }
}
async function sbPatch(path, body) {
  const r = await fetch(_SUPA + '/rest/v1/' + path, {
    method: 'PATCH',
    headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('patch ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j[0] : j;
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!(await _rlAllow('provider-claim', _rlIp(req), 6, 10))) return res.status(429).json({ ok: false, error: 'Too many requests' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const appId = (b.app_id || '').trim();
    const userId = (b.user_id || '').trim();
    if (!appId || !userId) return res.status(400).json({ ok: false, error: 'missing app_id or user_id' });

    const rows = await sbGet(`provider_applications?id=eq.${encodeURIComponent(appId)}&select=*`);
    const app = rows && rows[0];
    if (!app) return res.status(404).json({ ok: false, error: 'application not found' });

    // Already claimed by someone else -> refuse. Claimed by this user -> idempotent re-return.
    if (app.claimed_user_id && app.claimed_user_id !== userId) {
      return res.status(409).json({ ok: false, error: 'already claimed' });
    }

    const emailMatch = !!(app.email && b.email && String(app.email).toLowerCase() === String(b.email).toLowerCase());

    if (!app.claimed_user_id) {
      await sbPatch(`provider_applications?id=eq.${encodeURIComponent(appId)}`, {
        status: 'claimed', claimed_user_id: userId, claimed_at: new Date().toISOString()
      });
    }

    return res.status(200).json({
      ok: true,
      email_match: emailMatch,
      application: {
        kind: app.kind,
        name: app.name || '',
        city: app.city || '',
        gym_name: app.gym_name || '',
        disciplines: app.disciplines || [],
        note: app.note || '',
        ref_code: app.ref_code || null,
        marketing_consent: !!app.marketing_consent
      }
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
