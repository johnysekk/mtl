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

const _WELCOME_FOUNDER = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
let _welcomeOff = null;
async function welcomeKillSwitch() {
  if (_welcomeOff !== null) return _welcomeOff;
  try { const ks = await sb(`profiles?id=eq.${_WELCOME_FOUNDER}&select=welcome_zero_off`); _welcomeOff = !!(ks && ks[0] && ks[0].welcome_zero_off); }
  catch (e) { _welcomeOff = false; }
  return _welcomeOff;
}
// Mirrors isWelcomeZero() in pay.js, but on the payee profile we already loaded.
// In window -> this cash/QR sale is 0% MTL fee (clean books, no doklad), exactly like Stripe.
// First sale on a genuinely new account (<45 days) opens the 30-day window now (same anchor as Stripe).
async function isWelcomeZeroProfile(prof) {
  if (!prof || !prof.id) return false;
  if (await welcomeKillSwitch()) return false;
  const now = Date.now();
  if (prof.welcome_free_until) return now < new Date(prof.welcome_free_until).getTime();
  const created = prof.created_at ? new Date(prof.created_at).getTime() : 0;
  if (created && (now - created) < 45 * 86400000) {
    try { await sb(`profiles?id=eq.${prof.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ welcome_free_until: new Date(now + 30 * 86400000).toISOString() }) }); } catch (e) {}
    return true;
  }
  return false;
}

const ACQ_RATE = 0.10;     // standard providers
const ACQ_RATE_EP = 0.05;  // EP perk: HALF the acquisition fee (EP buys a cheap ongoing rate; acquisition is halved, not waived)
// MTL acquisition finder's fee: when the app demonstrably brought the member (acq_source='mtl_discovery'),
// MTL takes the acquisition rate for the window — membership = first 2 months; 1:1 = the first paid lesson.
// Mirrors pay.js _isAcq (membership) + the client first-lesson 10% (coach/drop-in). Never for EP or welcome.
// "Window" is bounded by counting prior COMPLETED tx of this type for this member at this provider
// (counts Stripe + cash together, so a member already past the window isn't re-charged 10% on cash).
async function acquisitionRate(acq, type, payee, memberId, scopeCol, scopeId) {
  if (acq !== 'mtl_discovery') return null;
  if (payee && payee.partner) return null;            // EP is always 1%, never the acquisition fee
  if (!memberId) return null;                          // can't bound the window without a member id
  let max;
  if (type === 'membership') max = 2;                  // first 2 months
  else if (type === 'drop_in' || type === 'coach_1to1') max = 1; // the first paid one
  else return null;                                    // custom / event / course: no acquisition fee
  try {
    const prior = await sb(`transactions?select=id&member_id=eq.${memberId}&type=eq.${encodeURIComponent(type)}&${scopeCol}=eq.${scopeId}&status=eq.completed&limit=${max}`);
    if (!prior || prior.length < max) return (payee && payee.partner) ? ACQ_RATE_EP : ACQ_RATE; // inside window: EP pays half
  } catch (e) {}
  return null;
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
      const owners = await sb(`profiles?id=eq.${gym.owner_id}&select=id,partner,coach_ref_score,welcome_free_until,created_at`);
      const ownerProf = (owners && owners[0]) || {};
      if (!ownerProf.id) ownerProf.id = gym.owner_id;
      rate = ladderRate(ownerProf);
      cur = currency || gym.currency || 'czk';
      const _wz = await isWelcomeZeroProfile(ownerProf);
      const _acq = _wz ? null : await acquisitionRate(acq_source, type, ownerProf, member_id, 'gym_id', gym_id);
      const mtl_fee = _wz ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
      row = {
        gym_id, coach_id: coach_id || null, member_id: member_id || null, paid_to: 'gym',
        gross_amount: gross, stripe_fee: 0, mtl_fee, refund_amount: 0, mtl_fee_refunded: 0,
        currency: cur, type, status: 'completed', payment_method,
        commission_status: _wz ? 'collected' : 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct',
      };
    } else {
      // coach pays out -> the coach authorizes their own cash/QR, rate from coach profile.
      const cs = await sb(`profiles?id=eq.${coach_id}&select=id,partner,coach_ref_score,account_suspended,cash_blocked,welcome_free_until,created_at`);
      const coach = cs && cs[0];
      if (!coach) return res.status(404).json({ error: 'coach not found' });
      if (coach.id !== uid) return res.status(403).json({ error: 'not your account' });
      if (coach.account_suspended) return res.status(403).json({ error: 'account suspended' });
      if (coach.cash_blocked) return res.status(403).json({ error: 'cash blocked' });
      rate = ladderRate(coach);
      cur = currency || 'czk';
      const _wz = await isWelcomeZeroProfile(coach);
      const _acq = _wz ? null : await acquisitionRate(acq_source, type, coach, member_id, 'coach_id', coach_id);
      const mtl_fee = _wz ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
      row = {
        gym_id: null, coach_id, member_id: member_id || null, paid_to: 'coach',
        gross_amount: gross, stripe_fee: 0, mtl_fee, refund_amount: 0, mtl_fee_refunded: 0,
        currency: cur, type, status: 'completed', payment_method,
        commission_status: _wz ? 'collected' : 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct',
      };
    }

    const ins = await sb('transactions', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) });
    return res.status(200).json({ ok: true, mtl_fee: row.mtl_fee, welcome: row.commission_status === 'collected' && row.mtl_fee === 0, id: (ins && ins[0] && ins[0].id) || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
