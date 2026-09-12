// /api/founder-wipe-tx — FOUNDER-ONLY. Smaže řádky z `transactions` a z tabulek, které na ně
// odkazují (`doklady`, `reschedule_confirmations`). Ostré doklady chrání spouštěč v databázi
// a ten zůstává v platnosti -- projdou jen doklady z testovacího režimu (sql-32).
//
// PROČ SERVER: tabulka transactions je uzamčená tak, že do ní smí jen server (zápisy chodí
// přes record-cash.js a stripe-webhook.js se service-role klíčem). Úklid testovacích dat
// i Nuke mažou z prohlížeče, takže na tenhle zámek narazily -- PostgREST vrátil 400 a
// transakce po přepnutí na ostro zůstaly viset. Ostatních 23 tabulek se smazalo.
//
// Maže VŠECHNY řádky, stejně jako u ostatních tabulek v úklidu. Volá se jen z Nuke a
// z přepnutí na ostro, obojí je za potvrzením a jen pro foundera.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    const token = req.headers['x-access-token'] ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!token) return res.status(401).json({ error: 'no token' });

    // Volající musí být founder. Ověřuje se proti databázi, ne proti tomu, co pošle klient.
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });
    const pr = await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: svc });
    const prows = pr.ok ? await pr.json() : [];
    if (!prows.length || prows[0].role !== 'founder') return res.status(403).json({ error: 'founder only' });

    // Kolik jich tam je (do odpovědi, ať founder vidí, co zmizelo).
    let before = null;
    try {
      const cr = await fetch(`${SB}/rest/v1/transactions?select=id&limit=1`, {
        headers: Object.assign({}, svc, { Prefer: 'count=exact' }),
      });
      const cr2 = (cr.headers.get('content-range') || '').split('/')[1];
      if (cr2 && cr2 !== '*') before = Number(cr2);
    } catch (e) {}

    // POŘADÍ: nejdřív to, co na transakce odkazuje (doklady.transaction_id,
    // reschedule_confirmations.transaction_id), jinak to databáze odmítne kvůli cizímu klíči.
    // Doklady chrání spouštěč před smazáním; výjimku má jen doklad z testovacího režimu
    // (sql-32). Ostrý doklad se tudy smazat NEDÁ a to je správně -- je to účetní dokument.
    const steps = [];
    for (const t of ['doklady', 'reschedule_confirmations', 'transactions']) {
      const r = await fetch(`${SB}/rest/v1/${t}?id=not.is.null`, {
        method: 'DELETE',
        headers: Object.assign({}, svc, { Prefer: 'return=minimal' }),
      });
      if (!r.ok) {
        const body = await r.text();
        return res.status(500).json({ error: 'delete failed', table: t, detail: body.slice(0, 400), done: steps });
      }
      steps.push(t);
    }

    // Číslování dokladů začne znovu od jedničky; jinak by po úklidu pokračovalo starou řadou.
    try {
      await fetch(`${SB}/rest/v1/doklad_series?series_key=not.is.null`, {
        method: 'DELETE', headers: Object.assign({}, svc, { Prefer: 'return=minimal' }),
      });
    } catch (e) {}

    return res.status(200).json({ ok: true, deleted: before, tables: steps });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
