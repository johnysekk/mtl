import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ════════════════════════════════════════════════════════════════════════
// MTL — sloučený platební router (Vercel Hobby má limit serverless funkcí).
// Nahrazuje: checkout.js (coach) + gym-checkout.js + membership-checkout.js
// + partner-checkout.js. Větví se podle ?type=coach|gym|membership|partner.
// Každá větev je 1:1 přenesená logika z původního souboru — nic se nemění.
// ════════════════════════════════════════════════════════════════════════

const GYM_STUDENT_MARKUP = 1.00;  // no markup
const GYM_MTL_TAKE       = 0.03;   // drop-in: Stripe track base 3%
const MEMB_MTL_PERCENT   = 3;       // membership: Stripe track base 3% (was 3.5 = the old ladder)

// --- Genuine welcome 0%: no fee charged up front (replaces charge-then-instant-refund) ---
const _SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, ''), _SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const _WELCOME_FOUNDER = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
async function _wsbGet(path){
  if(!_SUPA_URL || !_SUPA_KEY) return [];
  try{ const r = await fetch(_SUPA_URL.replace(/\/+$/,'') + '/rest/v1/' + path, { headers:{ apikey:_SUPA_KEY, Authorization:'Bearer '+_SUPA_KEY } }); return r.ok ? await r.json() : []; }catch(e){ return []; }
}
// True if the provider holding this connected account is still inside their welcome window
// (welcome_free_until in the future), unless the founder kill-switch (welcome_zero_off) is on.
// When true we set the application fee to 0 at checkout = clean books, no refund, no doklad.
async function _wsbPatch(path, body){
  if(!_SUPA_URL || !_SUPA_KEY) return;
  try{ await fetch(_SUPA_URL.replace(/\/+$/,'') + '/rest/v1/' + path, { method:'PATCH', headers:{ apikey:_SUPA_KEY, Authorization:'Bearer '+_SUPA_KEY, 'Content-Type':'application/json', Prefer:'return=minimal' }, body: JSON.stringify(body) }); }catch(e){ console.error('wsbPatch', e.message); }
}
// SERVER-SIDE CREDIT VERIFICATION.
// The `credit` query param used to be TRUSTED: `if (String(credit)==='student') COMMISSION = 0`
// straight from req.query, with no check at all. Anyone could append &credit=student&refDisc=0.5
// to a checkout URL and pay up to 50% less while MTL collected NOTHING - the provider ate the
// discount. record-cash.js (the bank track) already refuses to trust the client here; the Stripe
// track did not. Returns the referral_credits row id when the credit is real, else null.
async function verifyStudentCredit(studentId){
  if(!studentId) return null;
  try{
    const prof = await _wsbGet(`profiles?id=eq.${encodeURIComponent(studentId)}&select=student_credits`);
    const sc = (prof && prof[0]) ? Number(prof[0].student_credits || 0) : 0;
    if(!(sc > 0)) return null;
    const nowIso = new Date().toISOString();
    const rows = await _wsbGet(`referral_credits?user_id=eq.${encodeURIComponent(studentId)}&consumed=eq.false&expires_at=gt.${encodeURIComponent(nowIso)}&select=id&order=earned_at.asc&limit=1`);
    return (rows && rows[0] && rows[0].id) ? String(rows[0].id) : null;
  }catch(e){ console.error('verifyStudentCredit', e.message); return null; }
}

// ---------------------------------------------------------------------------
// WELCOME CAP — 100,000 CZK of turnover inside the window, in REAL money.
// The cap used to add gross_amount across currencies with no conversion, so a EUR gym
// got an effective 100,000 EUR cap (~25x too generous). fx-sync.js already caches the
// ECB reference rates daily in fx_rates (base EUR), so use them.
// Fail-safe in BOTH directions: if the rates are missing we count only the rows already
// in CZK, which UNDER-counts and therefore leaves the window open a little longer.
// Under-counting is the safe error - it never over-charges a provider.
const WELCOME_CAP_CZK_MINOR = 100000 * 100;   // gross_amount is stored in minor units
let _fxCache = null;
async function _fxRates(){
  if (_fxCache !== null) return _fxCache;
  try{
    const r = await _wsbGet(`fx_rates?id=eq.ecb-latest&select=data&limit=1`);
    const d = r && r[0] && r[0].data;
    _fxCache = (d && d.rates && d.rates.CZK) ? d.rates : false;
  }catch(e){ _fxCache = false; }
  return _fxCache;
}
// ECB feed is EUR-based: 1 EUR = rates[CUR] of CUR. EUR itself is not in the feed.
function _toCzkMinor(amountMinor, cur, rates){
  const c = String(cur || 'CZK').toUpperCase();
  if (c === 'CZK') return Number(amountMinor) || 0;
  if (!rates) return 0;                                  // no rates -> don't count it (under-count = safe)
  const per = (c === 'EUR') ? 1 : rates[c];
  if (!per) return 0;
  return (Number(amountMinor) || 0) / per * rates.CZK;
}
async function welcomeCapReached(rows){
  const rates = await _fxRates();
  let sum = 0;
  for (const r of (rows || [])) sum += _toCzkMinor(r.gross_amount, r.currency, rates);
  return sum >= WELCOME_CAP_CZK_MINOR;
}

async function isWelcomeZero(acct){
  if(!acct) return false;
  try{
    const ks = await _wsbGet(`profiles?id=eq.${_WELCOME_FOUNDER}&select=welcome_zero_off`);
    if(ks && ks[0] && ks[0].welcome_zero_off) return false;
    const a = encodeURIComponent(String(acct).trim());
    let _wtbl = 'profiles';
    let prov = (await _wsbGet(`profiles?stripe_account=eq.${a}&select=id,welcome_free_until,created_at&limit=1`))[0]
            || (await _wsbGet(`profiles?gym_payout_account=eq.${a}&select=id,welcome_free_until,created_at&limit=1`))[0];
    if(!prov){
      // gyms has ONLY stripe_account; gym_payout_account is a profiles column. The second
      // query here always 400'd and returned nothing - a fallback that never fell back.
      let g = (await _wsbGet(`gyms?stripe_account=eq.${a}&select=id,owner_id,welcome_free_until,created_at&limit=1`))[0];
      if(g && g.id){ prov = g; _wtbl = 'gyms'; }
    }
    if(!prov || !prov.id) return false;
    const now = Date.now();
    if(prov.welcome_free_until){
      if(now >= new Date(prov.welcome_free_until).getTime()) return false; // 30-day window elapsed
      // Volume trigger: the welcome window also ends at 100,000 CZK of turnover.
      // Scoped by payee_id (the entity that owns welcome_free_until) and converted to CZK -
      // this used to scope by payee_account, which is NULL for a bank/QR provider and which
      // diverged from record-cash's gym_id/coach_id scope; and it used to SUM CURRENCIES,
      // so a EUR gym effectively had a 100,000 EUR cap.
      try{
        const winStart = new Date(new Date(prov.welcome_free_until).getTime() - 30*86400000).toISOString();
        const rows = await _wsbGet(`transactions?select=gross_amount,currency&payee_id=eq.${encodeURIComponent(prov.id)}&status=eq.completed&created_at=gte.${encodeURIComponent(winStart)}`);
        if (await welcomeCapReached(rows)) return false;   // over the cap -> charge normally from now on
      }catch(e){ /* on any error keep welcome (never over-charge) */ }
      return true;
    }
    // First sale on a genuinely new account (<45 days): open the 30-day window now and make THIS sale 0%.
    const created = prov.created_at ? new Date(prov.created_at).getTime() : 0;
    if(created && (now - created) < 45*86400000){
      // Welcome is a NEW-PROVIDER incentive. A gym owner gets it for their FIRST gym only;
      // any 2nd+ gym is an existing provider expanding, not a new acquisition, so no welcome.
      // "First" = no other gym of this owner was created before this one (deleted gyms count,
      // so deleting gym #1 can't reset gym #2 into a fresh welcome). Solo coaches (profiles)
      // are unaffected - this gate only applies when the paying entity is a gym.
      if(_wtbl === 'gyms' && prov.owner_id){
        try{
          const earlier = await _wsbGet(`gyms?owner_id=eq.${encodeURIComponent(prov.owner_id)}&created_at=lt.${encodeURIComponent(new Date(created).toISOString())}&select=id&limit=1`);
          if(earlier && earlier.length) return false;   // not the owner's first gym -> no welcome
        }catch(e){ /* on error, fall through and grant (never over-charge on our own bug) */ }
      }
      await _wsbPatch(`${_wtbl}?id=eq.${prov.id}`, { welcome_free_until: new Date(now + 30*86400000).toISOString() });
      return true;
    }
    return false;
  }catch(e){ console.error('isWelcomeZero', e.message); return false; }
}
// DIAGNOSTIC: same lookup as isWelcomeZero but returns WHY (shown in Stripe metadata as mtl_welcome).
// off=kill-switch | noprov=provider not found by account | ok-*=welcome active | expired-* | old-*(>45d no window) | anchor-*(would open) | err

// Guard: a connected account must be able to accept payments (charges_enabled)
// before we create a Checkout on it. Otherwise Stripe throws a raw error
// (e.g. "you must set a business name") and the buyer sees garbage. This also
// protects real providers who haven't finished Stripe onboarding.
async function _assertAcctReady(acct, res) {
  try {
    const a = await stripe.accounts.retrieve(String(acct));
    if (!a.charges_enabled) {
      res.status(400).json({ error: 'Na strane kouce/gymu je chyba v konfiguraci plateb. Pokud jsi s nimi v kontaktu, dej jim o tom vedet.' });
      return false;
    }
    return true;
  } catch (e) {
    res.status(400).json({ error: 'Na strane kouce/gymu je chyba v konfiguraci plateb. Pokud jsi s nimi v kontaktu, dej jim o tom vedet.' });
    return false;
  }
}

export default async function handler(req, res) {
  const type = String(req.query.type || 'coach');
  try {
    if (type === 'coach')      return await coachCheckout(req, res);
    if (type === 'gym')        return await gymCheckout(req, res);
    if (type === 'membership') return await membershipCheckout(req, res);
    if (type === 'partner')    return await partnerCheckout(req, res);
    if (type === 'event')      return await eventCheckout(req, res);
    return res.status(400).json({ error: 'Neznámý type: ' + type });
  } catch (err) {
    console.error('pay error [' + type + ']:', err);
    res.status(500).json({ error: err.message });
  }
}

// ───────────────────────── COACH (lekce / online) ─────────────────────────
async function coachCheckout(req, res) {
  const {
    coachId, coachName, amount, currency = 'CZK', slotId, online,
    coachProfileId, fmt, commission, nomarkup, credit, studentId, disc, markup, refDisc,
  } = req.query;

  if (!coachId || !amount) return res.status(400).json({ error: 'Chybí coachId nebo amount' });
  if (!(await _assertAcctReady(coachId, res))) return;

  const rate = parseInt(amount, 10);
  const cur = String(currency).toLowerCase();
  // The client only ever sends _ladderRate(), whose whole range is 0.01 (EP) .. 0.035 (bank
  // base). The old guard was `>= 0.02 && <= 0.25 else 0.10`, which is broken twice over:
  //   * an EXCLUSIVE PARTNER sends 0.01 -> FAILS the >= 0.02 test -> was charged 0.10.
  //     An EP pays 1000 CZK/month FOR a 1% rate and was being billed 10% on every 1:1.
  //   * the fallback itself was 10%, not the base rate.
  // Legitimate range: 0.01 (EP) .. 0.10 (the coach-1:1 ACQUISITION fee, which the client
  // DOES send here as Math.max(comm, partner?0.05:0.10)). Fallback = Stripe base 3%.
  let COMMISSION = commission ? parseFloat(commission) : 0.03;
  if (!(COMMISSION >= 0.01 && COMMISSION <= 0.10)) COMMISSION = 0.03;
  let MK = 1.00; // no markup — student pays exactly the listed price
  let STUDENT_MARKUP = MK;
  const _credRow = (String(credit) === 'student') ? await verifyStudentCredit(studentId) : null;
  if (_credRow) {
    // Referral reward: MTL waives its whole fee; the provider funds the rest of the discount.
    // Only ever reached when the credit was VERIFIED against the DB above.
    let d = refDisc ? parseFloat(refDisc) : COMMISSION;
    if (!(d >= 0 && d <= 0.5)) d = COMMISSION;
    STUDENT_MARKUP = Math.max(0, MK - d);
    COMMISSION = 0;
  } else if (String(nomarkup) === '1') {
    STUDENT_MARKUP = 1.00;
  }

  const isCZK = String(currency || 'CZK').toUpperCase() === 'CZK';
  const unitAmount     = isCZK ? Math.floor(rate * STUDENT_MARKUP) * 100 : Math.round(rate * STUDENT_MARKUP * 100);
  const applicationFee = Math.round(rate * COMMISSION * 100); // exact pct (was floored to whole CZK -> under-charged)

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';
  const isOnline = String(online) === '1';

  let successUrl;
  if (isOnline) {
    successUrl = `${proto}://${host}/?platba=ok&online=1&coach=${encodeURIComponent(coachProfileId || '')}&amount=${rate}&currency=${currency}&fmt=${encodeURIComponent(fmt || '')}&acct=${encodeURIComponent(coachId)}&session={CHECKOUT_SESSION_ID}`;
  } else {
    successUrl = `${proto}://${host}/?platba=ok&slot=${encodeURIComponent(slotId || '')}&acct=${encodeURIComponent(coachId)}&session={CHECKOUT_SESSION_ID}`;
  }

  const productName = isOnline
    ? `Online coaching${fmt ? ' — ' + fmt : ''} — ${coachName || 'Kouč'}`
    : `Lekce s ${coachName || 'Kouč'}`;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    metadata: {
      booking_type: isOnline ? 'online' : 'inperson',
      mtl_welcome_waived: (await isWelcomeZero(coachId)) ? String(applicationFee) : '0',
      mtl_credit_row: _credRow || '',
      mtl_credit_user: _credRow ? String(studentId || '') : '',
      mtl_ref_pct: _credRow ? String(Math.round((MK - STUDENT_MARKUP) * 100)) : '0',
      mtl_list_amount: String(Math.round(rate * 100)),
      student_id: studentId || '',
      slot_id: slotId || '',
      coach_profile_id: coachProfileId || '',
      base_amount: String(rate),
      booking_currency: currency,
      online_fmt: fmt || '',
      coach_name: coachName || '',
      discipline: disc || '',
    },
    line_items: [
      { price_data: { currency: cur, product_data: { name: productName }, unit_amount: unitAmount }, quantity: 1 },
    ],
    payment_intent_data: {
      application_fee_amount: (await isWelcomeZero(coachId)) ? 0 : applicationFee,
      metadata: {
        credit_type: credit || 'none',
        mtl_credit_row: _credRow || '',      // set ONLY when server-verified; the webhook consumes it
        mtl_credit_user: _credRow ? String(studentId||'') : '',
        mtl_ref_pct: _credRow ? String(Math.round((MK - STUDENT_MARKUP) * 100)) : '0',
        mtl_list_amount: String(Math.round(rate * 100)),
        coach_pct: (STUDENT_MARKUP - COMMISSION).toFixed(2),
        commission_pct: COMMISSION.toFixed(2),
        coach_name: coachName || '',
      },
    },
    success_url: successUrl,
    cancel_url: `${proto}://${host}/`,
  }, { stripeAccount: coachId });

  res.redirect(303, session.url);
}

// ───────────────────────── GYM drop-in (direct charge) ─────────────────────────
async function gymCheckout(req, res) {
  const {
    gymAccount, gymName, className, amount, currency = 'CZK', bookingId,
    income, memberName, payee, disc, level, partner, guest, token, founding, credit, refDisc, take,
    gymId, studentId, coachId, grace, merch, merchId, qty, variant, merchName,
  } = req.query;

  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });
  if (!(await _assertAcctReady(gymAccount, res))) return;

  const P = parseInt(amount, 10);
  const cur = String(currency).toLowerCase();
  const isPartner = (String(partner) === '1');
  const MK   = 1.00;
  let STUDENT_MK = MK;
  // owner's MTL League tier rate (Shikai 3% / Bankai 2%), passed from the client and range-validated.
  let _tk = take ? parseFloat(take) : GYM_MTL_TAKE;
  if (!(_tk >= 0.01 && _tk <= 0.05)) _tk = GYM_MTL_TAKE;
  let TAKE = (String(partner)==='1') ? 0.01 : _tk; // EP 1%, else owner's tier rate (3.5/3/2%)
  const _credRow = (String(credit) === 'student') ? await verifyStudentCredit(studentId) : null;
  if (_credRow) {
    // Referral reward on a drop-in: MTL waives its whole fee; the gym/coach funds the rest.
    // Only ever reached when the credit was VERIFIED against the DB above.
    let d = refDisc ? parseFloat(refDisc) : TAKE;
    if (!(d >= 0 && d <= 0.5)) d = TAKE;
    STUDENT_MK = Math.max(0, MK - d);
    TAKE = 0;
  }

  const isCZK = cur === 'czk';
  const unitAmount     = isCZK ? Math.floor(P * STUDENT_MK) * 100 : Math.round(P * STUDENT_MK * 100);
  const applicationFee = Math.round(P * TAKE * 100); // exact pct (was floored to whole CZK -> 8.75 became 8)

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      metadata: { mtl_payment_type: (String(merch)==='1'?'merch':'drop_in'), commission_pct: TAKE.toFixed(2), mtl_credit_row: _credRow || '', mtl_credit_user: _credRow ? String(studentId || '') : '', mtl_ref_pct: _credRow ? String(Math.round((MK - STUDENT_MK) * 100)) : '0', mtl_list_amount: String(Math.round(P * 100)), mtl_welcome_waived: (await isWelcomeZero(gymAccount)) ? String(applicationFee) : '0', gym_id: gymId || '', student_id: studentId || '', coach_id: coachId || '', mtl_plan: className || 'Drop-in', merch_name: merchName || '', mtl_currency: cur },
      line_items: [
        { price_data: { currency: cur, product_data: { name: `${className || 'Drop-in lekce'} — ${gymName || 'MTL Gym'}` }, unit_amount: unitAmount }, quantity: 1 },
      ],
      payment_intent_data: {
        application_fee_amount: (await isWelcomeZero(gymAccount)) ? 0 : applicationFee,
        description: `${className || 'Drop-in'}${level ? ' [' + level + ']' : ''} — ${gymName || 'MTL Gym'} (drop-in)`,
        metadata: {
          mtl_payment_type: (String(merch)==='1'?'merch':'drop_in'),
          merch_name: merchName || '',
          mtl_plan: className || 'Drop-in',
          mtl_level: level || '',
          mtl_income: income || 'side',
          gym_name: gymName || '',
          mtl_payee: payee || gymName || '',
          mtl_disc: disc || '',
          mtl_base: String(P),
          mtl_currency: cur,
          member_name: memberName || '',
          mtl_credit: credit || 'none',
          mtl_credit_row: _credRow || '',    // set ONLY when server-verified; the webhook consumes it
          mtl_credit_user: _credRow ? String(studentId||'') : '',
          mtl_ref_pct: _credRow ? String(Math.round((MK - STUDENT_MK) * 100)) : '0',
          mtl_list_amount: String(Math.round(P * 100)),
        },
      },
      success_url: (String(merch)==='1')
        ? `${proto}://${host}/?merch_pay=ok&merchid=${encodeURIComponent(merchId || '')}&qty=${encodeURIComponent(qty || '1')}&variant=${encodeURIComponent(variant || '')}&gym=${encodeURIComponent(gymId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`
        : (String(grace)==='1')
        ? `${proto}://${host}/?grace_pay=ok&gracegym=${encodeURIComponent(gymId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`
        : (String(guest)==='1')
        ? `${proto}://${host}/?guest_drop=ok&booking=${encodeURIComponent(bookingId || '')}&acct=${encodeURIComponent(gymAccount)}&token=${encodeURIComponent(token || '')}&session={CHECKOUT_SESSION_ID}`
        : `${proto}://${host}/?gym_pay=ok&booking=${encodeURIComponent(bookingId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${proto}://${host}/`,
    },
    { stripeAccount: gymAccount }
  );

  res.redirect(303, session.url);
}

// ───────────────────────── GYM membership (direct charge subscription) ─────────────────────────
// ───────────────────────── EVENT TICKET (flat 6% = 3% markup + 3% cut, no partner discount) ─────────────────────────
async function eventCheckout(req, res) {
  const { gymAccount, eventTitle, tierName, amount, currency = 'CZK', ticketId, buyerName, qty, qrToken, eventId, founding, partner, disc, gymId, payoutCoachId, take } = req.query;
  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });
  if (!(await _assertAcctReady(gymAccount, res))) return;
  const P = parseInt(amount, 10);
  const Q = Math.max(1, parseInt(qty, 10) || 1);
  const cur = String(currency).toLowerCase();
  // owner's MTL League tier rate (Shikai 3% / Bankai 2%), passed from the client and range-validated.
  const MK = 1.00;
  let _etk = take ? parseFloat(take) : 0.03;
  if (!(_etk >= 0.01 && _etk <= 0.05)) _etk = 0.03;
  const TAKE = (String(partner)==='1') ? 0.01 : _etk; // EP 1%, else owner's tier rate (3.5/3/2%)
  const isCZK = cur === 'czk';
  const unit = isCZK ? Math.floor(P * MK) * 100 : Math.round(P * MK * 100);
  const fee  = Math.round(P * TAKE * 100); // exact pct (was floored to whole CZK)
  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      line_items: [
        { price_data: { currency: cur, product_data: { name: `${eventTitle || 'Event'}${tierName ? ' — ' + tierName : ''}` }, unit_amount: unit }, quantity: Q },
      ],
      payment_intent_data: {
        application_fee_amount: (await isWelcomeZero(gymAccount)) ? 0 : (fee * Q),
        description: `${eventTitle || 'Event'}${tierName ? ' [' + tierName + ']' : ''} (MTL event ticket)`,
        metadata: {
          mtl_payment_type: 'event_ticket',
          mtl_event: eventTitle || '',
          mtl_tier: tierName || '',
          mtl_base: String(P),
          mtl_currency: cur,
          buyer_name: buyerName || '',
          ticket_id: ticketId || '',
          qr_token: qrToken || '',
          mtl_event_id: eventId || '',
        },
      },
      metadata: {
        mtl_payment_type: 'event_ticket',
        mtl_welcome_waived: (await isWelcomeZero(gymAccount)) ? String(fee * Q) : '0',
        ticket_id: ticketId || '',
        qr_token: qrToken || '',
        mtl_event_id: eventId || '',
        mtl_event: eventTitle || '',
        buyer_name: buyerName || '',
        mtl_disc: disc || '',
        mtl_base: String(P * Q),
        mtl_currency: cur,
        gym_id: gymId || '',
        payout_coach_id: payoutCoachId || '',
      },
      success_url: `${proto}://${host}/?event_pay=ok&ticket=${encodeURIComponent(ticketId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${proto}://${host}/`,
    },
    { stripeAccount: gymAccount } // DIRECT CHARGE on the chosen payee account (gym or coach)
  );
  res.redirect(303, session.url);
}

async function membershipCheckout(req, res) {
  const {
    gymAccount, gymName, planName, amount, currency = 'CZK', interval = 'month', months,
    membershipId, income, memberName, payee, disc, access, partner, refPct, refUser, founding, acq, fee,
    gymId, studentId,
  } = req.query;

  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });

  const P = parseInt(amount, 10);
  const cur = String(currency).toLowerCase();
  const ivl = interval === 'year' ? 'year' : 'month';
  if (!(await _assertAcctReady(gymAccount, res))) return;
  // owner's MTL League tier rate (Shikai 3% / Bankai 2%), passed from the client and range-validated.
  let _fp = fee ? parseFloat(fee) : MEMB_MTL_PERCENT;
  if (!(_fp >= 1 && _fp <= 5)) _fp = MEMB_MTL_PERCENT;
  const FEE_PCT = (String(partner)==='1') ? 1 : _fp; // EP 1%, else owner's tier rate (3.5/3/2%)
  // MTL acquisition fee: when the app DEMONSTRABLY brought this member (organic deck/search
  // discovery, acq=mtl_discovery), MTL takes 10% for the first 2 months, then a webhook drops
  // it to the normal rate (a finder's fee for the acquisition). Monthly subs only.
  const MTL_ACQ_PERCENT = 10;
  // NOTE: this used to also require String(partner) !== '1', which excluded an EP from the
  // acquisition fee entirely - making the "EP pays half" branch below DEAD CODE and billing
  // an EP acquisition at their normal 1%. EP pays HALF the acquisition fee, not none.
  const _isAcq = (String(acq) === 'mtl_discovery' && ivl === 'month');
  // EP perk: HALF the acquisition fee (5%) vs 10% for standard providers; after the window the webhook drops to mtl_acq_base (EP=1%).
  const FEE_NOW = _isAcq ? (String(partner)==='1' ? (MTL_ACQ_PERCENT/2) : MTL_ACQ_PERCENT) : FEE_PCT;

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';

  // Gym member referral: new member gets a one-time first-month discount.
  // Coupon is created on the CONNECTED account (charges are direct on the gym).
  // GATE: the referrer must CURRENTLY be an active member of this gym; otherwise no referral at all
  // (no discount for the new member, and no reward for the referrer -> we also drop refUser below).
  let discounts;
  // refPct arrives from the CLIENT URL. It used to be clamped only to <=100, which meant a
  // student could append refPct=100&refUser=<any active member> and buy the membership free,
  // with the gym eating the whole discount. The only legitimate value is the gym's own
  // configured member_ref_pct - so clamp to it server-side, and zero when referral is off.
  let refPctN = parseInt(refPct, 10) || 0;
  let _refUserOk = refUser || '';
  if (refPctN > 0 && gymId) {
    try {
      const _gRow = (await _wsbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=member_ref_pct`))[0];
      const _maxP = (_gRow && parseInt(_gRow.member_ref_pct, 10)) || 0;
      refPctN = Math.min(refPctN, _maxP);          // referral off (0) kills it entirely
    } catch (e) { refPctN = 0; }                   // cannot verify -> no discount (never guess with money)
  }
  if (refPctN > 0 && refUser && gymId) {
    let _refActive = false;
    try {
      const _rm = await _wsbGet(`gym_memberships?student_id=eq.${encodeURIComponent(refUser)}&gym_id=eq.${encodeURIComponent(gymId)}&status=in.(active,cancelling)&select=id&limit=1`);
      _refActive = !!(_rm && _rm[0]);
    } catch (e) {}
    if (!_refActive) { refPctN = 0; _refUserOk = ''; }   // referrer not an active member -> kill the referral
  }
  if (refPctN > 0 && refPctN <= 100) {
    try {
      const coupon = await stripe.coupons.create(
        { percent_off: refPctN, duration: 'once', name: `MTL referral -${refPctN}%` },
        { stripeAccount: gymAccount }
      );
      discounts = [{ coupon: coupon.id }];
    } catch (e) { console.error('referral coupon failed', e && e.message); }
  }

  // ── MULTI-MONTH MEMBERSHIP = ONE-TIME PAYMENT ────────────────────────────────────────────
  // Monthly plans (months = 1, the default) stay exactly as they were: a Stripe subscription
  // that renews. A 3/6/12-month plan is NOT a subscription — a club sells a term ("pololetni
  // kurzovne"), the member pays once, and the membership simply expires at the end. Renewing a
  // 6-month term automatically would be wrong (and a refund/dispute magnet).
  // Commission: charged ONCE on the whole amount (Petr's call), via application_fee_amount.
  const _months = Math.max(1, parseInt(months, 10) || 1);
  if (_months > 1) {
    const _amtMinor = Math.round(P * 100);
    const _feePct = (await isWelcomeZero(gymAccount)) ? 0 : FEE_NOW;
    const _feeMinor = Math.round(_amtMinor * (_feePct / 100));
    const _meta = {
      mtl_payment_type: 'membership',
      mtl_membership_kind: 'one_time',
      mtl_months: String(_months),
      gym_id: gymId || '',
      student_id: studentId || '',
      membership_id: membershipId || '',
      mtl_plan: planName || 'Membership',
      mtl_access: access || '',
      mtl_income: income || 'side',
      gym_name: gymName || '',
      mtl_payee: payee || gymName || '',
      mtl_disc: disc || '',
      mtl_base: String(P),
      mtl_currency: cur,
      member_name: memberName || '',
      mtl_ref_user: _refUserOk,
      mtl_ref_pct: String(refPctN || 0),
    };
    const _s1 = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        metadata: _meta,
        line_items: [
          { price_data: { currency: cur, product_data: { name: `${planName || 'Membership'}${access ? ' [' + access + ']' : ''} — ${gymName || ''} (${_months} m)` }, unit_amount: _amtMinor }, quantity: 1 }
        ],
        payment_intent_data: {
          ...(_feeMinor > 0 ? { application_fee_amount: _feeMinor } : {}),
          metadata: _meta,
        },
        ...(discounts ? { discounts } : {}),
        success_url: `${proto}://${host}/?gym_sub=ok&membership=${encodeURIComponent(membershipId || '')}&acct=${encodeURIComponent(gymAccount)}`,
        cancel_url: `${proto}://${host}/`,
      },
      { stripeAccount: gymAccount }
    );
    return res.redirect(303, _s1.url);
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      metadata: {
        mtl_payment_type: 'membership',
        gym_id: gymId || '',
        student_id: studentId || '',
        membership_id: membershipId || '',
        mtl_plan: planName || 'Membership',
        mtl_disc: disc || '',
        mtl_base: String(P),
        mtl_currency: cur,
        mtl_ref_user: _refUserOk,
        mtl_ref_pct: String(refPctN || 0),
      },
      line_items: [
        { price_data: { currency: cur, product_data: { name: `${planName || 'Membership'}${access ? ' [' + access + ']' : ''} — ${gymName || 'MTL Gym'}` }, unit_amount: Math.round(P * 100), recurring: { interval: ivl } }, quantity: 1 },
      ],
      subscription_data: {
        application_fee_percent: (await isWelcomeZero(gymAccount)) ? 0 : FEE_NOW,
        metadata: {
          // mtl_acq   = this membership is inside the MTL acquisition window
          // mtl_acq_pct  = the acquisition rate for THIS provider (10, or 5 for an EP)
          // mtl_acq_base = the rate to fall back to once the window is over
          // Storing the rate itself means the webhook and the cron never have to re-derive
          // it (and never have to know whether the provider is an EP).
          mtl_acq: _isAcq ? '1' : '',
          mtl_acq_pct: _isAcq ? String(FEE_NOW) : '',
          mtl_acq_base: String(FEE_PCT),
          mtl_income: income || 'side',
          mtl_payment_type: 'membership',
          gym_id: gymId || '',
          student_id: studentId || '',
          membership_id: membershipId || '',
          mtl_plan: planName || 'Membership',
          mtl_access: access || '',
          mtl_income: income || 'side',
          gym_name: gymName || '',
          mtl_payee: payee || gymName || '',
          mtl_disc: disc || '',
          mtl_base: String(P),
          mtl_currency: cur,
          member_name: memberName || '',
          mtl_ref_user: _refUserOk,
          mtl_ref_pct: String(refPctN || 0),
        },
      },
      ...(discounts ? { discounts } : {}),
      success_url: `${proto}://${host}/?gym_sub=ok&membership=${encodeURIComponent(membershipId || '')}&acct=${encodeURIComponent(gymAccount)}&refuser=${encodeURIComponent(refUser || '')}&refpct=${encodeURIComponent(refPctN || 0)}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${proto}://${host}/`,
    },
    { stripeAccount: gymAccount }
  );

  res.redirect(303, session.url);
}

// ───────────────────────── Exclusive MTL Partner (localized price by region, platform account) ─────────────────────────
// Localized EP price by the provider's region. Mirrors _epRegion() in index.html.
// SK is a cheaper EUR tier than the EU default; both are EUR, so we MUST key on COUNTRY, not currency.
function epTierForCountry(cc){
  // FLAT EP pricing: 1000 CZK/mo for everyone (founding price, first 100 PAID partners).
  // Single currency = zero FX on MTL books. Client shows an indicative ECB conversion only.
  // When the 100 founding spots fill, raise this to 2000 (and _epPrice() in index.html).
  return { currency:'czk', amount:1000 };
}

async function partnerCheckout(req, res) {
  const { userId, email } = req.query;
  if (!userId) return res.status(400).json({ error: 'Chybí userId' });

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';

  // Region = country of the provider's connected Stripe account (authoritative for what we charge).
  // Fall back to cached stripe_country / profile country if no account is retrievable yet.
  let cc = '';
  try {
    const prof = (await _wsbGet(`profiles?id=eq.${encodeURIComponent(userId)}&select=stripe_account,gym_payout_account,country`))[0] || {};
    let acct = prof.stripe_account || prof.gym_payout_account || '';
    if(!acct){ const g=(await _wsbGet(`gyms?owner_id=eq.${encodeURIComponent(userId)}&select=stripe_account&limit=1`))[0]; if(g) acct=g.stripe_account||g.gym_payout_account||''; }
    if(acct){
      try{ const a=await stripe.accounts.retrieve(String(acct)); cc=String(a.country||'').toUpperCase(); }catch(e){}
      if(cc){ _wsbPatch(`profiles?id=eq.${encodeURIComponent(userId)}`, { stripe_country: cc }); } // cache for client display; no-op until ep-pricing.sql adds the column
    }
    if(!cc) cc = String(prof.country || '').toUpperCase();
  } catch(e){}
  const tier = epTierForCountry(cc);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true, required: 'if_supported' },
    client_reference_id: userId,
    line_items: [
      { price_data: { currency: tier.currency, product_data: { name: 'Exclusive MTL Partner — coach & gym rates' }, unit_amount: Math.round(tier.amount*100), recurring: { interval: 'month' } }, quantity: 1 },
    ],
    subscription_data: { metadata: { mtl_payment_type: 'partner_sub', user_id: userId, ep_country: cc||'', ep_currency: tier.currency, ep_amount: String(tier.amount) } },
    metadata: { mtl_payment_type: 'partner_sub', user_id: userId, ep_country: cc||'' },
    success_url: `${proto}://${host}/?partner_sub=ok&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${proto}://${host}/`,
  }, { apiVersion: '2024-09-30.acacia' });

  res.redirect(303, session.url);
}
