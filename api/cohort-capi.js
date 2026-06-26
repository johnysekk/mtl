// /api/cohort-capi — multi-tenant Meta Conversions API (CAPI) relay for cohort signups.
// The browser Pixel and this server event share the same `event_id`, so Meta de-duplicates
// them = no double counting. Each cohort carries its OWN pixel id (gym_meta_pixel) and a
// secret CAPI token (capi_token) — the token NEVER leaves the server.
//
// POST body: { cohort_id, event, event_id, email, phone, fbp, fbc, value, currency, event_source_url }
//   event = 'Lead' | 'Purchase' (defaults to 'Lead')
//
// Consent: the client only calls this after the lead ticked the consent box (and, for Purchase,
// after a real payment). The provider is the controller for their own pixel; MTL is the conduit.

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const cohortId = b.cohort_id;
    if (!cohortId) return res.status(400).json({ ok: false, error: 'missing cohort_id' });
    const event_name = (b.event === 'Purchase') ? 'Purchase' : 'Lead';

    // Look up this cohort's own pixel + secret token (server-side only).
    const rows = await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohortId)}&select=gym_meta_pixel,capi_token,currency`);
    const c = rows && rows[0];
    if (!c || !c.gym_meta_pixel || !c.capi_token) {
      // No CAPI configured for this cohort — nothing to relay, not an error.
      return res.status(200).json({ ok: true, relayed: false });
    }

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
             || (req.socket && req.socket.remoteAddress) || '';
    const ua = req.headers['user-agent'] || '';

    const user_data = {};
    if (b.email) user_data.em = [sha256(b.email)];
    if (b.phone) user_data.ph = [sha256Phone(b.phone)];
    if (b.fbp) user_data.fbp = b.fbp;
    if (b.fbc) user_data.fbc = b.fbc;
    if (ip) user_data.client_ip_address = ip;
    if (ua) user_data.client_user_agent = ua;

    const custom_data = {};
    if (event_name === 'Purchase') {
      custom_data.value = Number(b.value || 0);
      custom_data.currency = (b.currency || c.currency || 'CZK');
    }

    const evt = {
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: b.event_id || (event_name.toLowerCase() + '_' + cohortId + '_' + Date.now()),
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
