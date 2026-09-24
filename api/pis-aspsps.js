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

// ── FINBRICKS: SEZNAM BANK ───────────────────────────────────────────────────────────────
// Stejny endpoint jako u Neonomics, jen jiny zdroj. Appka se nemeni.
import { createClient } from '@supabase/supabase-js';
import { fbxCall, MERCHANT_ID as FBX_MERCHANT, FBX_BASE } from './_fbx.js';

const _sbCfg = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function fbxBanks(country) {
  // Bez IBANu platce prijme /transaction/platform/init jen banky, ktere resi vyber uctu na sve
  // strane; ostatni vraci 266. MOCK_COBS je sandboxovy simulator -- jedina banka, kde se da
  // v testu platbu dokoncit.
  const PLATFORM_OK = ['MBANK', 'RAIFFEISEN', 'UNICREDIT', 'MOCK_COBS'];
  const path = `/status/bankInfo?merchantId=${encodeURIComponent(FBX_MERCHANT)}&countryCode=${encodeURIComponent(country)}`
    + '&domesticPaymentSupported=true&enabledForMerchant=true';
  const r = await fbxCall('GET', path, null);
  if (!r.ok) {
    const d = r.data || {};
    console.error('[pis-aspsps/fbx]', r.status, JSON.stringify(d));
    return { list: [], total: 0, error: d.message ? ('Finbricks ' + (d.code != null ? d.code : r.status) + ': ' + d.message) : ('Finbricks HTTP ' + r.status) };
  }
  const rows = Array.isArray(r.data) ? r.data : [];
  const ecom = (process.env.FINBRICKS_FLOW || 'ecommerce').toLowerCase() === 'ecommerce';
  const list = rows
    .filter((b) => b && b.paymentProvider)
    .filter((b) => ecom || PLATFORM_OK.includes(String(b.paymentProvider).toUpperCase()))
    .map((b) => ({
      name: b.bankName || b.paymentProvider,
      country: b.countryCode || country,
      bankId: b.paymentProvider,
      bic: b.bic || null,
      logo: b.logoUrl ? (String(b.logoUrl).startsWith('http') ? b.logoUrl : (FBX_BASE.replace('api.', 'cdn.') + b.logoUrl)) : null,
      psu_types: ['personal'],
    }))
    .sort((a, b) => {
      const am = a.bankId === 'MOCK_COBS' ? 0 : 1, bm = b.bankId === 'MOCK_COBS' ? 0 : 1;
      return (am - bm) || a.name.localeCompare(b.name, 'cs');
    });
  return { list, total: rows.length, error: null };
}

export default async function handler(req, res) {
  // Podle prepinace v Adminu: Neonomics, nebo Finbricks.
  try {
    const cfg = await _sbCfg.from('platform_config').select('pis_provider').eq('id', 1).maybeSingle();
    if (String((cfg.data && cfg.data.pis_provider) || 'neonomics') === 'finbricks') {
      const cc = String((req.query && req.query.country) || 'CZ').toUpperCase().slice(0, 2);
      // Kdyz seznam prijde prazdny, appka rekne "platba z uctu tu neni dostupna" -- a bez
      // duvodu se nepozna, jestli Finbricks nic nevratil, nebo spadlo volani. Duvod jde s tim.
      const _out = await fbxBanks(cc);
      return res.status(200).json({ aspsps: _out.list, provider: 'finbricks', total: _out.total, error: _out.error || null });
    }
  } catch (e) { console.error('[pis-aspsps/fbx]', e && e.message); }

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
