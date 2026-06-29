// /api/record-cash.js
// Server-side recording of off-Stripe (cash/QR) transactions. The browser sends
// only the payment FACTS; the SERVER recomputes the MTL commission (mtl_fee) from
// the PAYEE's rate so a provider cannot tamper it, then writes the row with the
// service-role key. This lets RLS lock the transactions table to server-only inserts.
//
// Body: { token, provider('gym'|'coach', default 'gym'),
//         gym_id?, coach_id?, member_id?, gross_amount(minor), currency?,
//         type('drop_in'|'membership'|'custom'|'event_ticket'|'coach_1to1'|'course'),
//         payment_method('cash'|'qr'), cash_payer_name?, acq_source? }
// Auth:
//   provider='gym'   -> token must be the gym OWNER's access token (gyms.owner_id).
//   provider='coach' -> token must be the COACH's own access token (profiles.id===coach_id).
// Rate: EP 1%, else MTL League ladder (Bankai 2% @ coach_ref_score>=10,
//       Shikai 3% @ >=3, base 3.5%) read from the PAYEE's profile.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body,
  });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
}

const ALLOWED_TYPES = ['drop_in', 'membership', 'custom', 'event_ticket', 'coach_1to1', 'course'];
function ladderRate(profile) {
  if (!profile) return 0.035;
  if (profile.partner) return 0.01;
  const s = profile.coach_ref_score || 0;
  return s >= 10 ? 0.02 : (s >= 3 ? 0.03 : 0.035);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SB || !KEY) return res.status(500).json({ error: 'env not set' });
  try {
    const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {};
    const { token, gym_id, coach_id, member_id, gross_amount, currency, type, payment_method, cash_payer_name, acq_source } = b;
    const provider = b.provider === 'coach' ? 'coach' : 'gym';

    if (!token || !type || !payment_method) return res.status(400).json({ error: 'missing fields' });
    if (!['cash', 'qr'].includes(payment_method)) return res.status(400).json({ error: 'bad method' });
    if (!ALLOWED_TYPES.includes(type)) return res.status(400).json({ error: 'bad type' });
    const gross = Math.round(Number(gross_amount));
    if (!(gross > 0)) return res.status(400).json({ error: 'bad amount' });
    if (provider === 'gym' && !gym_id) return res.status(400).json({ error: 'missing gym_id' });
    if (provider === 'coach' && !coach_id) return res.status(400).json({ error: 'missing coach_id' });

    // verify caller identity
    const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!ur.ok) return res.status(401).json({ error: 'bad token' });
    const u = await ur.json(); const uid = u && u.id;
    if (!uid) return res.status(401).json({ error: 'no user' });

    let rate, row, cur;
    const month = new Date().toISOString().slice(0, 7);

    if (provider === 'gym') {
      // gym pays out -> gym owner authorizes, rate from owner profile
      const gyms = await sb(`gyms?id=eq.${gym_id}&select=id,owner_id,currency,account_suspended`);
      const gym = gyms && gyms[0];
      if (!gym) return res.status(404).json({ error: 'gym not found' });
      if (gym.owner_id !== uid) return res.status(403).json({ error: 'not your gym' });
      if (gym.account_suspended) return res.status(403).json({ error: 'account suspended' });
      const owners = await sb(`profiles?id=eq.${gym.owner_id}&select=partner,coach_ref_score`);
      rate = ladderRate((owners && owners[0]) || {});
      cur = currency || gym.currency || 'czk';
      const mtl_fee = Math.round(gross * rate);
      row = {
        gym_id, coach_id: coach_id || null, member_id: member_id || null, paid_to: 'gym',
        gross_amount: gross, stripe_fee: 0, mtl_fee, refund_amount: 0, mtl_fee_refunded: 0,
        currency: cur, type, status: 'completed', payment_method,
        commission_status: 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct',
      };
    } else {
      // coach pays out -> the coach authorizes their own cash/QR, rate from coach profile.
      const cs = await sb(`profiles?id=eq.${coach_id}&select=id,partner,coach_ref_score,account_suspended,cash_blocked`);
      const coach = cs && cs[0];
      if (!coach) return res.status(404).json({ error: 'coach not found' });
      if (coach.id !== uid) return res.status(403).json({ error: 'not your account' });
      if (coach.account_suspended) return res.status(403).json({ error: 'account suspended' });
      if (coach.cash_blocked) return res.status(403).json({ error: 'cash blocked' });
      rate = ladderRate(coach);
      cur = currency || 'czk';
      const mtl_fee = Math.round(gross * rate);
      row = {
        gym_id: null, coach_id, member_id: member_id || null, paid_to: 'coach',
        gross_amount: gross, stripe_fee: 0, mtl_fee, refund_amount: 0, mtl_fee_refunded: 0,
        currency: cur, type, status: 'completed', payment_method,
        commission_status: 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct',
      };
    }

    const ins = await sb('transactions', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) });
    return res.status(200).json({ ok: true, mtl_fee: row.mtl_fee, id: (ins && ins[0] && ins[0].id) || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
