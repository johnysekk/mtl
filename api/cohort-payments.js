// /api/cohort-payments   read ONE cohort member's payment log via the SERVICE ROLE (bypasses RLS).
// cohort_payments is RLS-subject on the browser client (like transactions), so the roster's
// "Co zaplatil" reads through here instead of the browser client, to show the real Stripe/QR
// rows the service role (webhook / owner confirm) wrote.
// Security: caller sends their Supabase access token; we verify it and confirm the user OWNS
// the cohort (via gym_cohorts.owner_id) before returning any rows.

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
    const memberId = q.member || b.member;
    const token = req.headers['x-access-token'] || b.token ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

    if (!memberId) return res.status(400).json({ error: 'no member' });
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    // 1) verify the user from their access token
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });

    // 2) resolve the member -> cohort, and confirm this user OWNS the cohort
    const mres = await fetch(`${SB}/rest/v1/cohort_members?id=eq.${encodeURIComponent(memberId)}&select=cohort_id,status,paid_amount`, { headers: svc });
    const mrows = mres.ok ? await mres.json() : [];
    const member = mrows.length ? mrows[0] : null;
    const cohortId = member ? member.cohort_id : null;
    if (!cohortId) return res.status(404).json({ error: 'member not found' });

    const cres = await fetch(`${SB}/rest/v1/gym_cohorts?id=eq.${encodeURIComponent(cohortId)}&select=owner_id,gym_id,currency`, { headers: svc });
    const crows = cres.ok ? await cres.json() : [];
    if (!crows.length) return res.status(404).json({ error: 'cohort not found' });
    let owns = crows[0].owner_id === uid;
    if (!owns && crows[0].gym_id) {
      // fall back to gym ownership (cohort.owner_id may be unset on older rows)
      const gres = await fetch(`${SB}/rest/v1/gyms?id=eq.${encodeURIComponent(crows[0].gym_id)}&select=owner_id`, { headers: svc });
      const grows = gres.ok ? await gres.json() : [];
      owns = grows.length && grows[0].owner_id === uid;
    }
    if (!owns) return res.status(403).json({ error: 'not owner' });

    // 3) read the member's payments via the service role (bypasses RLS)
    const pres = await fetch(
      `${SB}/rest/v1/cohort_payments?cohort_member_id=eq.${encodeURIComponent(memberId)}` +
      `&select=kind,amount,currency,payment_method,status,created_at&order=created_at.asc`,
      { headers: svc }
    );
    const payments = pres.ok ? await pres.json() : [];

    return res.status(200).json({ ok: true, payments: Array.isArray(payments) ? payments : [], paid_amount: member ? (member.paid_amount || 0) : 0, status: member ? member.status : null, currency: (crows && crows[0] && crows[0].currency) || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
