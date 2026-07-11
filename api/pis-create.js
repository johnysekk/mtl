// /api/pis-create.js  — Enable Banking (Model A: pure PIS, money goes student -> gym IBAN directly)
// MTL never holds funds. This just INITIATES a payment to the gym's IBAN and returns the bank URL.
//
// ENV VARS (set in Vercel — NEVER commit these):
//   ENABLE_APP_ID        = b060fa99-b053-4279-8231-b27292e3e814   (your Application ID)
//   ENABLE_PRIVATE_KEY   = contents of the downloaded <appid>.pem (the -----BEGIN PRIVATE KEY----- block)
//   PIS_RETURN_URL       = https://app.martialtraininglab.com/api/pis-return  (whitelisted in the Enable console)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// NOTE: the private key is a MULTILINE value. In Vercel paste it as-is; in code we normalise "\n".

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const APP_ID   = process.env.ENABLE_APP_ID;
const PRIV_KEY = (process.env.ENABLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const EB_BASE  = 'https://api.enablebanking.com';
const RETURN_URL = process.env.PIS_RETURN_URL || 'https://app.martialtraininglab.com/api/pis-return';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const b64url = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

// Enable Banking JWT: header {typ,alg:RS256,kid:appId}; body {iss,aud fixed, iat, exp<=iat+3600}; RS256 signed with the .pem
function ebJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'RS256', kid: APP_ID };
  const body   = { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 };
  const signingInput = b64url(header) + '.' + b64url(body);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), PRIV_KEY).toString('base64url');
  return signingInput + '.' + sig;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const {
      bookingId,            // our booking id — carried in `state`, used to reconcile on webhook/return
      gymName, gymIban,     // beneficiary = the gym (creditor)
      amount, currency = 'CZK',
      vs,                   // numeric variabilní symbol -> reference_number (only if 1-10 digits)
      message,              // free-text message -> remittance_information (always set)
      aspspName,            // the student's chosen bank, e.g. "Ceska sporitelna" (from GET /aspsps?country=CZ)
      aspspCountry = 'CZ',
      psuType = 'personal',
      kind                  // 'memb'->gym_memberships, 'coach1'->bookings, 'event'->event_tickets, 'cohort'->cohort_members, else gym_bookings
    } = req.body || {};

    if (!bookingId || !gymIban || !amount || !aspspName) {
      return res.status(400).json({ error: 'missing fields (bookingId, gymIban, amount, aspspName)' });
    }

    const jwt = ebJwt();
    const payload = {
      // TODO confirm in sandbox: CZK domestic payment type for Czech banks.
      // For CZ domestic CZK it is likely a domestic type (e.g. "DOMESTIC") rather than "SEPA" (which is EUR).
      payment_type: 'SEPA',
      payment_request: {
        credit_transfer_transaction: [{
          beneficiary: {
            creditor_account: { scheme_name: 'IBAN', identification: gymIban },
            creditor: { name: (gymName || 'Gym').slice(0, 70) }
          },
          instructed_amount: { amount: String(amount), currency },
          // Enable requires reference_number OR remittance_information. We always set remittance_information;
          // reference_number only when a valid numeric CZ VS (1-10 digits) is provided.
          ...((vs && /^[0-9]{1,10}$/.test(String(vs))) ? { reference_number: String(vs) } : {}),
          remittance_information: [ String(message || vs || ('MTL ' + bookingId)).slice(0, 140) ]
        }]
      },
      aspsp: { name: aspspName, country: aspspCountry },
      state: String(bookingId),
      redirect_url: RETURN_URL,
      psu_type: psuType
    };

    const r = await fetch(EB_BASE + '/payments', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'enable_error', detail: data });

    // stash the Enable payment_id on the booking so the webhook/return can find it
    try {
      const _pisTbl = (kind === 'memb') ? 'gym_memberships' : (kind === 'coach1') ? 'bookings' : (kind === 'event') ? 'event_tickets' : (kind === 'cohort') ? 'cohort_members' : 'gym_bookings';
      await sb.from(_pisTbl)
        .update({ pis_payment_id: data.payment_id, pis_status: data.status || 'RCVD' })
        .eq('id', bookingId);
    } catch (e) { /* non-fatal */ }

    // { url } is where we redirect the student to authorise in their bank
    return res.status(200).json({ payment_id: data.payment_id, url: data.url, status: data.status });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
