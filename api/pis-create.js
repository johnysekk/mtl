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
// Neonomics lists three usable DNB sandbox SSNs: 31125461118, 31125453913, 31125461037.
// If one test customer's sandbox account is in a bad state, the next one is a free thing to try,
// so it is an env var rather than a literal.
export const DNB_SANDBOX_SSN = process.env.NEONOMICS_DNB_SSN || '31125453913';
// Neonomics 1048: "Only A-Å, a-å, 0-9, and space allowed" in name fields. Czech diacritics are NOT
// in that range -- e, s, c, r, z with hacek all sit outside it -- and a Czech class or plan name
// goes straight into the remittance line. A Norwegian bank being handed "Petr Haiser - Deti" with a
// hacek is a plausible way to earn an unexplained internal error, so fold to the allowed set before
// sending. Nothing is lost that matters: the remittance is how the club recognises the payment, and
// it recognises it the same without the accents.
const NORDIC_OK = /[^A-Za-z\u00C0-\u00FF0-9 \-\/\.,:()]/g;
function nordicSafe(v, max) {
  let t = String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  t = t.replace(NORDIC_OK, ' ').replace(/\s+/g, ' ').trim();
  return max ? t.slice(0, max) : t;
}
   // one of the three SSNs Neonomics lists for DNB sandbox

// DNB (and any bank with personalIdentificationRequired) wants the national ID in x-psu-id
// ENCRYPTED, not raw. Neonomics decrypts it with the same key before handing it to the bank.
// Format, taken from their PHP sample: AES-GCM over the SSN with the key file's rawValue as the
// key, then base64 of IV || ciphertext || authTag. Key length decides 128 vs 256.
// NEONOMICS_PSU_KEY = the rawValue field out of the <client_id>.json downloaded from the portal.
// No key set -> send the raw value exactly as before, so this can be deployed ahead of the key
// without changing today's behaviour.
function encPsuId(ssn) {
  const raw = process.env.NEONOMICS_PSU_KEY || '';
  if (!raw) return null;
  try {
    const key = Buffer.from(raw, 'base64');
    const alg = key.length === 32 ? 'aes-256-gcm' : 'aes-128-gcm';
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv(alg, key, iv, { authTagLength: 16 });
    const ct = Buffer.concat([c.update(String(ssn), 'utf8'), c.final()]);
    return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
  } catch (e) { return null; }
}


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

// ── FINBRICKS ────────────────────────────────────────────────────────────────────────────
// Zalozeni platby u druheho poskytovatele. Nema vlastni endpoint: appka vola porad
// /api/pis-create a rozhoduje se tady podle platform_config.pis_provider. Drive to byl
// samostatny soubor a skoncilo to tim, ze se v nem opakovaly chyby, ktere tady uz davno
// vyresene byly -- specificke je jen prihlaseni, adresy a tvar tela.
import crypto from 'crypto';
import { fbxCall, psuIpFrom, FBX_SANDBOX, FBX_MAX_SANDBOX, MERCHANT_ID as FBX_MERCHANT } from './_fbx.js';

const PIS_TABLES = ['gym_bookings', 'gym_memberships', 'bookings', 'event_tickets', 'cohort_members', 'merch_orders'];

async function pisProvider(sb) {
  try {
    const r = await sb.from('platform_config').select('pis_provider').eq('id', 1).maybeSingle();
    return String((r.data && r.data.pis_provider) || 'neonomics');
  } catch (e) { return 'neonomics'; }
}

// Variabilni symbol se posila vzdycky: podle nej klub pozna platbu ve vlastnim vypisu.
function fbxVs(uuid) {
  const hex = String(uuid || '').replace(/[^0-9a-f]/gi, '').slice(0, 12);
  if (!hex) return undefined;
  return String(parseInt(hex, 16) % 1000000000).padStart(9, '0');
}
const fbxSym = (v) => { const x = String(v == null ? '' : v).replace(/\D/g, '').slice(0, 10); return x || undefined; };
const fbxDesc = (v) => String(v || '')
  .replace(/[^a-zA-Z0-9\u00C0-\u024F()_\-@".,/':+\s]/g, ' ').trim().slice(0, 140) || 'Platba MTL';

// Vraci stejny tvar jako Neonomics vetev: { payment_id, url } nebo { error }.
async function fbxCreate(sb, req, body) {
  if (!FBX_MERCHANT) return { error: 'FINBRICKS_MERCHANT_ID not configured' };
  const rowId = String(body.bookingId || '');
  if (!rowId) return { error: 'no id' };

  // Tabulku neuhadneme z "kind" -- appka ho nepouziva jednotne. Radek se najde podle id.
  let tbl = null, row = null;
  for (const t of PIS_TABLES) {
    const r = await sb.from(t).select('*').eq('id', rowId).maybeSingle();
    if (r.data) { tbl = t; row = r.data; break; }
  }
  if (!row) return { error: 'row not found' };

  // IBAN prijemce VZDY z databaze, nikdy z pozadavku prohlizece.
  let iban = null, payeeName = null;
  if (row.gym_id) {
    const g = (await sb.from('gyms').select('receiver_id_value,legal_name,name').eq('id', row.gym_id).maybeSingle()).data;
    iban = g && g.receiver_id_value; payeeName = g && (g.legal_name || g.name);
  } else if (row.coach_id) {
    const c = (await sb.from('profiles').select('receiver_id_value,payout_receiver_id_value,legal_name,name').eq('id', row.coach_id).maybeSingle()).data;
    iban = c && (c.payout_receiver_id_value || c.receiver_id_value); payeeName = c && (c.legal_name || c.name);
  }
  if (!iban) return { error: 'payee has no IBAN' };

  const real = Number(row.amount || body.amount || 0);
  if (!(real > 0)) return { error: 'bad amount' };
  // Sandbox ma strop 1 Kc; na radku zustava skutecna castka, aby se do uctovani nepropsala koruna.
  const amount = FBX_SANDBOX ? Math.min(real, FBX_MAX_SANDBOX) : real;

  const mtid = crypto.randomUUID();
  const payerId = row.student_id || row.buyer_id || row.member_id || null;
  const payload = {
    merchantId: FBX_MERCHANT,
    merchantTransactionId: mtid,
    amount,
    creditorAccountIban: String(iban).replace(/\s+/g, ''),
    creditorName: payeeName ? String(payeeName).slice(0, 100) : undefined,
    variableSymbol: fbxSym(body.vs) || fbxVs(mtid),
    description: fbxDesc(body.message || row.class_name || row.item_name),
    initiatorName: 'Martial Training Lab',
    clientId: payerId ? String(payerId).slice(0, 100) : undefined,
    instructionPriority: 'INST',
    callbackUrl: (process.env.APP_URL || 'https://app.martialtraininglab.com') + '/api/pis-return?mtid=' + mtid,
    shoppingCartUrl: (process.env.APP_URL || 'https://app.martialtraininglab.com') + '/?fbxcancel=1',
    paymentProvider: body.bankId ? String(body.bankId) : undefined,
  };
  Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

  const opts = { psuIp: psuIpFrom(req), psuUa: req.headers['user-agent'] || 'MTL/1.0', lang: (body.lang === 'en' ? 'en' : 'cs') };
  const FLOW = (process.env.FINBRICKS_FLOW || 'ecommerce').toLowerCase();
  let r = (FLOW === 'platform') ? { ok: false, data: { code: 308 } }
                                : await fbxCall('POST', '/ecommerce/transaction/init', payload, opts);
  if (!r.ok && r.data && [308, 300, 302].includes(r.data.code)) {
    const p2 = { ...payload, totalPrice: payload.amount };
    delete p2.amount; delete p2.shoppingCartUrl;
    r = await fbxCall('POST', '/transaction/platform/init', p2, opts);
  }
  if (!r.ok || !r.data || !r.data.redirectUrl) {
    const d = r.data || {};
    console.error('[pis-create/fbx]', r.status, JSON.stringify(d));
    return { error: d.message ? ('Finbricks ' + (d.code != null ? d.code : r.status) + ': ' + d.message) : ('Finbricks HTTP ' + r.status), code: d.code ?? null };
  }

  await sb.from(tbl).update({ pis_payment_id: mtid, pis_provider: 'finbricks', pis_started_at: new Date().toISOString() }).eq('id', rowId);
  return { payment_id: mtid, url: r.data.redirectUrl };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    // Ktery poskytovatel prave plati. Prepina se v Adminu, ne nasazenim.
    if ((await pisProvider(sb)) === 'finbricks') {
      const out = await fbxCreate(sb, req, req.body || {});
      return res.status(200).json(out);
    }
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

    // POZASTAVENÝ POSKYTOVATEL NEPŘIJÍMÁ ANI PŘEVODEM. Bez téhle kontroly stačilo obejít deck
    // přímým odkazem a zaplatit klubu, který má pozastavený účet. Vlastníka dohledáme z řádku,
    // ke kterému se platba váže -- ten už kind rozlišuje níž při zápisu payment_id.
    try {
      const _tbl = (kind === 'memb') ? 'gym_memberships' : (kind === 'coach1') ? 'bookings'
        : (kind === 'event') ? 'event_tickets' : (kind === 'cohort') ? 'cohort_members'
        : (kind === 'merch') ? 'merch_orders' : 'gym_bookings';
      const _bid = String(bookingId).startsWith('orgfee:') ? String(bookingId).slice(7) : String(bookingId);
      const { data: _row } = await sb.from(_tbl).select('gym_id,coach_id').eq('id', _bid).maybeSingle();
      if (_row) {
        if (_row.gym_id) {
          const { data: _g } = await sb.from('gyms').select('account_suspended').eq('id', _row.gym_id).maybeSingle();
          if (_g && _g.account_suspended) return res.status(403).json({ error: 'provider suspended' });
        }
        if (_row.coach_id) {
          const { data: _c } = await sb.from('profiles').select('account_suspended').eq('id', _row.coach_id).maybeSingle();
          if (_c && _c.account_suspended) return res.status(403).json({ error: 'provider suspended' });
        }
      }
    } catch (e) { /* nedostupná databáze platbu neblokuje */ }

    const token = await neoToken();
    const deviceId = crypto.randomUUID();
    const sessionId = await neoSession(token, bankId, deviceId);

    const iban = String(gymIban).replace(/\s+/g, '');
    const e2e = (String(vs || bookingId).replace(/[^A-Za-z0-9]/g, '').slice(0, 35)) || ('MTL' + Date.now());
    const remit = nordicSafe(message || vs || ('MTL ' + bookingId), 140) || ('MTL ' + String(bookingId).slice(0, 8));
    // ODKUD ČLOVĚK PLATIL. Návrat dosud vedl vždy na pevnou APP_URL, takže kdo začal jinde
    // (dashboard, jiná doména projektu), skončil na app -- a když tam měl přihlášený jiný účet,
    // vrátil se jako někdo jiný. Původ si proto neseme s sebou.
    let _origin = '';
    try {
      _origin = String(req.headers.origin || '');
      if (!_origin && req.headers.referer) _origin = new URL(req.headers.referer).origin;
    } catch (e) { _origin = ''; }
    const redirect = RETURN_URL + (RETURN_URL.indexOf('?') >= 0 ? '&' : '?') + 'state=' + encodeURIComponent(bookingId)
      + (_origin ? ('&o=' + encodeURIComponent(_origin)) : '');

    const payBody = {
      creditorAccount: { accountScheme: 'IBAN', identifier: iban },
      creditorName: nordicSafe(gymName || 'Klub', 70) || 'Klub',
      instrumentedAmount: String(amount),
      currency,
      remittanceInformationUnstructured: remit,
      endToEndIdentification: e2e,
      paymentMetadata: {}
    };

    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const commonHeaders = {
      Authorization: 'Bearer ' + token,
      'x-device-id': deviceId,
      'x-session-id': sessionId,
      'x-redirect-url': redirect,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (xff) commonHeaders['x-psu-ip-address'] = xff;

    // SANDBOX ONLY: Neonomics test banks require a debtor account; DNB also needs x-psu-id. Force DNB test data
    // so the flow completes end-to-end (Neonomics is a fallback provider — this path is purely mechanical).
    // PRODUCTION Model A: the debtor is the student's own account, selected at their bank during SCA.
    if (ENVN === 'sandbox') {
      payBody.creditorAccount = { bban: '12073650567' };            // DNB sandbox account acting as the gym (creditor = payee)
      payBody.debtorAccount   = { bban: '12032202452' };            // DNB sandbox account acting as the payer (debtor = payer)
      payBody.debtorName      = 'MTL Test Payer';                   // debtor name (account holder) is required
      // Encrypted when NEONOMICS_PSU_KEY is set, raw otherwise. Raw is what we sent until now and it
      // got past Neonomics' own validation only to fail inside DNB with 4930 Internal bank error.
      commonHeaders['x-psu-id'] = encPsuId(DNB_SANDBOX_SSN) || DNB_SANDBOX_SSN;
    }

    const initR = await fetch(ICS_BASE + '/payments/domestic-transfer', {
      method: 'POST', headers: commonHeaders, body: JSON.stringify(payBody)
    });
    const init = await initR.json().catch(() => ({}));

    // link/id extractors that work regardless of the exact status/errorCode Neonomics returns
    const idFrom = (o) => (o && (o.paymentId || (o.meta && o.meta.id) || (Array.isArray(o.links) && o.links[0] && o.links[0].meta && o.links[0].meta.id))) || null;
    const firstHref = (o) => (o && Array.isArray(o.links) && o.links.length) ? (o.links[0].href || null) : null;

    let paymentId = idFrom(init);
    let bankUrl = null;
    let status = init.status || 'RCVD';

    if (initR.status === 200 || initR.status === 201) {
      // created (SCA-exempt) OR an authorization link is already present -> prefer the bank URL, else bounce home
      bankUrl = pickBankUrl(init.links) || redirect;
    } else if (firstHref(init)) {
      // auth/consent required (1428/1426/any variant): follow the link the response carries
      const href = firstHref(init);
      if (/^https?:\/\//i.test(href) && !/neonomics\.io\/ics\//i.test(href)) {
        bankUrl = href;                         // already an external bank/consent URL
      } else {
        const authR = await fetch(href, {
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'x-device-id': deviceId, 'x-session-id': sessionId, 'x-redirect-url': redirect }
        });
        const auth = await authR.json().catch(() => ({}));
        paymentId = paymentId || idFrom(auth);
        bankUrl = pickBankUrl(auth.links) || firstHref(auth);
        if (!bankUrl) return res.status(200).json({ error: 'neo_authorize_no_url http=' + authR.status + ' ' + JSON.stringify(auth).slice(0, 240), detail: auth });
      }
    } else {
      // genuine failure -> surface the REAL Neonomics status + code + message in the toast
      // x-request-id is Neonomics' correlation id. For a 4000-5999 bank error it is the ONLY thing
      // their support can act on, and until now we threw it away and kept a message that says
      // nothing. Surface it so a failure is reportable instead of just annoying.
      const _rid = initR.headers && (initR.headers.get('x-request-id') || initR.headers.get('X-Request-Id'));
      const msg = 'neo_init[SPU] http=' + initR.status
        + (init.errorCode ? (' code=' + init.errorCode) : '')
        + (_rid ? (' req=' + _rid) : '')
        + ' ' + (init.message ? String(init.message).slice(0, 150) : JSON.stringify(init).slice(0, 200));
      return res.status(200).json({ error: msg, detail: init });
    }

    // stash the payment id on the target row (reconcile lookup, same as before)
    try {
      // ČLENSKÝ POPLATEK má vlastní tabulku i vlastní sloupec. Bez téhle větve se číslo platby
      // neuložilo nikam a návrat z banky ji pak nenašel -- platba proto vždy skončila jako
      // "čeká na potvrzení bankou", přestože banka potvrdila hned.
      if (String(bookingId).startsWith('orgfee:')) {
        if (paymentId) await sb.from('organization_clubs')
          .update({ fee_payment_intent: paymentId }).eq('id', String(bookingId).slice(7));
      } else {
        const tbl = (kind === 'memb') ? 'gym_memberships' : (kind === 'coach1') ? 'bookings' : (kind === 'event') ? 'event_tickets' : (kind === 'cohort') ? 'cohort_members' : (kind === 'merch') ? 'merch_orders' : 'gym_bookings';
        if (paymentId) await sb.from(tbl).update({ pis_payment_id: paymentId, pis_status: status }).eq('id', bookingId);
      }
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
