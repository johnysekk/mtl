// _cohort-pis.js — CO A ZA KOLIK SE U KURZU PLATÍ Z ÚČTU (PIS).
//
// Cenu určuje server, nikdy prohlížeč. Řádek přihlášky (cohort_members) vlastní částku nemá,
// takže se dřív platilo tolik, kolik poslala appka. Tady se z ceníku kurzu a stavu člena určí:
//   * záloha            -- člen ještě nic nezaplatil: deposit_amount kurzu
//   * doplatek 1. měsíce -- záloha zaplacena: cena tarifu minus zaplacené (+ další měsíce naráz)
//   * další měsíc(e)    -- zapsaný člen: cena tarifu × počet měsíců
// Počet měsíců si člen volí v appce (stejný výběr jako u karty); server ho pozná podle částky,
// kterou appka chce zaplatit -- a když neodpovídá žádné povolené volbě, platbu nezaloží.
// Stejný výpočet jako cohort-pay.js (karta), aby obě cesty stály stejně.

export function tierPriceOf(coh, tierName) {
  const tiers = Array.isArray(coh.price_tiers) ? coh.price_tiers : null;
  if (tiers && tiers.length) {
    const hit = tiers.find((t) => t && String(t.name) === String(tierName));
    return Number(hit ? hit.price : tiers[0].price) || 0;
  }
  return Number((tierName === 'student') ? coh.price_student : coh.price_regular) || 0;
}

const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;

// sb = supabase klient (service role), row = cohort_members, wanted = částka z appky.
// Vrací { purpose, months, amount, currency } nebo { error }.
export async function cohortPisPlan(sb, row, wanted) {
  const coh = (await sb.from('gym_cohorts').select('deposit_amount,months,price_tiers,price_student,price_regular,currency').eq('id', row.cohort_id).maybeSingle()).data;
  if (!coh) return { error: 'Kurz nenalezen' };
  const currency = coh.currency || 'CZK';
  const st = String(row.status || '');
  if (['converted', 'completed', 'cancelled', 'removed'].includes(st)) return { error: 'Tahle přihláška už platbu nepřijímá' };
  const tier = tierPriceOf(coh, row.tier);
  const total = Math.max(1, Number(coh.months || 1));
  if (!['deposit_paid', 'enrolled'].includes(st)) {
    const dep = r2(coh.deposit_amount);
    if (!(dep > 0)) return { error: 'Kurz nemá nastavenou zálohu' };
    return { purpose: 'deposit', months: 0, amount: dep, currency };
  }
  if (!(tier > 0)) return { error: 'Kurz nemá nastavenou cenu' };
  let base, left, purpose;
  if (st === 'deposit_paid') {
    purpose = 'first_month';
    base = r2(Math.max(0, tier - Number(row.paid_amount || 0)));
    if (!(base > 0)) return { error: 'První měsíc je už zaplacený' };
    left = total;
  } else {
    purpose = 'month';
    base = tier;
    left = total - Math.max(0, Number(row.months_paid || 0));
    if (left <= 0) return { error: 'Všechny měsíce kurzu jsou zaplacené' };
  }
  // Volby: 1 až zbývající počet měsíců. Bez částky z appky platí jeden měsíc.
  const want = r2(wanted);
  for (let n = 1; n <= left; n++) {
    const amt = r2(base + tier * (n - 1));
    if (!(want > 0) ? n === 1 : Math.abs(amt - want) < 0.01) return { purpose, months: n, amount: amt, currency };
  }
  return { error: 'Částka neodpovídá ceníku kurzu', code: 'price_mismatch' };
}
