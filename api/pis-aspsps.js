// /api/pis-aspsps.js  — NEONOMICS (UAPI, Model A: pure PIS, money student -> gym IBAN directly).
// Lists banks that can do a DOMESTIC (non-SEPA) transfer for a country, in the shape index.html expects.
//
// ENV (Vercel, NEVER commit): NEONOMICS_CLIENT_ID, NEONOMICS_SECRET_ID, NEONOMICS_ENV('sandbox'|'production')
// Verified from docs.neonomics.io 2026-07-16:
//   token: POST https://{env}.neonomics.io/auth/realms/{env}/protocol/openid-connect/token (OAuth2 client_credentials)
//   banks: GET  https://{env}.neonomics.io/ics/v3/banks?countryCode=XX  (Bearer + x-device-id + Accept)
// Response kept identical to the old Enable shape so index.html only needs to start sending bankId:
//   { aspsps:[{ name, country, bankId, bic, logo, psu_types:['personal'] }] }

const ENVN = (process.env.NEONOMICS_ENV || 'sandbox').toLowerCase();
const AUTH_BASE = 'https://' + ENVN + '.neonomics.io/auth/realms/' + ENVN + '/protocol/openid-connect/token';
const ICS_BASE  = 'https://' + ENVN + '.neonomics.io/ics/v3';
const LIST_DEVICE_ID = 'mtl-server';

async function neoToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.NEONOMICS_CLIENT_ID || '',
    client_secret: process.env.NEONOMICS_SECRET_ID || ''
  });
  const r = await fetch(AUTH_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('neo_token_failed:' + (d.error || r.status));
  return d.access_token;
}

export default async function handler(req, res) {
  try {
    const country = String((req.query && req.query.country) || 'CZ').toUpperCase();
    const token = await neoToken();
    const r = await fetch(ICS_BASE + '/banks?countryCode=' + encodeURIComponent(country), {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'x-device-id': LIST_DEVICE_ID }
    });
    const list = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'neo_banks_error', detail: list, aspsps: [] });

    const banks = (Array.isArray(list) ? list : (list.banks || []))
      .filter(b => String(b.status || '').toUpperCase() === 'AVAILABLE'
                && Array.isArray(b.supportedServices)
                && b.supportedServices.indexOf('domestic-transfer') >= 0)
      .map(b => ({
        name: b.bankDisplayName || b.bankOfficialName || b.bic || 'Bank',
        country: b.countryCode || country,
        bankId: b.id,
        bic: b.bic || '',
        logo: b.bankLogoUrl || '',
        psu_types: ['personal']
      }));

    return res.status(200).json({ aspsps: banks });
  } catch (e) {
    return res.status(500).json({ error: e.message, aspsps: [] });
  }
}
