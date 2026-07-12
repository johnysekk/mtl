// /api/reconcile-cash.js
// SAFETY NET for QR bookkeeping. When a QR payment is confirmed the booking is set
// status='active' FIRST, then record-cash.js writes the transaction. If that write
// fails even after the client's retry (server/DB/offline), the booking is 'active'
// (student unblocked) but the money is NOT recorded -> MTL would silently lose the fee.
// This cron finds confirmed QR bookings with NO matching transaction (via
// transactions.source_booking_id) and backfills the transaction, recomputing the MTL
// fee EXACTLY like record-cash.js. Idempotent: the partial UNIQUE index on
// source_booking_id makes a double-insert impossible, and we re-check right before insert.
// Run on a schedule (e.g. every 30 min). Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

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

// --- fee logic: mirrors record-cash.js exactly ---
function ladderRate(profile) {
  // reconcile-cash backfills cash/qr/pis = the BANK-TRANSFER track, and MUST agree with
  // record-cash.js exactly: base 3.5%, Shikai 3% at ref_score>=2, NO Bankai. EP = 1%.
  // It used to grant a 2.5% "Bankai" that does not exist on the bank track, so the SAME
  // sale was charged 3% if recorded normally and 2.5% if it happened to be backfilled.
  if (!profile) return 0.035;
  if (profile.partner) return 0.01;
  const s = profile.coach_ref_score || 0;
  return (s >= 2) ? 0.03 : 0.035;
}

const _WELCOME_FOUNDER = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
let _welcomeOff = null;
async function welcomeKillSwitch() {
  if (_welcomeOff !== null) return _welcomeOff;
  try { const ks = await sb(`profiles?id=eq.${_WELCOME_FOUNDER}&select=welcome_zero_off`); _welcomeOff = !!(ks && ks[0] && ks[0].welcome_zero_off); }
  catch (e) { _welcomeOff = false; }
  return _welcomeOff;
}
const WELCOME_CAP_MINOR = 100000 * 100; // welcome also ends at 100,000 CZK turnover in the window
// Reconciliation must NOT open a new welcome window (only record-cash does, on a live sale). So we
// only READ welcome_free_until here; if it isn't set we treat the sale as non-welcome (normal fee).
async function isWelcomeZeroReadOnly(prof, scopeCol, scopeId) {
  if (!prof || !prof.id) return false;
  if (await welcomeKillSwitch()) return false;
  if (!prof.welcome_free_until) return false;
  const now = Date.now();
  if (now >= new Date(prof.welcome_free_until).getTime()) return false;
  if (scopeCol && scopeId) {
    try {
      const winStart = new Date(new Date(prof.welcome_free_until).getTime() - 30 * 86400000).toISOString();
      const rows = await sb(`transactions?select=gross_amount&${scopeCol}=eq.${scopeId}&status=eq.completed&created_at=gte.${encodeURIComponent(winStart)}`);
      const sum = (rows || []).reduce((a, r) => a + (Number(r.gross_amount) || 0), 0);
      if (sum >= WELCOME_CAP_MINOR) return false;
    } catch (e) { /* keep welcome on error */ }
  }
  return true;
}

const ACQ_RATE = 0.10, ACQ_RATE_EP = 0.05;
async function acquisitionRate(acq, type, payee, memberId, scopeCol, scopeId) {
  if (acq !== 'mtl_discovery') return null;
  if (payee && payee.partner) return null;
  if (!memberId) return null;
  let max;
  if (type === 'membership') max = 2;
  else if (type === 'drop_in' || type === 'coach_1to1') max = 1;
  else return null;
  try {
    const prior = await sb(`transactions?select=id&member_id=eq.${memberId}&type=eq.${encodeURIComponent(type)}&${scopeCol}=eq.${scopeId}&status=eq.completed&limit=${max}`);
    if (!prior || prior.length < max) return (payee && payee.partner) ? ACQ_RATE_EP : ACQ_RATE;
  } catch (e) {}
  return null;
}

async function findStudentCredit(memberId) {
  try {
    const prof = await sb(`profiles?id=eq.${memberId}&select=student_credits`);
    const scN = prof && prof[0] ? Number(prof[0].student_credits || 0) : 0;
    if (scN <= 0) return null;
    const nowIso = new Date().toISOString();
    const rows = await sb(`referral_credits?user_id=eq.${memberId}&consumed=eq.false&expires_at=gt.${encodeURIComponent(nowIso)}&select=id&order=earned_at.asc&limit=1`);
    if (!rows || !rows.length) return null;
    return { id: rows[0].id, sc: scN };
  } catch (e) { return null; }
}
async function consumeStudentCredit(memberId, creditRowId, sc) {
  try {
    await sb(`profiles?id=eq.${memberId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ student_credits: Math.max(0, (Number(sc) || 1) - 1) }) });
    await sb(`referral_credits?id=eq.${creditRowId}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ consumed: true }) });
  } catch (e) {}
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'env not set' });
  const out = { scanned: 0, backfilled: 0, already: 0, skipped: 0, errors: [] };
  try {
    const since = new Date(Date.now() - 14 * 86400000).toISOString(); // bound the scan to recent confirmations
    const bookings = await sb(`gym_bookings?select=id,gym_id,coach_id,student_id,student_name,amount,currency,paid_to,acq_source,created_at,credit_used&payment_method=eq.qr&status=eq.active&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=500`);
    for (const b of (bookings || [])) {
      out.scanned++;
      try {
        const existing = await sb(`transactions?select=id&source_booking_id=eq.${encodeURIComponent(b.id)}&limit=1`);
        if (existing && existing.length) { out.already++; continue; }
        const gross = Math.round(Number(b.amount || 0) * 100);
        if (!(gross > 0)) { out.skipped++; continue; }
        let _creditRow = null;
        const month = (b.created_at ? new Date(b.created_at) : new Date()).toISOString().slice(0, 7);
        const type = 'drop_in';
        let row;
        if (b.paid_to === 'coach' && b.coach_id) {
          const cs = await sb(`profiles?id=eq.${b.coach_id}&select=id,partner,coach_ref_score,bankai_eligible,welcome_free_until,created_at,gym_payout_account,stripe_account,referral_optin`);
          const coach = cs && cs[0]; if (!coach) { out.skipped++; continue; }
          const rate = ladderRate(coach);
          const _wz = await isWelcomeZeroReadOnly(coach, 'coach_id', b.coach_id);
          const _cc = (b.credit_used === 'student' && b.student_id && coach.referral_optin !== false) ? await findStudentCredit(b.student_id) : null;
          if (_cc) _creditRow = { memberId: b.student_id, id: _cc.id, sc: _cc.sc };
          const _acq = (_wz || _cc) ? null : await acquisitionRate(b.acq_source, type, coach, b.student_id, 'coach_id', b.coach_id);
          const mtl_fee = (_wz || _cc) ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
          row = { gym_id: b.gym_id || null, coach_id: b.coach_id, member_id: b.student_id || null, paid_to: 'coach', payee_account: (coach.gym_payout_account || coach.stripe_account || null), gross_amount: gross, stripe_fee: 0, mtl_fee, refund_amount: 0, mtl_fee_refunded: 0, currency: (b.currency || 'czk'), type, status: 'completed', payment_method: 'qr', commission_status: _wz ? 'collected' : 'pending', commission_month: month, cash_payer_name: b.student_name || null, acq_source: b.acq_source || 'direct', source_booking_id: b.id };
        } else {
          const gyms = await sb(`gyms?id=eq.${b.gym_id}&select=id,owner_id,currency,stripe_account,account_suspended,welcome_free_until,created_at`);
          const gym = gyms && gyms[0]; if (!gym) { out.skipped++; continue; }
          const owners = await sb(`profiles?id=eq.${gym.owner_id}&select=id,partner,coach_ref_score,bankai_eligible,welcome_free_until,created_at,referral_optin`);
          const ownerProf = (owners && owners[0]) || { id: gym.owner_id };
          const rate = ladderRate(ownerProf);
          const _wz = await isWelcomeZeroReadOnly(gym, 'gym_id', b.gym_id);
          const _cc = (b.credit_used === 'student' && b.student_id && ownerProf.referral_optin !== false) ? await findStudentCredit(b.student_id) : null;
          if (_cc) _creditRow = { memberId: b.student_id, id: _cc.id, sc: _cc.sc };
          const _acq = (_wz || _cc) ? null : await acquisitionRate(b.acq_source, type, ownerProf, b.student_id, 'gym_id', b.gym_id);
          const mtl_fee = (_wz || _cc) ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
          let _gymPayee = gym.stripe_account || null;
          if (b.coach_id) { try { const _cp = await sb(`profiles?id=eq.${b.coach_id}&select=gym_payout_account`); const _cpa = _cp && _cp[0] && _cp[0].gym_payout_account; if (_cpa) _gymPayee = _cpa; } catch (e) {} }
          row = { gym_id: b.gym_id, coach_id: b.coach_id || null, member_id: b.student_id || null, paid_to: 'gym', payee_account: _gymPayee, gross_amount: gross, stripe_fee: 0, mtl_fee, refund_amount: 0, mtl_fee_refunded: 0, currency: (b.currency || gym.currency || 'czk'), type, status: 'completed', payment_method: 'qr', commission_status: _wz ? 'collected' : 'pending', commission_month: month, cash_payer_name: b.student_name || null, acq_source: b.acq_source || 'direct', source_booking_id: b.id };
        }
        // re-check right before insert (reduce race with a concurrent record-cash); the UNIQUE index is the hard guard
        const recheck = await sb(`transactions?select=id&source_booking_id=eq.${encodeURIComponent(b.id)}&limit=1`);
        if (recheck && recheck.length) { out.already++; continue; }
        try {
          await sb('transactions', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(row) });
          if (_creditRow) await consumeStudentCredit(_creditRow.memberId, _creditRow.id, _creditRow.sc);
          out.backfilled++;
        } catch (e) {
          // a 409 from the unique index means a concurrent write won the race -> already recorded, fine
          if (String(e.message || '').includes('409') || /duplicate|unique/i.test(String(e.message || ''))) { out.already++; }
          else throw e;
        }
      } catch (e) { out.errors.push(String((e && e.message) || e).slice(0, 200)); }
    }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
