// /api/_fbx.js — FINBRICKS: PODPIS POZADAVKU A VOLANI API.
//
// Kazdy pozadavek se podepisuje detached JWS (RFC 7515, Appendix F) v hlavicce JWS-Signature:
//   header:  { typ:'JWT', alg:'RS256', kid:<merchantId> }
//   payload: {"uri":"<cesta + query>","body":"<PRESNE telo, jak se odesle>"}   (jeden radek)
//   vysledek: base64url(header) + '..' + base64url(podpis)   -- payload se do JWS nedava
//
// DVE VECI, NA KTERYCH SE TO NEJCASTEJI ROZBIJE:
//   1) `body` v podepisovanem payloadu musi byt BYTE PO BYTU to, co se odesle. Proto se telo
//      serializuje JEDNOU do retezce a ten se podepisuje i posila; nikdy se neserializuje
//      dvakrat (JSON.stringify muze poradi klicu zachovat, ale mezery a escapovani ne).
//   2) `uri` je cesta VCETNE query retezce, bez domeny.
//
// ENV (Vercel, NIKDY do gitu):
//   FINBRICKS_ENV          sandbox | production   (default sandbox)
//   FINBRICKS_MERCHANT_ID  UUID z administrace
//   FINBRICKS_PRIVATE_KEY  privatni klic v PEM (PKCS#8, 4096 bit) -- radky oddelene \n

import crypto from 'crypto';

const ENV = (process.env.FINBRICKS_ENV || 'sandbox').toLowerCase();
export const FBX_BASE = (ENV === 'production')
  ? 'https://api.finbricks.com'
  : 'https://api.sandbox.finbricks.com';
export const FBX_SANDBOX = (ENV !== 'production');
export const MERCHANT_ID = process.env.FINBRICKS_MERCHANT_ID || '';

// SANDBOX MA STROP 1 CZK. Kdyz se posle vic, banka platbu odmitne a clovek nepozna proc.
export const FBX_MAX_SANDBOX = 1;

function privateKey() {
  const raw = process.env.FINBRICKS_PRIVATE_KEY || '';
  if (!raw) throw new Error('FINBRICKS_PRIVATE_KEY not configured');
  // Ve Vercelu se vicerakove promenne casto ulozi s literalnim \n -- prelozit zpatky.
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

const b64u = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Detached JWS nad {"uri":..,"body":..}
export function fbxSign(uri, bodyString) {
  if (!MERCHANT_ID) throw new Error('FINBRICKS_MERCHANT_ID not configured');
  const header = { typ: 'JWT', alg: 'RS256', kid: MERCHANT_ID };
  const payload = JSON.stringify({ uri, body: bodyString || '' });
  const h = b64u(JSON.stringify(header));
  const p = b64u(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), privateKey());
  return h + '..' + b64u(sig);   // payload vynechan = detached
}

// Jedno misto, kde se vola Finbricks. Vraci { ok, status, data }.
//
// PSU-IP-Address a PSU-User-Agent jsou od 14. 11. 2025 povinne: banky je chteji kvuli
// auditni stope. Musi to byt VEREJNA IP koncoveho uzivatele, ne nase serverova a ne
// lokalni rozsah -- proto se prebira z pozadavku prohlizece a posila dal.
export async function fbxCall(method, path, body, opts = {}) {
  const bodyString = (body == null) ? '' : JSON.stringify(body);
  const sig = fbxSign(path, bodyString);
  const headers = {
    'JWS-Signature': sig,
    'Correlation-ID': opts.correlationId || crypto.randomUUID(),
  };
  if (bodyString) headers['Content-Type'] = 'application/json';
  if (opts.psuIp) headers['PSU-IP-Address'] = opts.psuIp;
  if (opts.psuUa) headers['PSU-User-Agent'] = opts.psuUa;
  if (opts.lang) headers['Accept-Language'] = opts.lang;

  const r = await fetch(FBX_BASE + path, {
    method,
    headers,
    ...(bodyString ? { body: bodyString } : {}),
  });
  let data = null;
  try { data = await r.json(); } catch (e) { data = null; }
  return { ok: r.ok, status: r.status, data };
}

// VEREJNA IP UZIVATELE. Vercel ji dava do x-forwarded-for (prvni polozka je klient).
// Kdyz vyjde soukroma nebo zadna, vrati se placeholder -- soukrome rozsahy Finbricks odmita.
export function psuIpFrom(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xf || String(req.headers['x-real-ip'] || '').trim();
  const bad = !ip
    || /^10\./.test(ip)
    || /^127\./.test(ip)
    || /^169\.254\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || ip === '0.0.0.0'
    || ip.includes(':');                      // IPv6 dokumentace nepripousti
  return bad ? '88.205.47.1' : ip;
}

// Stavy z /transaction/platform/status. `finalBankStatus` rika, jestli uz je to konecne;
// resultCode, jestli to dopadlo dobre. Dokud neni finalni, NIC se nezauctovava.
export function fbxOutcome(st) {
  const code = String((st && st.resultCode) || '').toUpperCase();
  const final = !!(st && st.finalBankStatus);
  // Doložené stavy z dokumentace: OPENED (zalozeno, ceka na cloveka, finalBankStatus=false),
  // BOOKED (zauctovano), ACCEPTED. O tom, jestli je to konecne, rozhoduje finalBankStatus --
  // nazvy stavu se u bank lisi a spolehat se jen na ne by byla chyba.
  // COMPLETED vraci Finbricks u dokoncene platby (videno v jejich prehledu) -- bez nej se
  // uspesna platba vyhodnotila jako "ani zaplaceno, ani zamitnuto" a NIC se nestalo:
  // rezervace zustala nezaplacena, nepriletela notifikace, nezauctovalo se.
  const good = ['COMPLETED', 'BOOKED', 'SETTLED', 'ACCEPTED', 'ACSC', 'ACCC', 'ACSP', 'ACWC'].includes(code);
  const bad = ['REJECTED', 'RJCT', 'CANCELLED', 'CANC', 'EXPIRED', 'FAILED', 'TIMEOUT'].includes(code);
  return { code, final, paid: final && good, failed: final && bad };
}
