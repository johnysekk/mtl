// /api/cohort-capi — multi-tenant Meta Conversions API (CAPI) relay for cohort signups.
// The browser Pixel and this server event share the same `event_id`, so Meta de-duplicates
// them = no double counting. Each cohort carries its OWN pixel id (gym_meta_pixel) and a
// secret CAPI token (capi_token) — the token NEVER leaves the server.
//
// POST body: Lead     { cohort_id, event:'Lead', event_id, email, phone, fbp, fbc, event_source_url, consent:true }
//            Purchase { cohort_id, event:'Purchase', cohort_member_id }
//
// SOUHLAS. Lead posílá přihláška jen se zaškrtnutým marketingovým souhlasem (consent:true, bez
// něj se nic neodešle). Purchase si server ověří sám: přihláška musí patřit ke kurzu, mít v sobě
// marketingový souhlas a zaplacenou zálohu -- e-mail, telefon a fbp/fbc se berou z ní, ne z těla
// požadavku (jinak by kdokoli mohl posílat cizí údaje do pixelu poskytovatele).
// Správcem pixelu je poskytovatel; MTL je jen zprostředkovatel.

import crypto from 'crypto';

const API_VERSION = 'v21.0';
const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbGet(path) {
  try { const r = await fetch(_SUPA + '/rest/v1/' + path, { headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY } }); return r.ok ? await r.json() : []; } catch (e) { return []; }
}
const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
// phones: strip everything but digits before hashing (Meta's expected normalization)
const sha256Phone = (v) => crypto.createHash('sha256').update(String(v).replace(/[^0-9]/g, '')).digest('hex');

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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!(await _rlAllow('cohort-capi', _rlIp(req), 40))) return res.status(429).json({ ok: false, error: 'Too many requests' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const cohortId = b.cohort_id;
    if (!cohortId) return res.status(400).json({ ok: false, error: 'missing cohort_id' });
    const event_name = (b.event === 'Purchase') ? 'Purchase' : 'Lead';

    // Look up this cohort's own pixel + secret token (server-side only).
    let mem = null;
    if (event_name === 'Purchase') {
      if (!b.cohort_member_id) return res.status(400).json({ ok: false, error: 'missing cohort_member_id' });
      mem = ((await sbGet(`cohort_members?id=eq.${encodeURIComponent(b.cohort_member_id)}&select=cohort_id,email,phone,fbp,fbc,consents,paid_amount`)) || [])[0] || null;
      if (!mem || String(mem.cohort_id) !== String(cohortId) || !(Number(mem.paid_amount) > 0) || !(mem.consents && mem.consents.marketing === true))
        return res.status(200).json({ ok: true, relayed: false });
    } else if (b.consent !== true) {
      return res.status(200).json({ ok: true, relayed: false });
    }
    const rows = await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohortId)}&select=gym_meta_pixel,capi_token,currency,deposit_amount`);
    const c = rows && rows[0];
    if (!c || !c.gym_meta_pixel || !c.capi_token) {
      // No CAPI configured for this cohort — nothing to relay, not an error.
      return res.status(200).json({ ok: true, relayed: false });
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
             || (req.socket && req.socket.remoteAddress) || '';
    const ua = req.headers['user-agent'] || '';

    const src = mem || b;
    const user_data = {};
    if (src.email) user_data.em = [sha256(src.email)];
    if (src.phone) user_data.ph = [sha256Phone(src.phone)];
    if (src.fbp) user_data.fbp = src.fbp;
    if (src.fbc) user_data.fbc = src.fbc;
    if (ip) user_data.client_ip_address = ip;
    if (ua) user_data.client_user_agent = ua;

    const custom_data = {};
    if (event_name === 'Purchase') {
      custom_data.value = Number(c.deposit_amount || 0);
      custom_data.currency = c.currency || 'CZK';
    }

    const evt = {
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: mem ? ('cp_' + b.cohort_member_id) : (b.event_id || ('lead_' + cohortId + '_' + Date.now())),
      user_data,
    };
    if (b.event_source_url) evt.event_source_url = b.event_source_url;
    if (Object.keys(custom_data).length) evt.custom_data = custom_data;

    const url = `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(c.gym_meta_pixel)}/events?access_token=${encodeURIComponent(c.capi_token)}`;
    const fbRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [evt] }),
    });
    const fbJson = await fbRes.json().catch(() => ({}));
    if (!fbRes.ok) return res.status(200).json({ ok: false, relayed: false, fb: fbJson });
    return res.status(200).json({ ok: true, relayed: true });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
