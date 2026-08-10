// /api/claim-tickets — when someone who bought an event ticket WITHOUT an app account later makes
// one, this links their past event_tickets (buyer_id IS NULL, same e-mail) to the new account, so
// the ticket, its QR and the event show up under it.
//
// Straight mirror of claim-cohorts.js, including why it is built this way: the e-mail comes from the
// caller's own verified auth token, so they can only ever claim what was sold to an address they
// control, and the write uses the service role because event_tickets.buyer_id is not client-writable
// on unowned rows. Idempotent and safe to call on every login.

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
    const email = ((user && user.email) || '').trim().toLowerCase();
    if (!uid || !email) return res.status(400).json({ error: 'no verified email' });

    // Only rows nobody owns yet, matched on the address this person just proved is theirs.
    const rows = await (await fetch(
      `${SB}/rest/v1/event_tickets?buyer_id=is.null&buyer_email=ilike.${encodeURIComponent(email)}&select=id`,
      { headers: svc }
    )).json();
    if (!Array.isArray(rows) || !rows.length) return res.status(200).json({ ok: true, claimed: 0 });

    // claimed_by records WHEN it was linked, which is the difference between a ticket bought in the
    // app and one bought cold and adopted later -- worth being able to tell apart afterwards.
    const r = await fetch(
      `${SB}/rest/v1/event_tickets?buyer_id=is.null&buyer_email=ilike.${encodeURIComponent(email)}`,
      { method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' },
        body: JSON.stringify({ buyer_id: uid, claimed_by: new Date().toISOString() }) }
    );
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return res.status(500).json({ error: 'claim failed', detail: t });
    }
    return res.status(200).json({ ok: true, claimed: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
