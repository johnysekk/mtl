// /api/provider-apply — accountless submit for the "apply to become a provider" funnel.
// Inserts a provider_applications staging row. No auth. Service-role only.
// Legal basis for the core data = pre-contractual steps at the subject's request (GDPR 6(1)(b));
// consent_at/version = Terms (VOP) + privacy-notice acceptance; marketing_consent = separate opt-in.

import crypto from 'crypto';
const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbInsert(table, row) {
  const r = await fetch(_SUPA + '/rest/v1/' + table, {
    method: 'POST',
    headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error('insert ' + table + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  return Array.isArray(j) ? j[0] : j;
}

const FOUNDER = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
async function sbGet(path) {
  try { const r = await fetch(_SUPA + '/rest/v1/' + path, { headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY } }); return r.ok ? await r.json() : []; } catch (e) { return []; }
}
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const kind = (b.kind === 'gym') ? 'gym' : (b.kind === 'coach') ? 'coach' : null;
    if (!kind) return res.status(400).json({ ok: false, error: 'invalid kind' });
    const name = clip((b.name || '').trim(), 120);
    const email = clip((b.email || '').trim().toLowerCase(), 160);
    if (!name) return res.status(400).json({ ok: false, error: 'name required' });
    if (!email || email.indexOf('@') < 0) return res.status(400).json({ ok: false, error: 'valid email required' });
    if (kind === 'gym' && !((b.gym_name || '').trim())) return res.status(400).json({ ok: false, error: 'gym name required' });

    let disciplines = null;
    try { if (Array.isArray(b.disciplines) && b.disciplines.length) disciplines = b.disciplines.slice(0, 12).map((d) => clip(d, 40)); } catch (e) {}

    const marketing = !!b.marketing_consent;
    const row = {
      kind,
      name,
      email,
      city: clip((b.city || '').trim(), 80) || null,
      gym_name: clip((b.gym_name || '').trim(), 120) || null,
      disciplines,
      note: clip((b.note || '').trim(), 1000) || null,
      consent_at: new Date().toISOString(),
      consent_version: clip(b.consent_version || '', 40) || null,
      marketing_consent: marketing,
      // fbp/fbc only stored when the marketing opt-in was given (consent-gated).
      fbp: marketing ? (clip(b.fbp, 200) || null) : null,
      fbc: marketing ? (clip(b.fbc, 200) || null) : null,
      src: clip(b.src || 'direct', 60),
      ref_code: clip(b.ref_code || '', 80) || null,
      status: 'new'
    };

    const ins = await sbInsert('provider_applications', row);

    // Notify the founder of a new provider application.
    try {
      await fetch(_SUPA + '/rest/v1/notifications', {
        method: 'POST',
        headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: FOUNDER, type: 'system', read: false, message: '🥊 Nová provider přihláška (' + kind + '): ' + name + (row.gym_name ? (' — ' + row.gym_name) : '') })
      });
    } catch (e) {}

    // Server-side Meta CAPI "ProviderApply" on MTL's OWN ecosystem pixel — only with marketing consent.
    // Shares eco_event_id with the browser pixel for dedup. No-ops cleanly until the env vars are set.
    try {
      let PX = '', TK = '';
      try { const fp = (await sbGet(`profiles?id=eq.${encodeURIComponent(FOUNDER)}&select=mtl_eco_pixel,mtl_eco_capi_token`))[0]; if (fp) { PX = fp.mtl_eco_pixel || ''; TK = fp.mtl_eco_capi_token || ''; } } catch (e) {}
      if (marketing && PX && TK && b.eco_event_id) {
        const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
        const ud = { em: [sha(email)] };
        if (row.fbp) ud.fbp = row.fbp;
        if (row.fbc) ud.fbc = row.fbc;
        const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '';
        const ua = req.headers['user-agent'] || '';
        if (ip) ud.client_ip_address = ip; if (ua) ud.client_user_agent = ua;
        const evt = { event_name: 'ProviderApply', event_time: Math.floor(Date.now() / 1000), action_source: 'website', event_id: String(b.eco_event_id), user_data: ud, custom_data: { kind } };
        await fetch('https://graph.facebook.com/v21.0/' + encodeURIComponent(PX) + '/events?access_token=' + encodeURIComponent(TK), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [evt] }) });
      }
    } catch (e) { console.error('eco capi', e.message); }

    return res.status(200).json({ ok: true, id: ins && ins.id });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
