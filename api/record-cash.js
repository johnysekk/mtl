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
// Rate: BANK track - EP 1%, else base 3.5% / Shikai 3% at coach_ref_score>=2. No Bankai.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { ladderRate as _mtlRate, acquisitionRate as _mtlAcq } from './_rate.js';
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
  // cash/qr/pis = BANK-TRANSFER track. Single source of truth in _rate.js: same EP/FP/ladder as
  // Stripe (Bankai is Stripe-only, so the bank track floors at Shikai).
  if (!profile) return 0.035;
  return _mtlRate('qr_bank', { partner: profile.partner, founding: profile.founding, score: profile.coach_ref_score, bankai: profile.bankai_eligible });
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
// WELCOME CAP - identical to pay.js, deliberately. It used to scope by gym_id/coach_id
// while pay.js scoped by payee_account: the same thing until a coach with their own Stripe
// sits inside a gym, at which point a gym class they merely TAUGHT (paid to the gym) carried
// their coach_id and burned THEIR welcome window. Both now scope by payee_id - the entity
// that actually owns welcome_free_until. And the cap is now real money: it used to add
// gross_amount across currencies, giving a EUR gym an effective 100,000 EUR cap.
const WELCOME_CAP_CZK_MINOR = 100000 * 100; // gross_amount is stored in minor units
let _fxCache = null;
async function _fxRates() {
  if (_fxCache !== null) return _fxCache;
  try {
    const r = await sb(`fx_rates?id=eq.ecb-latest&select=data&limit=1`);
    const d = r && r[0] && r[0].data;
    _fxCache = (d && d.rates && d.rates.CZK) ? d.rates : false;
  } catch (e) { _fxCache = false; }
  return _fxCache;
}
// ECB feed is EUR-based: 1 EUR = rates[CUR]. EUR itself is not listed.
// No rates -> count only CZK rows: an UNDER-count, which leaves the window open longer.
// Under-counting is the safe error - it never over-charges.
function _toCzkMinor(amountMinor, cur, rates) {
  const c = String(cur || 'CZK').toUpperCase();
  if (c === 'CZK') return Number(amountMinor) || 0;
  if (!rates) return 0;
  const per = (c === 'EUR') ? 1 : rates[c];
  if (!per) return 0;
  return (Number(amountMinor) || 0) / per * rates.CZK;
}
async function welcomeCapReached(rows) {
  const rates = await _fxRates();
  let sum = 0;
  for (const r of (rows || [])) sum += _toCzkMinor(r.gross_amount, r.currency, rates);
  return sum >= WELCOME_CAP_CZK_MINOR;
}
async function isWelcomeZeroProfile(prof, table) {   // scope is now payee_id = prof.id; the old scopeCol/scopeId args are gone
  table = table || 'profiles';
  if (!prof || !prof.id) return false;
  if (await welcomeKillSwitch()) return false;
  const now = Date.now();
  if (prof.welcome_free_until) {
    if (now >= new Date(prof.welcome_free_until).getTime()) return false; // 30-day window elapsed
    // volume trigger: welcome also ends once turnover in the window reaches the cap
    try {
      const winStart = new Date(new Date(prof.welcome_free_until).getTime() - 30 * 86400000).toISOString();
      const rows = await sb(`transactions?select=gross_amount,currency&payee_id=eq.${encodeURIComponent(prof.id)}&status=eq.completed&created_at=gte.${encodeURIComponent(winStart)}`);
      if (await welcomeCapReached(rows)) return false; // over the cap -> charge normally from now on
    } catch (e) { /* on any error keep welcome (never over-charge) */ }
    return true;
  }
  const created = prof.created_at ? new Date(prof.created_at).getTime() : 0;
  if (created && (now - created) < 45 * 86400000) {
    // Welcome is a NEW-PROVIDER incentive: a gym owner gets it for their FIRST gym only. A 2nd+
    // gym is an existing owner expanding, not a new acquisition. "First" = no earlier-created gym
    // of this owner exists (deleted gyms count, so deleting gym #1 can't reset gym #2). Mirrors pay.js.
    if (table === 'gyms' && prof.owner_id) {
      try {
        const earlier = await sb(`gyms?owner_id=eq.${encodeURIComponent(prof.owner_id)}&created_at=lt.${encodeURIComponent(new Date(created).toISOString())}&select=id&limit=1`);
        if (earlier && earlier.length) return false;   // not the owner's first gym -> no welcome
      } catch (e) { /* on error grant (never over-charge on our own bug) */ }
    }
    try { await sb(`${table}?id=eq.${prof.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ welcome_free_until: new Date(now + 30 * 86400000).toISOString() }) }); } catch (e) {}
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
  // Delegates to the single source of truth in _rate.js.
  const r = await _mtlAcq(sb, { acqSource: acq, type, ownerPartner: payee && payee.partner, memberId, scopeCol, scopeId });
  // _rate.js returns { rate, months } for memberships so a multi-month payment can be blended.
  // Cash and QR are billed one period at a time, so the rate alone is what matters here.
  if (r && typeof r === 'object') return (typeof r.rate === 'number') ? r.rate : null;
  return r;
}

// Referral-credit redemption (parity with the Stripe client flow): MTL waives its WHOLE fee when a
// member redeems a referral credit. Server-side anti-tamper — we never trust the client that a credit
// exists; we verify the member's student_credits counter AND a live referral_credits row before zeroing.
async function findStudentCredit(memberId) {
  if (!memberId) return null;
  try {
    const prof = await sb(`profiles?id=eq.${memberId}&select=student_credits`);
    const scN = prof && prof[0] ? Number(prof[0].student_credits || 0) : 0;
    if (!(scN > 0)) return null;
    const nowIso = new Date().toISOString();
    const rows = await sb(`referral_credits?user_id=eq.${memberId}&consumed=eq.false&expires_at=gt.${encodeURIComponent(nowIso)}&select=id&order=earned_at.asc&limit=1`);
    return (rows && rows[0] && rows[0].id) ? { id: rows[0].id, sc: scN } : null;
  } catch (e) { return null; }
}
// Mirror of the client consumption (index.html ~20611): decrement the counter + mark the oldest
// (earned_at asc) live credit row consumed. Runs AFTER the tx insert; a rare post-insert failure
// leaves the tx correct (fee already waived) and the credit re-verifies false next time, so no double-burn.
async function consumeStudentCredit(memberId, creditRowId, sc) {
  try {
    await sb(`profiles?id=eq.${memberId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ student_credits: Math.max(0, (Number(sc) || 1) - 1) }) });
    await sb(`referral_credits?id=eq.${creditRowId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ consumed: true }) });
  } catch (e) { console.error('consumeStudentCredit', e.message); }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SB || !KEY) return res.status(500).json({ error: 'env not set' });
  try {
    const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {};
    const { token, gym_id, coach_id, member_id, gross_amount, currency, type, payment_method, cash_payer_name, acq_source, credit, source_booking_id, cohort_id, income_class } = b;
    // trusted internal call (PIS server-side confirm) — reuses ALL the commission logic, no user token
    const _trusted = !!(b.internal && b.intSecret && process.env.PIS_INTERNAL_SECRET && b.intSecret === process.env.PIS_INTERNAL_SECRET);
    const provider = b.provider === 'coach' ? 'coach' : 'gym';

    if ((!token && !_trusted) || !type || !payment_method) return res.status(400).json({ error: 'missing fields' });
    if (!['cash', 'qr', 'pis'].includes(payment_method)) return res.status(400).json({ error: 'bad method' });
    if (!ALLOWED_TYPES.includes(type)) return res.status(400).json({ error: 'bad type' });
    const gross = Math.round(Number(gross_amount));
    if (!(gross > 0)) return res.status(400).json({ error: 'bad amount' });
    if (provider === 'gym' && !gym_id) return res.status(400).json({ error: 'missing gym_id' });
    if (provider === 'coach' && !coach_id) return res.status(400).json({ error: 'missing coach_id' });

    // verify caller identity (skipped for trusted internal PIS confirm)
    let uid = null;
    if (!_trusted) {
      const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
      if (!ur.ok) return res.status(401).json({ error: 'bad token' });
      const u = await ur.json(); uid = u && u.id;
      if (!uid) return res.status(401).json({ error: 'no user' });
    }

    let rate, row, cur;
    let _creditRow = null;   // {memberId,id,sc} to consume after a successful insert (referral-credit redemption)
    const _wantCredit = (credit === 'student' && member_id && ['coach_1to1', 'drop_in'].includes(type));
    const month = new Date().toISOString().slice(0, 7);

    if (provider === 'gym') {
      // gym pays out -> gym owner authorizes, rate from owner profile
      const gyms = await sb(`gyms?id=eq.${gym_id}&select=id,owner_id,currency,account_suspended,stripe_account,welcome_free_until,created_at`);
      const gym = gyms && gyms[0];
      if (!gym) return res.status(404).json({ error: 'gym not found' });
      if (!_trusted && gym.owner_id !== uid) return res.status(403).json({ error: 'not your gym' });
      if (!_trusted && gym.account_suspended) return res.status(403).json({ error: 'account suspended' });
      const owners = await sb(`profiles?id=eq.${gym.owner_id}&select=id,partner,founding,coach_ref_score,bankai_eligible,welcome_free_until,created_at,referral_optin`);
      const ownerProf = (owners && owners[0]) || {};
      if (!ownerProf.id) ownerProf.id = gym.owner_id;
      rate = ladderRate(ownerProf);
      cur = currency || gym.currency || 'czk';
      const _wz = await isWelcomeZeroProfile(gym, 'gyms');
      const _cc = (_wantCredit && ownerProf.referral_optin !== false) ? await findStudentCredit(member_id) : null;
      if (_cc) _creditRow = { memberId: member_id, id: _cc.id, sc: _cc.sc };
      const _acq = _wz ? null : await acquisitionRate(acq_source, type, ownerProf, member_id, 'gym_id', gym_id);
      const mtl_fee = (_cc || _wz) ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
      const _effRate = (_cc || _wz) ? 0 : (_acq != null ? _acq : rate); // per-tx rate -> doklad can itemise by tier
      let _gymPayee = gym.stripe_account || null;
      if (coach_id) { try { const _cp = await sb(`profiles?id=eq.${coach_id}&select=gym_payout_account`); const _cpa = _cp && _cp[0] && _cp[0].gym_payout_account; if (_cpa) _gymPayee = _cpa; } catch(e){} }
      row = {
        gym_id, coach_id: coach_id || null, member_id: member_id || null, paid_to: 'gym', payee_account: _gymPayee,
        payee_id: gym.id, payee_kind: 'gym',   // the entity that owns welcome_free_until
        gross_amount: gross, stripe_fee: 0, mtl_fee, mtl_rate: _effRate, refund_amount: 0, mtl_fee_refunded: 0,
        currency: cur, type, status: 'completed', payment_method, cohort_id: cohort_id || null, income_class: income_class || null,
        commission_status: (_cc || _wz) ? 'collected' : 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct', source_booking_id: source_booking_id || null,
      };
    } else {
      // coach pays out -> the coach authorizes their own cash/QR, rate from coach profile.
      const cs = await sb(`profiles?id=eq.${coach_id}&select=id,partner,founding,coach_ref_score,bankai_eligible,account_suspended,cash_blocked,welcome_free_until,created_at,referral_optin,gym_payout_account,stripe_account`);
      const coach = cs && cs[0];
      if (!coach) return res.status(404).json({ error: 'coach not found' });
      if (!_trusted && coach.id !== uid) return res.status(403).json({ error: 'not your account' });
      if (!_trusted && coach.account_suspended) return res.status(403).json({ error: 'account suspended' });
      if (!_trusted && coach.cash_blocked) return res.status(403).json({ error: 'cash blocked' });
      rate = ladderRate(coach);
      cur = currency || 'czk';
      const _wz = await isWelcomeZeroProfile(coach, 'profiles');
      const _cc = (_wantCredit && coach.referral_optin !== false) ? await findStudentCredit(member_id) : null;
      if (_cc) _creditRow = { memberId: member_id, id: _cc.id, sc: _cc.sc };
      const _acq = _wz ? null : await acquisitionRate(acq_source, type, coach, member_id, 'coach_id', coach_id);
      const mtl_fee = (_cc || _wz) ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
      const _effRate = (_cc || _wz) ? 0 : (_acq != null ? _acq : rate); // per-tx rate -> doklad can itemise by tier
      row = {
        gym_id: null, coach_id, member_id: member_id || null, paid_to: 'coach', payee_account: (coach.gym_payout_account || coach.stripe_account || null),
        payee_id: coach.id, payee_kind: 'profile',   // the entity that owns welcome_free_until
        gross_amount: gross, stripe_fee: 0, mtl_fee, mtl_rate: _effRate, refund_amount: 0, mtl_fee_refunded: 0,
        currency: cur, type, status: 'completed', payment_method, cohort_id: cohort_id || null, income_class: income_class || null,
        commission_status: (_cc || _wz) ? 'collected' : 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct', source_booking_id: source_booking_id || null,
      };
    }

    const ins = await sb('transactions', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) });
    if (_creditRow) await consumeStudentCredit(_creditRow.memberId, _creditRow.id, _creditRow.sc);
    return res.status(200).json({ ok: true, mtl_fee: row.mtl_fee, welcome: row.commission_status === 'collected' && row.mtl_fee === 0, credit_redeemed: !!_creditRow, id: (ins && ins[0] && ins[0].id) || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
