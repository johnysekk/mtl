// /api/mtl-revenue — FOUNDER-ONLY: real MTL commission revenue from the transactions ledger
// via the SERVICE ROLE (bypasses RLS). This is the platform's true profit — the sum of real
// mtl_fee minus mtl_fee_refunded — the same way a gym owner reads their real net, not an estimate.
//
// Returns:
//   months: [{ ym:'2026-06', byCur:{ CZK:{mtl,refunded,count}, EUR:{...} } }, ...]  (amounts in haléře/cents)
//   rows:   raw transaction rows for CSV export
//
// Security: caller MUST be the MTL founder (uid === FOUNDER_UUID), verified server-side from the token.
// NOTE: this scans the transactions table page-by-page. Fine for launch volume; at large scale move to a
//       pre-aggregated monthly rollup table refreshed by a cron, per the platform scale rules.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDER_UUID = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = req.headers['x-access-token'] ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    // verify caller + enforce founder-only
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });
    if (uid !== FOUNDER_UUID) return res.status(403).json({ error: 'forbidden' });

    const sel = 'created_at,currency,type,payment_method,gym_id,coach_id,plan,payment_intent,gross_amount,stripe_fee,mtl_fee,mtl_fee_refunded,net_amount,refund_amount,status';
    let rows = [], from = 0; const page = 1000;
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`${SB}/rest/v1/transactions?select=${sel}&order=created_at.desc`,
        { headers: { ...svc, 'Range-Unit': 'items', Range: `${from}-${from + page - 1}` } });
      if (!r.ok) break;
      const batch = await r.json();
      if (!Array.isArray(batch) || !batch.length) break;
      rows = rows.concat(batch);
      if (batch.length < page) break;
      from += page;
    }

    // Cohorts (Kurzy) live in cohort_payments, not transactions. Pull them in as synthetic rows
    // (type='cohort') so the founder ledger shows a Kurzy line instead of hiding them in "Other".
    // cohort_payments amounts are MAJOR units -> x100 to match the transactions minor-unit convention.
    try {
      let cp = [], cfrom = 0;
      for (let i = 0; i < 50; i++) {
        const cr = await fetch(`${SB}/rest/v1/cohort_payments?select=created_at,currency,payment_method,amount,mtl_fee,stripe_fee,status&order=created_at.desc`,
          { headers: { ...svc, 'Range-Unit': 'items', Range: `${cfrom}-${cfrom + page - 1}` } });
        if (!cr.ok) break;
        const cb = await cr.json();
        if (!Array.isArray(cb) || !cb.length) break;
        cp = cp.concat(cb);
        if (cb.length < page) break;
        cfrom += page;
      }
      cp.filter(p => p.status !== 'refunded').forEach(p => {
        const g = Math.round(Number(p.amount || 0) * 100);
        const mf = Math.round(Number(p.mtl_fee || 0) * 100);
        const sf = Math.round(Number(p.stripe_fee || 0) * 100);
        rows.push({ created_at: p.created_at, currency: p.currency || 'CZK', type: 'cohort', payment_method: p.payment_method || 'stripe', gym_id: null, coach_id: null, plan: 'Kurz', payment_intent: null, gross_amount: g, stripe_fee: sf, mtl_fee: mf, mtl_fee_refunded: 0, net_amount: g - mf - sf, refund_amount: 0, status: p.status || 'paid' });
      });
    } catch (e) { /* cohorts optional */ }

    // Cohorts are counted via cohort_payments (added below); drop the record-cash 'course'
    // transactions so a PIS cohort deposit isn't counted twice.
    rows = rows.filter(t => t.type !== 'course');
    const months = {};
    rows.forEach(t => {
      const ym = (t.created_at || '').slice(0, 7);
      if (!ym) return;
      const cur = t.currency || 'CZK';
      const m = months[ym] = months[ym] || {};
      const c = m[cur] = m[cur] || { mtl: 0, refunded: 0, count: 0, byMethod: {} };
      const net = Number(t.mtl_fee || 0) - Number(t.mtl_fee_refunded || 0);
      c.mtl += Number(t.mtl_fee || 0);
      c.refunded += Number(t.mtl_fee_refunded || 0);
      c.count += 1;
      // by payment method (stripe / qr / pis / cash), same buckets the coach & gym dashboards use
      const pm = t.payment_method || 'other';
      const bm = c.byMethod[pm] = c.byMethod[pm] || { net: 0, gross: 0, count: 0 };
      bm.net += net;
      bm.gross += Number(t.gross_amount || 0);
      bm.count += 1;
    });
    const monthArr = Object.keys(months).sort().reverse().map(ym => ({ ym, byCur: months[ym] }));

    return res.status(200).json({ ok: true, months: monthArr, rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
