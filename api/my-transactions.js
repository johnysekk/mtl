// /api/my-transactions — read the signed-in user's transactions via the SERVICE ROLE (bypasses RLS).
// The browser client is RLS-subject and cannot read `transactions` directly, so HERO net,
// the coach 1:1 dashboard, the gym-team dashboard and the money dashboard all read through here.
// Returns: { coachTx, gymTx }
//   coachTx = transactions where coach_id = the caller (their 1:1 lessons + any gym classes they taught;
//             coach_id is stamped on both paid_to='coach' and paid_to='gym' rows)
//   gymTx   = transactions for every gym the caller OWNS
// Security: caller must send their Supabase access token; we verify it server-side.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const q = req.query || {};
    const since = q.since || null;
    const token = req.headers['x-access-token'] ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    // 1) verify the user from their access token
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });

    const sinceQ = since ? `&created_at=gte.${encodeURIComponent(since)}` : '';

    // 2) the caller's coach transactions (1:1 + gym classes they taught)
    const cres = await fetch(`${SB}/rest/v1/transactions?coach_id=eq.${encodeURIComponent(uid)}${sinceQ}&order=created_at.desc`, { headers: svc });
    const coachTx = cres.ok ? await cres.json() : [];

    // 3) the gyms the caller OWNS, then those gyms' transactions
    const gres = await fetch(`${SB}/rest/v1/gyms?owner_id=eq.${encodeURIComponent(uid)}&select=id`, { headers: svc });
    const gyms = gres.ok ? await gres.json() : [];
    const gymIds = (gyms || []).map(g => g.id).filter(Boolean);
    let gymTx = [];
    if (gymIds.length) {
      const tres = await fetch(`${SB}/rest/v1/transactions?gym_id=in.(${gymIds.join(',')})${sinceQ}&order=created_at.desc`, { headers: svc });
      gymTx = tres.ok ? await tres.json() : [];
    }

    return res.status(200).json({ ok: true, coachTx, gymTx });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
