import Stripe from 'stripe';
import { resolveRate, effectiveRate, effectiveRateBreakdown, onlineRateFor } from './_rate.js';
import { sellKind, sellLabel, sellKindFor } from './_sell-kind.js';
import { checkPrice } from './_price-check.js';
const _PC = (kind, extra) => ({ SB: _SUPA_URL, KEY: _SUPA_KEY, kind, ...extra });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ════════════════════════════════════════════════════════════════════════
// MTL — sloučený platební router (Vercel Hobby má limit serverless funkcí).
// Nahrazuje: checkout.js (coach) + gym-checkout.js + membership-checkout.js
// + partner-checkout.js. Větví se podle ?type=coach|gym|membership|partner.
// Každá větev je 1:1 přenesená logika z původního souboru — nic se nemění.
// ════════════════════════════════════════════════════════════════════════

const GYM_STUDENT_MARKUP = 1.00;  // no markup
const GYM_MTL_TAKE       = 0.02;   // drop-in: Stripe track base 2 % (bylo 3 %)
const MEMB_MTL_PERCENT   = 3;       // membership: Stripe track base 3% (was 3.5 = the old ladder)

const _SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, ''), _SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function _wsbGet(path){
  if(!_SUPA_URL || !_SUPA_KEY) return [];
  try{ const r = await fetch(_SUPA_URL.replace(/\/+$/,'') + '/rest/v1/' + path, { headers:{ apikey:_SUPA_KEY, Authorization:'Bearer '+_SUPA_KEY } }); return r.ok ? await r.json() : []; }catch(e){ return []; }
}
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
// ODSTRANENO s uvitacim oknem: _fxRates() a _toCzkMinor(). Existovaly VYHRADNE proto, aby se dal
// stotisicovy strop porovnat napric menami. record-cash.js si svoji kopii nechava -- tam je
// potrebuje minimalni provize u PIS.
// ODSTRANENO: welcomeCapReached() + isWelcomeZero(). Uvitaci okno bylo zruseno -- pri zakladu
// 2 % na Stripe a 2,5 % na bance uz neni co zlevnovat, a stalo za vic kodu na penezni ceste nez
// samotny zebricek: okno na dvou entitach, strop v CZK vyzadujici prepocet men, kill-switch,
// razitko welcome_waived na transakci a pravidlo "welcome prebiji akvizici" na peti mistech.
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

// ═══ POZASTAVENÝ POSKYTOVATEL NEPRODÁVÁ ═════════════════════════════════════════════════
// Deck ho skryje, ale přímý odkaz na platbu (z e-mailu, ze staré záložky, zpětné tlačítko)
// šel dál a student mu mohl zaplatit. Tady se to zavírá u zdroje: než vznikne Checkout,
// ověří se, že klub ani kouč nejsou pozastavení.
//
// TÝKÁ SE JEN NOVÝCH PLATEB. Už běžící předplatné u Stripe jede dál — to je záměr a slibujeme
// ho poskytovateli i studentovi.
const _SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function _isSuspended(table, id) {
  try {
    if (!id) return false;
    const r = await fetch(`${_SB}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=account_suspended`, {
      headers: { apikey: _SKEY, Authorization: `Bearer ${_SKEY}` },
    });
    if (!r.ok) return false;              // nedostupná databáze platbu neblokuje
    const j = await r.json();
    return !!(j && j[0] && j[0].account_suspended);
  } catch (e) { return false; }
}
async function _assertNotSuspended(req, res) {
  const q = req.query || {};
  const gymId = q.gymId || q.gym_id || null;
  const coachId = q.coachProfileId || q.coachId || null;
  const orgId = q.organizationId || q.orgId || null;
  const hits = await Promise.all([
    gymId ? _isSuspended('gyms', gymId) : false,
    coachId ? _isSuspended('profiles', coachId) : false,
    orgId ? _isSuspended('organizations', orgId) : false,
  ]);
  if (hits.some(Boolean)) {
    res.status(403).json({ error: 'Tento poskytovatel má dočasně pozastavený účet a nemůže teď přijímat platby.' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  const type = String(req.query.type || 'coach');
  try {
    // partner = platba Exclusive Partnera směrem k MTL; tu pozastavení blokovat nesmí,
    // jinak by se poskytovatel nedostal z dluhu ven.
    if (type !== 'partner' && !(await _assertNotSuspended(req, res))) return;
    if (type === 'coach')      return await coachCheckout(req, res);
    if (type === 'gym')        return await gymCheckout(req, res);
    if (type === 'membership') return await membershipCheckout(req, res);
    if (type === 'partner')    return await partnerCheckout(req, res);
    if (type === 'event')      return await eventCheckout(req, res);
    if (type === 'online_plan') return await onlinePlanCheckout(req, res);
    return res.status(400).json({ error: 'Neznámý type: ' + type });
  } catch (err) {
    console.error('pay error [' + type + ']:', err);
    res.status(500).json({ error: err.message });
  }
}

// ───────────────────────── COACH (lekce / online) ─────────────────────────
async function coachCheckout(req, res) {
  // Kdo platí, když se to liší od toho, komu služba patří (zástupce za mladistvého).
  // Čte se TADY, ne v handleru: handler je jiná funkce a její proměnné sem nedosáhnou.
  const payerId = String(req.query.payerId || '');
  const payerName = String(req.query.payerName || '').slice(0, 120);
  const {
    coachId, coachName, amount, currency = 'CZK', slotId, online,
    coachProfileId, fmt, commission, nomarkup, credit, studentId, disc, markup, refDisc, acq,
  } = req.query;

  if (!coachId || !amount) return res.status(400).json({ error: 'Chybí coachId nebo amount' });
  if (!(await _assertAcctReady(coachId, res))) return;

  const rate = parseInt(amount, 10);
  const cur = String(currency).toLowerCase();
  // The client only ever sends _ladderRate(), whose whole range is 0.005 (EP) .. 0.03 (bank base)
  // base). The old guard was `>= 0.02 && <= 0.25 else 0.10`, which is broken twice over:
  //   * an EXCLUSIVE PARTNER sends 0.01 -> FAILS the >= 0.02 test -> was charged 0.10.
  //     An EP pays 1000 CZK/month FOR a 1% rate and was being billed 10% on every 1:1.
  //   * the fallback itself was 10%, not the base rate.
  // Legitimate range: 0.01 (EP) .. 0.10 (the coach-1:1 ACQUISITION fee, which the client
  // DOES send here as Math.max(comm, partner?0.05:0.10)). Fallback = Stripe base 3%.
  // Server-side single source: ladder + acquisition via _rate.js (client 'commission' only a fallback).
  let COMMISSION;
  try {
    // Online koučing: vlastní sazba (1 / 0,75 / 0,5 %) a bez akvizice. Osobní lekce: žebříček + akvizice.
    COMMISSION = (String(online) === '1')
      ? await onlineRateFor(_wsbGet, coachProfileId)
      : await effectiveRate(_wsbGet, { ownerId: coachProfileId, mode: 'stripe', type: 'coach_1to1', acqSource: acq, memberId: studentId, scopeCol: 'coach_id', scopeId: coachProfileId });
  } catch (e) {
    console.error('pay.coach effectiveRate failed:', e.message);
    COMMISSION = (commission && parseFloat(commission) >= 0.005 && parseFloat(commission) <= 0.10) ? parseFloat(commission) : 0.02;   // fallback = base Stripe (bylo 0.03)
  }
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

  // OSOBNÍ SOUKROMKA: cena proti slotu / ceníku kouče / soukromým nabídkám.
  if (!isOnline) {
    const _pc = await checkPrice(_PC('coachPrivate', { amount: rate, currency, coachProfileId, slotId }));
    if (!_pc.ok) return res.status(400).json({ error: _pc.error });
  }

  // CENA ONLINE KOUČINGU SE OVĚŘUJE PROTI PROFILU KOUČE. Dřív server vzal částku i měnu z adresy
  // tak, jak přišly, takže šlo zaplatit libovolnou částku. Povolené dvojice cena + měna: balíčky
  // (každý ve své měně; starší bez měny = měna online), rate_online a ceny po disciplínách v měně online.
  if (isOnline) {
    const p = ((await _wsbGet(`profiles?id=eq.${encodeURIComponent(String(coachProfileId || ''))}&select=online_services,online_tiers,rate_online,currency_online,currency,discipline_rates_online,stripe_account&limit=1`)) || [])[0];
    if (!p || String(p.stripe_account || '').trim() !== String(coachId).trim()) return res.status(400).json({ error: 'Kouč nenalezen' });
    const defCur = String(p.currency_online || p.currency || 'CZK').toUpperCase();
    let tiers = []; try { const _src = (p.online_services != null) ? p.online_services : p.online_tiers; tiers = typeof _src === 'string' ? JSON.parse(_src) : (_src || []); } catch (e) {}
    let dro = {}; try { dro = typeof p.discipline_rates_online === 'string' ? JSON.parse(p.discipline_rates_online) : (p.discipline_rates_online || {}); } catch (e) {}
    const okPairs = [];
    (Array.isArray(tiers) ? tiers : []).forEach((t) => okPairs.push([Number(t && t.price), String((t && t.cur) || defCur).toUpperCase()]));
    if (Number(p.rate_online) > 0) okPairs.push([Number(p.rate_online), defCur]);
    Object.values(dro || {}).forEach((v) => { if (Number(v) > 0) okPairs.push([Number(v), defCur]); });
    const C = String(currency || 'CZK').toUpperCase();
    if (!okPairs.some(([pr, cu]) => pr === rate && cu === C)) {
      return res.status(400).json({ error: 'Cena neodpovídá aktuální nabídce kouče. Obnov jeho profil a zkus to znovu.' });
    }
  }

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
      mtl_credit_row: _credRow || '',
      mtl_credit_user: _credRow ? String(studentId || '') : '',
      mtl_ref_pct: _credRow ? String(Math.round((MK - STUDENT_MARKUP) * 100)) : '0',
      mtl_list_amount: String(Math.round(rate * 100)),
      student_id: studentId || '',
      paid_by: payerId || '',
      paid_by_name: payerName || '',
      student_name: String(req.query.studentName || '').slice(0, 120),
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
      application_fee_amount: applicationFee,
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
    gymId, studentId, coachId, grace, merch, merchId, qty, variant, merchName, acq,
  } = req.query;

  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });
  if (!(await _assertAcctReady(gymAccount, res))) return;

  const P = parseInt(amount, 10);
  // CENA PROTI DATABÁZI. Merch podle zboží; drop-in / grace / recepce podle ceníku klubu nebo kouče.
  {
    const _k = (String(merch) === '1') ? 'merch' : 'gymDropin';
    const _pc = await checkPrice(_PC(_k, { amount: P, currency, gymId, coachId, merchId, qty }));
    if (!_pc.ok) return res.status(400).json({ error: _pc.error });
  }
  const cur = String(currency).toLowerCase();
  const isPartner = (String(partner) === '1');
  const MK   = 1.00;
  let STUDENT_MK = MK;
  // Server-side single source: ladder + acquisition via _rate.js. Merch/grace/guest are not drop-ins
  // so they never get the acquisition fee. Client 'take' is only a fallback if resolve fails.
  let TAKE;
  let _acqMonths = 0, _baseRate = null;
  try {
    const _txType = (String(merch) === '1') ? 'merch' : ((String(grace) === '1' || String(guest) === '1') ? 'other' : 'drop_in');
    const _brk = await effectiveRateBreakdown(_wsbGet, { gymAccount, mode: 'stripe', type: _txType, acqSource: acq, memberId: studentId, scopeCol: 'gym_id', scopeId: gymId, months: (Math.max(1, parseInt(months, 10) || 1)) });
    TAKE = _brk.rate; _acqMonths = _brk.acqMonths; _baseRate = _brk.baseRate;
  } catch (e) {
    console.error('pay.gym effectiveRate failed:', e.message);
    TAKE = (take && parseFloat(take) >= 0.005 && parseFloat(take) <= 0.10) ? parseFloat(take) : GYM_MTL_TAKE;
  }
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
      metadata: { mtl_payment_type: (String(merch)==='1'?'merch':'drop_in'), commission_pct: TAKE.toFixed(2), mtl_credit_row: _credRow || '', mtl_credit_user: _credRow ? String(studentId || '') : '', mtl_ref_pct: _credRow ? String(Math.round((MK - STUDENT_MK) * 100)) : '0', mtl_list_amount: String(Math.round(P * 100)), gym_id: gymId || '', student_id: studentId || '', coach_id: coachId || '', mtl_plan: className || 'Drop-in', merch_name: merchName || '', mtl_currency: cur,
        // Ktera pojmenovana cena za vstup to byla a jestli u ni klub jeste musi videt
        // doklad. Webhook to prepise do transakce; bez toho by sleva zmizela beze stopy.
        mtl_dropin_plan: String(req.query.dropinPlan || ''),
        mtl_need_proof: (String(req.query.needProof || '') === '1' ? '1' : '') },
      line_items: [
        { price_data: { currency: cur, product_data: { name: `${String(merch)==='1' ? 'Zboží' : 'Jednorázový vstup'} · ${className || 'Lekce'} — ${gymName || 'MTL Gym'}` }, unit_amount: unitAmount }, quantity: 1 },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFee,
        description: `${String(merch)==='1' ? 'Zboží' : 'Jednorázový vstup'} · ${className || 'Lekce'} — ${gymName || 'MTL Gym'}`,
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
  const { gymAccount, eventTitle, tierName, amount, currency = 'CZK', ticketId, buyerName, buyerEmail, qty, qrToken, eventId, founding, partner, disc, gymId, payoutCoachId, take } = req.query;
  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });
  // ČÁSTKA A ÚČET ZE SERVERU, NE Z ADRESY. Dřív šla částka i sazba MTL do Stripe tak, jak je
  // poslal prohlížeč: upravený odkaz zaplatil za lístek 1 Kč nebo snížil provizi. Teď se
  // částka sečte z rezervovaných lístků objednávky a účet musí patřit pořadateli té akce.
  let P = parseInt(amount, 10);
  if (ticketId) {
    const _t = ((await _wsbGet(`event_tickets?id=eq.${encodeURIComponent(ticketId)}&select=order_id,event_id`)) || [])[0];
    if (!_t) return res.status(404).json({ error: 'Lístek nenalezen' });
    const _rows = _t.order_id
      ? ((await _wsbGet(`event_tickets?order_id=eq.${encodeURIComponent(_t.order_id)}&select=amount,status`)) || [])
      : ((await _wsbGet(`event_tickets?id=eq.${encodeURIComponent(ticketId)}&select=amount,status`)) || []);
    const _open = _rows.filter((r) => ['pending', 'reserved'].includes(String(r.status || '')));
    const _sum = _open.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    if (!(_sum > 0)) return res.status(400).json({ error: 'Objednávka už není k zaplacení' });
    P = _sum;
    const _ev = ((await _wsbGet(`events?id=eq.${encodeURIComponent(_t.event_id)}&select=gym_id,payout_coach_id,organization_id`)) || [])[0] || {};
    const _acc = new Set();
    try {
      if (_ev.payout_coach_id) { const pr = ((await _wsbGet(`profiles?id=eq.${encodeURIComponent(_ev.payout_coach_id)}&select=stripe_account,gym_payout_account`)) || [])[0] || {}; if (pr.gym_payout_account) _acc.add(pr.gym_payout_account); if (pr.stripe_account) _acc.add(pr.stripe_account); }
      if (_ev.gym_id) { const g = ((await _wsbGet(`gyms?id=eq.${encodeURIComponent(_ev.gym_id)}&select=stripe_account`)) || [])[0] || {}; if (g.stripe_account) _acc.add(g.stripe_account); }
      if (_ev.organization_id) { const o = ((await _wsbGet(`organizations?id=eq.${encodeURIComponent(_ev.organization_id)}&select=stripe_account`)) || [])[0] || {}; if (o.stripe_account) _acc.add(o.stripe_account); }
    } catch (e) {}
    if (_acc.size && !_acc.has(String(gymAccount))) return res.status(400).json({ error: 'Účet neodpovídá pořadateli akce' });
  }
  if (!(await _assertAcctReady(gymAccount, res))) return;
  // POZOR: `amount` je u akce VŽDY celková částka objednávky, ne cena za kus -- klient sčítá košík
  // sám, protože v jedné objednávce můžou být různé varianty za různé ceny, a jedno `qty` by to
  // nepopsalo. Q proto musí zůstat 1; kdyby sem někdo qty začal posílat, Stripe by tu částku
  // vynásobil podruhé a člověk by zaplatil dvakrát.
  const Q = 1;
  const cur = String(currency).toLowerCase();
  const MK = 1.00;
  // Rate: client _ladderRate (EP 0.5% / FP / ladder), server resolve as backstop. No partner override.
  // Sazba vždy ze serveru. Z adresy (take=) by si ji kupující mohl snížit.
  let TAKE = NaN;
  try { TAKE = await resolveRate(_wsbGet, { gymAccount, mode: 'stripe' }); }
  catch (e) { console.error('pay.event rate resolve failed:', e.message); TAKE = NaN; }
  if (!(TAKE >= 0.005 && TAKE <= 0.10)) { const _t2 = take ? parseFloat(take) : NaN; TAKE = (_t2 >= 0.005 && _t2 <= 0.10) ? _t2 : 0.03; }
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
      // Predvyplni e-mail na Stripe strance a hlavne posle uctenku tam, kam patri. U kupujiciho
      // bez uctu v MTL je to jedina adresa, kterou o nem mame.
      ...(buyerEmail ? { customer_email: String(buyerEmail).trim() } : {}),
      payment_intent_data: {
        application_fee_amount: (fee * Q),
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
  const _q0 = req.query || {};
  // Členství (spolek) / Permanentka (klub podnikatele nebo kouč) -- podle prodávajícího.
  // Prodávajícího bereme z řádku členství (paid_to: klub / kouč), ne z parametrů adresy.
  let _skPaidTo = 'gym', _skGym = _q0.gymId || null;
  try { if (_q0.membershipId) { const _mr = ((await _wsbGet(`gym_memberships?id=eq.${encodeURIComponent(_q0.membershipId)}&select=paid_to,gym_id`)) || [])[0]; if (_mr) { _skPaidTo = _mr.paid_to || 'gym'; _skGym = _mr.gym_id || _skGym; } } } catch (e) {}
  const _skLbl = sellLabel(await sellKindFor(_wsbGet, { gymId: _skGym, paidTo: _skPaidTo }), 'cs');
  const {
    gymAccount, gymName, planName, amount, currency = 'CZK', interval = 'month', months, endsOn,
    membershipId, income, memberName, payee, disc, access, partner, refPct, refUser, founding, acq, fee,
    gymId, studentId,
  } = req.query;

  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });

  // CENA PROTI CENÍKU ČLENSTVÍ KLUBU (membership_plans). Více měsíců = násobek / poměrná část.
  { const _pc = await checkPrice(_PC('gymMembership', { amount: parseInt(amount, 10), currency, gymId: _skGym || gymId })); if (!_pc.ok) return res.status(400).json({ error: _pc.error }); }

  const P = parseInt(amount, 10);
  const cur = String(currency).toLowerCase();
  const ivl = interval === 'year' ? 'year' : 'month';
  if (!(await _assertAcctReady(gymAccount, res))) return;
  // owner's MTL League tier rate (Shikai 3% / Bankai 2%), passed from the client and range-validated.
  // Rate in PERCENT. Client sends its _ladderRate (EP 0.5% / FP / ladder); resolve server-side if
  // invalid. No partner override -> EP 0.5% honoured. Acquisition (below) still stacks on top.
  let FEE_PCT = fee ? parseFloat(fee) : NaN;
  if (!(FEE_PCT >= 0.5 && FEE_PCT <= 10)) {
    try { FEE_PCT = (await resolveRate(_wsbGet, { gymAccount, mode: 'stripe' })) * 100; }
    catch (e) { console.error('pay.membership rate resolve failed:', e.message); FEE_PCT = MEMB_MTL_PERCENT; }
  }
  // MTL acquisition fee: when the app DEMONSTRABLY brought this member (organic deck/search
  // discovery, acq=mtl_discovery), MTL takes 10% for the first 2 months, then a webhook drops
  // it to the normal rate (a finder's fee for the acquisition). Monthly subs only.
  const MTL_ACQ_PERCENT = 10;
  // NOTE: this used to also require String(partner) !== '1', which excluded an EP from the
  // acquisition fee entirely - making the "EP pays half" branch below DEAD CODE and billing
  // an EP acquisition at their normal 1%. EP pays HALF the acquisition fee, not none.
  const _isAcq = (String(acq) === 'mtl_discovery' && ivl === 'month');
  // EP perk: HALF the acquisition fee (5%) vs 10% for standard providers; after the window the webhook drops to mtl_acq_base (EP=1%).
  let FEE_NOW = _isAcq ? (String(partner)==='1' ? (MTL_ACQ_PERCENT/2) : MTL_ACQ_PERCENT) : FEE_PCT;
  // A term plan is one payment covering N months, but only the first two ever carry the
  // acquisition fee -- so the rate has to be blended over the months it is actually owed for.
  // A monthly plan has months=1 and comes out of this unchanged.
  let _acqMonthsM = 0, _baseRateM = null;
  try {
    const _moM = Math.max(1, parseInt(months, 10) || 1);
    const _brkM = await effectiveRateBreakdown(_wsbGet, {
      gymAccount, mode: 'stripe', type: 'membership', acqSource: acq,
      memberId: studentId, scopeCol: 'gym_id', scopeId: gymId, months: _moM
    });
    if (_brkM && typeof _brkM.rate === 'number') {
      FEE_NOW = _brkM.rate * 100;
      _acqMonthsM = _brkM.acqMonths || 0;
      _baseRateM = _brkM.baseRate;
    }
  } catch (e) { console.error('pay.membership blended rate failed:', e.message); }

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
  // Jednorázově i měsíc (once=1): klub nabízí „Měsíční (jednorázově)" -- bez předplatného.
  if (_months > 1 || String((req.query || {}).once || '') === '1') {
    const _amtMinor = Math.round(P * 100);
    const _feePct = FEE_NOW;
    const _feeMinor = Math.round(_amtMinor * (_feePct / 100));
    const _meta = {
      mtl_payment_type: 'membership',
      mtl_membership_kind: 'one_time',
      mtl_months: String(_months),
      ...(endsOn ? { mtl_ends_on: String(endsOn) } : {}),
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
          { price_data: { currency: cur, product_data: { name: `${_skLbl} · ${planName || _skLbl} (${_months} měs.) — ${gymName || ''}` }, unit_amount: _amtMinor }, quantity: 1 }
        ],
        payment_intent_data: {
          ...(_feeMinor > 0 ? { application_fee_amount: _feeMinor } : {}),
          metadata: _meta,
        },
        ...(discounts ? { discounts } : {}),
        success_url: `${proto}://${host}/?gym_sub=ok&membership=${encodeURIComponent(membershipId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`,
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
        { price_data: { currency: cur, product_data: { name: `${_skLbl} · ${planName || _skLbl} — ${gymName || 'MTL Gym'}` }, unit_amount: Math.round(P * 100), recurring: { interval: ivl } }, quantity: 1 },
      ],
      subscription_data: {
        application_fee_percent: FEE_NOW,
        metadata: {
          // mtl_acq   = this membership is inside the MTL acquisition window
          // mtl_acq_pct  = the acquisition rate for THIS provider (10, or 5 for an EP)
          // mtl_acq_base = the rate to fall back to once the window is over
          // Storing the rate itself means the webhook and the cron never have to re-derive
          // it (and never have to know whether the provider is an EP).
          mtl_acq: _isAcq ? '1' : '',
          mtl_acq_pct: _isAcq ? String(FEE_NOW) : '',
          ...(_acqMonthsM ? { mtl_acq_months: String(_acqMonthsM) } : {}),
          ...(_baseRateM != null ? { mtl_base_rate: String(_baseRateM) } : {}),
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
// CENA PARTNERSTVI. Musi souhlasit s _epPrice() v index.html.
//   zakladajici cena  500 CZK -- pro prvnich EP_SPOTS partneru, plati jim, dokud nezrusi
//   ceníková cena    1000 CZK
// Zahranicni pasma (eurozona 20/40 EUR, USA 25/50 USD) jsou pripravena, ale zatim se
// neuctuji: dokud nemame poskytovatele mimo CR, uctuje se vsem v korunach a appka pod cenou
// ukaze prepocet kurzem ECB. Az se zapnou, musi se zaroven doresit ulozeni zamcene ceny
// (profiles.partner_price/partner_currency) a u USA i stat, ktery dnes nikde nemame.
const EP_SPOTS = 50;
const EP_FOUNDING_CZK = 500;
const EP_LIST_CZK = 1000;

async function epTierForCountry(cc) {
  // Kolik zakladajicich mist jeste zbyva. Pocitaji se vsichni aktivni partneri, i rucne udeleni.
  let taken = 0;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?select=id&partner=is.true`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: 'count=exact' },
    });
    const cr = r.headers.get('content-range') || '';
    taken = Number(String(cr).split('/')[1] || 0) || 0;
  } catch (e) { taken = 0; }
  const amount = (taken < EP_SPOTS) ? EP_FOUNDING_CZK : EP_LIST_CZK;
  return { currency: 'czk', amount };
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
  const tier = await epTierForCountry(cc);   // ceka na zjisteni, kolik zakladajicich mist zbyva

  // DIČ U ZAHRANIČNÍHO POSKYTOVATELE JE PODMÍNKA. Bez něj bychom u odběratele z jiné země
  // EU museli řešit režim OSS (místem plnění je jeho stát). Tomu se vyhýbáme: předplatné
  // se bez DIČ nezaloží, takže nevznikne platba, ke které nejde vystavit doklad.
  try {
    const _ps = (await _wsbGet('platform_settings?id=eq.1&select=require_vat_foreign,home_country'))[0] || {};
    if (_ps.require_vat_foreign) {
      const EU = ['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT',
                  'LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
      const home = String(_ps.home_country || 'CZ').toUpperCase();
      const p2 = (await _wsbGet(`profiles?id=eq.${encodeURIComponent(userId)}&select=vat_id,billing_country,country_code`))[0] || {};
      const bc = String(p2.billing_country || p2.country_code || cc || home).toUpperCase();
      const euForeign = bc && bc !== home && EU.indexOf(bc) >= 0 && EU.indexOf(home) >= 0;
      if (euForeign && !String(p2.vat_id || '').trim()) {
        return res.redirect(303, `${proto}://${host}/?partner_sub=need_vat`);
      }
    }
  } catch (e) { console.error('[ep] vat gate', e.message); }
  // Test mode bills EP daily instead of monthly, so the whole loop -- charge, Stripe invoice,
  // e-mail, renewal -- can be seen the next morning rather than in a month.
  let _epDaily = false;
  try { const { isTestMode } = await import('./_config.js'); _epDaily = await isTestMode(); } catch (e) {}
  const _epInterval = _epDaily ? 'day' : 'month';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true, required: 'if_supported' },
    client_reference_id: userId,
    line_items: [
      { price_data: { currency: tier.currency, product_data: { name: 'Exclusive MTL Partner — coach & gym rates' }, unit_amount: Math.round(tier.amount*100), recurring: { interval: _epInterval } }, quantity: 1 },
    ],
    subscription_data: { metadata: { mtl_payment_type: 'partner_sub', user_id: userId, ep_country: cc||'', ep_currency: tier.currency, ep_amount: String(tier.amount) } },
    metadata: { mtl_payment_type: 'partner_sub', user_id: userId, ep_country: cc||'' },
    success_url: `${proto}://${host}/?partner_sub=ok&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${proto}://${host}/`,
  }, { apiVersion: '2024-09-30.acacia' });

  res.redirect(303, session.url);
}

// ───────────────────────── ONLINE: MĚSÍČNÍ PŘEDPLATNÉ KOUČE ─────────────────────────
// Kouč si v online nabídce vytvoří měsíční předplatné (profiles.online_plans: název, cena, měna,
// co student dostane). Platí se JEN přes Stripe jako opakované předplatné na účet kouče.
// Řádek členství zakládá appka předem (gym_memberships: gym_id = null, paid_to = 'coach',
// status 'pending'); tady se z něj vezme JEN identita -- cena a měna se berou z nabídky kouče,
// nikdy z adresy. Sazba je online (1 / 0,75 / 0,5 %) a bez akvizice. Webhook pak předplatné
// propojí s řádkem a zapíše platbu stejně jako u členství v klubu.
async function onlinePlanCheckout(req, res) {
  const membershipId = String(req.query.membershipId || '');
  if (!membershipId) return res.status(400).json({ error: 'Chybí membershipId' });
  const mb = ((await _wsbGet(`gym_memberships?id=eq.${encodeURIComponent(membershipId)}&select=id,coach_id,student_id,paid_by,plan_name,amount,currency,status,gym_id,paid_to`)) || [])[0];
  if (!mb || mb.gym_id || mb.paid_to !== 'coach' || !mb.coach_id) return res.status(400).json({ error: 'Předplatné nenalezeno' });
  if (String(mb.status) !== 'pending') return res.status(400).json({ error: 'Předplatné už není k zaplacení' });
  const p = ((await _wsbGet(`profiles?id=eq.${encodeURIComponent(mb.coach_id)}&select=id,name,stripe_account,online_plans,account_suspended&limit=1`)) || [])[0];
  if (!p || !p.stripe_account) return res.status(400).json({ error: 'Kouč nemá nastavené platby kartou' });
  if (p.account_suspended) return res.status(400).json({ error: 'Účet kouče je pozastavený' });
  const acct = String(p.stripe_account).trim();
  if (!(await _assertAcctReady(acct, res))) return;
  let plans = []; try { plans = typeof p.online_plans === 'string' ? JSON.parse(p.online_plans) : (p.online_plans || []); } catch (e) {}
  const defCur = String(mb.currency || 'CZK').toUpperCase();
  const plan = (Array.isArray(plans) ? plans : []).find((x) => x && String(x.name || '') === String(mb.plan_name || '')
    && Number(x.price) === Number(mb.amount) && String(x.cur || defCur).toUpperCase() === defCur);
  if (!plan || !(Number(plan.price) > 0)) return res.status(400).json({ error: 'Předplatné neodpovídá aktuální nabídce kouče. Obnov jeho profil a zkus to znovu.' });

  const cur = String(plan.cur || defCur).toUpperCase();
  const unit = (cur === 'CZK') ? Math.round(Number(plan.price)) * 100 : Math.round(Number(plan.price) * 100);
  const pct = Math.round((await onlineRateFor(_wsbGet, mb.coach_id)) * 10000) / 100;   // procenta, 2 desetinná
  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';
  const meta = {
    mtl_payment_type: 'membership', mtl_online: '1', membership_id: mb.id,
    coach_id: String(mb.coach_id), student_id: String(mb.student_id || ''), gym_id: '',
    mtl_plan: String(plan.name || 'Online předplatné').slice(0, 120), mtl_currency: cur, mtl_income: 'main',
    paid_by: String(mb.paid_by || ''), coach_name: String(p.name || '').slice(0, 120),
  };
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price_data: { currency: cur.toLowerCase(), product_data: { name: `${String(plan.name || 'Online předplatné').slice(0, 100)} — ${String(p.name || 'Kouč').slice(0, 60)}` }, unit_amount: unit, recurring: { interval: 'month' } }, quantity: 1 }],
    subscription_data: { application_fee_percent: pct, metadata: meta },
    metadata: meta,
    success_url: `${proto}://${host}/?platba=ok&online_plan=1&coach=${encodeURIComponent(mb.coach_id)}&mb=${encodeURIComponent(mb.id)}&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${proto}://${host}/`,
  }, { stripeAccount: acct });
  res.redirect(303, session.url);
}
