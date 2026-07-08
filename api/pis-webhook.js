// /api/pis-webhook.js — Enable Banking payment-status webhook (the reliable async confirmation).
// Enable signs the webhook with a JWT: header {alg:RS256, x5u:<https url to X.509 pubkey on enablebanking.com>},
// payload { sub:<appId>, environment:'PRODUCTION'|'SANDBOX', msgi:'sha256-<base64 digest of the raw body>' }.
// Handler MUST verify: (1) x5u is https + enablebanking.com host, (2) JWT signature against that cert,
// (3) msgi matches the sha256 of the raw request body, (4) sub === our app id.
//
// IMPORTANT (Vercel): msgi is computed over the RAW body bytes, so disable JSON body-parsing for this route:
//   export const config = { api: { bodyParser: false } };
// and read the raw body yourself (below). Then JSON.parse it after verification.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const APP_ID = process.env.ENABLE_APP_ID;
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export const config = { api: { bodyParser: false } };

// statuses Enable/ASPSP report as FINAL SUCCESS — CONFIRM the exact set for CZ banks in sandbox.
const PAID_STATUSES = new Set(['ACCC', 'ACSC', 'ACSP', 'ACWC', 'SETLD', 'SETTLED']);

const certCache = {}; // x5u -> pem (public certs rotate rarely; cache to avoid a fetch per webhook)

async function readRaw(req) {
  return await new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); req.on('error', reject);
  });
}

async function verify(req, rawBody) {
  const token = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const [h64, p64, s64] = token.split('.');
  if (!h64 || !p64 || !s64) throw new Error('malformed jwt');
  const header  = JSON.parse(Buffer.from(h64, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p64, 'base64url').toString());

  // (1) x5u must be https on an enablebanking.com host
  const u = new URL(header.x5u || '');
  if (u.protocol !== 'https:' || !/(^|\.)enablebanking\.com$/.test(u.hostname)) throw new Error('bad x5u host');

  // (2) fetch public cert + verify RS256 signature over header.payload
  let pem = certCache[header.x5u];
  if (!pem) { pem = await (await fetch(header.x5u)).text(); certCache[header.x5u] = pem; }
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h64 + '.' + p64), pem, Buffer.from(s64, 'base64url'));
  if (!ok) throw new Error('bad signature');

  // (3) msgi = digest of the RAW body
  const digest = 'sha256-' + crypto.createHash('sha256').update(rawBody).digest('base64');
  if (payload.msgi !== digest) throw new Error('body digest mismatch');

  // (4) it's for our application
  if (payload.sub !== APP_ID) throw new Error('wrong app');
  return payload;
}

export default async function handler(req, res) {
  try {
    const raw = await readRaw(req);
    await verify(req, raw);
    const evt = JSON.parse(raw || '{}');

    // TODO confirm the webhook body shape in sandbox. Likely carries the payment id + status somewhere like:
    const paymentId = evt.payment_id || evt.paymentId || (evt.data && (evt.data.payment_id || evt.data.paymentId));
    const status    = evt.status     || (evt.data && evt.data.status);
    if (!paymentId) return res.status(200).json({ ok: true, note: 'no payment_id' });

    const { data: bk } = await sb.from('gym_bookings')
      .select('id,status,student_id,gym_id,class_name')
      .eq('pis_payment_id', paymentId).maybeSingle();
    if (!bk) return res.status(200).json({ ok: true, note: 'no matching booking' });

    if (PAID_STATUSES.has(String(status)) && bk.status !== 'active') {
      // idempotent: mark paid + fire the SAME notification QR_bank fires when the owner confirms
      await sb.from('gym_bookings').update({ status: 'active', pis_status: status }).eq('id', bk.id);
      try {
        await sb.from('notifications').insert({
          user_id: bk.student_id, type: 'booking', read: false,
          data: JSON.stringify({ kind: 'payment_confirmed', gym_id: bk.gym_id, class_name: bk.class_name })
        });
      } catch (e) { /* non-fatal */ }
    } else {
      await sb.from('gym_bookings').update({ pis_status: status }).eq('id', bk.id);
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    // return 4xx so Enable retries on transient issues; but don't leak details
    return res.status(400).json({ error: e.message });
  }
}
