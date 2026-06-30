// /api/gym-terms-accept — a walk-in guest (NO MTL account) confirms a gym's terms
// on their OWN phone (scanned a reception QR). Writes a guest waiver_acceptances row
// (guest_token links it to the reception booking). The reception verifies that row
// exists (by token) before recording the cash payment.
//
// POST { gymId, token, name, hash, version } -> service-role insert.
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { createClient } = require('@supabase/supabase-js');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!(await _rlAllow('gym-terms-accept', _rlIp(req), 20, 0))) return res.status(429).json({ error: 'Too many requests' });
  try {
    const SB = process.env.SUPABASE_URL;
    const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SB || !SR) return res.status(500).json({ error: 'config (supabase)' });
    const admin = createClient(SB, SR, { auth: { persistSession: false, autoRefreshToken: false } });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const gymId = (body.gymId || '').toString();
    const token = (body.token || '').toString();
    const name = ((body.name || '').toString().slice(0, 120)) || null;
    const hash = (body.hash || '').toString() || null;
    const version = parseInt(body.version, 10) || 0;
    if (!gymId || !token) return res.status(400).json({ error: 'missing gymId/token' });

    // gym must exist and actually have terms (don't record empty acceptances)
    const { data: g } = await admin.from('gyms').select('id,terms_text').eq('id', gymId).single();
    if (!g) return res.status(404).json({ error: 'gym not found' });
    if (!(g.terms_text && g.terms_text.trim())) return res.json({ ok: true, skipped: true });

    // idempotent: one acceptance per (gym, token)
    try {
      const { data: ex } = await admin.from('waiver_acceptances').select('id').eq('gym_id', gymId).eq('guest_token', token).limit(1);
      if (ex && ex.length) return res.json({ ok: true, already: true });
    } catch (e) {}

    const { error } = await admin.from('waiver_acceptances').insert({
      gym_id: gymId,
      guest_token: token,
      student_id: null,
      student_name: name,
      body_hash: hash,
      version: version,
      accepted_at: new Date().toISOString()
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: (e && e.message) || 'error' }); }
};
