// THE single source of truth for MTL's per-transaction rate. Every charge path (pay, cohort-pay,
// record-cash, ...) resolves the rate through here so a coach/club is billed the SAME way for a
// lesson, membership, event or course. Two layers:
//   - ladderRate(): the EP/FP/Shikai/Bankai ladder (what the owner pays ongoing).
//   - acquisitionRate(): the finder's fee MTL takes when the APP demonstrably brought the member
//     (first paid lesson / first membership month). EP pays less, by tier (EP_TIERS).
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
// ── AKVIZIČNÍ SAZBY ────────────────────────────────────────────────────────────────────
// Dvě různé věci, dvě různé ceny:
//   • ORGANICKÝ OBJEV (mtl_discovery) — člověk si klub našel sám v appce. MTL za ten příchod
//     nic nezaplatilo, jen ho zprostředkovalo, takže JEDNORÁZOVĚ a levně.
//   • REKLAMA (mtl_ads) — MTL za ten klik zaplatilo z vlastní kapsy. Proto OPAKOVANĚ, dokud
//     ten člověk u poskytovatele platí; jinak by se kampaň nezaplatila. Reklama od MTL je jen
//     pro kluby s EP (meta-feed.js), sazba podle stupně (EP_TIERS). Bez EP se neúčtuje vůbec.
// EP má i objev v appce levnější podle stupně.
const ACQ_RATE = 0.10;         // objev v appce, jednorázově (bez EP)

// ── STUPNĚ EXCLUSIVE PARTNERA ──────────────────────────────────────────────────────────────
// Jediný ceník EP. Zrcadlo je v index.html (EP_TIERS) -- když měníš jedno, měň obojí.
//              provize  akvizice  reklama MTL  partneři  cena/měs           zakládající cena
//   Genin       0,75 %   5 %       20 %          3         499 Kč / 20 €     --
//   Chūnin      0,5 %    3 %       10 %          6         799 Kč / 32 €     499 Kč / 20 € pro prvních 10
//   Jōnin       0,25 %   2 %       10 %         10       1 699 Kč / 69 €     --
//   Kage        0 %      0 %       10 %         20       4 999 Kč / 199 €    3 999 Kč / 159 € pro prvních 5
// Provize platí stejně na kartě i na převodu. Poplatek obchodu (12,1 % v nativní appce) EP
// neodpouští -- ten MTL platí Apple / Googlu. Ceny bez DPH, pevně v měně (ne přepočet kurzem):
// v korunách pro odběratele z Česka, v eurech pro všechny ostatní (epCurrencyFor). Zakládající
// místa jsou společná pro obě měny. Roční předplatné = EP_YEAR_MONTHS měsíců. Zakládající cenu
// drží člověk u stupně (profiles.ep_founding), dokud EP úplně nezruší.
export const EP_TIERS = {
  genin:  { rate: 0.0075, acq: 0.05, ads: 0.20, partners: 3,  price: { CZK: 499,  EUR: 20 } },
  chunin: { rate: 0.005,  acq: 0.03, ads: 0.10, partners: 6,  price: { CZK: 799,  EUR: 32 },  founding: { CZK: 499,  EUR: 20 },  foundingSpots: 10 },
  jonin:  { rate: 0.0025, acq: 0.02, ads: 0.10, partners: 10, price: { CZK: 1699, EUR: 69 } },
  kage:   { rate: 0,      acq: 0,    ads: 0.10, partners: 20, price: { CZK: 4999, EUR: 199 }, founding: { CZK: 3999, EUR: 159 }, foundingSpots: 5 },
};
// Měna EP podle země toho, na koho jde faktura (klub nebo kouč, billing_country): Česko a bez
// vyplněné země koruny, jinak eura. Zrcadlo _epCurFor v index.html.
export function epCurrencyFor(cc) { const c = String(cc || '').trim().toUpperCase(); return (!c || c === 'CZ') ? 'CZK' : 'EUR'; }
// Měsíční cena stupně v měně (zakládající, když ji člověk u stupně má nebo dostane).
export function epAmount(tier, cur, founding) {
  const T = EP_TIERS[tier]; const c = String(cur || 'CZK').toUpperCase();
  return (founding && T.founding) ? T.founding[c] : T.price[c];
}
export const EP_TIER_ORDER = ['genin', 'chunin', 'jonin', 'kage'];
export const EP_YEAR_MONTHS = 10;
export const EP_TIER_NAMES = { genin: 'Genin', chunin: 'Chūnin', jonin: 'Jōnin', kage: 'Kage' };
// Ručně udělené EP (partner = true bez stupně) je Chūnin -- sazba dosavadního EP.
export const EP_DEFAULT_TIER = 'chunin';
// Hodnota → klíč stupně, nebo null. Bere klíč stupně i staré true.
export function epTierKey(v) {
  if (v === true) return EP_DEFAULT_TIER;
  return (typeof v === 'string' && EP_TIERS[v]) ? v : null;
}
// Stupeň z profilu (partner + partner_tier), nebo null, když EP nemá.
export function epTierOf(p) {
  if (!p || !p.partner) return null;
  return epTierKey(p.partner_tier) || EP_DEFAULT_TIER;
}
// JAK DLOUHO SE REKLAMA ÚČTUJE. Ne navždy: MTL zaplatilo za ZÍSKÁNÍ člena, ne za jeho život.
// Okno je KALENDÁŘNÍ, běží od první platby z reklamy. Přerušené členství ho tedy neprodlužuje:
// kdo platí 3 měsíce, dva vynechá a pak platí další 3, zaplatí vyšší sazbu ze šesti plateb,
// které se do těch dvanácti měsíců vešly. Počítat „12 zaplacených měsíců" by se u někoho
// táhlo roky a nikdo by nevěděl, kdy to skončí.
const ADS_WINDOW_MONTHS = 12;
// Jak dlouhá pauza ukončí „období" u klubu. Stejné číslo hlídá i to, kdo je stávající člen:
// kdo za posledního půl roku platil nebo trénoval, není akvizice.
const ADS_GAP_MONTHS = 6;

// mode: 'stripe' (Stripe track) | anything else (QR/bank/cash/pis track)
// o: { partner, founding, score, bankai, org } -- partner = stupeň EP (epTierOf), ne jen true
// Má poskytovatel právě teď sazbu z členství v asociaci? Datum, ne příznak -- členství
// vyprší samo a nikdo ho nemusí odklikávat. Používá se všude, kde se sazba počítá.
export function hasOrgRate(profile) {
  try {
    if (!profile) return false;
    // Sloupec profiles.org_rate NEEXISTUJE -- kdyz se dostal do select, PostgREST odmitl
    // cely dotaz, profil prisel prazdny a sazba spadla na zakladni. Ridime se jen datem.
    const u = profile.org_rate_until;
    if (!u) return false;
    // Bereme jen DEN. Slepovat 'T23:59:59' k celé hodnotě funguje jen tehdy, když sloupec
    // vrátí čisté datum; u časové značky vznikne neplatné datum a členství tiše zmizí.
    const day = String(u).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    return new Date(day + 'T23:59:59').getTime() >= Date.now();
  } catch (e) { return false; }
}

export function ladderRate(mode, o) {
  o = o || {};
  // ── SAZEBNÍK ────────────────────────────────────────────────────────────────────────────
  //                      Stripe    banka        jak se k tomu dostaneš
  //   base                2,0 %     2,5 %       nijak, výchozí
  //   Shikai              1,5 %     2,0 %       ref_score >= 2
  //   Bankai              1,0 %     1,25 %      ref_score >= 5 + výkonnostní brána
  //   Organizace          1,5 %     1,5 %       schválená organizace, MTL ji potvrzuje ručně
  //   EP                  0,75 / 0,5 / 0,25 / 0 %  podle stupně (EP_TIERS výš)
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
  // VYHRÁVÁ NEJNIŽŠÍ SAZBA (stejně jako zrcadlo v index.html).
  const s = o.score || 0;
  const stripe = (mode === 'stripe');
  const cand = [stripe ? 0.02 : 0.025];                          // základ
  if (s >= 2) cand.push(stripe ? 0.015 : 0.02);                  // Shikai
  if (s >= 5 && o.bankai) cand.push(stripe ? 0.01 : 0.0125);     // Bankai
  if (o.org) cand.push(0.015);                                   // schválená organizace, obě koleje
  const ep = epTierKey(o.partner);
  if (ep) cand.push(EP_TIERS[ep].rate);                          // EP podle stupně
  return Math.min.apply(null, cand);
}


// ── ONLINE KOUČING ───────────────────────────────────────────────────────────────────────
// Online sekce (jednorázová služba i měsíční předplatné) má VLASTNÍ, nižší sazbu, stejnou na
// obou kolejích, a NEMÁ akvizici (jako kurzy a vstupenky):
//   base 1 %  ·  Shikai 0,75 %  ·  Bankai 0,5 %  ·  EP podle stupně, když je nižší
// (Genin 0,75 % tak online nic nezlepší, Jōnin 0,25 % a Kage 0 % ano).
// Shikai/Bankai podle stejného ref_score a bankai_eligible jako zbytek žebříčku. Organizace
// (1,5 %) tu nic nezlepší -- online základ 1 % je nižší, vyhrává lepší sazba.
export function onlineRate(o) {
  o = o || {};
  const s = o.score || 0;
  const ladder = (s >= 5 && o.bankai) ? 0.005 : ((s >= 2) ? 0.0075 : 0.01);   // Bankai / Shikai / base
  const ep = epTierKey(o.partner);
  return ep ? Math.min(ladder, EP_TIERS[ep].rate) : ladder;
}
export async function onlineRateFor(sbGet, ownerId) {
  const p = await resolveOwner(sbGet, { ownerId });
  return onlineRate({ partner: p.partner, score: p.coach_ref_score, bankai: p.bankai_eligible });   // p.partner = stupeň (resolveOwner)
}

// ── ONLINE KOUČINK V NATIVNÍ APPCE (App Store / Google Play) ─────────────────────────────────
// Online koučink je pro Apple i Google digitální služba: když se koupí v nativní appce, berou si
// z ceny poplatek i při vlastní platební bráně (EU, malý vývojář: 10 %, Apple od 1. 10. 2026,
// Google od 30. 6. 2026). Ten poplatek platí MTL obchodu, a protože je to služba ze zahraničí
// (Irsko), přiznává k němu MTL českou DPH 21 % a jako neplátce si ji neodečte. Skutečný náklad
// je tedy 10 % × 1,21 = 12,1 % z ceny v appce.
// Kouč si v nastavení online zapíná „Nabízet v mobilní aplikaci" (profiles.online_native); pak
// v nativní appce platí cena s přirážkou a MTL si náklad obchodu strhne navíc ke své provizi
// (jedna application fee). Kouč dostane STEJNĚ jako za stejný nákup na webu.
// Zrcadlo v index.html (MTL_STORE_COST).
export const STORE_FEE = 0.10;    // poplatek obchodu
export const STORE_VAT = 0.21;    // DPH, kterou z něj MTL odvede (přenesená povinnost, bez odpočtu)
export const STORE_COST = Math.round(STORE_FEE * (1 + STORE_VAT) * 10000) / 10000;   // 0,121
// Cena v nativní appce: aby po odečtení 12,1 % zbyla webová cena. +12,1 % z webové ceny by
// nestačilo -- poplatek se počítá z vyšší ceny v appce (500 Kč -> 569 Kč, ne 561 Kč).
// Zaokrouhleno nahoru na celé.
export function nativePrice(p) {
  const v = Number(p) || 0;
  return v > 0 ? Math.ceil(v / (1 - STORE_COST) - 1e-9) : v;
}
// Podíl MTL z nativní ceny: náklad obchodu + běžná provize z toho, co zbyde. Kouč tak dostane
// (1 - STORE_COST)(1 - r) z nativní ceny = (1 - r) z webové.
export function nativeRate(r) {
  return 1 - (1 - STORE_COST) * (1 - (Number(r) || 0));
}
// Totéž pro application_fee_percent předplatného (procenta, 2 desetinná místa). Volá se ve
// všech místech, která sazbu předplatného přepočítávají -- jinak by noční přepočet vrátil
// nativnímu předplatnému webovou sazbu a poplatek obchodu by zaplatilo MTL ze svého.
export function withStoreFee(pct, sub) {
  const md = (sub && sub.metadata) || {};
  if (md.mtl_native !== '1' || pct == null) return pct;
  return Math.round(nativeRate(Number(pct) / 100) * 10000) / 100;
}

// ── ORGANIZACE ───────────────────────────────────────────────────────────────────────────
// Organizace nejde po zebricku. Ten je stavěný na opakovaný prodej treninku -- Shikai i Bankai
// se odemykaji poctem privatek nebo clenstvi, coz poradatel akci nikdy mit nebude. Sazba je
// proto pevna a odviji se od toho, KDO organizace je:
//   federation -- 0 % ze vseho: clenske poplatky, skoleni, souteze i fight nights. Svaz privadi
//                 cele sve clenske kluby a MTL vydela na jejich treninku, ne na svazu.
//   promotion  -- 1 % ze vseho. Komercni poradatel na akcich vydelava. Rezim plateb je natvrdo Stripe.
export function orgRate(org) {
  return (org && org.kind === 'federation') ? 0 : 0.01;
}

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
  let p = (await sbGet(`profiles?id=eq.${encodeURIComponent(oid)}&select=id,partner,partner_tier,founding,coach_ref_score,bankai_eligible,org_rate_until,billing_country`))[0];
  if (!p) throw new Error('resolveOwner: owner profile not found');
  // partner = STUPEŇ EP (genin / chunin / jonin / kage) nebo null. Všechno, co sazbu počítá
  // z výsledku resolveOwner, tak dostane stupeň, ne jen „je partner".
  p = Object.assign({}, p, { partner: epTierOf(p) });
  // Země klubu má přednost před zemí majitele.
  if (gymCC) p.billing_country = gymCC;
  return p;
}

// The owner's ongoing ladder rate (no acquisition). Cohorts (courses) use this directly.
export async function resolveRate(sbGet, { ownerId, gymId, gymAccount, mode }) {
  const p = await resolveOwner(sbGet, { ownerId, gymId, gymAccount });
  // ČLENSTVÍ VE FEDERACI. Sazba 1,5 % patří KLUBU, ne osobě -- jeden člověk může mít klub
  // ve federaci i klub mimo ni. Platí do org_rate_until a pak sama vyprší; kdyby to byl
  // příznak, jedna zaplacená sezóna by dala slevu navždy.
  // Vyhrává lepší sazba, stejně jako v celém žebříčku: Bankai (1 %) se členstvím nezhorší.
  const _base = ladderRate(mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score,
    bankai: p.bankai_eligible, org: hasOrgRate(p) });
  return _base;
}

// Acquisition finder's fee, or null if it doesn't apply. Only when acqSource === 'mtl_discovery'
// AND it is their FIRST one of that kind here: first membership, first drop-in, first 1:1.
// (Was: membership = first 2 months. Single charge now -- see the header.) Window is bounded by counting prior COMPLETED tx of this type for this member at
// this provider (Stripe + cash together). ownerPartner = stupeň EP => sazba podle EP_TIERS.
// OKNO NOVÉHO KLUBU: prvních 14 dní od založení klubu se do MTL převádějí jeho stálí členové.
// Kdokoli se v tu dobu přidá, je klubu vlastní (direct) -- bez ohledu na to, jak přišel -- a
// poplatek za přivedení se neúčtuje. Jediné místo s tou délkou; appka i server se ptají sem.
export const GYM_ONBOARDING_DAYS = 14;
export async function gymOnboardingUntil(sbGet, gymId) {
  if (!gymId) return null;
  try {
    const g = await sbGet(`gyms?select=created_at&id=eq.${encodeURIComponent(gymId)}&limit=1`);
    const c = g && g[0] && g[0].created_at; if (!c) return null;
    const until = new Date(Date.parse(c) + GYM_ONBOARDING_DAYS * 86400000);
    return (Date.now() < until.getTime()) ? until.toISOString() : null;
  } catch (e) { return null; }
}
// Akviziční sazby podle stupně EP. Bez EP objev v appce 10 % a reklama nic (program je jen pro
// EP). Nulová sazba (Kage) = akvizice se neúčtuje.
function _acqRates(ownerPartner) {
  const t = epTierKey(ownerPartner);
  return t ? { acq: EP_TIERS[t].acq, ads: EP_TIERS[t].ads } : { acq: ACQ_RATE, ads: 0 };
}
export async function acquisitionRate(sbGet, { acqSource, type, ownerPartner, memberId, scopeCol, scopeId }) {
  // Nový klub v okně převodu členů: žádná akvizice.
  if (scopeCol === 'gym_id' && scopeId && (acqSource === 'mtl_discovery' || acqSource === 'mtl_ads')) {
    if (await gymOnboardingUntil(sbGet, scopeId)) return null;
  }
  // 'mtl_ads' = člověk přišel z kampaně, kterou zaplatilo MTL. Je to akvizice se stejnou
  // sazbou jako organický objev; rozdíl je jen ve zdroji, aby se dalo doložit, odkud přišel
  // (a u reklamy je ten nárok nejsilnější -- MTL za ten klik opravdu zaplatilo).
  if ((acqSource !== 'mtl_discovery' && acqSource !== 'mtl_ads') || !memberId) return null;
  const R = _acqRates(ownerPartner);

  // REKLAMA SE ÚČTUJE Z KAŽDÉ PLATBY toho člověka, ne jen z první. Nehledá se tedy žádná
  // předchozí transakce -- právě tím se liší od organického objevu.
  if (acqSource === 'mtl_ads') {
    if (!(R.ads > 0)) return null;                      // bez EP reklama od MTL neběží
    // JEN ČLENSTVÍ. Jednorázový vstup za 200 Kč by dal 50 Kč, což nestojí za vysvětlování,
    // a členství je zároveň to, co má hodnotu pro klub i pro MTL.
    if (type !== 'membership') return null;
    if (!scopeCol || !scopeId) return null;
    try {
      const MS_MONTH = 30.44 * 86400000;
      const gapMs = ADS_GAP_MONTHS * MS_MONTH;

      // ── SOUČASNÉ OBDOBÍ U KLUBU ────────────────────────────────────────────────────
      // „Období" je řada plateb, mezi kterými není mezera delší než půl roku. Kdo přestal
      // chodit a po půl roce se vrátil, začíná nové období -- a přivést ho zpátky je nová
      // akvizice. Bez tohohle se okno počítalo od vůbec první platby z reklamy, takže
      // člověk, který se vrátil po dvou letech, už nikdy akvizicí být nemohl.
      const pays = await sbGet(
        `transactions?select=created_at,acq_source&member_id=eq.${encodeURIComponent(memberId)}` +
        `&${scopeCol}=eq.${encodeURIComponent(scopeId)}&status=in.(paid,completed)` +
        `&order=created_at.desc&limit=200`
      );
      const spell = [];
      let prev = Date.now();
      for (const p of (pays || [])) {
        const t = Date.parse(p.created_at || '');
        if (!t) continue;
        if (prev - t > gapMs) break;      // mezera delší než půl roku = konec období
        spell.push({ t, acq: p.acq_source || '' });
        prev = t;
      }

      // Nejstarší platba Z REKLAMY v tomhle období. Od ní běží okno.
      const adsInSpell = spell.filter(x => x.acq === 'mtl_ads');
      const anchor = adsInSpell.length ? adsInSpell[adsInSpell.length - 1].t : null;

      if (anchor == null) {
        // V tomhle období ještě žádná platba z reklamy není, takže tahle by okno zakládala.
        // Ale jen u někoho, kdo u klubu opravdu nebyl: kdo platil nebo trénoval v posledním
        // půlroce, je klubův člověk, i kdyby na reklamu klikl.
        if (spell.length) return null;
        if (scopeCol === 'gym_id') {
          const back = new Date(Date.now() - gapMs).toISOString().slice(0, 10);
          const att = await sbGet(
            `gym_attendance?select=id&student_id=eq.${encodeURIComponent(memberId)}` +
            `&gym_id=eq.${encodeURIComponent(scopeId)}&class_date=gte.${encodeURIComponent(back)}&limit=1`
          );
          if (att && att.length) return null;
        }
        return { rate: R.ads, months: ADS_WINDOW_MONTHS };
      }

      // Okno běží od první platby z reklamy v tomhle období.
      const end = new Date(anchor);
      end.setMonth(end.getMonth() + ADS_WINDOW_MONTHS);
      if (Date.now() > end.getTime()) return null;              // okno vypršelo
      const left = Math.max(0, Math.ceil((end.getTime() - Date.now()) / MS_MONTH));
      if (left <= 0) return null;
      return { rate: R.ads, months: Math.min(ADS_WINDOW_MONTHS, left) };
    } catch (e) {
      // Výpadek databáze nesmí cenu zdražit ani zlevnit: bereme celé okno.
      return { rate: R.ads, months: ADS_WINDOW_MONTHS };
    }
  }

  if (!(R.acq > 0)) return null;                        // Kage: akvizice se neúčtuje
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
      return { rate: R.acq, months: 1 };
    }
    // A 1:1 lesson is written under THREE names: pay.js asks for coach_1to1, the bank rail writes
    // coach_1to1, and Stripe writes coach_inperson or coach_online because it keeps the distinction
    // the bank rail throws away. Asking for one of the three found none of the Stripe ones, so the
    // acquisition fee re-applied on every Stripe lesson forever. Online counts, per the product.
    const _1to1 = (type === 'coach_1to1' || type === 'coach_inperson' || type === 'coach_online');
    const _typeQ = _1to1 ? 'type=in.(coach_1to1,coach_inperson,coach_online)' : `type=eq.${encodeURIComponent(type)}`;
    const prior = await sbGet(`transactions?select=id&member_id=eq.${encodeURIComponent(memberId)}&${_typeQ}&${scopeCol}=eq.${encodeURIComponent(scopeId)}&status=in.(paid,completed)`);
    if (!prior || prior.length < max) return R.acq;
  } catch (e) {}
  return null;
}

// The actual per-transaction rate = the higher of the owner's ladder rate and any acquisition fee.
export async function effectiveRate(sbGet, { ownerId, gymId, gymAccount, mode, type, acqSource, memberId, scopeCol, scopeId, months }) {
  const p = await resolveOwner(sbGet, { ownerId, gymId, gymAccount });
  // CHYBĚLO `org`. effectiveRate tím ignorovala sazbu z asociace, takže členovi asociace
  // vycházel základ 2 % místo 1,5 % u zboží, jednorázových vstupů, lekcí 1:1 i jednorázových
  // členství. Nahoře (effectiveRateBreakdown) to bylo správně, tady a níž ne -- a právě tuhle
  // funkci používá pay.js při platbě, takže se účtovalo o půl procenta víc.
  const ladder = ladderRate(mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible, org: hasOrgRate(p) });
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
  const ladder = ladderRate(args.mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible, org: hasOrgRate(p) });   // org viz výš
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
