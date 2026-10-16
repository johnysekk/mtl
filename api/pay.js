import Stripe from 'stripe';
import { resolveRate, effectiveRate, effectiveRateBreakdown, onlineRateFor, orgRate, nativePrice, nativeRate, STORE_COST, EP_TIERS, EP_TIER_ORDER, EP_TIER_NAMES, EP_YEAR_MONTHS, EP_DEFAULT_TIER, epTierKey, epTierOf, epCurrencyFor, epAmount, epRefDisc } from './_rate.js';
import { applyEpUpgrade, notifyEpDowngradeScheduled, finishEpYearly, notifyEpMonthlyScheduled, epScheduleMonthly } from './_ep.js';
import { sellKind, sellLabel, sellKindFor } from './_sell-kind.js';
import { checkPrice, offerPrices, planTermPrices, checkOnlineCountry } from './_price-check.js';
import { vatMode } from './_vat.js';
import { membCalendar, membModeMissing, membProrate, membActiveEnd, calTerm, calStart, calSubPlan } from './_memb-term.js';
import { viesCheck } from './tax-verify.js';
import { b2cSmallState } from './_oss.js';
import { ensurePmDomain } from './_pm-domain.js';
import { attDiscForPurchase, attProgress } from './_att-disc.js';
const _PC = (kind, extra) => ({ SB: _SUPA_URL, KEY: _SUPA_KEY, kind, ...extra });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ════════════════════════════════════════════════════════════════════════
// MTL — sloučený platební router (Vercel Hobby má limit serverless funkcí).
// Nahrazuje: checkout.js (coach) + gym-checkout.js + membership-checkout.js
// + partner-checkout.js. Větví se podle ?type=coach|gym|membership|partner.
// Každá větev je 1:1 přenesená logika z původního souboru — nic se nemění.
// ════════════════════════════════════════════════════════════════════════

const GYM_STUDENT_MARKUP = 1.00;  // no markup

const _SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, ''), _SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function _wsbGet(path){
  if(!_SUPA_URL || !_SUPA_KEY) return [];
  try{ const r = await fetch(_SUPA_URL.replace(/\/+$/,'') + '/rest/v1/' + path, { headers:{ apikey:_SUPA_KEY, Authorization:'Bearer '+_SUPA_KEY } }); return r.ok ? await r.json() : []; }catch(e){ return []; }
}
// PATCH, který vrátí, jestli se opravdu zapsal (aspoň jeden řádek). Pro zápisy, na kterých
// závisí peníze (přechod EP): když selže, nesmí se pokračovat ve Stripe.
async function _wsbPatchOk(path, body){
  if(!_SUPA_URL || !_SUPA_KEY) return false;
  try{ const r = await fetch(_SUPA_URL + '/rest/v1/' + path, { method:'PATCH', headers:{ apikey:_SUPA_KEY, Authorization:'Bearer '+_SUPA_KEY, 'Content-Type':'application/json', Prefer:'return=representation' }, body: JSON.stringify(body) });
    if(!r.ok){ console.error('wsbPatchOk', r.status, (await r.text()).slice(0,200)); return false; }
    const j = await r.json(); return Array.isArray(j) && j.length > 0; }catch(e){ console.error('wsbPatchOk', e.message); return false; }
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
// VÝŠE REFERRAL SLEVY SE POČÍTÁ NA SERVERU. Dřív přišla v adrese (refDisc) a server ji jen omezil
// na 0..50 %, takže kdo měl kredit, mohl si sám nastavit 50 % místo 10 / 20 %. Pravidlo z appky:
// 20 % u poskytovatele, kde student ještě nic nezaplatil, jinak 10 %.
async function _refDiscFor(studentId, scope) {
  try {
    const col = scope.gymId ? 'gym_id' : 'coach_id', id = scope.gymId || scope.coachId;
    if (!studentId || !id) return 0.10;
    const prior = await _wsbGet(`transactions?member_id=eq.${encodeURIComponent(studentId)}&${col}=eq.${encodeURIComponent(id)}&status=not.in.(refunded)&select=id&limit=1`);
    return (prior && prior.length) ? 0.10 : 0.20;
  } catch (e) { return 0.10; }
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
    if (type !== 'partner' && type !== 'partner_change' && type !== 'supplier' && type !== 'att_disc' && !(await _assertNotSuspended(req, res))) return;
    if (type === 'att_disc')   return await attDiscInfo(req, res);
    if (type === 'coach')      return await coachCheckout(req, res);
    if (type === 'gym')        return await gymCheckout(req, res);
    if (type === 'membership') return await membershipCheckout(req, res);
    if (type === 'partner')    return await partnerCheckout(req, res);
    if (type === 'partner_change') return await partnerChange(req, res);
    if (type === 'supplier')   return await supplierCheckout(req, res);
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
    coachProfileId, fmt, nomarkup, credit, studentId, disc, markup, refDisc, acq,
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
  // Server-side single source: ladder + acquisition via _rate.js (nothing from the URL).
  let COMMISSION;
  try {
    // Online koučing: vlastní sazba (1 / 0,75 / 0,5 %) a bez akvizice. Osobní lekce: žebříček + akvizice.
    COMMISSION = (String(online) === '1')
      ? await onlineRateFor(_wsbGet, coachProfileId)
      : await effectiveRate(_wsbGet, { ownerId: coachProfileId, mode: 'stripe', type: 'coach_1to1', acqSource: acq, memberId: studentId, scopeCol: 'coach_id', scopeId: coachProfileId });
  } catch (e) {
    // Sazba jen ze serveru. Dřív se při výpadku databáze vzala sazba z adresy (commission=),
    // kterou si kupující může přepsat -- platba radši nezačne.
    console.error('pay.coach effectiveRate failed:', e.message);
    return res.status(503).json({ error: 'Platbu teď nejde spustit (nepodařilo se ověřit sazbu). Zkus to prosím za chvíli.' });
  }
  let MK = 1.00; // no markup — student pays exactly the listed price
  let STUDENT_MARKUP = MK;
  const _credRow = (String(credit) === 'student') ? await verifyStudentCredit(studentId) : null;
  if (_credRow) {
    // Referral reward: MTL waives its whole fee; the provider funds the rest of the discount.
    // Only ever reached when the credit was VERIFIED against the DB above.
    const d = await _refDiscFor(studentId, { coachId: coachProfileId });   // 10 / 20 % ze serveru, ne z adresy
    STUDENT_MARKUP = Math.max(0, MK - d);
    COMMISSION = 0;
  } else if (String(nomarkup) === '1') {
    STUDENT_MARKUP = 1.00;
  }

  const isCZK = String(currency || 'CZK').toUpperCase() === 'CZK';
  const unitAmount     = isCZK ? Math.floor(rate * STUDENT_MARKUP) * 100 : Math.round(rate * STUDENT_MARKUP * 100);
  let applicationFee = Math.round(rate * COMMISSION * 100); // exact pct (was floored to whole CZK -> under-charged)

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';
  const isOnline = String(online) === '1';
  // Nákup v nativní appce (App Store / Google Play): cena s přirážkou na poplatek obchodu a MTL si
  // ten poplatek strhne navíc. Jen u online koučinku a jen u kouče, který to má zapnuté (_rate.js).
  const isNative = isOnline && String(req.query.native || '') === '1';
  const NP = (v) => (isNative ? nativePrice(v) : v);
  let _storeFee = 0;
  let _onlQty = 1;   // počet kusů balíčku online služby -- bere se z nabídky kouče, ne z adresy

  // OSOBNÍ SOUKROMKA: cena proti slotu / ceníku kouče / soukromým nabídkám.
  if (!isOnline) {
    const _pc = await checkPrice(_PC('coachPrivate', { strict: true, amount: rate, currency, coachProfileId, slotId, memberId: studentId }));
    if (!_pc.ok) return res.status(400).json({ error: _pc.error });
  }

  // CENA ONLINE KOUČINGU SE OVĚŘUJE PROTI PROFILU KOUČE. Dřív server vzal částku i měnu z adresy
  // tak, jak přišly, takže šlo zaplatit libovolnou částku. Povolené dvojice cena + měna: balíčky
  // (každý ve své měně; starší bez měny = měna online), rate_online a ceny po disciplínách v měně online.
  if (isOnline) {
    const p = ((await _wsbGet(`profiles?id=eq.${encodeURIComponent(String(coachProfileId || ''))}&select=online_services,rate_online,currency_online,currency,discipline_rates_online,stripe_account,online_native&limit=1`)) || [])[0];
    if (!p || String(p.stripe_account || '').trim() !== String(coachId).trim()) return res.status(400).json({ error: 'Kouč nenalezen' });
    if (isNative && p.online_native !== true) return res.status(400).json({ error: 'Tento kouč online koučink v mobilní aplikaci nenabízí.' });
    const defCur = String(p.currency_online || p.currency || 'CZK').toUpperCase();
    let tiers = []; try { const _src = p.online_services; tiers = typeof _src === 'string' ? JSON.parse(_src) : (_src || []); } catch (e) {}
    let dro = {}; try { dro = typeof p.discipline_rates_online === 'string' ? JSON.parse(p.discipline_rates_online) : (p.discipline_rates_online || {}); } catch (e) {}
    const okPairs = [];
    // Každý balíček může mít ruční ceny ve více měnách (prices) -- povolená je kterákoli z nich.
    (Array.isArray(tiers) ? tiers : []).forEach((t) => { const pm = offerPrices(t, defCur); Object.keys(pm).forEach((cu) => okPairs.push([NP(pm[cu]), cu])); });
    if (Number(p.rate_online) > 0) okPairs.push([NP(Number(p.rate_online)), defCur]);
    Object.values(dro || {}).forEach((v) => { if (Number(v) > 0) okPairs.push([NP(Number(v)), defCur]); });
    const C = String(currency || 'CZK').toUpperCase();
    if (!okPairs.some(([pr, cu]) => pr === rate && cu === C)) {
      return res.status(400).json({ error: 'Cena neodpovídá aktuální nabídce kouče. Obnov jeho profil a zkus to znovu.' });
    }
    const _tl = Array.isArray(tiers) ? tiers : [];
    const _tq = _tl.find((t) => t && NP(offerPrices(t, defCur)[C]) === rate && String(t.label || '') === String(fmt || ''))
             || _tl.find((t) => t && NP(offerPrices(t, defCur)[C]) === rate);
    _onlQty = Math.max(1, Math.min(50, parseInt(_tq && _tq.qty, 10) || 1));
    const _cc = await checkOnlineCountry({ SB: _SUPA_URL, KEY: _SUPA_KEY, coachId: coachProfileId, buyerId: payerId || studentId });
    if (!_cc.ok) return res.status(400).json({ error: _cc.error });
    // Náklad obchodu (10 % + 21 % DPH) z toho, co student opravdu platí, + provize ze zbytku.
    if (isNative) {
      _storeFee = Math.round(unitAmount * STORE_COST);
      applicationFee = Math.round(rate * 100 * COMMISSION * (1 - STORE_COST)) + _storeFee;
    }
  }

  let successUrl;
  if (isOnline) {
    successUrl = `${proto}://${host}/?platba=ok&online=1&coach=${encodeURIComponent(coachProfileId || '')}&amount=${rate}&currency=${currency}&fmt=${encodeURIComponent(fmt || '')}&qty=${_onlQty}&acct=${encodeURIComponent(coachId)}&session={CHECKOUT_SESSION_ID}`;
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
      online_qty: String(_onlQty),
      coach_name: coachName || '',
      discipline: disc || '',
      mtl_native: isNative ? '1' : '',
      mtl_store_fee: String(_storeFee),
    },
    line_items: [
      { price_data: { currency: cur, product_data: { name: productName }, unit_amount: unitAmount }, quantity: 1 },
    ],
    payment_intent_data: {
      ...(applicationFee > 0 ? { application_fee_amount: applicationFee } : {}),   // EP Kage: 0 %
      metadata: {
        credit_type: credit || 'none',
        mtl_credit_row: _credRow || '',      // set ONLY when server-verified; the webhook consumes it
        mtl_credit_user: _credRow ? String(studentId||'') : '',
        mtl_ref_pct: _credRow ? String(Math.round((MK - STUDENT_MARKUP) * 100)) : '0',
        mtl_list_amount: String(Math.round(rate * 100)),
        coach_pct: (STUDENT_MARKUP - COMMISSION).toFixed(2),
        commission_pct: COMMISSION.toFixed(2),
        coach_name: coachName || '',
        mtl_native: isNative ? '1' : '',
        mtl_store_fee: String(_storeFee),   // část application fee, která patří obchodu s aplikacemi
      },
    },
    ..._checkoutEnd(req, successUrl, `${proto}://${host}/`),
  }, { stripeAccount: coachId });

  return _sendCheckout(req, res, session, coachId);
}

// ───────────────────────── GYM drop-in (direct charge) ─────────────────────────
async function gymCheckout(req, res) {
  const {
    gymAccount, gymName, className, amount, currency = 'CZK', bookingId,
    income, memberName, payee, disc, level, guest, token, credit, refDisc,
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
  const MK   = 1.00;
  let STUDENT_MK = MK;
  // Server-side single source: ladder + acquisition via _rate.js. Merch/grace/guest are not drop-ins
  // so they never get the acquisition fee. Nothing from the URL.
  let TAKE;
  let _acqMonths = 0, _baseRate = null;
  try {
    const _txType = (String(merch) === '1') ? 'merch' : ((String(grace) === '1' || String(guest) === '1') ? 'other' : 'drop_in');
    const _brk = await effectiveRateBreakdown(_wsbGet, { gymAccount, mode: 'stripe', type: _txType, acqSource: acq, memberId: studentId, scopeCol: 'gym_id', scopeId: gymId, months: 1 });
    TAKE = _brk.rate; _acqMonths = _brk.acqMonths; _baseRate = _brk.baseRate;
  } catch (e) {
    // Sazba jen ze serveru (dřív záloha z adresy take=, kterou si kupující může přepsat).
    console.error('pay.gym effectiveRate failed:', e.message);
    return res.status(503).json({ error: 'Platbu teď nejde spustit (nepodařilo se ověřit sazbu). Zkus to prosím za chvíli.' });
  }
  const _credRow = (String(credit) === 'student') ? await verifyStudentCredit(studentId) : null;
  if (_credRow) {
    // Referral reward on a drop-in: MTL waives its whole fee; the gym/coach funds the rest.
    // Only ever reached when the credit was VERIFIED against the DB above.
    const d = await _refDiscFor(studentId, { gymId: gymId || null, coachId: coachId || null });   // 10 / 20 % ze serveru
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
        ...(applicationFee > 0 ? { application_fee_amount: applicationFee } : {}),   // EP Kage: 0 %
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
      ..._checkoutEnd(req, (String(merch)==='1')
        ? `${proto}://${host}/?merch_pay=ok&merchid=${encodeURIComponent(merchId || '')}&qty=${encodeURIComponent(qty || '1')}&variant=${encodeURIComponent(variant || '')}&gym=${encodeURIComponent(gymId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`
        : (String(grace)==='1')
        ? `${proto}://${host}/?grace_pay=ok&gracegym=${encodeURIComponent(gymId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`
        : (String(guest)==='1')
        ? `${proto}://${host}/?guest_drop=ok&booking=${encodeURIComponent(bookingId || '')}&acct=${encodeURIComponent(gymAccount)}&token=${encodeURIComponent(token || '')}&session={CHECKOUT_SESSION_ID}`
        : `${proto}://${host}/?gym_pay=ok&booking=${encodeURIComponent(bookingId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`,
        `${proto}://${host}/`),
    },
    { stripeAccount: gymAccount }
  );

  return _sendCheckout(req, res, session, gymAccount);
}

// ───────────────────────── GYM membership (direct charge subscription) ─────────────────────────
// ───────────────────────── EVENT TICKET (flat 6% = 3% markup + 3% cut, no partner discount) ─────────────────────────
async function eventCheckout(req, res) {
  const { gymAccount, eventTitle, tierName, amount, currency = 'CZK', ticketId, buyerName, buyerEmail, qty, qrToken, eventId, disc, gymId, payoutCoachId } = req.query;
  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });
  // ČÁSTKA A ÚČET ZE SERVERU, NE Z ADRESY. Dřív šla částka i sazba MTL do Stripe tak, jak je
  // poslal prohlížeč: upravený odkaz zaplatil za lístek 1 Kč nebo snížil provizi. Teď se
  // částka sečte z rezervovaných lístků objednávky a účet musí patřit pořadateli té akce.
  let P = parseInt(amount, 10);
  let _payOrg = null;   // organizace, které peníze za lístek jdou -- pak platí její sazba, ne žebříček
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
      if (_ev.organization_id) { const o = ((await _wsbGet(`organizations?id=eq.${encodeURIComponent(_ev.organization_id)}&select=stripe_account,kind`)) || [])[0] || {}; if (o.stripe_account) { _acc.add(o.stripe_account); if (String(o.stripe_account) === String(gymAccount)) _payOrg = o; } }
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
  // Akce ORGANIZACE: sazba organizace (svaz 0 %, pořadatel 1 %). Dřív sem padala do žebříčku,
  // ten účet organizace nenašel a vzala se sazba z adresy (typicky 2 % autora akce).
  let TAKE = NaN;
  if (_payOrg) TAKE = orgRate(_payOrg);
  else {
    try { TAKE = await resolveRate(_wsbGet, { gymAccount, mode: 'stripe' }); }
    catch (e) { console.error('pay.event rate resolve failed:', e.message); TAKE = NaN; }
    // Sazba jen ze serveru (0–30 %; EP Kage má 0 %). Dřív se při chybě vzala z adresy (take=).
    if (!(TAKE >= 0 && TAKE <= 0.30)) return res.status(503).json({ error: 'Platbu teď nejde spustit (nepodařilo se ověřit sazbu). Zkus to prosím za chvíli.' });
  }
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
        ...(fee > 0 ? { application_fee_amount: (fee * Q) } : {}),   // svaz: bez provize MTL
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
      ..._checkoutEnd(req, `${proto}://${host}/?event_pay=ok&ticket=${encodeURIComponent(ticketId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`, `${proto}://${host}/`),
    },
    { stripeAccount: gymAccount } // DIRECT CHARGE on the chosen payee account (gym or coach)
  );
  return _sendCheckout(req, res, session, gymAccount);
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
    membershipId, income, memberName, payee, disc, access, acq,
    gymId, studentId,
  } = req.query;

  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });

  const _once = String(_q0.once || '') === '1';
  const _moQ = Math.max(1, parseInt(months, 10) || 1);
  // KALENDÁŘNÍ MĚSÍC (režim klubu -- _memb-term.js). Cenu i konec počítá server: jednorázově =
  // období do posledního dne N-tého měsíce (první měsíc celý, nebo poměrně podle klubu),
  // předplatné = měsíční cena, první měsíc jednorázovou položkou a obnovy vždy 1.
  // _cal = { one: { price, endsOn } } nebo { sub: calSubPlan(...) }, jinak null.
  let _cal = null, _calChild = null;
  // CENA, POČET MĚSÍCŮ A KONEC MUSÍ PATŘIT K TOMUTÉŽ PLÁNU. Dřív šlo zaplatit měsíční cenu
  // s months=12 (nebo endsOn=2099-12-31) a webhook podle toho nastavil platnost.
  try {
    // select=*: sloupec memb_calendar dokud neproběhne sql/memb-calendar.sql neexistuje a výčet by shodil celý dotaz.
    const _g = ((await _wsbGet(`gyms?id=eq.${encodeURIComponent(_skGym || gymId || '')}&select=*`)) || [])[0] || {};
    let _pl = []; try { _pl = typeof _g.membership_plans === 'string' ? JSON.parse(_g.membership_plans) : (_g.membership_plans || []); } catch (e) {}
    if (!(Array.isArray(_pl) && _pl.length) && Number(_g.membership_price) > 0) _pl = [{ price: Number(_g.membership_price), months: 1 }];
    const _amt = parseInt(amount, 10), _mo = _moQ, _end = endsOn ? String(endsOn).slice(0, 10) : '';
    // Spolek bez vybraného režimu členství neprodává (Nastavení klubu → Ceny & členství).
    if (membModeMissing(_g)) return res.status(400).json({ error: 'Klub ještě nenastavil, jak členství počítá (kalendářní měsíc / měsíc od zaplacení). Do té doby ho nejde koupit.' });
    const _isCal = membCalendar(_g), _prorate = membProrate(_g);
    let _actEnd = null;
    if (_isCal) {
      try { if (membershipId) _calChild = (((await _wsbGet(`gym_memberships?id=eq.${encodeURIComponent(membershipId)}&select=child_name`)) || [])[0] || {}).child_name || null; } catch (e) {}
      _actEnd = await membActiveEnd(_wsbGet, { gymId: _skGym || gymId, studentId, childName: _calChild, excludeId: membershipId });
    }
    const _hit = (_pl || []).some((p) => {
      const pm = Math.max(1, parseInt(p && p.months, 10) || 1); if (pm !== _mo) return false;
      const full = Number(p && p.price) || 0; if (!(full > 0)) return false;
      // Kalendářní režim (plán bez pevného konce): předplatné za měsíční cenu, jednorázově
      // přesně to, co spočítá server. Při půlnoci na přelomu dne se může lišit -- pak obnovit.
      if (_isCal && !p.ends_on) {
        if (pm === 1 && !_once) { if (Math.abs(full - _amt) < 1) { _cal = { sub: calSubPlan(full, _actEnd, null, _prorate) }; return true; } return false; }
        const ct = calTerm(full, pm, calStart(_actEnd), _prorate);
        if (Math.abs(ct.price - _amt) < 1) { _cal = { one: ct }; return true; }
        return false;
      }
      if (_end && String((p && p.ends_on) || '').slice(0, 10) !== _end) return false;
      if (Math.abs(full - _amt) < 1) return true;
      if (pm > 1 && p.prorate) { for (let L = 1; L <= pm; L++) if (Math.abs(Math.round((full / pm) * L) - _amt) < 1) return true; }
      return false;
    });
    if (!_hit) return res.status(400).json({ error: 'Členství neodpovídá aktuální nabídce klubu. Obnov stránku a zkus to znovu.' });
  } catch (e) { return res.status(400).json({ error: 'Nepodařilo se ověřit nabídku klubu.' }); }
  // Platné členství sahá dál než do příštího měsíce: předplatné kartou zatím zapnout nejde.
  if (_cal && _cal.sub && _cal.sub.kind === 'later') {
    return res.status(400).json({ error: `Tvoje současné členství platí do ${_dmy(String(_cal.sub.activeEnd || '').slice(0, 10))}. Předplatné kartou, které na něj naváže, si můžeš zapnout od ${_dmy(_cal.sub.from)}.` });
  }
  // CENA A MĚNA PROTI CENÍKU ČLENSTVÍ KLUBU (membership_plans; kalendářní ceny umí taky).
  { const _pc = await checkPrice(_PC('gymMembership', { amount: parseInt(amount, 10), currency, gymId: _skGym || gymId, months: _moQ, studentId, childName: _calChild, excludeId: membershipId })); if (!_pc.ok) return res.status(400).json({ error: _pc.error }); }

  const P = (_cal && _cal.one) ? _cal.one.price : parseInt(amount, 10);
  const _endsOn = (_cal && _cal.one) ? _cal.one.endsOn : endsOn;
  // SLEVA ZA DOCHÁZKU (_att-disc.js): spočítá ji server sám, z adresy nic. Navazující období
  // po splněné docházce v předchozím. Jednorázově = nižší cena položky; předplatné = sleva na
  // první platbu (kupón na účtu klubu), nebo -- když první platba přijde až později (kotva na
  // konec platného členství) -- záporná položka na tu fakturu (zakládá webhook).
  let _att = null;
  try {
    // Člen JEN z řádku členství (ten zakládá appka za přihlášeného), ne z adresy -- jinak by si
    // kdokoli vzal slevu za cizí docházku. Řádek musí ještě čekat na platbu.
    const _mrA = membershipId ? (((await _wsbGet(`gym_memberships?id=eq.${encodeURIComponent(membershipId)}&select=student_id,child_name,gym_id,status`)) || [])[0] || null) : null;
    const _gA = (_mrA && _mrA.status === 'pending' && _mrA.gym_id) ? (((await _wsbGet(`gyms?id=eq.${encodeURIComponent(_mrA.gym_id)}&select=id,membership_plans,currency,schedule`)) || [])[0] || null) : null;
    const _r = _gA ? await attDiscForPurchase(_wsbGet, { gym: _gA, studentId: _mrA.student_id, childName: _mrA.child_name || null, newMonths: _moQ, price: P, excludeId: membershipId }) : null;
    if (_r && _r.ok && _r.amount > 0) _att = _r;
  } catch (e) { console.error('att disc', e.message); }
  const cur = String(currency).toLowerCase();
  const ivl = interval === 'year' ? 'year' : 'month';
  if (!(await _assertAcctReady(gymAccount, res))) return;
  // SAZBA JEN ZE SERVERU (_rate.js): žebříček / stupeň EP + akvizice, u delšího období rozložená
  // na měsíce, kterých se akvizice týká. Dřív přišla z adresy (fee=) a server ji jen hlídal
  // rozsahem 0,5–10 % -- kupující si ji tak mohl snížit a nulová sazba (EP Kage) by neprošla.
  // Když se sazbu nepodaří zjistit, platba nezačne (handler vrátí chybu) -- žádná náhradní sazba.
  const _brkM = await effectiveRateBreakdown(_wsbGet, {
    gymAccount, mode: 'stripe', type: 'membership', acqSource: acq,
    memberId: studentId, scopeCol: 'gym_id', scopeId: gymId, months: Math.max(1, parseInt(months, 10) || 1)
  });
  const FEE_NOW = _brkM.rate * 100;
  const _baseRateM = _brkM.baseRate;
  const FEE_PCT = _baseRateM * 100;                      // sazba po skončení akvizice
  const _acqMonthsM = _brkM.acqMonths || 0;
  // Předplatné je v akvizičním okně jen tehdy, když akvizice opravdu padla (první členství
  // u klubu, ne u Kage). Dřív stačilo acq=mtl_discovery v adrese.
  const _isAcq = (String(acq) === 'mtl_discovery' && ivl === 'month' && _acqMonthsM > 0);

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';

  // ── MULTI-MONTH MEMBERSHIP = ONE-TIME PAYMENT ────────────────────────────────────────────
  // Monthly plans (months = 1, the default) stay exactly as they were: a Stripe subscription
  // that renews. A 3/6/12-month plan is NOT a subscription — a club sells a term ("pololetni
  // kurzovne"), the member pays once, and the membership simply expires at the end. Renewing a
  // 6-month term automatically would be wrong (and a refund/dispute magnet).
  // Commission: charged ONCE on the whole amount (Petr's call), via application_fee_amount.
  const _months = _moQ;
  // Jednorázově i měsíc (once=1): klub nabízí „Měsíční (jednorázově)" -- bez předplatného.
  if (_months > 1 || _once) {
    const _D1 = _att ? Math.min(_att.amount, P) : 0;
    if (_att && membershipId) await _wsbPatch(`gym_memberships?id=eq.${encodeURIComponent(membershipId)}`, { att_disc: _D1, att_disc_from: _att.prevId, att_disc_for: _att.prevEnd, amount: P - _D1 });
    const _amtMinor = Math.round((P - _D1) * 100);
    const _feePct = FEE_NOW;
    const _feeMinor = Math.round(_amtMinor * (_feePct / 100));
    const _meta = {
      mtl_payment_type: 'membership',
      mtl_membership_kind: 'one_time',
      mtl_months: String(_months),
      ...(_endsOn ? { mtl_ends_on: String(_endsOn) } : {}),
      gym_id: gymId || '',
      student_id: studentId || '',
      membership_id: membershipId || '',
      mtl_plan: planName || 'Membership',
      mtl_access: access || '',
      mtl_income: income || 'side',
      gym_name: gymName || '',
      mtl_payee: payee || gymName || '',
      mtl_disc: disc || '',
      mtl_base: String(P - _D1),
      mtl_currency: cur,
      member_name: memberName || '',
      ...(_D1 ? { mtl_att_disc: String(_D1), mtl_att_info: _att.summary } : {}),
    };
    const _s1 = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        billing_address_collection: 'required',
        tax_id_collection: { enabled: true },
        metadata: _meta,
        line_items: [
          { price_data: { currency: cur, product_data: { name: `${_skLbl} · ${planName || _skLbl} (${_cal && _cal.one ? `do ${_dmy(_cal.one.endsOn)}` : `${_months} měs.`}) — ${gymName || ''}${_D1 ? ` · sleva za docházku −${_D1} ${cur === 'czk' ? 'Kč' : cur.toUpperCase()}` : ''}` }, unit_amount: _amtMinor }, quantity: 1 }
        ],
        payment_intent_data: {
          ...(_feeMinor > 0 ? { application_fee_amount: _feeMinor } : {}),
          metadata: _meta,
        },
        ..._checkoutEnd(req, `${proto}://${host}/?gym_sub=ok&membership=${encodeURIComponent(membershipId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`, `${proto}://${host}/`),
        // Se slevou za docházku platí platba jen 31 minut -- tak dlouho drží slevu jen tenhle řádek
        // (_att-disc.js ATT_HOLD_MIN), aby se nedala zaplatit dvakrát.
        ...(_D1 ? { expires_at: Math.floor(Date.now() / 1000) + 31 * 60 } : {}),
      },
      { stripeAccount: gymAccount }
    );
    return _sendCheckout(req, res, _s1, gymAccount);
  }

  // KALENDÁŘNÍ MĚSÍC U PŘEDPLATNÉHO: obnovy vždy 1. (billing_cycle_anchor). Tento měsíc (celý,
  // nebo jen zbývající dny, když to má klub zapnuté) je jednorázová položka na první faktuře, aby
  // částka přesně seděla s tím, co appka ukázala. Provize (application_fee_percent) se počítá
  // z celé faktury, tedy i z té položky. Kdo má platné členství do konce měsíce, teď neplatí nic
  // a první platba přijde 1. dne, kdy navazuje (calSubPlan v _memb-term.js).
  const _cs = _cal && _cal.sub;
  const _subLines = [
    { price_data: { currency: cur, product_data: { name: `${_skLbl} · ${planName || _skLbl} — ${gymName || 'MTL Gym'}` }, unit_amount: Math.round(P * 100), recurring: { interval: ivl } }, quantity: 1 },
  ];
  const _subTiming = {};
  if (_cs && _cs.kind === 'first') {
    _subLines.push({ price_data: { currency: cur, product_data: { name: `${_skLbl} · ${planName || _skLbl} — ${_cs.partial ? 'zbytek měsíce' : 'tento měsíc'} (do ${_dmy(_cs.endsOn)})` }, unit_amount: Math.round(_cs.chargeNow * 100) }, quantity: 1 });
    Object.assign(_subTiming, { billing_cycle_anchor: _cs.anchor, proration_behavior: 'none' });
  } else if (_cs && _cs.kind === 'anchor') {
    Object.assign(_subTiming, { billing_cycle_anchor: _cs.anchor, proration_behavior: 'none' });
  }
  const _subMeta = (_cs && _cs.kind !== 'plain') ? { mtl_calendar: '1' } : {};
  // Sleva za docházku u předplatného: na první platbu. Strhává-li se hned (běžně nebo zbytek
  // měsíce), kupón „jednou"; když první platba přijde až s kotvou, položku přidá webhook.
  let _attMeta = {}, _discounts = null;
  if (_att) {
    const _firstNow = (_cs && _cs.kind === 'first') ? _cs.chargeNow : ((_cs && _cs.kind === 'anchor') ? 0 : P);
    const _D2 = Math.min(_att.amount, _firstNow > 0 ? _firstNow : P);
    if (_D2 > 0) {
      if (_firstNow > 0) {
        const _cp = await stripe.coupons.create({ amount_off: Math.round(_D2 * 100), currency: cur, duration: 'once', max_redemptions: 1, name: 'Sleva za docházku' }, { stripeAccount: gymAccount });
        _discounts = [{ coupon: _cp.id }];
      }
      _attMeta = { mtl_att_disc: String(_D2), mtl_att_info: _att.summary, mtl_att_mode: _firstNow > 0 ? 'coupon' : 'next' };
      if (membershipId) await _wsbPatch(`gym_memberships?id=eq.${encodeURIComponent(membershipId)}`, { att_disc: _D2, att_disc_from: _att.prevId, att_disc_for: _att.prevEnd });
    }
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
        ..._attMeta,
      },
      line_items: _subLines,
      ...(_discounts ? { discounts: _discounts } : {}),
      ...(_attMeta.mtl_att_disc ? { expires_at: Math.floor(Date.now() / 1000) + 31 * 60 } : {}),
      subscription_data: {
        application_fee_percent: FEE_NOW,
        ..._subTiming,
        metadata: {
          ..._subMeta,
          // mtl_acq   = this membership is inside the MTL acquisition window
          // mtl_acq_pct  = the acquisition rate for THIS provider (10, or by EP tier)
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
        },
      },
      ..._checkoutEnd(req, `${proto}://${host}/?gym_sub=ok&membership=${encodeURIComponent(membershipId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`, `${proto}://${host}/`),
    },
    { stripeAccount: gymAccount }
  );
  return _sendCheckout(req, res, session, gymAccount);
}
// SLEVA ZA DOCHÁZKU -- co appka ukáže (_att-disc.js; cenu stejně počítá server při platbě).
// GET ?type=att_disc&gymId=&months=[&child=][&member=]  -> sleva na navazující období
// GET ?type=att_disc&membershipId=&progress=1            -> průběh v běžícím období
// Za sebe (a za účet, za který platí -- paid_by), nebo za člena klubu, když se ptá majitel / tým.
async function attDiscInfo(req, res) {
  const user = await _authUser(req);
  if (!user) return res.status(401).json({ error: 'Přihlášení vypršelo.' });
  const q0 = req.query || {};
  const staffOf = async (gymId) => {
    const g = ((await _wsbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id`)) || [])[0];
    if (g && g.owner_id === user.id) return true;
    const t = (await _wsbGet(`gym_coaches?gym_id=eq.${encodeURIComponent(gymId)}&coach_id=eq.${encodeURIComponent(user.id)}&status=eq.active&select=coach_id&limit=1`)) || [];
    return t.length > 0;
  };
  if (String(q0.progress || '') === '1') {
    const row = ((await _wsbGet(`gym_memberships?id=eq.${encodeURIComponent(String(q0.membershipId || ''))}&select=*`)) || [])[0];
    if (!row || !row.gym_id) return res.status(404).json({ error: 'not found' });
    if (row.student_id !== user.id && row.paid_by !== user.id && !(await staffOf(row.gym_id))) return res.status(403).json({ error: 'forbidden' });
    const g = ((await _wsbGet(`gyms?id=eq.${encodeURIComponent(row.gym_id)}&select=id,membership_plans,currency,schedule`)) || [])[0];
    const pr = g ? await attProgress(_wsbGet, { gym: g, row }) : null;
    const next = (row.att_eval_for && row.period_end && Date.parse(row.att_eval_for) === Date.parse(row.period_end)) ? (Number(row.att_disc_next) || 0) : null;
    return res.status(200).json({ ok: true, progress: pr, next, currency: row.currency || (g && g.currency) || 'CZK' });
  }
  const gymId = String(q0.gymId || '');
  const member = String(q0.member || '') || user.id;
  if (member !== user.id && !(await staffOf(gymId))) {
    // Zástupce platící za mladistvého: u klubu už za něj aspoň jednou platil (paid_by).
    const pb = (await _wsbGet(`gym_memberships?gym_id=eq.${encodeURIComponent(gymId)}&student_id=eq.${encodeURIComponent(member)}&paid_by=eq.${encodeURIComponent(user.id)}&select=id&limit=1`)) || [];
    if (!pb.length) return res.status(403).json({ error: 'forbidden' });
  }
  const g = ((await _wsbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=id,membership_plans,currency,schedule`)) || [])[0];
  if (!g) return res.status(404).json({ error: 'gym not found' });
  const r = await attDiscForPurchase(_wsbGet, { gym: g, studentId: member, childName: q0.child ? String(q0.child) : null,
    newMonths: q0.months, price: Number(q0.price) || 0, excludeId: q0.excludeId ? String(q0.excludeId) : null });
  return res.status(200).json({ ok: true, disc: r ? { ok: r.ok, amount: r.amount, would: r.would, visits: r.visits, absences: r.absences, needVisits: r.needVisits, allowAbs: r.allowAbs, summary: r.summary, prevId: r.prevId, prevEnd: r.prevEnd, plan: r.plan } : null, currency: g.currency || 'CZK' });
}
// 2026-09-30 -> 30. 9. 2026 (do názvu položky ve Stripe).
function _dmy(ymd) { const [y, m, d] = String(ymd || '').slice(0, 10).split('-').map(Number); return (y && m && d) ? `${d}. ${m}. ${y}` : String(ymd || ''); }

// ───────────────────────── Exclusive MTL Partner (předplatné na účtu MTL) ─────────────────────────
// CENA JE JEN TADY, z ceníku EP_TIERS v _rate.js. Z appky přijde jen stupeň, měsíc/rok a na koho
// je faktura. Ceny bez DPH, v Kč pro odběratele z Česka, v EUR pro ostatní (podle země toho, na
// koho jde faktura). Běžící předplatné si měnu drží. Roční = EP_YEAR_MONTHS měsíců.
// ZAKLÁDAJÍCÍ CENA je u stupně (Chūnin 10 míst, Kage 5). Místo drží každý, kdo má stupeň
// v profiles.ep_founding -- i když mezitím přešel na jiný stupeň; uvolní ho až úplné zrušení EP.
// Kdo už ji u stupně má, dostane ji znovu i po vyčerpání míst.
async function _epFoundingTaken(tier) {
  try {
    const r = await fetch(`${_SUPA_URL}/rest/v1/profiles?select=id&limit=1&ep_founding=cs.%7B${encodeURIComponent(tier)}%7D`, {
      headers: { apikey: _SUPA_KEY, Authorization: `Bearer ${_SUPA_KEY}`, Prefer: 'count=exact' },
    });
    if (!r.ok) return Infinity;            // nevíme -> zakládající cenu neslibujeme
    return Number(String(r.headers.get('content-range') || '').split('/')[1]) || 0;
  } catch (e) { return Infinity; }
}
// prof potřebuje ep_founding, coach_ref_score a bankai_eligible (sleva Shikai/Bankai, _rate.js).
async function epPriceFor(tier, prof, currency) {
  const T = EP_TIERS[tier], cur = String(currency || 'CZK').toUpperCase();
  const has = Array.isArray(prof && prof.ep_founding) && prof.ep_founding.indexOf(tier) >= 0;
  const founding = !!T.founding && (has || (await _epFoundingTaken(tier)) < T.foundingSpots);
  const disc = epRefDisc(prof);
  return { currency: cur.toLowerCase(), amount: epAmount(tier, cur, founding, disc), founding, disc };
}
// Přihlášený uživatel z tokenu (Authorization: Bearer). EP se kupuje a mění jen za sebe.
async function _authUser(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok || !_SUPA_URL || !_SUPA_KEY) return null;
  try {
    const r = await fetch(`${_SUPA_URL}/auth/v1/user`, { headers: { apikey: _SUPA_KEY, Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    const u = await r.json();
    return (u && u.id) ? u : null;
  } catch (e) { return null; }
}
// Běží předplatné EP? (aktivní, zkušební, nebo čeká na zaplacení obnovy)
async function _epLiveSub(subId) {
  if (!subId) return null;
  try {
    const sub = await stripe.subscriptions.retrieve(String(subId));
    return (['active', 'trialing', 'past_due'].indexOf(sub.status) >= 0) ? sub : null;
  } catch (e) { return null; }
}

// DIČ ZAHRANIČNÍHO ODBĚRATELE MUSÍ BÝT PLATNÉ VE VIES, ne jen vyplněné. Přenesení daně smíme
// použít, jen když máme platnost ověřenou (čl. 18 odst. 1 písm. a) nařízení 282/2011) -- a
// musíme to umět doložit. Proto se ukládá, KTERÉ DIČ a KDY prošlo, a číslo konzultace VIES
// (vat_vies_ref, když má MTL DIČ). Při výpadku VIES projde jen DIČ, které už jednou ověřené je.
// Vrací null (projde) nebo důvod pro návrat do appky: need_vat (nad limitem bez DIČ) | vat_invalid.
// BEZ DIČ: spotřebitel. Pod limitem 10 000 EUR (_oss.js) se smí prodat -- faktura půjde bez DPH
// s místem plnění v ČR. Nad limitem (OSS) až s DIČ. Výpadek VIES nebrání: režim rozhodne
// faktura (ep-doklad ověřuje znovu), a když DIČ neprojde, bere se jako bez DIČ.
async function _foreignVatGate(table, id, rec, home, mtlDic) {
  const vat = String(rec.vat_id || '').replace(/\s+/g, '').toUpperCase();
  if (!vat) { let st = null; try { st = await b2cSmallState(_wsbGet); } catch (e) {} return (st && st.fits(0)) ? null : 'need_vat'; }
  const bc = String(rec.billing_country || rec.country_code || rec.country || '').toUpperCase();
  const v = await viesCheck(vat, bc, mtlDic);
  if (!v.ok) return null;
  if (!v.valid) return 'vat_invalid';
  await _wsbPatch(`${table}?id=eq.${encodeURIComponent(id)}`, { vat_verified_id: vat, vat_verified_at: new Date().toISOString(), vat_vies_ref: v.ref || null });
  return null;
}

// ───────────────────────── VLOŽENÝ CHECKOUT (všechny platby kartou z appky) ─────────────────────────
// S ?embed=1 se platba neotevírá na stránce Stripe, ale uvnitř MTL (Stripe Embedded Checkout,
// ui_mode 'embedded'): EP, dodavatel i všechny platby studentů poskytovatelům. Server vrací JSON
// místo přesměrování: { clientSecret, publishableKey, stripeAccount } -- stripeAccount u přímých
// plateb na účet klubu / kouče (direct charge), Stripe.js se s ním musí inicializovat. Když platba
// nemůže začít (DIČ, už aktivní), { redirect } se stejnou adresou, kam by šel redirect. Bez
// publishable key se založí klasická stránka Stripe a vrátí se { url }.
// Bez embed=1 vše jako dřív (přesměrování) -- tak to jede z QR na recepci, který se skenuje mobilem.
function _isEmbed(req) { return String(req.query.embed || '') === '1'; }
function _checkoutEnd(req, okUrl, cancelUrl) {
  return (_isEmbed(req) && process.env.STRIPE_PUBLISHABLE_KEY)
    ? { ui_mode: 'embedded', return_url: okUrl }
    : { success_url: okUrl, cancel_url: cancelUrl };
}
async function _sendCheckout(req, res, session, stripeAccount) {
  if (session.ui_mode === 'embedded') {
    await ensurePmDomain(stripe, req.headers.host, stripeAccount);   // Apple Pay / Google Pay ve vloženém formuláři
    return res.status(200).json({ clientSecret: session.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, stripeAccount: stripeAccount || null });
  }
  if (_isEmbed(req)) return res.status(200).json({ url: session.url });
  return res.redirect(303, session.url);
}
function _goBack(req, res, url) {
  if (_isEmbed(req)) return res.status(200).json({ redirect: url });
  return res.redirect(303, url);
}

async function partnerCheckout(req, res) {
  // Kupuje se jen za sebe: uživatel z přihlášení, ne z adresy.
  const user = await _authUser(req);
  if (!user) return res.status(401).json({ error: 'Přihlášení vypršelo. Přihlas se znovu a zkus to ještě jednou.' });
  const userId = user.id;
  // Stupeň z appky; starší appka ho neposílá -> Chūnin (dosavadní EP).
  const tier = epTierKey(String(req.query.tier || '')) || EP_DEFAULT_TIER;

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';

  const prof = (await _wsbGet(`profiles?id=eq.${encodeURIComponent(userId)}&select=partner_sub,ep_founding,coach_ref_score,bankai_eligible,stripe_account,gym_payout_account,country`))[0] || {};
  // UŽ BĚŽÍCÍ EP: stupeň se mění přechodem (type=partner_change), druhé předplatné by platil dvakrát.
  if (await _epLiveSub(prof.partner_sub)) return _goBack(req, res, `${proto}://${host}/?partner_sub=already`);

  // NA KOHO SE FAKTURUJE. EP si kupuje člověk, ale platit ho může jeho klub (spolek / s.r.o.)
  // nebo on sám jako kouč (IČO). Volba z appky: bill=coach | bill=gym:<id>. Klub musí patřit
  // kupujícímu. Volba jede v metadatech předplatného, takže každá faktura (i obnovy) jde na
  // stejný subjekt -- ep-doklad ji dostane přes webhook.
  let billGym = null, billCC = '';
  { const _b = String(req.query.bill || '');
    if (_b.indexOf('gym:') === 0) {
      const g = (await _wsbGet(`gyms?id=eq.${encodeURIComponent(_b.slice(4))}&owner_id=eq.${encodeURIComponent(userId)}&select=id,billing_country`))[0];
      if (!g) return res.status(403).json({ error: 'Tenhle klub ti nepatří' });
      billGym = g.id; billCC = g.billing_country || '';
    } else {
      billCC = ((await _wsbGet(`profiles?id=eq.${encodeURIComponent(userId)}&select=billing_country`))[0] || {}).billing_country || '';
    } }
  // MĚNA podle země toho, na koho jde faktura (Česko Kč, jinak EUR) -- stejně jako v appce.
  const epCur = epCurrencyFor(billCC);

  // Země připojeného účtu Stripe (pro DIČ bránu níž a metadata), náhradou země z profilu.
  let cc = '';
  try {
    let acct = prof.stripe_account || prof.gym_payout_account || '';
    if(!acct){ const g=(await _wsbGet(`gyms?owner_id=eq.${encodeURIComponent(userId)}&select=stripe_account&limit=1`))[0]; if(g) acct=g.stripe_account||''; }
    if(acct){
      try{ const a=await stripe.accounts.retrieve(String(acct)); cc=String(a.country||'').toUpperCase(); }catch(e){}
      if(cc){ _wsbPatch(`profiles?id=eq.${encodeURIComponent(userId)}`, { stripe_country: cc }); }
    }
    if(!cc) cc = String(prof.country || '').toUpperCase();
  } catch(e){}
  const price = await epPriceFor(tier, prof, epCur);

  // ZAHRANIČNÍ ODBĚRATEL Z EU. S platným DIČ (VIES) = přenesení daňové povinnosti. Bez DIČ jen
  // dokud MTL nepřekročí limit 10 000 EUR pro přeshraniční elektronické služby (_oss.js), pak
  // DIČ chceme. Rozhoduje _foreignVatGate.
  try {
    const _ps = (await _wsbGet('platform_settings?id=eq.1&select=require_vat_foreign,home_country,dic'))[0] || {};
    if (_ps.require_vat_foreign) {
      const EU = ['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT',
                  'LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
      const home = String(_ps.home_country || 'CZ').toUpperCase();
      // DIČ a země toho, KDO platí: klub, nebo kouč sám.
      const p2 = billGym
        ? ((await _wsbGet(`gyms?id=eq.${encodeURIComponent(billGym)}&select=vat_id,billing_country,country,vat_verified_id`))[0] || {})
        : ((await _wsbGet(`profiles?id=eq.${encodeURIComponent(userId)}&select=vat_id,billing_country,country_code,vat_verified_id`))[0] || {});
      const bc = String(p2.billing_country || p2.country_code || p2.country || cc || home).toUpperCase();
      const euForeign = bc && bc !== home && EU.indexOf(bc) >= 0 && EU.indexOf(home) >= 0;
      if (euForeign) {
        const _why = await _foreignVatGate(billGym ? 'gyms' : 'profiles', billGym || userId, Object.assign({}, p2, { billing_country: bc }), home, _ps.dic);
        if (_why) return _goBack(req, res, `${proto}://${host}/?partner_sub=${_why}`);
      }
    }
  } catch (e) { console.error('[ep] vat gate', e.message); }
  // Test mode bills EP daily instead of monthly, so the whole loop -- charge, Stripe invoice,
  // e-mail, renewal -- can be seen the next morning rather than in a month.
  let _epDaily = false;
  try { const { isTestMode } = await import('./_config.js'); _epDaily = await isTestMode(); } catch (e) {}
  // Roční EP (volba z appky; cena = EP_YEAR_MONTHS × měsíční, počítá server).
  const _epYear = String(req.query.interval || '') === 'year';
  const _epInterval = _epDaily ? 'day' : (_epYear ? 'year' : 'month');
  const _epAmount = _epYear ? price.amount * EP_YEAR_MONTHS : price.amount;
  const md = { mtl_payment_type: 'partner_sub', user_id: userId, ep_tier: tier, ep_founding: price.founding ? '1' : '',
    ep_country: cc || '', ep_currency: price.currency, ep_amount: String(_epAmount), ep_month: String(price.amount),
    ep_interval: _epYear ? 'year' : 'month', ep_bill_gym: billGym || '', ep_ref_disc: price.disc ? String(price.disc) : '' };

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    // BEZ DIČ A ADRESY NA STRIPE. Fakturační údaje (název, IČO, DIČ, sídlo) má MTL u účtu,
    // fakturu z nich dělá ep-doklad a DIČ u zahraničních hlídá brána výš (require_vat_foreign).
    // required:'if_supported' chtělo DIČ povinně -- český neplátce DPH tak nemohl zaplatit.
    billing_address_collection: 'auto',
    client_reference_id: userId,
    ...(user.email ? { customer_email: user.email } : {}),
    line_items: [
      { price_data: { currency: price.currency, product_data: { name: 'Exclusive MTL Partner' }, unit_amount: Math.round(_epAmount*100), recurring: { interval: _epInterval } }, quantity: 1 },
    ],
    subscription_data: { metadata: md },
    metadata: md,
    ..._checkoutEnd(req, `${proto}://${host}/?partner_sub=ok&session={CHECKOUT_SESSION_ID}`, `${proto}://${host}/`),
  }, { apiVersion: '2024-09-30.acacia' });

  return _sendCheckout(req, res, session);
}

// ───────────────────────── PŘECHOD MEZI STUPNI EP ─────────────────────────
// POST /api/pay?type=partner_change&tier=<stupeň>  |  &cancel_downgrade=1
// NAHORU platí hned: Stripe dopočítá rozdíl za zbytek zaplaceného období a strhne ho z karty
// u předplatného (faktura za přechod -> doklad ep-doklad). Když banka chce platbu potvrdit,
// vrátí se clientSecret a appka ji potvrdí přes Stripe.js; stupeň pak zapíše webhook.
// DOLŮ platí od konce zaplaceného období (u ročního od konce roku): cena předplatného se
// přepne hned bez doplatku a vratky, takže příští obnova už je za nižší stupeň; stupeň a sazby
// se změní až se zaplacením té obnovy (webhook). Do té doby jde přechod zrušit.
// MĚSÍČNÍ <-> ROČNÍ PLATBA (&interval=year | &interval=month | &cancel_interval=1), stupeň zůstává:
//   * na roční HNED: nové roční období začíná dnes, nevyčerpané celé dny měsíce se odečtou
//     (Stripe: billing_cycle_anchor now + always_invoice) -- faktura za přechod jako u stupně;
//   * na měsíční OD KONCE ZAPLACENÉHO ROKU: plán předplatného (subscription schedule) se dvěma
//     fázemi -- do konce roku roční cena, pak měsíční. Do té doby jde přechod zrušit (plán se uvolní).
// Změna stupně a změna intervalu se nepotkají: dokud čeká jedna, druhá nejde (jinak by plán
// a přechod dolů přepisovaly cenu jeden druhému).
// Ručně udělené EP (bez předplatného) se tudy nemění -- to řeší founder v Adminu.
async function partnerChange(req, res) {
  const _preview = String(req.query.preview || '') === '1';   // jen spočítat doplatky, nic neměnit (GET)
  if (req.method !== 'POST' && !_preview) return res.status(405).json({ error: 'POST' });
  const user = await _authUser(req);
  if (!user) return res.status(401).json({ error: 'Přihlášení vypršelo. Přihlas se znovu a zkus to ještě jednou.' });
  const uid = user.id;
  const prof = (await _wsbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=partner,partner_tier,partner_tier_next,partner_tier_from,partner_sub,partner_price,ep_founding,coach_ref_score,bankai_eligible`))[0] || {};
  const cur = epTierOf(prof);
  const sub = cur ? await _epLiveSub(prof.partner_sub) : null;
  if (!sub) return res.status(409).json({ error: 'Stupeň jde měnit jen u placeného předplatného Exclusive Partner.' });
  if (sub.cancel_at_period_end) return res.status(409).json({ error: 'Předplatné je zrušené ke konci období. Nejdřív ho obnov, pak stupeň změníš.' });
  if (sub.status === 'past_due') return res.status(409).json({ error: 'Poslední platba předplatného neprošla. Až se zaplatí, stupeň změníš.' });
  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item || !item.price || !item.price.recurring) return res.status(409).json({ error: 'Předplatné nemá položku k úpravě.' });
  const product = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
  const rec = { interval: item.price.recurring.interval, interval_count: item.price.recurring.interval_count || 1 };
  const baseMd = Object.assign({}, sub.metadata || {});
  const subCur = String(item.price.currency || 'czk').toUpperCase();   // předplatné si měnu drží
  // Roční podle předplatného samotného; testovací režim strhává denně, tam rozhoduje volba z nákupu.
  const yearly = rec.interval === 'year' || (rec.interval === 'day' && baseMd.ep_interval === 'year');
  const amountOf = (monthCzk) => Math.round((yearly ? monthCzk * EP_YEAR_MONTHS : monthCzk) * 100);
  const priceData = (unit) => ({ currency: item.price.currency, product, unit_amount: unit, recurring: rec });
  const pendingDown = !!epTierKey(prof.partner_tier_next);
  // Částka, kterou předplatné stálo před naplánovaným přechodem dolů -- vrací se přesně ta.
  // Bez čekajícího přechodu je to prostě dnešní cena položky.
  const prevUnit = !pendingDown ? item.price.unit_amount : Number(baseMd.ep_prev_amount) > 0 ? Number(baseMd.ep_prev_amount) : amountOf(Number(prof.partner_price) > 0 ? Number(prof.partner_price) : (await epPriceFor(cur, prof, subCur)).amount);
  const pfx = `profiles?id=eq.${encodeURIComponent(uid)}&partner_sub=eq.${encodeURIComponent(sub.id)}`;
  const clearDown = { ep_tier_next: '', ep_month_next: '', ep_founding_next: '', ep_prev_amount: '' };

  // DOPLATEK PO CELÝCH DNECH. Stripe sám počítá zbytek období po sekundách; proto se mu předá
  // proration_date = začátek dnešního dne předplatného (dny se počítají od hodiny, kdy předplatné
  // začalo). Doplatek je pak rozdíl cen × zbývající celé dny ÷ dny období, dnešek celý za novou cenu.
  const ps = sub.current_period_start || item.current_period_start, pe = sub.current_period_end || item.current_period_end;
  const prorDate = ps + Math.floor(Math.max(0, Math.floor(Date.now() / 1000) - ps) / 86400) * 86400;
  const frac = (pe > ps) ? Math.max(0, Math.min(1, (pe - prorDate) / (pe - ps))) : 0;   // zbývající část období po celých dnech
  const peIso = new Date(pe * 1000).toISOString();

  // NAPLÁNOVANÝ PŘECHOD NA MĚSÍČNÍ PLATBU = plán předplatného, který založila tahle cesta.
  let sched = null;
  if (sub.schedule) {
    try { sched = typeof sub.schedule === 'string' ? await stripe.subscriptionSchedules.retrieve(sub.schedule) : sub.schedule; } catch (e) { console.error('[ep] schedule', e.message); }
  }
  const pendingMonthly = !!(sched && (sched.metadata || {}).ep_switch === 'month' && ['active', 'not_started'].indexOf(sched.status) >= 0);
  // Ceny pro přechod mezi intervaly ze dnešní ceny předplatného (drží zakládající i starší ceník).
  const yearUnit = item.price.unit_amount * EP_YEAR_MONTHS;
  const monthUnit = Math.round(item.price.unit_amount / EP_YEAR_MONTHS);

  // NÁHLED DOPLATKŮ pro tlačítka „Přejít hned" -- stejný výpočet jako Stripe, bez volání Stripe.
  // Plus interval: měsíční -> kolik se strhne za přechod na roční; roční -> měsíční cena po roce.
  if (_preview) {
    const out = [];
    for (const t of EP_TIER_ORDER.slice(EP_TIER_ORDER.indexOf(cur) + 1)) {
      const pr = await epPriceFor(t, prof, subCur);
      out.push({ tier: t, month: pr.amount, founding: pr.founding, due: Math.max(0, Math.round((amountOf(pr.amount) - prevUnit) * frac)) / 100 });
    }
    return res.status(200).json({ ok: true, tier: cur, currency: subCur, upgrades: out,
      interval: yearly ? 'year' : 'month', interval_next: pendingMonthly ? 'month' : null, period_end: peIso,
      ...(yearly ? { month_amount: monthUnit / 100 }
        : { year_amount: yearUnit / 100, year_due: Math.max(0, yearUnit - Math.round(item.price.unit_amount * frac)) / 100 }) });
  }

  const ivWant = String(req.query.interval || '');
  if (ivWant === 'year' || ivWant === 'month' || String(req.query.cancel_interval || '') === '1') {
    return partnerInterval(req, res, { uid, cur, sub, item, sched, pendingMonthly, pendingDown, yearly, rec, product, prorDate, peIso, yearUnit, monthUnit, subCur, ivWant });
  }
  if (pendingMonthly) return res.status(409).json({ error: `Máš naplánovaný přechod na měsíční platbu od ${new Date(pe * 1000).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' })}. Stupeň změníš, až ho zrušíš nebo až proběhne.` });

  // ZRUŠENÍ NAPLÁNOVANÉHO PŘECHODU DOLŮ: cena předplatného zpět, bez doplatku.
  if (String(req.query.cancel_downgrade || '') === '1') {
    if (pendingDown) {
      await stripe.subscriptions.update(sub.id, { items: [{ id: item.id, price_data: priceData(prevUnit) }], proration_behavior: 'none', metadata: clearDown });
      await _wsbPatchOk(pfx, { partner_tier_next: null, partner_tier_from: null });
    }
    return res.status(200).json({ ok: true, tier: cur, next: null });
  }

  const want = epTierKey(String(req.query.tier || ''));
  if (!want) return res.status(400).json({ error: 'Neznámý stupeň.' });
  if (want === cur) return res.status(400).json({ error: 'Tenhle stupeň už máš.' });
  const price = await epPriceFor(want, prof, subCur);
  const up = EP_TIER_ORDER.indexOf(want) > EP_TIER_ORDER.indexOf(cur);

  if (!up) {
    // DOLŮ od konce období. Nejdřív databáze (kdyby zápis selhal, cena se nemění), pak Stripe.
    // Zakládající místo nižšího stupně se zapíše až s přechodem (webhook), ne teď -- jinak by šlo
    // místo zabrat naplánováním a zrušením přechodu.
    const atIso = new Date(sub.current_period_end * 1000).toISOString();
    if (!(await _wsbPatchOk(pfx, { partner_tier_next: want, partner_tier_from: atIso }))) return res.status(500).json({ error: 'Přechod se nepodařilo uložit, zkus to znovu.' });
    try {
      await stripe.subscriptions.update(sub.id, { items: [{ id: item.id, price_data: priceData(amountOf(price.amount)) }], proration_behavior: 'none',
        metadata: { ep_tier: cur, ep_tier_next: want, ep_month_next: String(price.amount), ep_founding_next: price.founding ? '1' : '',
          ep_prev_amount: String(pendingDown ? prevUnit : item.price.unit_amount) } });
    } catch (e) {
      await _wsbPatchOk(pfx, { partner_tier_next: pendingDown ? prof.partner_tier_next : null, partner_tier_from: pendingDown ? prof.partner_tier_from : null });
      console.error('[ep] downgrade', e.message);
      return res.status(502).json({ error: 'Přechod se nepodařil: ' + e.message });
    }
    await notifyEpDowngradeScheduled(uid, cur, want, atIso);
    return res.status(200).json({ ok: true, tier: cur, next: want, from: atIso, month: price.amount });
  }

  // NAHORU. Čekal-li přechod dolů, cena předplatného už je snížená -- nejdřív zpět, jinak by
  // Stripe za zbytek období odečetl nižší částku, než člověk zaplatil.
  if (pendingDown) {
    await stripe.subscriptions.update(sub.id, { items: [{ id: item.id, price_data: priceData(prevUnit) }], proration_behavior: 'none', metadata: clearDown });
    await _wsbPatchOk(pfx, { partner_tier_next: null, partner_tier_from: null });
  }
  // Co se zapíše po zaplacení rozdílu (webhook to čte z metadat předplatného).
  const clearPending = { ep_tier_pending: '', ep_month_pending: '', ep_founding_pending: '' };
  await stripe.subscriptions.update(sub.id, { metadata: { ep_tier_pending: want, ep_month_pending: String(price.amount), ep_founding_pending: price.founding ? '1' : '' } });
  let upd;
  try {
    // Čekající změna (pending_if_incomplete) bere jen hotovou cenu, ne price_data.
    const np = await stripe.prices.create(priceData(amountOf(price.amount)));
    upd = await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: np.id }],   // id položky se změnou ceny nemění
      proration_behavior: 'always_invoice',
      proration_date: prorDate,
      payment_behavior: 'pending_if_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });
  } catch (e) {
    console.error('[ep] upgrade', e.message);
    try { await stripe.subscriptions.update(sub.id, { metadata: clearPending }); } catch (e2) {}
    return res.status(402).json({ error: 'Přechod se nepodařil: ' + e.message });
  }
  const inv = upd.latest_invoice && typeof upd.latest_invoice === 'object' ? upd.latest_invoice : null;
  const pi = inv && inv.payment_intent && typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
  if (upd.pending_update) {
    // Rozdíl se nestrhl. Banka chce potvrzení -> appka ho otevře (stupeň pak zapíše webhook).
    if (pi && pi.status === 'requires_action' && process.env.STRIPE_PUBLISHABLE_KEY) {
      return res.status(200).json({ ok: false, requires_action: true, clientSecret: pi.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, tier: want });
    }
    // Karta neprošla: fakturu za přechod zrušit, ať ji Stripe nestrhne později bez vědomí člověka.
    try { if (inv && inv.id) await stripe.invoices.voidInvoice(inv.id); } catch (e) { console.error('[ep] void', e.message); }
    try { await stripe.subscriptions.update(sub.id, { metadata: clearPending }); } catch (e) {}
    const why = (pi && pi.last_payment_error && pi.last_payment_error.message) || '';
    return res.status(402).json({ error: 'Platba rozdílu kartou neprošla' + (why ? (' (' + why + ')') : '') + '. Stupeň zůstává ' + EP_TIER_NAMES[cur] + '.' });
  }
  // Zaplaceno hned -> stupeň se zapíše teď (webhook to pak už nezmění).
  await applyEpUpgrade(uid, want, { founding: price.founding, month: price.amount, subId: sub.id, currency: subCur });
  try { await stripe.subscriptions.update(sub.id, { metadata: Object.assign({ ep_tier: want, ep_month: String(price.amount), ep_founding: price.founding ? '1' : (baseMd.ep_founding || '') }, clearPending) }); } catch (e) { console.error('[ep] upgrade md', e.message); }
  return res.status(200).json({ ok: true, tier: want, next: null, month: price.amount });
}

// MĚSÍČNÍ <-> ROČNÍ PLATBA EP (volá partnerChange, který už ověřil přihlášení a běžící předplatné).
async function partnerInterval(req, res, c) {
  const { uid, cur, sub, item, sched, pendingMonthly, pendingDown, yearly, rec, product, prorDate, peIso, yearUnit, monthUnit, subCur, ivWant } = c;
  const _dt = (iso) => new Date(iso).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' });
  const daily = rec.interval === 'day';     // testovací režim: období je den, interval se nemění, jen cena
  const recFor = (iv) => (daily ? rec : { interval: iv, interval_count: 1 });

  // ZRUŠENÍ NAPLÁNOVANÉHO PŘECHODU NA MĚSÍČNÍ: plán se uvolní, předplatné jede dál ročně.
  if (String(req.query.cancel_interval || '') === '1') {
    if (pendingMonthly) {
      try { await stripe.subscriptionSchedules.release(sched.id); }
      catch (e) { console.error('[ep] release', e.message); return res.status(502).json({ error: 'Přechod se nepodařilo zrušit: ' + e.message }); }
      try { await stripe.subscriptions.update(sub.id, { metadata: { ep_interval_next: '' } }); } catch (e) {}
    }
    return res.status(200).json({ ok: true, interval: 'year', interval_next: null });
  }
  if (pendingDown) return res.status(409).json({ error: `Máš naplánovaný přechod na nižší stupeň od ${_dt(peIso)}. Platbu přepneš, až ho zrušíš nebo až proběhne.` });

  // ROČNÍ -> MĚSÍČNÍ od konce zaplaceného roku.
  if (ivWant === 'month') {
    if (!yearly) return res.status(400).json({ error: 'Už platíš měsíčně.' });
    if (pendingMonthly) return res.status(200).json({ ok: true, interval: 'year', interval_next: 'month', from: peIso });
    if (sub.schedule) return res.status(409).json({ error: 'Předplatné má jiný naplánovaný plán. Napiš nám prosím.' });
    try { await epScheduleMonthly(sub, monthUnit, uid); }
    catch (e) { console.error('[ep] to monthly', e.message); return res.status(502).json({ error: 'Přechod se nepodařil: ' + e.message }); }
    try { await stripe.subscriptions.update(sub.id, { metadata: { ep_interval_next: 'month' } }); } catch (e) {}
    await notifyEpMonthlyScheduled(uid, cur, { month: monthUnit / 100, currency: subCur, atIso: peIso });
    return res.status(200).json({ ok: true, interval: 'year', interval_next: 'month', from: peIso, month_amount: monthUnit / 100 });
  }

  // MĚSÍČNÍ -> ROČNÍ hned. Nové roční období začíná dnes, nevyčerpané celé dny měsíce se odečtou.
  if (yearly) return res.status(400).json({ error: 'Už platíš ročně.' });
  const clearPending = { ep_interval_pending: '' };
  await stripe.subscriptions.update(sub.id, { metadata: { ep_interval_pending: 'year' } });
  let upd;
  try {
    const np = await stripe.prices.create({ currency: item.price.currency, product, unit_amount: yearUnit, recurring: recFor('year') });
    upd = await stripe.subscriptions.update(sub.id, {
      items: [{ id: item.id, price: np.id }],
      billing_cycle_anchor: 'now',
      proration_behavior: 'always_invoice',
      proration_date: prorDate,
      payment_behavior: 'pending_if_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });
  } catch (e) {
    console.error('[ep] to yearly', e.message);
    try { await stripe.subscriptions.update(sub.id, { metadata: clearPending }); } catch (e2) {}
    return res.status(402).json({ error: 'Přechod se nepodařil: ' + e.message });
  }
  const inv = upd.latest_invoice && typeof upd.latest_invoice === 'object' ? upd.latest_invoice : null;
  const pi = inv && inv.payment_intent && typeof inv.payment_intent === 'object' ? inv.payment_intent : null;
  if (upd.pending_update) {
    if (pi && pi.status === 'requires_action' && process.env.STRIPE_PUBLISHABLE_KEY) {
      return res.status(200).json({ ok: false, requires_action: true, clientSecret: pi.client_secret, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, interval: 'year' });
    }
    try { if (inv && inv.id) await stripe.invoices.voidInvoice(inv.id); } catch (e) { console.error('[ep] void', e.message); }
    try { await stripe.subscriptions.update(sub.id, { metadata: clearPending }); } catch (e) {}
    const why = (pi && pi.last_payment_error && pi.last_payment_error.message) || '';
    return res.status(402).json({ error: 'Platba kartou neprošla' + (why ? (' (' + why + ')') : '') + '. Dál platíš měsíčně.' });
  }
  await finishEpYearly(uid, sub.id, { paid: inv ? (inv.amount_paid || 0) / 100 : null, currency: subCur });
  return res.status(200).json({ ok: true, interval: 'year', interval_next: null, year_amount: yearUnit / 100 });
}

// ───────────────────────── DODAVATEL (organizations.kind='supplier') ─────────────────────────
// Předplatné profilu dodavatele na PLATFORMOVÉM účtu MTL -- stejná cesta jako EP (partnerCheckout):
// Stripe Checkout v režimu subscription, webhook (mtl_payment_type 'supplier_sub') zapíše
// organizations.supplier_sub a profil se tím zobrazí, faktura jde přes ep-doklad (kind 'supplier_sub').
// CENA JE JEN TADY (server), z adresy se bere jen volba měsíc/rok. Ceny jsou BEZ DPH: zakládající
// 199 Kč pro prvních SUPPLIER_SPOTS zaplacených dodavatelů (zůstane jim -- Stripe drží cenu
// u předplatného, supplier_price se uloží při zaplacení), pak 299 Kč. Roční = 10 měsíců.
// Musí souhlasit se SUPPLIER_* v index.html.
const SUPPLIER_SPOTS = 20, SUPPLIER_FOUNDING_CZK = 199, SUPPLIER_LIST_CZK = 299;
async function supplierTier() {
  let taken = 0;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/organizations?select=id&kind=eq.supplier&supplier_sub=not.is.null`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: 'count=exact' },
    });
    taken = Number(String(r.headers.get('content-range') || '').split('/')[1] || 0) || 0;
  } catch (e) { taken = 0; }
  return (taken < SUPPLIER_SPOTS) ? SUPPLIER_FOUNDING_CZK : SUPPLIER_LIST_CZK;
}

async function supplierCheckout(req, res) {
  const { orgId, userId } = req.query;
  if (!orgId) return res.status(400).json({ error: 'Chybí orgId' });
  const interval = (String(req.query.interval || 'month') === 'year') ? 'year' : 'month';
  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';

  const org = (await _wsbGet(`organizations?id=eq.${encodeURIComponent(orgId)}&select=*`))[0];
  if (!org || org.kind !== 'supplier') return res.status(404).json({ error: 'Dodavatel nenalezen' });
  if (org.status !== 'approved') return res.status(403).json({ error: 'Profil dodavatele je pozastavený nebo zamítnutý.' });
  // NAVAZUJÍCÍ PŘEDPLATNÉ. Běží předplatné, které se na konci období ukončí (zrušené, nebo ho platil
  // předchozí majitel organizace): nové jde založit hned, první platba se strhne až v den, kdy staré
  // skončí. Profil tak běží bez přerušení a nikdo neplatí dvakrát. Stripe dovolí začátek nejvýš
  // jedno období dopředu -- dřív to nejde a appka řekne, od kdy ano.
  // PŘEVZETÍ: po převodu s volbou „dál platí dosavadní majitel" běží předplatné z cizí karty a
  // nekončí. Nový majitel ho převezme stejně -- jeho předplatné začne v den další platby toho
  // starého a staré se po zaplacení nastaví ke konci období (webhook, replaces_sub).
  let _anchor = null, _replaces = null;
  if (org.supplier_sub) {
    const _now = Math.floor(Date.now() / 1000);
    const _pe = org.supplier_period_end ? Math.floor(new Date(org.supplier_period_end).getTime() / 1000) : 0;
    const _foreign = !!(org.supplier_sub_by && String(org.supplier_sub_by) !== String(org.owner_id));
    if (org.supplier_cancelling && _pe > _now + 60) _anchor = _pe;
    else if (!org.supplier_cancelling && _foreign) {
      try {
        const _s = await stripe.subscriptions.retrieve(org.supplier_sub);
        const _cpe = _s.current_period_end || (_s.items && _s.items.data && _s.items.data[0] && _s.items.data[0].current_period_end) || 0;
        if (['active', 'trialing', 'past_due'].includes(_s.status) && _cpe > _now + 60) { _anchor = _cpe; _replaces = org.supplier_sub; }
      } catch (e) { console.error('[supplier] takeover', e.message); }
    }
    if (!_anchor) return _goBack(req, res, `${proto}://${host}/?supplier_sub=active`);
  }

  // DIČ U ZAHRANIČNÍHO DODAVATELE -- stejná brána jako u EP (require_vat_foreign).
  let _ps = {};
  try {
    _ps = (await _wsbGet('platform_settings?id=eq.1&select=require_vat_foreign,home_country,vat_payer,vat_rate,dic'))[0] || {};
    if (_ps.require_vat_foreign) {
      const EU = ['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT',
                  'LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'];
      const home = String(_ps.home_country || 'CZ').toUpperCase();
      const bc = String(org.billing_country || org.country || home).toUpperCase();
      if (bc && bc !== home && EU.indexOf(bc) >= 0 && EU.indexOf(home) >= 0) {
        const _why = await _foreignVatGate('organizations', org.id, Object.assign({}, org, { billing_country: bc }), home, _ps.dic);
        if (_why) return _goBack(req, res, `${proto}://${host}/?supplier_sub=${_why}`);
      }
    }
  } catch (e) { console.error('[supplier] vat gate', e.message); }

  // Testovací režim strhává denně (stejně jako EP), ať je celý cyklus vidět hned druhý den.
  let _daily = false;
  try { const { isTestMode } = await import('./_config.js'); _daily = await isTestMode(); } catch (e) {}
  if (_anchor) {
    const _max = Math.floor(Date.now() / 1000) + (_daily ? 86400 : (interval === 'year' ? 365 : 28) * 86400);
    if (_anchor > _max) return _goBack(req, res, `${proto}://${host}/?supplier_sub=later&at=${encodeURIComponent(new Date((_anchor - (interval === 'year' ? 365 : 28) * 86400) * 1000).toISOString())}`);
  }
  const _m = await supplierTier();
  const net = interval === 'year' ? _m * 10 : _m;
  // DPH NAVÍC jen když je MTL plátce a jde o domácí plnění (stejný režim, jaký pak napíše
  // faktura -- ep-doklad, _vat.js). Dnes MTL plátce není, takže cena bez DPH = konečná.
  let amount = net;
  try {
    const V = vatMode(String(_ps.home_country || 'CZ').toUpperCase(), String(org.billing_country || org.country || _ps.home_country || 'CZ').toUpperCase(), org.vat_id, { kind: 'electronic', supIsVatPayer: !!_ps.vat_payer });
    if (_ps.vat_payer && V.mode === 'domestic') amount = Math.round(net * (1 + (Number(_ps.vat_rate) || 21) / 100) * 100) / 100;
  } catch (e) {}

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    // BEZ DIČ A ADRESY NA STRIPE. Fakturační údaje (název, IČO, DIČ, sídlo) má MTL u účtu,
    // fakturu z nich dělá ep-doklad a DIČ u zahraničních hlídá brána výš (require_vat_foreign).
    // required:'if_supported' chtělo DIČ povinně -- český neplátce DPH tak nemohl zaplatit.
    billing_address_collection: 'auto',
    client_reference_id: String(userId || org.owner_id),
    customer_email: (org.invoice_email || org.contact_email || undefined),
    line_items: [
      { price_data: { currency: 'czk', product_data: { name: 'MTL — profil dodavatele (' + (org.name || '') + ')' },
        unit_amount: Math.round(amount * 100), recurring: { interval: _daily ? 'day' : interval } }, quantity: 1 },
    ],
    subscription_data: { metadata: { mtl_payment_type: 'supplier_sub', org_id: String(org.id), user_id: String(org.owner_id), sup_amount: String(amount), sup_net: String(net), sup_interval: interval },
      ...(_anchor ? { billing_cycle_anchor: _anchor, proration_behavior: 'none' } : {}) },
    metadata: { mtl_payment_type: 'supplier_sub', org_id: String(org.id), user_id: String(org.owner_id), sup_interval: interval, sup_net: String(net),
      ...(_anchor ? { sup_anchor: String(_anchor) } : {}), ...(_replaces ? { replaces_sub: _replaces } : {}) },
    ..._checkoutEnd(req, `${proto}://${host}/?supplier_sub=ok&session={CHECKOUT_SESSION_ID}`, `${proto}://${host}/`),
  }, { apiVersion: '2024-09-30.acacia' });

  return _sendCheckout(req, res, session);
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
  const mb = ((await _wsbGet(`gym_memberships?id=eq.${encodeURIComponent(membershipId)}&select=id,coach_id,student_id,paid_by,plan_name,amount,currency,status,gym_id,paid_to,months`)) || [])[0];
  if (!mb || mb.gym_id || mb.paid_to !== 'coach' || !mb.coach_id) return res.status(400).json({ error: 'Předplatné nenalezeno' });
  if (String(mb.status) !== 'pending') return res.status(400).json({ error: 'Předplatné už není k zaplacení' });
  const p = ((await _wsbGet(`profiles?id=eq.${encodeURIComponent(mb.coach_id)}&select=id,name,stripe_account,online_plans,currency_online,currency,account_suspended,online_native&limit=1`)) || [])[0];
  if (!p || !p.stripe_account) return res.status(400).json({ error: 'Kouč nemá nastavené platby kartou' });
  // Nativní appka: cena s přirážkou na poplatek obchodu (viz coachCheckout a _rate.js).
  const isNative = String(req.query.native || '') === '1';
  if (isNative && p.online_native !== true) return res.status(400).json({ error: 'Tento kouč online koučink v mobilní aplikaci nenabízí.' });
  if (p.account_suspended) return res.status(400).json({ error: 'Účet kouče je pozastavený' });
  const acct = String(p.stripe_account).trim();
  if (!(await _assertAcctReady(acct, res))) return;
  let plans = []; try { plans = typeof p.online_plans === 'string' ? JSON.parse(p.online_plans) : (p.online_plans || []); } catch (e) {}
  const mainCur = String(p.currency_online || p.currency || 'CZK').toUpperCase();
  const cur = String(mb.currency || mainCur).toUpperCase();
  // VARIANTA: 1 měsíc = předplatné obnovované kartou; 3/6/12 měsíců = JEDNORÁZOVÁ platba za celé
  // období, nic se neobnovuje (stejně jako delší permanentka v klubu). Cena i měna se berou
  // z nabídky kouče (prices / terms), řádek dodá jen název, variantu a zvolenou měnu.
  const months = Math.max(1, parseInt(mb.months, 10) || 1);
  if (![1, 3, 6, 12].includes(months)) return res.status(400).json({ error: 'Neplatná délka předplatného.' });
  const plan = (Array.isArray(plans) ? plans : []).find((x) => x && String(x.name || '') === String(mb.plan_name || ''));
  const _webPrice = plan ? Number(planTermPrices(plan, months, mainCur)[cur] || 0) : 0;
  const price = isNative ? nativePrice(_webPrice) : _webPrice;
  if (!plan || !(price > 0) || Math.abs(price - Number(mb.amount)) > 0.005) return res.status(400).json({ error: 'Předplatné neodpovídá aktuální nabídce kouče. Obnov jeho profil a zkus to znovu.' });

  const _cc = await checkOnlineCountry({ SB: _SUPA_URL, KEY: _SUPA_KEY, coachId: mb.coach_id, buyerId: mb.paid_by || mb.student_id });
  if (!_cc.ok) return res.status(400).json({ error: _cc.error });
  const unit = (cur === 'CZK') ? Math.round(price) * 100 : Math.round(price * 100);
  const _rateWeb = await onlineRateFor(_wsbGet, mb.coach_id);
  const rate = isNative ? nativeRate(_rateWeb) : _rateWeb;
  const pct = Math.round(rate * 10000) / 100;   // procenta, 2 desetinná
  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';
  const meta = {
    mtl_payment_type: 'membership', mtl_online: '1', membership_id: mb.id,
    coach_id: String(mb.coach_id), student_id: String(mb.student_id || ''), gym_id: '',
    mtl_plan: String(plan.name || 'Online předplatné').slice(0, 120), mtl_currency: cur, mtl_income: 'main',
    paid_by: String(mb.paid_by || ''), coach_name: String(p.name || '').slice(0, 120),
    // Přepočty sazby (webhook, noční cron, gym-rerate) podle tohohle přidávají poplatek obchodu.
    ...(isNative ? { mtl_native: '1' } : {}),
  };
  const success_url = `${proto}://${host}/?platba=ok&online_plan=1&coach=${encodeURIComponent(mb.coach_id)}&mb=${encodeURIComponent(mb.id)}&session={CHECKOUT_SESSION_ID}`;
  const pname = `${String(plan.name || 'Online předplatné').slice(0, 90)}${months > 1 ? ` (${months} měs.)` : ''} — ${String(p.name || 'Kouč').slice(0, 60)}`;
  let session;
  if (months > 1) {
    // Provize jednou z celé částky (application_fee_amount), stejně jako delší permanentka v klubu.
    const m1 = { ...meta, mtl_membership_kind: 'one_time', mtl_months: String(months) };
    const fee = Math.round(unit * rate);
    session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price_data: { currency: cur.toLowerCase(), product_data: { name: pname }, unit_amount: unit }, quantity: 1 }],
      payment_intent_data: { ...(fee > 0 ? { application_fee_amount: fee } : {}), metadata: m1 },
      metadata: m1,
      ..._checkoutEnd(req, success_url, `${proto}://${host}/`),
    }, { stripeAccount: acct });
  } else {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price_data: { currency: cur.toLowerCase(), product_data: { name: pname }, unit_amount: unit, recurring: { interval: 'month' } }, quantity: 1 }],
      subscription_data: { application_fee_percent: pct, metadata: meta },
      metadata: meta,
      ..._checkoutEnd(req, success_url, `${proto}://${host}/`),
    }, { stripeAccount: acct });
  }
  return _sendCheckout(req, res, session, acct);
}
