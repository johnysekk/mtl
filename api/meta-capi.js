// /api/meta-capi.js  —  Meta Conversions API (CAPI) relay for a Carrd page
// Deploy this as a serverless function on Vercel (e.g. add it to your existing MTL app
// under /api/meta-capi.js). The Carrd page calls it on form submit.
//
// SETUP (one-time):
//   1) Vercel → Project → Settings → Environment Variables:
//        META_CAPI_TOKEN = <your Conversions API access token>
//      Generate it in Meta Events Manager → your dataset (2107830393410251)
//        → Settings → Conversions API → "Generate access token".
//      The token lives ONLY here on the server — never in the Carrd page.
//   2) (Optional) lock the endpoint to your Carrd domain — see ALLOWED_ORIGIN below.
//
// The browser Pixel (in the Carrd embed) and this server event share the same
// `event_id`, so Meta de-duplicates them = no double counting.

import crypto from 'crypto';

const PIXEL_ID    = '2107830393410251';
const API_VERSION = 'v21.0';                 // bump to the current Graph API version if needed
const ALLOWED_ORIGIN = '*';                  // or set to e.g. 'https://yourpage.carrd.co'

// Meta wants PII normalized (trim + lowercase) then SHA-256 hashed.
const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

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
  // CORS — the Carrd page is on a different domain
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });
  if (!(await _rlAllow('meta-capi', _rlIp(req), 20))) return res.status(429).json({ error: 'Too many requests' });

  const token = process.env.META_CAPI_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_CAPI_TOKEN env var is not set' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const {
      event_name = 'Lead',
      event_id,
      event_source_url,
      email, phone, first_name, last_name,
      fbp, fbc,
      custom_data = {},
      test_event_code,            // pass this to see events in Meta's "Test events" tab
    } = b;

    // client IP + user agent improve match quality
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
             || (req.socket && req.socket.remoteAddress) || '';
    const ua = req.headers['user-agent'] || '';

    // Tag the lead level so muaythailab.cz vs pokrocili.muaythailab.cz are distinguishable in Meta.
    // Explicit lead_level wins; otherwise infer from the source domain. Never overrides a provided content_name.
    if (!custom_data.content_name) {
      if (b.lead_level) custom_data.content_name = String(b.lead_level);
      else {
        const _src = String(event_source_url || req.headers.referer || '').toLowerCase();
        if (_src.includes('pokrocili')) custom_data.content_name = 'pokrocili';
        else if (_src.includes('muaythailab')) custom_data.content_name = 'zaklad';
      }
    }

    const user_data = {};
    if (email)      user_data.em = [sha256(email)];
    if (phone)      user_data.ph = [sha256(String(phone).replace(/[^0-9]/g, ''))]; // digits only, incl. country code
    if (first_name) user_data.fn = [sha256(first_name)];
    if (last_name)  user_data.ln = [sha256(last_name)];
    if (ip) user_data.client_ip_address = ip;
    if (ua) user_data.client_user_agent = ua;
    if (fbp) user_data.fbp = fbp;   // _fbp cookie (NOT hashed)
    if (fbc) user_data.fbc = fbc;   // _fbc cookie (NOT hashed)

    const event = {
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: event_id || undefined,                          // dedup key with the Pixel
      event_source_url: event_source_url || req.headers.referer || undefined,
      user_data,
      custom_data,
    };

    const payload = { data: [event] };
    if (test_event_code) payload.test_event_code = test_event_code;

    const r = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    const out = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Meta API error', detail: out });
    return res.status(200).json({ ok: true, meta: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
