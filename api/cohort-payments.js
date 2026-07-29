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
    const cohortQ = q.cohort || b.cohort;
    const token = req.headers['x-access-token'] || b.token ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

    if (!memberId && !cohortQ) return res.status(400).json({ error: 'no member or cohort' });
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    // 1) verify the user from their access token
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });

    // 2) resolve the cohort (from ?cohort= directly, or via the member), then confirm ownership
    let member = null, cohortId = cohortQ || null;
    if (!cohortId) {
      const mres = await fetch(`${SB}/rest/v1/cohort_members?id=eq.${encodeURIComponent(memberId)}&select=cohort_id,status,paid_amount`, { headers: svc });
      const mrows = mres.ok ? await mres.json() : [];
      member = mrows.length ? mrows[0] : null;
      cohortId = member ? member.cohort_id : null;
      if (!cohortId) return res.status(404).json({ error: 'member not found' });
    }

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

    // 3) read payments via the service role (bypasses RLS): whole cohort in cohort mode, else one member
    const _filter = cohortQ ? `cohort_id=eq.${encodeURIComponent(cohortId)}` : `cohort_member_id=eq.${encodeURIComponent(memberId)}`;
    // Select the CORE columns first (always present). stripe_fee + payment_method are migration-added
    // and may be absent; asking for them makes the whole select 400 -> empty Trzby. So try them, and
    // if that 400s, retry with just the core columns. cohort_payments is keyed by cohort_id, so this
    // is the source of truth for BOTH app and accountless members (name/email live on the member row).
    const _coreSel = 'cohort_member_id,kind,amount,currency,mtl_fee,status,created_at';
    let pres = await fetch(`${SB}/rest/v1/cohort_payments?${_filter}&select=${_coreSel},payment_method,stripe_fee&order=created_at.asc`, { headers: svc });
    if (!pres.ok) pres = await fetch(`${SB}/rest/v1/cohort_payments?${_filter}&select=${_coreSel}&order=created_at.asc`, { headers: svc });
    let payments = pres.ok ? await pres.json() : [];

    // Fallback for cohort mode: if cohort_payments has no rows yet, derive the cohort's revenue from the
    // REAL transactions rows (recordTransaction stored the true gross/mtl/stripe fee). Link via the
    // members' student_ids. Amounts in transactions are in minor units (x100), so normalise to match.
    if (cohortQ && (!payments || !payments.length)) {
      try {
        const memres = await fetch(`${SB}/rest/v1/cohort_members?cohort_id=eq.${encodeURIComponent(cohortId)}&select=id,student_id,paid_amount,status`, { headers: svc });
        const mem = memres.ok ? await memres.json() : [];
        const sids = [...new Set(mem.map(m => m.student_id).filter(Boolean))];
        let txRows = [];
        if (sids.length) {
          const inList = sids.map(encodeURIComponent).join(',');
          const txres = await fetch(`${SB}/rest/v1/transactions?type=eq.course&member_id=in.(${inList})&select=member_id,gross_amount,mtl_fee,stripe_fee,net_amount,currency,income_class,created_at&order=created_at.asc`, { headers: svc });
          txRows = txres.ok ? await txres.json() : [];
        }
        payments = txRows.map(t => ({
          cohort_member_id: null,
          kind: (t.income_class === 'cohort_first_month' ? 'first_month' : (t.income_class === 'cohort_month' ? 'month' : 'deposit')),
          amount: (Number(t.gross_amount || 0) / 100),
          currency: t.currency,
          payment_method: 'stripe',
          mtl_fee: (Number(t.mtl_fee || 0) / 100),
          stripe_fee: (Number(t.stripe_fee || 0) / 100),
          status: 'paid',
          created_at: t.created_at,
        }));
      } catch (e) { /* leave payments empty */ }
    }

    return res.status(200).json({ ok: true, payments: Array.isArray(payments) ? payments : [], paid_amount: member ? (member.paid_amount || 0) : 0, status: member ? member.status : null, currency: (crows && crows[0] && crows[0].currency) || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
