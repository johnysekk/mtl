// /api/fbx-notify — NOTIFIKACE OD FINBRICKS (webhook). Adresu nastavuje Finbricks na své straně
// (posílá se jim e-mailem); všechny kategorie chodí sem:
//   paymentPairingResultChange  data.uniquePaymentPairingId -> stav párování (pairing.js)
//   resultCodeChange            data.merchantTransactionId  -> stav platby z účtu a zaúčtování,
//                               stejně jako návrat z banky (pis-return.js fbxReturn). Zachrání
//                               platbu, když student po zaplacení zavře prohlížeč dřív, než se vrátí.
//   instantPaymentOutage / výpadky                          -> jen potvrdit
//
// Tělu NEVĚŘÍME: bere se z něj jen identifikátor a stav si server zjistí sám podepsaným dotazem.
// Proto se nemusí ověřovat JWS notifikace. Finbricks čeká 202 Accepted a svoje x-request-id zpátky.
import { pairingNotify } from './pairing.js';
import { fbxReturn } from './pis-return.js';

// Hodnoty klíče kdekoli v těle (tvar se u kategorií liší).
function valuesOf(x, key, out) {
  if (!x || typeof x !== 'object') return out;
  if (Array.isArray(x)) { x.forEach((y) => valuesOf(y, key, out)); return out; }
  Object.keys(x).forEach((k) => { if (k === key && (typeof x[k] === 'string' || typeof x[k] === 'number')) out.add(String(x[k])); else valuesOf(x[k], key, out); });
  return out;
}

// fbxReturn odpovídá přes res; tady se odpověď jen zahodí.
const sink = () => { const r = { setHeader() {}, status() { return r; }, json() { return r; }, end() { return r; } }; return r; };

export default async function handler(req, res) {
  const xr = req.headers['x-request-id']; if (xr) res.setHeader('x-request-id', String(xr));
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  try {
    const pair = [...valuesOf(b, 'uniquePaymentPairingId', new Set())].filter((v) => /^\d+$/.test(v));
    if (pair.length) await pairingNotify(pair);
    const mtids = [...valuesOf(b, 'merchantTransactionId', new Set())].filter((v) => /^[A-Za-z0-9:_\-.]{6,100}$/.test(v)).slice(0, 20);
    for (const mtid of mtids) {
      try { await fbxReturn({ query: { json: '1' }, headers: { accept: 'application/json' } }, sink(), mtid); }
      catch (e) { console.error('[fbx-notify] payment', mtid, e && e.message); }
    }
    const cat = b && b['meta-data'] && b['meta-data'].category;
    console.log('[fbx-notify]', cat || '?', 'pairing:', pair.length, 'payments:', mtids.length);
  } catch (e) { console.error('[fbx-notify]', e && e.message); }
  return res.status(202).json({ ok: true });
}
