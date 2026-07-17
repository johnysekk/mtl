// /api/pis-create.js — NEONOMICS (UAPI, Model A: pure PIS, money goes student -> gym IBAN directly).
// MTL never holds funds. Initiates a DOMESTIC transfer to the gym's IBAN and returns the bank auth URL.
//
// ENV (Vercel, NEVER commit): NEONOMICS_CLIENT_ID, NEONOMICS_SECRET_ID, NEONOMICS_ENV,
//   PIS_RETURN_URL (default https://app.martialtraininglab.com/api/pis-return),
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Flow (verified from docs.neonomics.io 2026-07-16):
//   1) OAuth2 client_credentials -> access_token
//   2) POST /ics/v3/session {bankId} (+x-device-id) -> sessionId
//   3) POST /ics/v3/payments/domestic-transfer (+x-session-id +x-device-id +x-redirect-url) -> 201 | 510/1426 | 510/1428
//   4) on 510/1428: GET the authorize href -> links[]."Authorization URL" = the bank URL to send the student to
//   Persist pis_payment_id on the target row (reconcile lookup) + session_id/device_id in pis_session (return needs them).
//
// SANDBOX-VERIFY (flagged for the first e2e run, mirrors how the Enable version carried TODOs):
//   - debtorAccount is OMITTED (student picks their account at the bank in the decoupled redirect). If a bank
//     rejects that, add debtorAccount/debtorName.
//   - Primary path handled is 510/1428 (the documented "authorization required" flow). 1426 (consent) is followed
//     best-effort; if a sandbox bank returns 1426, the post-consent re-initiation may need one iteration.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const ENVN = (process.env.NEONOMICS_ENV || 'sandbox').toLowerCase();
const AUTH_BASE = 'https://' + ENVN + '.neonomics.io/auth/realms/' + ENVN + '/protocol/openid-connect/token';
const ICS_BASE  = 'https://' + ENVN + '.neonomics.io/ics/v3';
const RETURN_URL = process.env.PIS_RETURN_URL || 'https://app.martialtraininglab.com/api/pis-return';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function neoToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.NEONOMICS_CLIENT_ID || '',
    client_secret: process.env.NEONOMICS_SECRET_ID || ''
  });
  const r = await fetch(AUTH_BASE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('neo_token_failed:' + (d.error || r.status));
  return d.access_token;
}

async function neoSession(token, bankId, deviceId) {
  const r = await fetch(ICS_BASE + '/session', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'x-device-id': deviceId, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bankId })
  });
  const d = await r.json();
  if (!r.ok || !d.sessionId) throw new Error('neo_session_failed:' + (d.errorCode || d.error || r.status));
  return d.sessionId;
}

// pull the first bank/authorization URL out of a Neonomics links[] array
function pickBankUrl(links) {
  if (!Array.isArray(links)) return null;
  // prefer an explicit "Authorization URL", else the first http(s) href that is NOT a neonomics API url
  const auth = links.find(l => /authorization/i.test(l.rel || ''));
  if (auth && auth.href) return auth.href;
  const ext = links.find(l => /^https?:\/\//i.test(l.href || '') && !/neonomics\.io\/ics\//i.test(l.href));
  return ext ? ext.href : (links[0] && links[0].href) || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const {
      bookingId,
      gymName, gymIban,
      amount, currency = 'CZK',
      vs,
      message,
      bankId,                 // NEW: base64 bank id from /api/pis-aspsps (index.html now sends it)
      psuType = 'personal',   // kept for compatibility (unused by Neonomics)
      kind
    } = req.body || {};

    if (!bookingId || !gymIban || !amount || !bankId) {
      return res.status(400).json({ error: 'missing fields (bookingId, gymIban, amount, bankId)' });
    }

    const token = await neoToken();
    const deviceId = crypto.randomUUID();
    const sessionId = await neoSession(token, bankId, deviceId);

    const iban = String(gymIban).replace(/\s+/g, '');
    const e2e = (String(vs || bookingId).replace(/[^A-Za-z0-9]/g, '').slice(0, 35)) || ('MTL' + Date.now());
    const remit = String(message || vs || ('MTL ' + bookingId)).slice(0, 140);
    const redirect = RETURN_URL + (RETURN_URL.indexOf('?') >= 0 ? '&' : '?') + 'state=' + encodeURIComponent(bookingId);

    const payBody = {
      creditorAccount: { accountScheme: 'IBAN', identifier: iban },
      creditorName: (gymName || 'Klub').slice(0, 70),
      instrumentedAmount: String(amount),
      currency,
      remittanceInformationUnstructured: remit,
      endToEndIdentification: e2e,
      paymentMetadata: {}
    };

    const commonHeaders = {
      Authorization: 'Bearer ' + token,
      'x-device-id': deviceId,
      'x-session-id': sessionId,
      'x-redirect-url': redirect,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    const initR = await fetch(ICS_BASE + '/payments/domestic-transfer', {
      method: 'POST', headers: commonHeaders, body: JSON.stringify(payBody)
    });
    const init = await initR.json().catch(() => ({}));

    let paymentId = init.paymentId || (init.meta && init.meta.id) || null;
    let bankUrl = null;
    let status = init.status || 'RCVD';

    if (initR.status === 201) {
      // SCA-exempt: payment already created. Send the student back into the app; pis-return polls the final status.
      bankUrl = redirect;
    } else if (initR.status === 510 && String(init.errorCode) === '1428') {
      // authorization required: the error links[] carry the authorize endpoint; GET it to obtain the bank URL.
      paymentId = paymentId || (init.links && init.links[0] && init.links[0].meta && init.links[0].meta.id) || null;
      const authHref = (init.links && init.links[0] && init.links[0].href) || null;
      if (!authHref) return res.status(502).json({ error: 'no_authorize_href', detail: init });
      const authR = await fetch(authHref, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'x-device-id': deviceId, 'x-session-id': sessionId, 'x-redirect-url': redirect }
      });
      const auth = await authR.json().catch(() => ({}));
      paymentId = paymentId || auth.paymentId || null;
      bankUrl = pickBankUrl(auth.links);
      if (!bankUrl) return res.status(502).json({ error: 'no_bank_url', detail: auth });
    } else if (initR.status === 510 && String(init.errorCode) === '1426') {
      // consent required: follow the consent href to the bank auth page (post-consent re-initiation may need iteration).
      const consentHref = (init.links && init.links[0] && init.links[0].href) || null;
      if (consentHref) {
        const cR = await fetch(consentHref, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'x-device-id': deviceId, 'x-session-id': sessionId, 'x-redirect-url': redirect } });
        const c = await cR.json().catch(() => ({}));
        bankUrl = pickBankUrl(c.links);
      }
      if (!bankUrl) return res.status(502).json({ error: 'consent_required', detail: init });
    } else {
      return res.status(initR.status || 502).json({ error: 'neo_init_error', detail: init });
    }

    // stash the payment id on the target row (reconcile lookup, same as before)
    try {
      const tbl = (kind === 'memb') ? 'gym_memberships' : (kind === 'coach1') ? 'bookings' : (kind === 'event') ? 'event_tickets' : (kind === 'cohort') ? 'cohort_members' : (kind === 'merch') ? 'merch_orders' : 'gym_bookings';
      if (paymentId) await sb.from(tbl).update({ pis_payment_id: paymentId, pis_status: status }).eq('id', bookingId);
    } catch (e) { /* non-fatal */ }

    // stash session_id + device_id so pis-return can call Get Payment by ID with the same context
    try {
      if (paymentId) await sb.from('pis_session').upsert({ payment_id: paymentId, session_id: sessionId, device_id: deviceId, booking_id: String(bookingId), kind: kind || 'dropin' }, { onConflict: 'payment_id' });
    } catch (e) { /* non-fatal */ }

    return res.status(200).json({ payment_id: paymentId, url: bankUrl, status });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
