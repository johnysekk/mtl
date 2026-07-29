// /api/claim-cohorts — when someone who paid for a course as an ACCOUNTLESS student later makes an
// app account, this links their past cohort_members (student_id IS NULL, same e-mail) to the new
// account so their courses, payments and stats appear under it. The e-mail comes from the caller's
// verified auth token (they own it), and the write uses the service role (cohort_members.student_id
// is not client-writable for unlinked rows). Idempotent + safe to call on every login.
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const token = req.headers['x-access-token'] ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    const email = (user && user.email || '').trim().toLowerCase();
    if (!uid || !email) return res.status(400).json({ error: 'no verified email' });

    // find accountless cohort_members with this e-mail (case-insensitive) and no owner yet
    const rows = await (await fetch(
      `${SB}/rest/v1/cohort_members?student_id=is.null&email=ilike.${encodeURIComponent(email)}&select=id`,
      { headers: svc }
    )).json();
    if (!Array.isArray(rows) || !rows.length) return res.status(200).json({ ok: true, claimed: 0 });

    const r = await fetch(
      `${SB}/rest/v1/cohort_members?student_id=is.null&email=ilike.${encodeURIComponent(email)}`,
      { method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify({ student_id: uid }) }
    );
    if (!r.ok) { const t = await r.text().catch(() => ''); return res.status(500).json({ error: 'claim failed', detail: t }); }
    return res.status(200).json({ ok: true, claimed: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
