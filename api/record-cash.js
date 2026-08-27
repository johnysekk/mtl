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
  if (!profile) return 0.025;  // base na bankovní koleji (bylo 0.035, pak 0.03)
  return _mtlRate('qr_bank', { partner: profile.partner, founding: profile.founding, score: profile.coach_ref_score, bankai: profile.bankai_eligible });
}


// ── MINIMÁLNÍ PROVIZE U PIS ────────────────────────────────────────────────────────────────
// PIS je jediná kolej, kde MTL platí za KAŽDOU platbu pevnou částku providerovi. Procento to
// u drobných nepokryje: 1,25 % ze sedmdesátikorunové jednorázovky je 88 haléřů, a platba stojí
// korunu. Podlaha, ne přirážka -- u členství za 1 400 Kč se neprojeví vůbec.
//
// Neplatí pro Stripe (tam si Stripe svoje bere sám od klubu a MTL žádnou pevnou položku nenese)
// ani pro QR a hotovost (ty nestojí nic).
//
// Nikdy se nestrhne víc, než kolik je celá platba -- kdyby někdo prodal lekci za korunu,
// nemá smysl mu účtovat dvě.
const PIS_MIN_FEE_CZK_MINOR = 200;   // 2 Kč
async function _pisMinFee(cur, grossMinor) {
  const c = String(cur || 'CZK').toUpperCase();
  if (c === 'CZK') return Math.min(PIS_MIN_FEE_CZK_MINOR, grossMinor);
  // Jiná měna: přepočet přes ECB kurzy. Když kurzy
  // nejsou, minimum se NEUPLATNÍ -- radši nevybrat, než vybrat špatně.
  try {
    const rates = await _fxRates();
    if (!rates || !rates.CZK) return 0;
    const per = (c === 'EUR') ? 1 : rates[c];
    if (!per) return 0;
    return Math.min(Math.round(PIS_MIN_FEE_CZK_MINOR / rates.CZK * per), grossMinor);
  } catch (e) { return 0; }
}

// VRACENO: _fxRates() a _toCzkMinor(). Rez welcome funkci je odnesl, ale _pisMinFee() nize je
// pouziva na prepocet minimalni provize u PIS do cizi meny -- bez nich by minimum za behu spadlo.
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

// ODSTRANENO: welcomeKillSwitch(), welcomeCapReached() a isWelcomeZeroProfile(). Uvitaci okno
// bylo zruseno -- pri zakladu 2 % na Stripe a 2,5 % na bance uz neni co zlevnovat. _fxRates() a
// _toCzkMinor() ZUSTAVAJI: vznikly sice kvuli stotisicovemu stropu, ale dnes je pouziva
// minimalni provize u PIS, viz _pisMinFee nize.

// REMOVED: two local constants (0.10 / 0.05, later 0.20 / 0.10) used to sit here. They were dead
// -- acquisitionRate() below delegates to _rate.js and never read them -- and a dead copy of a rate
// is worse than no copy, because the next person to change the fee edits the one they find first.
// The live values are ACQ_RATE / ACQ_RATE_EP in _rate.js lines 34-35.
// MTL acquisition finder's fee: when the app demonstrably brought the member (acq_source='mtl_discovery'),
// MTL takes the acquisition rate ONCE — the first membership, the first drop-in, the first 1:1.
// (Was: membership spread it over the first 2 months.)
// Mirrors pay.js _isAcq (membership) + the client first-lesson charge (coach/drop-in). Never for EP.
// "Window" is bounded by counting prior COMPLETED tx of this type for this member at this provider
// (counts Stripe + cash together, so a member already past the window isn't re-charged 10% on cash).
async function acquisitionRate(acq, type, payee, memberId, scopeCol, scopeId, ladder, periods) {
  // Delegates to the single source of truth in _rate.js.
  const r = await _mtlAcq(sb, { acqSource: acq, type, ownerPartner: payee && payee.partner, memberId, scopeCol, scopeId });
  if (r == null) return null;
  if (typeof r === 'number') return r;
  // FIXED. This used to take r.rate and throw r.months away, on the assumption that cash and QR are
  // always billed one period at a time. They are not: a club can sell a 12-month membership for one
  // QR payment, and the whole year was then charged the acquisition rate -- twelve times what is
  // owed. Blended the same way _rate.js effectiveRate does it, so the fee lands on the ONE month it
  // is for and the rest of the payment is charged at the club's ordinary rate. A yearly membership
  // now costs the club the same as twelve monthly ones, on every rail.
  const bought = Math.max(1, parseInt(periods, 10) || 1);
  const covered = Math.max(0, Math.min(bought, r.months));
  if (covered <= 0) return null;
  const hi = Math.max(Number(ladder) || 0, r.rate);
  return (covered >= bought) ? hi : ((hi * covered + (Number(ladder) || 0) * (bought - covered)) / bought);
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
    const { token, gym_id, coach_id, member_id, gross_amount, currency, type, payment_method, cash_payer_name, acq_source, credit, source_booking_id, cohort_id, income_class, months } = b;
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
      const gyms = await sb(`gyms?id=eq.${gym_id}&select=id,owner_id,currency,account_suspended,stripe_account,created_at`);
      const gym = gyms && gyms[0];
      if (!gym) return res.status(404).json({ error: 'gym not found' });
      if (!_trusted && gym.owner_id !== uid) return res.status(403).json({ error: 'not your gym' });
      if (!_trusted && gym.account_suspended) return res.status(403).json({ error: 'account suspended' });
      const owners = await sb(`profiles?id=eq.${gym.owner_id}&select=id,partner,founding,coach_ref_score,bankai_eligible,created_at,referral_optin`);
      const ownerProf = (owners && owners[0]) || {};
      if (!ownerProf.id) ownerProf.id = gym.owner_id;
      rate = ladderRate(ownerProf);
      cur = currency || gym.currency || 'czk';
      const _cc = (_wantCredit && ownerProf.referral_optin !== false) ? await findStudentCredit(member_id) : null;
      if (_cc) _creditRow = { memberId: member_id, id: _cc.id, sc: _cc.sc };
      const _acq = await acquisitionRate(acq_source, type, ownerProf, member_id, 'gym_id', gym_id, rate, months);
      let mtl_fee = _cc ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
      // Podlaha jen u PIS a jen když se opravdu něco účtuje -- uplatněný kredit zůstává nulový.
      if (mtl_fee > 0 && payment_method === 'pis') mtl_fee = Math.max(mtl_fee, await _pisMinFee(currency, gross));
      const _effRate = _cc ? 0 : (_acq != null ? _acq : rate); // per-tx rate -> doklad can itemise by tier
      // Rozklad na akvizici a běžnou sazbu. Bez těchhle dvou sloupců nechá export pro účetní pět
      // sloupců prázdných (akviz. měsíců/sazba/částka, běžná sazba/částka) -- _sp() se z nich počítá
      // a bez nich vrací prázdno. Píše se jen tam, kde akvizice opravdu padla.
      const _acqMonths = (_acq != null && !_cc) ? 1 : null;
      const _baseRate  = (_acq != null && !_cc) ? rate : null;
      let _gymPayee = gym.stripe_account || null;
      if (coach_id) { try { const _cp = await sb(`profiles?id=eq.${coach_id}&select=gym_payout_account`); const _cpa = _cp && _cp[0] && _cp[0].gym_payout_account; if (_cpa) _gymPayee = _cpa; } catch(e){} }
      row = {
        gym_id, coach_id: coach_id || null, member_id: member_id || null, paid_to: 'gym', payee_account: _gymPayee,
        payee_id: gym.id, payee_kind: 'gym',
        gross_amount: gross, stripe_fee: 0, mtl_fee, mtl_rate: _effRate, acq_months: _acqMonths, base_rate: _baseRate, refund_amount: 0, mtl_fee_refunded: 0,
        // CHANGED: was 'completed'. The column's own DB default is 'paid' and the Stripe rail writes
        // 'paid', so 'completed' was the odd one out -- and every reader of prior turnover asked for
        // 'completed' only, which is why none of them could see a Stripe transaction. One vocabulary
        // now; status-vocabulary.sql normalises the rows written before this.
        currency: cur, type, status: 'paid', payment_method, cohort_id: cohort_id || null, income_class: income_class || null,
        commission_status: _cc ? 'collected' : 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct', source_booking_id: source_booking_id || null,
      };
    } else {
      // coach pays out -> the coach authorizes their own cash/QR, rate from coach profile.
      const cs = await sb(`profiles?id=eq.${coach_id}&select=id,partner,founding,coach_ref_score,bankai_eligible,account_suspended,cash_blocked,created_at,referral_optin,gym_payout_account,stripe_account`);
      const coach = cs && cs[0];
      if (!coach) return res.status(404).json({ error: 'coach not found' });
      if (!_trusted && coach.id !== uid) return res.status(403).json({ error: 'not your account' });
      if (!_trusted && coach.account_suspended) return res.status(403).json({ error: 'account suspended' });
      if (!_trusted && coach.cash_blocked) return res.status(403).json({ error: 'cash blocked' });
      rate = ladderRate(coach);
      cur = currency || 'czk';
      const _cc = (_wantCredit && coach.referral_optin !== false) ? await findStudentCredit(member_id) : null;
      if (_cc) _creditRow = { memberId: member_id, id: _cc.id, sc: _cc.sc };
      const _acq = await acquisitionRate(acq_source, type, coach, member_id, 'coach_id', coach_id, rate, months);
      let mtl_fee = _cc ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
      // Podlaha jen u PIS a jen když se opravdu něco účtuje -- uplatněný kredit zůstává nulový.
      if (mtl_fee > 0 && payment_method === 'pis') mtl_fee = Math.max(mtl_fee, await _pisMinFee(currency, gross));
      const _effRate = _cc ? 0 : (_acq != null ? _acq : rate); // per-tx rate -> doklad can itemise by tier
      // Rozklad na akvizici a běžnou sazbu. Bez těchhle dvou sloupců nechá export pro účetní pět
      // sloupců prázdných (akviz. měsíců/sazba/částka, běžná sazba/částka) -- _sp() se z nich počítá
      // a bez nich vrací prázdno. Píše se jen tam, kde akvizice opravdu padla.
      const _acqMonths = (_acq != null && !_cc) ? 1 : null;
      const _baseRate  = (_acq != null && !_cc) ? rate : null;
      row = {
        gym_id: null, coach_id, member_id: member_id || null, paid_to: 'coach', payee_account: (coach.gym_payout_account || coach.stripe_account || null),
        payee_id: coach.id, payee_kind: 'profile',
        gross_amount: gross, stripe_fee: 0, mtl_fee, mtl_rate: _effRate, acq_months: _acqMonths, base_rate: _baseRate, refund_amount: 0, mtl_fee_refunded: 0,
        currency: cur, type, status: 'paid', payment_method, cohort_id: cohort_id || null, income_class: income_class || null,
        commission_status: _cc ? 'collected' : 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct', source_booking_id: source_booking_id || null,
      };
    }

    const ins = await sb('transactions', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) });
    if (_creditRow) await consumeStudentCredit(_creditRow.memberId, _creditRow.id, _creditRow.sc);
    return res.status(200).json({ ok: true, mtl_fee: row.mtl_fee, credit_redeemed: !!_creditRow, id: (ins && ins[0] && ins[0].id) || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
