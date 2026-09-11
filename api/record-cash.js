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

import { ladderRate as _mtlRate, acquisitionRate as _mtlAcq, introFreeFor as _introFree, hasOrgRate as _hasOrgRate } from './_rate.js';
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// _introFree() ocekava cteci funkci vracejici pole radku. Volalo se _wsbGet, ale nikde
// nebyla definovana -- potvrzeni QR platby proto padalo na "_wsbGet is not defined".

// ── DOKLAD NA BANKOVNÍ KOLEJI ────────────────────────────────────────────────────────────
// Hotovost, QR a PIS dosud doklad NEVYSTAVOVALY vůbec: snímek tvořil jen Stripe. Student,
// který zaplatil převodem, tedy neměl co dát účetní. Vystavujeme ho tady, ve chvíli platby,
// stejně jako to dělá stripe-webhook -- identita dodavatele, odběratel, popis a částka se
// OPÍŠOU tak, jak platí teď, a vykreslení už na živá data nikdy nesahá.
//
// Řada se slučuje v rámci ÚČTU, ne jen IČO: kdo má pod jedním IČO dva kluby a k tomu profil
// kouče, má jednu souvislou řadu. Kdyby totéž IČO používaly dva různé účty, sdílenou řadou
// by si navzájem brali čísla a ani jeden by nevěděl, proč mu v ní chybí.
//
// KOUČ MÁ DVĚ FAKTURAČNÍ IDENTITY: vlastní (soukromky) a payout_ (klubové plnění). Když má
// transakce gym_id, plnění patří do klubového režimu a doklad musí znít na tu druhou.
// Selhání nesmí shodit zápis platby -- peníze jsou důležitější než papír a doklad se doplní.
// ── FAKTURAČNÍ ADRESA ────────────────────────────────────────────────────────────────────
// Pravda je v rozpadu billing_line1/line2/city/postal (potřebuje ho DAC7). Jednořádkový
// tvar je jen pro zobrazení na dokladu, takže se SKLÁDÁ při čtení, ne ukládá zvlášť --
// dvě kopie téže adresy se vždy rozejdou.
// Prefix pokrývá druhou fakturační identitu kouče (payout_).
function _billAddr(row, prefix) {
  try {
    if (!row) return null;
    const p = prefix || '';
    const g = (k) => {
      const v = row[p + k];
      return (v == null) ? '' : String(v).trim();
    };
    const l1 = g('billing_line1'), l2 = g('billing_line2');
    const city = g('billing_city'), zip = g('billing_postal');
    const parts = [l1, l2, ((zip ? zip + ' ' : '') + city).trim()]
      .filter((x) => x && x.trim());
    if (parts.length) return parts.join(', ');
    // Záloha pro řádky z doby před rozpadem, kde je jen složený tvar.
    const legacy = g('billing_address');
    return legacy || null;
  } catch (e) { return null; }
}

// POLOZKA NA DOKLADU: druh + nazev ("Clenstvi · Zacatecnici", "Jednorazovy vstup · Bordelari").
// Pise se do snimku pri vystaveni. Driv tam byl jen nazev tarifu, nebo u banky syrovy typ "drop_in".
function _dokItemLabel(type, name) {
  const T = { membership: 'Členství', drop_in: 'Jednorázový vstup', coach_inperson: 'Soukromá lekce 1:1', coach_1to1: 'Soukromá lekce 1:1',
    coach_online: 'Online lekce', event_ticket: 'Vstupenka', event: 'Vstupenka', merch: 'Zboží', course: 'Kurz' };
  const t = T[String(type || '')] || '';
  const n = String(name || '').trim();
  // Obecne zastupne nazvy, ktere by jen opakovaly druh.
  const generic = /^(membership|drop-in|drop-in lekce|lekce 1:1|online|event|merch|platba)$/i;
  if (!t) return n || 'Platba';
  if (!n || generic.test(n) || n.toLowerCase() === t.toLowerCase()) return t;
  return t + ' · ' + n;
}
async function _issueDokladBank({ transactionId, gymId, coachId, clubMode, customerName,
                                  customerEmail, participantName, itemLabel, amount, currency,
                                  paymentMethod, testMode, sessionAt }) {
  try {
    if (!transactionId) return null;
    // clubMode je PARAMETR -- znovu ho deklarovat by prebilo to, co poslal volajici.
    let sup = null, ownerId = null;

    if (gymId && !coachId) {
      sup = (await _wsbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=legal_name,name,tax_id,vat_id,vat_payer,vat_rate,billing_line1,billing_line2,billing_city,billing_postal,owner_id`))[0] || null;
      ownerId = sup && sup.owner_id;
    } else if (coachId) {
      // clubMode urcuje volajici: v record-cash jde klubove plneni klubovou vetvi a pozna
      // se tim, ze se prijemce prepnul na koucuv klubovy ucet. Z gym_id to poznat nejde,
      // protoze koucova vetev zapisuje gym_id vzdy null.
      const p = (await _wsbGet(`profiles?id=eq.${encodeURIComponent(coachId)}&select=legal_name,name,tax_id,vat_id,vat_payer,vat_rate,billing_line1,billing_line2,billing_city,billing_postal,payout_legal_name,payout_tax_id,payout_vat_id,payout_vat_payer,payout_vat_rate,payout_billing_line1,payout_billing_line2,payout_billing_city,payout_billing_postal`))[0] || null;
      if (p) {
        sup = clubMode
          ? { legal_name: p.payout_legal_name, name: p.payout_legal_name,
              tax_id: p.payout_tax_id, vat_id: p.payout_vat_id,
              vat_payer: p.payout_vat_payer, vat_rate: p.payout_vat_rate,
              // Adresa se sklada z rozpadu s prefixem payout_; billing_address je jen
              // zaloha pro radky z doby pred rozpadem.
              billing_line1: p.payout_billing_line1, billing_line2: p.payout_billing_line2,
              billing_city: p.payout_billing_city, billing_postal: p.payout_billing_postal }
          : p;
      }
      ownerId = coachId;
    }
    if (!sup || !ownerId) return null;

    const ico = String(sup.tax_id || '').replace(/\s/g, '');
    // Bez IČO nemá řada klíč. U klubového režimu kouče to znamená, že druhou identitu ještě
    // nevyplnil -- doklad se tedy nevystaví teď a doplní se, až ji doplní. Radši žádný doklad
    // než doklad znějící na nesprávný subjekt.
    if (!ico) return null;

    const key = 'ico:' + ico + ':acct:' + ownerId;

    const r = await fetch(`${SB}/rest/v1/rpc/doklad_next`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: key }),
    });
    if (!r.ok) return null;
    let no = await r.json();
    if (no && typeof no === 'object') no = Array.isArray(no) ? no[0] : Object.values(no)[0];
    if (!no) return null;

    await sb('doklady', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({
        doklad_no: String(no), series_key: key,
        transaction_id: transactionId,
        sup_name: sup.legal_name || sup.name || null,
        sup_ico: ico, sup_dic: sup.vat_id || null, sup_address: _billAddr(sup) || null,   // sklada se z billing_line1/2/city/postal
        sup_vat_payer: !!sup.vat_payer, sup_vat_rate: (sup.vat_rate != null ? sup.vat_rate : null),
        cust_name: customerName || null, cust_email: customerEmail || null,
        // Ucastnik jen kdyz se lisi od odberatele -- u dospeleho, ktery jde trenovat sam,
        // by dvakrat totez jmeno nic nerikalo.
        participant_name: ((participantName && String(participantName).trim() &&
          String(participantName).trim() !== String(customerName||'').trim()) ? String(participantName).trim() : null),
        item_label: itemLabel || null,
        amount: Math.round(Number(amount) || 0),
        currency: String(currency || 'CZK').toUpperCase(),
        payment_method: paymentMethod || null, test_mode: !!testMode,
        session_at: sessionAt || null,   // termin lekce pri vystaveni; presun ho uz nezmeni
      }),
    });
    return String(no);
  } catch (e) { console.error('_issueDokladBank', e && e.message); return null; }
}

async function _wsbGet(path) {
  try {
    const r = await sb(path);
    return Array.isArray(r) ? r : (r ? [r] : []);
  } catch (e) { return []; }
}

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
  return _mtlRate('qr_bank', { partner: profile.partner, founding: profile.founding, score: profile.coach_ref_score, bankai: profile.bankai_eligible, org: _hasOrgRate(profile) });
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
    const { token, gym_id, coach_id, member_id, paid_by, paid_by_name, participant_name, item_name, session_at_issue, gross_amount, currency, type, payment_method, cash_payer_name, acq_source, credit, source_booking_id, cohort_id, income_class, months, dropin_plan_id, proof_checked } = b;
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
    // Kdyz klubove plneni vyplaci kouc ze svého klubového účtu, doklad zní na jeho payout_
    // identitu. Deklarace nad vetvemi, protoze doklad se vystavuje az za nimi.
    let _dokladPayoutCoach = null;
    // Jmeno platce, kdyz volajici posle jen jeho id (potvrzeni QR soukromky koucem). Bez nej by
    // doklad u ditete placeneho zastupcem znel na ucastnika, ktery neplatil.
    let _payerName = paid_by_name || null;
    if (!_payerName && paid_by) {
      try { const _pp = await _wsbGet(`profiles?id=eq.${encodeURIComponent(paid_by)}&select=name`); _payerName = (_pp && _pp[0] && _pp[0].name) || null; } catch (e) {}
    }

    if (provider === 'gym') {
      // gym pays out -> gym owner authorizes, rate from owner profile
      const gyms = await sb(`gyms?id=eq.${gym_id}&select=id,owner_id,currency,account_suspended,stripe_account,created_at,billing_country`);
      const gym = gyms && gyms[0];
      if (!gym) return res.status(404).json({ error: 'gym not found' });
      if (!_trusted && gym.owner_id !== uid) return res.status(403).json({ error: 'not your gym' });
      if (!_trusted && gym.account_suspended) return res.status(403).json({ error: 'account suspended' });
      const owners = await sb(`profiles?id=eq.${gym.owner_id}&select=id,partner,founding,coach_ref_score,bankai_eligible,created_at,referral_optin,billing_country,org_rate_until`);
      const ownerProf = (owners && owners[0]) || {};
      if (!ownerProf.id) ownerProf.id = gym.owner_id;
      rate = ladderRate(ownerProf);
      cur = currency || gym.currency || 'czk';
      const _cc = (_wantCredit && ownerProf.referral_optin !== false) ? await findStudentCredit(member_id) : null;
      if (_cc) _creditRow = { memberId: member_id, id: _cc.id, sc: _cc.sc };
      const _acq = await acquisitionRate(acq_source, type, ownerProf, member_id, 'gym_id', gym_id, rate, months);
      // Zaváděcí nulová provize. Tahle cesta počítá sazbu sama přes ladderRate, takže by kontrolu
      // uvnitř effectiveRateBreakdown (kudy jde Stripe) jinak obešla.
      // Země z přihlášky poskytovatele: u klubu jeho vlastní, u kouče z profilu. Majitel může
      // bydlet jinde, než odkud fakturuje klub -- doklad zní na klub, tak rozhoduje jeho země.
      const _intro = await _introFree(_wsbGet, (gym && gym.billing_country) || (ownerProf && ownerProf.billing_country));
      let mtl_fee = (_cc || _intro) ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
      // Podlaha jen u PIS a jen když se opravdu něco účtuje -- uplatněný kredit zůstává nulový.
      if (mtl_fee > 0 && payment_method === 'pis') mtl_fee = Math.max(mtl_fee, await _pisMinFee(currency, gross));
      const _effRate = (_cc || _intro) ? 0 : (_acq != null ? _acq : rate); // per-tx rate -> doklad can itemise by tier
      // Rozklad na akvizici a běžnou sazbu. Bez těchhle dvou sloupců nechá export pro účetní pět
      // sloupců prázdných (akviz. měsíců/sazba/částka, běžná sazba/částka) -- _sp() se z nich počítá
      // a bez nich vrací prázdno. Píše se jen tam, kde akvizice opravdu padla.
      const _acqMonths = (_acq != null && !_cc) ? 1 : null;
      const _baseRate  = (_acq != null && !_cc) ? rate : null;
      let _gymPayee = gym.stripe_account || null;
      if (coach_id) { try { const _cp = await sb(`profiles?id=eq.${coach_id}&select=gym_payout_account`); const _cpa = _cp && _cp[0] && _cp[0].gym_payout_account; if (_cpa) { _gymPayee = _cpa; _dokladPayoutCoach = coach_id; } } catch(e){} }
      row = {
        // Kdo doopravdy platil, když to není účastník (zástupce za mladistvého). Doklad musí
        // znít na plátce, ale docházka patří účastníkovi -- proto obojí zvlášť.
        gym_id, coach_id: coach_id || null, member_id: member_id || null,
        paid_by: paid_by || null, paid_by_name: _payerName,
        // Termín zafixovaný při vystavení -- doklad se z něj kreslí a pozdější přesun ho nemění.
        session_at_issue: session_at_issue || null,
        paid_to: 'gym', payee_account: _gymPayee,
        payee_id: gym.id, payee_kind: 'gym',
        gross_amount: gross, stripe_fee: 0, mtl_fee, mtl_rate: _effRate, acq_months: _acqMonths, base_rate: _baseRate, refund_amount: 0, mtl_fee_refunded: 0,
        // CHANGED: was 'completed'. The column's own DB default is 'paid' and the Stripe rail writes
        // 'paid', so 'completed' was the odd one out -- and every reader of prior turnover asked for
        // 'completed' only, which is why none of them could see a Stripe transaction. One vocabulary
        // now; status-vocabulary.sql normalises the rows written before this.
        currency: cur, type, status: 'paid', payment_method, cohort_id: cohort_id || null, income_class: income_class || null,
        commission_status: _cc ? 'collected' : 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct',
        // Ktera pojmenovana cena za vstup to byla; proof_checked=false znamena, ze klub
        // jeste musi videt doklad. Bez toho by slo vzit slevu bez naroku nedohledatelne.
        dropin_plan_id: dropin_plan_id || null,
        proof_checked: (proof_checked === false ? false : (proof_checked === true ? true : null)), source_booking_id: source_booking_id || null,
      };
    } else {
      // coach pays out -> the coach authorizes their own cash/QR, rate from coach profile.
      const cs = await sb(`profiles?id=eq.${coach_id}&select=id,partner,founding,coach_ref_score,bankai_eligible,account_suspended,cash_blocked,created_at,referral_optin,billing_country,gym_payout_account,stripe_account`);
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
      // Zaváděcí nulová provize. Tahle cesta počítá sazbu sama přes ladderRate, takže by kontrolu
      // uvnitř effectiveRateBreakdown (kudy jde Stripe) jinak obešla.
      // Země z přihlášky poskytovatele: u klubu jeho vlastní, u kouče z profilu. Majitel může
      // bydlet jinde, než odkud fakturuje klub -- doklad zní na klub, tak rozhoduje jeho země.
      const _intro = await _introFree(_wsbGet, (coach && coach.billing_country));
      let mtl_fee = (_cc || _intro) ? 0 : Math.round(gross * (_acq != null ? _acq : rate));
      // Podlaha jen u PIS a jen když se opravdu něco účtuje -- uplatněný kredit zůstává nulový.
      if (mtl_fee > 0 && payment_method === 'pis') mtl_fee = Math.max(mtl_fee, await _pisMinFee(currency, gross));
      const _effRate = (_cc || _intro) ? 0 : (_acq != null ? _acq : rate); // per-tx rate -> doklad can itemise by tier
      // Rozklad na akvizici a běžnou sazbu. Bez těchhle dvou sloupců nechá export pro účetní pět
      // sloupců prázdných (akviz. měsíců/sazba/částka, běžná sazba/částka) -- _sp() se z nich počítá
      // a bez nich vrací prázdno. Píše se jen tam, kde akvizice opravdu padla.
      const _acqMonths = (_acq != null && !_cc) ? 1 : null;
      const _baseRate  = (_acq != null && !_cc) ? rate : null;
      row = {
        gym_id: null, coach_id, member_id: member_id || null,
        paid_by: paid_by || null, paid_by_name: _payerName,
        session_at_issue: session_at_issue || null,
        paid_to: 'coach', payee_account: (coach.gym_payout_account || coach.stripe_account || null),
        payee_id: coach.id, payee_kind: 'profile',
        gross_amount: gross, stripe_fee: 0, mtl_fee, mtl_rate: _effRate, acq_months: _acqMonths, base_rate: _baseRate, refund_amount: 0, mtl_fee_refunded: 0,
        currency: cur, type, status: 'paid', payment_method, cohort_id: cohort_id || null, income_class: income_class || null,
        commission_status: _cc ? 'collected' : 'pending', commission_month: month,
        cash_payer_name: cash_payer_name || null, acq_source: acq_source || 'direct',
        // Ktera pojmenovana cena za vstup to byla; proof_checked=false znamena, ze klub
        // jeste musi videt doklad. Bez toho by slo vzit slevu bez naroku nedohledatelne.
        dropin_plan_id: dropin_plan_id || null,
        proof_checked: (proof_checked === false ? false : (proof_checked === true ? true : null)), source_booking_id: source_booking_id || null,
      };
    }

    // KDO BUDE FAKTUROVAT. Bez ICO nejde vystavit doklad, a platba bez dokladu je horsi
    // nez odmitnuta platba -- clovek zaplati a nema co dat ucetni. Skryti na profilu je jen
    // prvni obrana; stara stranka nebo prime volani ji obejdou, proto to hlida i server.
    {
      let _supIco = null, _who = null;
      try {
        if (_dokladPayoutCoach) {
          const _pp = (await _wsbGet(`profiles?id=eq.${encodeURIComponent(_dokladPayoutCoach)}&select=payout_tax_id,payout_legal_name`))[0];
          _supIco = _pp && _pp.payout_tax_id; _who = 'coach_payout';
        } else if (row.gym_id) {
          const _gg = (await _wsbGet(`gyms?id=eq.${encodeURIComponent(row.gym_id)}&select=tax_id`))[0];
          _supIco = _gg && _gg.tax_id; _who = 'gym';
        } else if (row.coach_id) {
          const _cc2 = (await _wsbGet(`profiles?id=eq.${encodeURIComponent(row.coach_id)}&select=tax_id`))[0];
          _supIco = _cc2 && _cc2.tax_id; _who = 'coach';
        }
      } catch (e) {}
      if (!String(_supIco || '').replace(/\s/g, '')) {
        return res.status(409).json({
          error: 'payout_identity_missing', who: _who,
          message: (_who === 'coach_payout')
            ? 'Trenér nemá vyplněnou fakturační identitu pro režim klub (IČO). Bez ní by doklad zněl na jiný subjekt, než který dostal peníze.'
            : 'Poskytovatel nemá vyplněné IČO. Bez něj nelze vystavit doklad.'
        });
      }
    }

    const ins = await sb('transactions', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(row) });
    const _txId = (ins && ins[0] && ins[0].id) || null;

    // DOKLAD. Bankovni kolej ho dosud nevystavovala vubec -- student, ktery zaplatil
    // prevodem, nemel co dat ucetni. doklady.transaction_id je UNIQUE, takze druhy pokus
    // o tez platbu se neulozí a cislo v rade se nespotrebuje nadarmo.
    let _dokNo = null;
    if (_txId) {
      // KDO JE ODBERATEL A KDO UCASTNIK.
      // Odberatel = kdo platil: zastupce (paid_by_name), plátce v hotovosti
      // (cash_payer_name), jinak clovek sam. Ucastnik = komu sluzba patri (member_id);
      // uvadi se jen kdyz se lisi. Jmeno ucastnika dohledame, record-cash zna jen id.
      let _memberName = null;
      try {
        if (row.member_id) {
          const _mp = await _wsbGet(`profiles?id=eq.${encodeURIComponent(row.member_id)}&select=name`);
          _memberName = (_mp && _mp[0] && _mp[0].name) || null;
        }
      } catch (e) {}
      // Ucastnik: dite vedene jen jmenem pod uctem rodice (child_name / attendee_name), jinak drzitel uctu.
      const _partName = (participant_name && String(participant_name).trim()) || _memberName;
      // Odberatel = kdo platil: zastupce, platce v hotovosti, jinak drzitel uctu. Nikdy dite, ktere
      // vlastni ucet nema -- to je ucastnik, ne ten, kdo platil.
      const _custName = row.paid_by_name || row.cash_payer_name || _memberName || _partName || null;
      // Termin lekce ZAFIXOVANY TED: z rezervace, ke ktere platba patri (soukromka nebo vstup).
      // Termin lekce a nazev polozky ZAFIXOVANE TED, z rezervace, ke ktere platba patri.
      let _sessAt = session_at_issue || null, _itemName = (item_name && String(item_name).trim()) || null;
      const _isUuid = (v) => /^[0-9a-f-]{36}$/i.test(String(v || ''));
      if (source_booking_id) {
        try {
          if (['coach_1to1', 'coach_inperson', 'coach_online'].includes(type) && /^\d+$/.test(String(source_booking_id))) {
            const _bk = ((await _wsbGet(`bookings?id=eq.${encodeURIComponent(source_booking_id)}&select=training_date,training_time,type,online_format`)) || [])[0];
            if (_bk && _bk.type !== 'online' && _bk.training_date && !_sessAt) _sessAt = _bk.training_date + (_bk.training_time ? ' ' + _bk.training_time : '');
            if (_bk && _bk.type === 'online') _itemName = _bk.online_format || _itemName;
          } else if (type === 'drop_in' && _isUuid(source_booking_id)) {
            const _gb = ((await _wsbGet(`gym_bookings?id=eq.${encodeURIComponent(source_booking_id)}&select=class_date,class_time,class_name`)) || [])[0];
            if (_gb && _gb.class_date && !_sessAt) _sessAt = String(_gb.class_date).slice(0, 10) + (_gb.class_time ? ' ' + _gb.class_time : '');
            if (_gb) _itemName = _gb.class_name || _itemName;
          } else if (type === 'membership' && _isUuid(source_booking_id)) {
            const _gm = ((await _wsbGet(`gym_memberships?id=eq.${encodeURIComponent(source_booking_id)}&select=plan_name`)) || [])[0];
            if (_gm) _itemName = _gm.plan_name || _itemName;
          } else if (type === 'merch' && _isUuid(source_booking_id)) {
            const _mo = ((await _wsbGet(`merch_orders?id=eq.${encodeURIComponent(source_booking_id)}&select=item_name,variant`)) || [])[0];
            if (_mo) _itemName = (_mo.item_name || '') + (_mo.variant ? ' (' + _mo.variant + ')' : '');
          }
        } catch (e) {}
      }

      _dokNo = await _issueDokladBank({
        transactionId: _txId,
        // Klubove plneni vyplacene koucovi -> jeho payout_ identita; jinak dodavatel podle
        // toho, komu penize doopravdy prisly.
        gymId: _dokladPayoutCoach ? null : (row.gym_id || null),
        coachId: _dokladPayoutCoach || row.coach_id || null,
        clubMode: !!_dokladPayoutCoach,
        customerName: _custName,
        customerEmail: null,
        participantName: _partName,
        itemLabel: _dokItemLabel(type, _itemName),
        amount: row.gross_amount,
        currency: row.currency,
        paymentMethod: row.payment_method,
        testMode: row.test_mode,
        sessionAt: _sessAt,
      });
    }
    if (_creditRow) await consumeStudentCredit(_creditRow.memberId, _creditRow.id, _creditRow.sc);
    return res.status(200).json({ ok: true, mtl_fee: row.mtl_fee, credit_redeemed: !!_creditRow, id: _txId, doklad_no: _dokNo });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
