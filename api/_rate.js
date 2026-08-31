// THE single source of truth for MTL's per-transaction rate. Every charge path (pay, cohort-pay,
// record-cash, ...) resolves the rate through here so a coach/club is billed the SAME way for a
// lesson, membership, event or course. Two layers:
//   - ladderRate(): the EP/FP/Shikai/Bankai ladder (what the owner pays ongoing).
//   - acquisitionRate(): the finder's fee MTL takes when the APP demonstrably brought the member
//     (first paid lesson / first 2 membership months). EP pays HALF (5% vs 10%).
//   - effectiveRate(): the actual per-tx rate = max(ladder, acquisition).
// No silent 3% fallback: resolvers throw if the owner can't be found, so an overcharge surfaces.

// ── CHANGED: acquisition is now ONE payment, not a two-month window ──────────────────────────
// WAS (until this change):  ACQ_RATE = 0.10, ACQ_RATE_EP = 0.05, and membership carried the fee
//                           for the FIRST TWO months (max = 2 on line 57 below).
// NOW:                      20% / 10% EP, charged on the FIRST month only (max = 1).
//
// The money is the same for anyone who stays two months: 10% twice equals 20% once. Someone who
// leaves after one month pays more, and that is deliberate -- they are exactly the member MTL
// delivered and the club failed to keep.
//
// What this buys is that the two-month window STOPS EXISTING, and with it five separate
// implementations of the same idea that had already drifted apart from each other:
//   _rate.js            used / leftQualifying month arithmetic       (below, now collapsed)
//   stripe-webhook.js   line 332, invoices paid < 2                  -> < 1
//   sub-rate-cron.js    line 54,  invoices paid < 2                  -> < 1
//   gym-rerate.js       line 50,  invoices paid < 2                  -> < 1
//   cron-attendance.js  line 77,  invoices paid < 2                  -> < 1
// plus the blended-rate machinery that only existed to spread two months across one payment.
//
// It also makes the club's conversions panel and the fee agree: one member = one acquisition,
// so "MTL brought you 3 people" and "you paid 3 acquisition fees" are the same sentence.
//
// A multi-month payment still blends, and that is what makes a yearly membership fair: the fee
// lands on one month's worth of it. 16 000 / 12 months -> 20% of 1 333 = 267, not 20% of 16 000.
// effectiveRate() below does that from { rate, months: 1 }; nothing extra is needed.
const ACQ_RATE = 0.20;     // finder's fee, standard providers  (was 0.10 across two months)
const ACQ_RATE_EP = 0.10;  // EP perk: half the acquisition fee (was 0.05 across two months)

// mode: 'stripe' (Stripe track) | anything else (QR/bank/cash/pis track)
// o: { partner, founding, score, bankai }
export function ladderRate(mode, o) {
  o = o || {};
  // ── SAZEBNÍK ────────────────────────────────────────────────────────────────────────────
  //                      Stripe    banka        jak se k tomu dostaneš
  //   base                2,0 %     2,5 %       nijak, výchozí
  //   Shikai              1,5 %     2,0 %       ref_score >= 2
  //   Bankai              1,0 %     1,25 %      ref_score >= 5 + výkonnostní brána
  //   Organizace          1,5 %     1,5 %       schválená organizace, MTL ji potvrzuje ručně
  //   EP                  0,5 %     0,5 %       platí 1000/měs (nebo uděleno zdarma na začátku)
  //
  // Banka je dražší než Stripe schválně: tam si provizi bereš rovnou z platby, tady ji musíš
  // strhnout klubu z karty -- to může selhat, upomínat, končit pozastavením účtu. Ten rozdíl
  // je cena za to riziko, ne za nic.
  //
  // ZRUŠENO: Founding Partner. Byl to čtvrtý stupeň mezi Shikai a EP a po tomhle snížení sazeb
  // ztratil smysl -- základ 2 % je dnes nižší, než býval FP. Ranou výhodou je místo něj EP
  // udělené zdarma, tedy partner=true bez partner_sub. Parametr `founding` se schválně nemaže
  // ze signatury ani ze selectů: sloupec v DB zůstává a ignorovat ho je bezpečnější než honit
  // jeho odstranění napříč šesti soubory kvůli něčemu, co se nepoužívá.
  if (o.partner) return 0.005;                                   // EP
  if (o.org) return 0.015;                                       // schválená organizace, obě koleje
  const s = o.score || 0;
  if (mode === 'stripe') {
    if (s >= 5 && o.bankai) return 0.01;                         // Bankai
    return (s >= 2) ? 0.015 : 0.02;                              // Shikai / base
  }
  if (s >= 5 && o.bankai) return 0.0125;                         // Bankai na bance
  return (s >= 2) ? 0.02 : 0.025;                                // Shikai / base
}


// Resolve the profile of whoever owns the money (ownerId, or via gymId / gym stripe_account).
export async function resolveOwner(sbGet, { ownerId, gymId, gymAccount }) {
  let oid = ownerId;
  // Země z PŘIHLÁŠKY POSKYTOVATELE, ne z registrace do appky. Klub má vlastní billing_country --
  // majitel může bydlet v Česku a fakturovat klub ze Slovenska. Podle toho se řídí provize i DAC7,
  // a doklad zní na klub, takže rozhoduje jeho země. Profil majitele je až náhradní zdroj.
  let gymCC = null;
  if (gymId) {
    const g = (await sbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id,billing_country`))[0];
    if (g) { oid = oid || g.owner_id; gymCC = g.billing_country || null; }
  }
  if (!oid || !gymCC) {
    if (gymAccount) {
      const g = (await sbGet(`gyms?stripe_account=eq.${encodeURIComponent(gymAccount)}&select=owner_id,billing_country&limit=1`))[0];
      if (g) { oid = oid || g.owner_id; gymCC = gymCC || g.billing_country || null; }
    }
  }
  if (!oid) throw new Error('resolveOwner: no owner (ownerId/gymId/gymAccount all unresolved)');
  let p = (await sbGet(`profiles?id=eq.${encodeURIComponent(oid)}&select=id,partner,founding,coach_ref_score,bankai_eligible,billing_country`))[0];
  if (!p) throw new Error('resolveOwner: owner profile not found');
  // Země klubu má přednost před zemí majitele.
  if (gymCC) p = Object.assign({}, p, { billing_country: gymCC });
  return p;
}

// The owner's ongoing ladder rate (no acquisition). Cohorts (courses) use this directly.
export async function resolveRate(sbGet, { ownerId, gymId, gymAccount, mode }) {
  const p = await resolveOwner(sbGet, { ownerId, gymId, gymAccount });
  return ladderRate(mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible });
}

// Acquisition finder's fee, or null if it doesn't apply. Only when acqSource === 'mtl_discovery'
// AND it is their FIRST one of that kind here: first membership, first drop-in, first 1:1.
// (Was: membership = first 2 months. Single charge now -- see the header.) Window is bounded by counting prior COMPLETED tx of this type for this member at
// this provider (Stripe + cash together). ownerPartner => EP pays half.
export async function acquisitionRate(sbGet, { acqSource, type, ownerPartner, memberId, scopeCol, scopeId }) {
  if (acqSource !== 'mtl_discovery' || !memberId) return null;
  let max;
  if (type === 'membership') max = 1;                   // CHANGED: was 2 (first two months)
  else if (type === 'drop_in' || type === 'coach_1to1') max = 1;
  else return null;                                     // custom / event / course: no acquisition fee
  if (!scopeCol || !scopeId) return null;
  try {
    if (type === 'membership' && scopeCol === 'gym_id') {
      // CHANGED. This block used to add up how many of the two qualifying months were already
      // spent, from transactions.acq_months with a gym_memberships fallback. Both halves were
      // broken: acq_months is never written by anything, and the query filtered status=completed
      // while the Stripe rail writes status=paid, so the first query ALWAYS came back empty. The
      // fallback then counted ROWS, not months -- a monthly subscription is one row with months=1
      // whether it ran for a month or three years -- so a member who had already paid both
      // qualifying months could be charged a third one on a new membership.
      // With one qualifying month the whole thing collapses into a single question, and that
      // question has no status vocabulary to get wrong: has this person ever held a membership
      // at this club before?
      // POZOR NA PORADI. Ptat se gym_memberships na "uz tu nekdy clenstvi mel?" nefunguje, protoze
      // radek TOHOTO nakupu uz existuje driv, nez sem dojde rec: klient ho zaklada dopredu kvuli
      // variabilnimu symbolu a pis-return.js ho prepne na 'active' JESTE PRED volanim record-cash.
      // Vlastni nakup se tim sam prohlasil za predchozi a akvizice na bankovni koleji nepadla nikdy.
      // Ptame se proto ucetnictvi, ne clenstvi: transakce vznika az ve chvili, kdy jsou penize
      // zaplacene, takze zadna transakce tohoto nakupu jeste neexistuje. Beru oba slovniky statusu
      // ('paid' i historicke 'completed') a oba typy koleji.
      const prior = await sbGet(`transactions?select=id&member_id=eq.${encodeURIComponent(memberId)}&gym_id=eq.${encodeURIComponent(scopeId)}&type=eq.membership&status=in.(paid,completed)&limit=1`);
      if (prior && prior.length) return null;           // not their first membership here
      return { rate: (ownerPartner ? ACQ_RATE_EP : ACQ_RATE), months: 1 };
    }
    // A 1:1 lesson is written under THREE names: pay.js asks for coach_1to1, the bank rail writes
    // coach_1to1, and Stripe writes coach_inperson or coach_online because it keeps the distinction
    // the bank rail throws away. Asking for one of the three found none of the Stripe ones, so the
    // acquisition fee re-applied on every Stripe lesson forever. Online counts, per the product.
    const _1to1 = (type === 'coach_1to1' || type === 'coach_inperson' || type === 'coach_online');
    const _typeQ = _1to1 ? 'type=in.(coach_1to1,coach_inperson,coach_online)' : `type=eq.${encodeURIComponent(type)}`;
    const prior = await sbGet(`transactions?select=id&member_id=eq.${encodeURIComponent(memberId)}&${_typeQ}&${scopeCol}=eq.${encodeURIComponent(scopeId)}&status=in.(paid,completed)`);
    if (!prior || prior.length < max) return ownerPartner ? ACQ_RATE_EP : ACQ_RATE;
  } catch (e) {}
  return null;
}

// The actual per-transaction rate = the higher of the owner's ladder rate and any acquisition fee.
export async function effectiveRate(sbGet, { ownerId, gymId, gymAccount, mode, type, acqSource, memberId, scopeCol, scopeId, months }) {
  const p = await resolveOwner(sbGet, { ownerId, gymId, gymAccount });
  const ladder = ladderRate(mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible });
  const acq = await acquisitionRate(sbGet, { acqSource, type, ownerPartner: p.partner, memberId, scopeCol, scopeId: (scopeId || p.id) });
  if (acq == null) return ladder;

  // Older shape: a bare number, no month information -> behave as before.
  if (typeof acq === 'number') return Math.max(ladder, acq);

  const bought = Math.max(1, parseInt(months, 10) || 1);
  const covered = Math.max(0, Math.min(bought, acq.months));
  if (covered <= 0) return ladder;
  if (covered >= bought) return Math.max(ladder, acq.rate);

  // A single payment covering more months than qualify: blend, so the acquisition fee lands on
  // the months it is owed for and the rest is charged at the ordinary rate. Buying a year up
  // front then costs the club the same as twelve monthly payments would have.
  const hi = Math.max(ladder, acq.rate);
  return (hi * covered + ladder * (bought - covered)) / bought;
}

// Same computation, but returns the parts as well, so the ledger can record WHY the rate is what
// it is instead of leaving a club to reverse-engineer a blended number.

// ── ZAVÁDĚCÍ NULOVÁ PROVIZE ──────────────────────────────────────────────────────────────────
// V nově otevřené zemi neúčtujeme provizi, dokud neuplyne nastavené datum. Je to jedno místo:
// platform_config.intro_rates, klíčované zemí daňového domicilu poskytovatele (billing_country --
// ne country, což je poloha klubu; klub v Českém Těšíně může fakturovat z Polska).
//
// Přidat další zemi znamená přidat klíč v adminu. Tenhle kód se kvůli tomu nemění.
export async function introFreeFor(sbGet, country) {
  try {
    const cc = String(country || '').trim().toUpperCase();
    if (!cc) return null;
    const row = (await sbGet('platform_config?id=eq.1&select=intro_rates'))[0];
    const map = (row && row.intro_rates) || {};
    const e = map[cc];
    if (!e || !e.off) return null;
    // Bez data platí bez omezení -- záměrné: dokud se nerozhodne, kdy skončí.
    if (!e.until) return { until: null };
    // Do konce uvedeného dne včetně.
    const end = new Date(String(e.until) + 'T23:59:59');
    if (isNaN(end.getTime()) || end.getTime() < Date.now()) return null;
    return { until: e.until };
  } catch (e) {
    // Když se to nepodaří zjistit, účtuje se normálně -- neúčtovat omylem je horší.
    console.error('introFreeFor:', e.message);
    return null;
  }
}

export async function effectiveRateBreakdown(sbGet, args) {
  const p = await resolveOwner(sbGet, { ownerId: args.ownerId, gymId: args.gymId, gymAccount: args.gymAccount });
  // Zaváděcí období má přednost před vším ostatním -- ani akviziční příplatek se neúčtuje.
  // billing_country = daňový domicil. U klubu i u profilu stejně; bydliště je v residence_country.
  // billing_country = daňový domicil, u profilu i u klubu stejně.
  const _free = await introFreeFor(sbGet, p.billing_country);
  if (_free) return { rate: 0, baseRate: 0, acqMonths: 0, months: Math.max(1, parseInt(args.months, 10) || 1), introFree: true, introUntil: _free.until };
  const ladder = ladderRate(args.mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible });
  const acq = await acquisitionRate(sbGet, { acqSource: args.acqSource, type: args.type, ownerPartner: p.partner, memberId: args.memberId, scopeCol: args.scopeCol, scopeId: (args.scopeId || p.id) });
  const bought = Math.max(1, parseInt(args.months, 10) || 1);
  if (acq == null) return { rate: ladder, baseRate: ladder, acqMonths: 0, months: bought };
  if (typeof acq === 'number') return { rate: Math.max(ladder, acq), baseRate: ladder, acqMonths: bought, months: bought };
  const covered = Math.max(0, Math.min(bought, acq.months));
  if (covered <= 0) return { rate: ladder, baseRate: ladder, acqMonths: 0, months: bought };
  const hi = Math.max(ladder, acq.rate);
  const rate = (covered >= bought) ? hi : ((hi * covered + ladder * (bought - covered)) / bought);
  return { rate, baseRate: ladder, acqMonths: covered, months: bought };
}
