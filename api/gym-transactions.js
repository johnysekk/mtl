// /api/gym-transactions  — read a gym's transactions via the SERVICE ROLE (bypasses RLS).
// The gym dashboard reads transactions through here instead of the RLS-subject browser
// client, so the ledger shows the real Stripe data that the service role wrote.
// Security: caller must send their Supabase access token; we verify it and confirm
// the user owns the gym before returning any rows.

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
    const b = (typeof req.body === 'object' && req.body) || {};
    const gymId = q.gymId || b.gymId;
    const since = q.since || b.since || null;
    const token = req.headers['x-access-token'] || b.token ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

    if (!gymId) return res.status(400).json({ error: 'no gymId' });
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    // 1) verify the user from their access token
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });

    // 2) confirm this user OWNS the gym
    const gres = await fetch(`${SB}/rest/v1/gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id`, { headers: svc });
    const grows = gres.ok ? await gres.json() : [];
    if (!grows.length || grows[0].owner_id !== uid) return res.status(403).json({ error: 'not owner' });

    // 3) read the gym's transactions via the service role (bypasses RLS)
    const sinceQ = since ? `&created_at=gte.${encodeURIComponent(since)}` : '';
    const tres = await fetch(`${SB}/rest/v1/transactions?gym_id=eq.${encodeURIComponent(gymId)}${sinceQ}&order=created_at.desc`, { headers: svc });
    const tx = tres.ok ? await tres.json() : [];

    return res.status(200).json({ ok: true, count: tx.length, transactions: tx });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
