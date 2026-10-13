// _memb-term.js — OBDOBÍ ČLENSTVÍ / PERMANENTKY: kalendářní měsíc, nebo 30 dní od zaplacení.
//
// Spolek vybírá členské příspěvky „za září", klub podnikatele prodává permanentku „na měsíc od
// zaplacení". Kterým způsobem klub počítá, říká gyms.memb_calendar; null = podle typu klubu
// (spolek = kalendářní měsíc, podnikatel = od zaplacení). Klub to může přepnout v nastavení.
//
// KALENDÁŘNÍ MĚSÍC:
//   * období končí vždy posledním dnem měsíce (u 3/6/12 měsíců posledním dnem N-tého měsíce),
//   * první platba uprostřed měsíce je jen za zbývající dny toho měsíce (poměrně, celé jednotky),
//   * kdo má u klubu ještě platné členství, začíná dnem po jeho konci -- zaplatit říjen 28. září
//     tak znamená celý říjen, ne tři dny září,
//   * předplatné kartou se ukotví na 1. den dalšího měsíce (Stripe první měsíc dopočítá poměrně).
// Plán s pevným datem konce (ends_on) má přednost -- ten si klub nastavil výslovně.
//
// Zrcadlo v index.html (_membCalendar, _calTerm). Měníš jedno, měň obojí; server cenu ověřuje.
const TZ = 'Europe/Prague';

export function membCalendar(g) {
  if (!g) return false;
  if (g.memb_calendar === true) return true;
  if (g.memb_calendar === false) return false;
  return g.org_form === 'nonprofit';
}

// Pražské datum jako [rok, měsíc 1-12, den].
export function pragueYMD(d) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d instanceof Date ? d : new Date(d || Date.now())).forEach((x) => { p[x.type] = x.value; });
  return [Number(p.year), Number(p.month), Number(p.day)];
}
const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Okamžik (UTC) daného pražského data a času. Posun Prahy se zjistí pro ten den (letní / zimní čas).
function pragueInstant(y, m, d, hh, mm, ss) {
  const guess = Date.UTC(y, m - 1, d, 12, 0, 0);
  const hPrague = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(guess)));
  const off = hPrague - 12;   // +1 v zimě, +2 v létě
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - off * 3600000);
}
export function pragueEndOfDay(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  return pragueInstant(y, m, d, 23, 59, 59);
}
// 1. den měsíce po `at`, 00:00 Praha, v unix sekundách (kotva předplatného kartou).
export function nextMonthAnchor(at) {
  const [y, m] = pragueYMD(at || new Date());
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return Math.floor(pragueInstant(ny, nm, 1, 0, 0, 0).getTime() / 1000);
}

// Cena a konec kalendářního období. full = cena plánu za celé období (N měsíců),
// start = den, od kterého má platit (Date; výchozí dnes). Cena v celých jednotkách měny.
export function calTerm(full, months, start) {
  const mo = Math.max(1, parseInt(months, 10) || 1);
  const [y, m, d] = pragueYMD(start || new Date());
  const dim = daysIn(y, m);
  const frac = (dim - d + 1) / dim;
  const price = d === 1 ? Number(full) : Math.round((Number(full) / mo) * (mo - 1 + frac));
  const t = y * 12 + (m - 1) + (mo - 1);
  const ey = Math.floor(t / 12), em = (t % 12) + 1;
  return { price, endsOn: `${ey}-${pad(em)}-${pad(daysIn(ey, em))}`, partial: d !== 1 };
}

// Od kdy počítat: den po konci platného členství člověka u klubu, jinak dnes.
export function calStart(activeEndIso, at) {
  const now = at ? new Date(at) : new Date();
  const e = activeEndIso ? new Date(activeEndIso) : null;
  if (e && !isNaN(e.getTime()) && e.getTime() > now.getTime()) return new Date(e.getTime() + 1000);
  return now;
}

// Konec platného členství člověka (nebo jeho dítěte) u klubu, ISO, nebo null. get(path) = GET na
// PostgREST vracející pole. excludeId = řádek, který se právě platí (ještě není aktivní, ale pro jistotu).
export async function membActiveEnd(get, { gymId, studentId, childName, excludeId }) {
  if (!gymId || !studentId) return null;
  try {
    const e = encodeURIComponent;
    const cf = childName ? `child_name=eq.${e(childName)}` : 'child_name=is.null';
    const rows = (await get(`gym_memberships?gym_id=eq.${e(gymId)}&student_id=eq.${e(studentId)}&status=in.(active,cancelling)&${cf}${excludeId ? `&id=neq.${e(excludeId)}` : ''}&period_end=not.is.null&select=period_end&order=period_end.desc&limit=1`)) || [];
    const pe = rows[0] && rows[0].period_end;
    return pe && new Date(pe).getTime() > Date.now() ? pe : null;
  } catch (err) { return null; }
}

// PŘEDPLATNÉ KARTOU V KALENDÁŘNÍM REŽIMU: kolik strhnout teď a jak ukotvit obnovy na 1. den měsíce.
//   prorate       -- začíná tento měsíc: teď jednorázově zbytek měsíce, předplatné od 1. dalšího měsíce
//   plain         -- dnes je 1.: obyčejné předplatné, obnovuje se vždy 1.
//   anchor/trial  -- platné členství kryje celý tento měsíc: teď nic, první celá platba 1. dne,
//                    kdy začne (Stripe: billing_cycle_anchor do 49 h, jinak trial_end -- ten musí
//                    být aspoň 48 h dopředu)
//   trial_prorate -- starší členství končí uprostřed pozdějšího měsíce: zkušební doba do jeho konce,
//                    pak Stripe dopočítá zbytek toho měsíce a dál vždy 1.
export function calSubPlan(full, activeEnd, at) {
  const now = at ? new Date(at) : new Date();
  const start = calStart(activeEnd, now);
  const [ny, nm] = pragueYMD(now);
  const [sy, sm, sd] = pragueYMD(start);
  const nowS = Math.floor(now.getTime() / 1000), startS = Math.floor(start.getTime() / 1000);
  if (sy === ny && sm === nm) {
    if (sd === 1) return { kind: 'plain', chargeNow: Number(full) };
    const ct = calTerm(full, 1, start);
    return { kind: 'prorate', chargeNow: ct.price, endsOn: ct.endsOn, anchor: nextMonthAnchor(start) };
  }
  if (sd === 1) {
    const first = Math.floor(pragueInstant(sy, sm, 1, 0, 0, 0).getTime() / 1000);
    return first - nowS < 49 * 3600 ? { kind: 'anchor', chargeNow: 0, anchor: first } : { kind: 'trial', chargeNow: 0, trialEnd: first };
  }
  return { kind: 'trial_prorate', chargeNow: 0, trialEnd: Math.max(startS, nowS + 49 * 3600), anchor: nextMonthAnchor(start) };
}

// Konec období pro zaplacené členství (PIS, převod, jednorázově kartou). gym = řádek klubu
// s membership_plans, org_form, memb_calendar; plan se dohledá podle jména.
export function membPeriodEnd({ gym, planName, months, at, activeEnd }) {
  let plans = gym && gym.membership_plans;
  if (typeof plans === 'string') { try { plans = JSON.parse(plans); } catch (e) { plans = []; } }
  const plan = Array.isArray(plans) ? plans.find((p) => p && String(p.name) === String(planName)) : null;
  const mo = Math.max(1, parseInt((plan && plan.months) || months, 10) || 1);   // plán klubu má přednost
  const now = at ? new Date(at) : new Date();
  if (plan && plan.ends_on) { const f = pragueEndOfDay(plan.ends_on); if (f > now) return { end: f, months: mo }; }
  if (membCalendar(gym)) return { end: pragueEndOfDay(calTerm(Number(plan && plan.price) || 0, mo, calStart(activeEnd, now)).endsOn), months: mo };
  const e = new Date(now); e.setMonth(e.getMonth() + mo);
  return { end: e, months: mo };
}

// Totéž pro zaplacený řádek gym_memberships (PIS převod: pis-return, pis-webhook). sb = supabase-js.
// Klub v kalendářním režimu: navazuje na platné členství téhož člověka / dítěte u klubu.
export async function membEndForRow(sb, rec) {
  let gym = null, activeEnd = null;
  if (rec && rec.gym_id) {
    // select=*: sloupec memb_calendar dokud neproběhne sql/memb-calendar.sql neexistuje a výčet by shodil celý dotaz.
    try { gym = (await sb.from('gyms').select('*').eq('id', rec.gym_id).maybeSingle()).data; } catch (e) {}
    if (membCalendar(gym) && rec.student_id) {
      try {
        let q = sb.from('gym_memberships').select('period_end').eq('gym_id', rec.gym_id).eq('student_id', rec.student_id)
          .in('status', ['active', 'cancelling']).neq('id', rec.id).not('period_end', 'is', null);
        q = rec.child_name ? q.eq('child_name', rec.child_name) : q.is('child_name', null);
        const { data } = await q.order('period_end', { ascending: false }).limit(1);
        const pe = data && data[0] && data[0].period_end;
        if (pe && new Date(pe).getTime() > Date.now()) activeEnd = pe;
      } catch (e) {}
    }
  }
  return membPeriodEnd({ gym, planName: rec && rec.plan_name, months: rec && rec.months, activeEnd });
}
