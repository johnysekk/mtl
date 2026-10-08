// /api/_price-check.js — OVĚŘENÍ CENY PROTI DATABÁZI.
//
// /api/pay bralo částku z adresy prohlížeče a poslalo ji Stripe. Kdokoli tak mohl zaplatit
// libovolně nízkou částku (/api/pay?...&amount=20). Tohle přepočítá cenu NA SERVERU ze stejných
// zdrojů jako appka a porovná ji s částkou v adrese. Když nesedí žádná legitimní cena, platba se
// odmítne. Online koučing si cenu kontroluje přímo v pay.js (má jiný tvar nabídky).
//
// Cesty: coachPrivate (sazba kouče, sazby za disciplínu, cena slotu 1:N, zvýhodněné ceny private_offers),
// gymDropin (základní drop-in + pojmenované vstupy dropin_plans),
// gymMembership (membership_plans), event (ticket_tiers), merch (gym_merch). Kurzy (cohort-pay) a
// převod (pis-create) si cenu už počítají ze své tabulky samy.

const q = encodeURIComponent;

function sbFactory(SB, KEY) {
  return async function sb(path) {
    const r = await fetch(`${SB.replace(/\/+$/, '')}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    if (!r.ok) throw new Error(`SB ${r.status}`);
    return r.json();
  };
}
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const parseJson = (v, d) => { try { return typeof v === 'string' ? JSON.parse(v) : (v == null ? d : v); } catch (e) { return d; } };
// Zaokrouhlení jako v appce: CZK na celé, ostatní na 2 desetinná.
const roundCur = (v, cur) => String(cur || 'CZK').toUpperCase() === 'CZK' ? Math.round(v) : Math.round(v * 100) / 100;
// Dvě ceny si odpovídají, když se liší o méně než 1 (CZK) / 0,01 (ostatní) -- kryje zaokrouhlení markupu.
function matches(paid, allowed, cur) {
  const eps = String(cur || 'CZK').toUpperCase() === 'CZK' ? 0.5 : 0.005;
  return allowed.some((a) => a > 0 && Math.abs(num(paid) - a) <= eps);
}

// ONLINE NABÍDKA VE VÍCE MĚNÁCH. Položka má hlavní cenu (price + cur) a ruční ceny v dalších
// měnách (prices: { EUR: 20, USD: 22 }). Předplatné má navíc delší varianty placené jednorázově
// (terms: { "3": { CZK: 1350, EUR: 54 }, "6": {...}, "12": {...} }) -- cena za celé období.
export function offerPrices(o, defCur) {
  const out = {};
  if (!o) return out;
  const pm = parseJson(o.prices, {}) || {};
  Object.keys(pm).forEach((k) => { const v = num(pm[k]); if (v > 0) out[String(k).toUpperCase()] = v; });
  if (num(o.price) > 0) out[String(o.cur || defCur || 'CZK').toUpperCase()] = num(o.price);
  return out;
}
export function planTermPrices(p, months, defCur) {
  const mo = Math.max(1, parseInt(months, 10) || 1);
  if (mo === 1) return offerPrices(p, defCur);
  const t = (parseJson(p && p.terms, {}) || {})[String(mo)] || {};
  const out = {};
  Object.keys(t).forEach((k) => { const v = num(t[k]); if (v > 0) out[String(k).toUpperCase()] = v; });
  return out;
}

// Vrátí { ok } nebo { ok:false, error }. opts = { SB, KEY, kind, amount, currency, ... }
export async function checkPrice(opts) {
  const sb = sbFactory(opts.SB, opts.KEY);
  const paid = num(opts.amount);
  const cur = String(opts.currency || 'CZK').toUpperCase();
  if (!(paid > 0)) return { ok: false, error: 'bad amount' };
  let allowed = [];
  try {
    if (opts.kind === 'coachPrivate' && opts.strict) {
      // PŘESNĚ JAKO PŘI REZERVACI: základní sazba, sazba disciplíny, cena slotu 1:N, a zvýhodněná
      // cena JEN když platí její podmínka -- člen koučova klubu (member_only) a/nebo méně vytížený
      // čas (offpeak: dny + od-do) v čase lekce. Nic jiného zapsat nejde (ani na recepci).
      const cid = String(opts.coachProfileId || '');
      const c = ((await sb(`profiles?id=eq.${q(cid)}&select=rate_inperson,currency_inperson,currency,discipline_rates,private_offers,timezone`)) || [])[0];
      if (!c) return { ok: false, error: 'coach not found' };
      const defCur = String(c.currency_inperson || c.currency || 'CZK').toUpperCase();
      if (defCur !== cur) return { ok: false, error: 'Měna neodpovídá ceníku kouče.' };
      if (num(c.rate_inperson) > 0) allowed.push(num(c.rate_inperson));
      Object.values(parseJson(c.discipline_rates, {}) || {}).forEach((v) => { if (num(v) > 0) allowed.push(num(v)); });
      let when = opts.at ? new Date(opts.at) : new Date();
      if (opts.slotId) { const sl = ((await sb(`slots?id=eq.${q(String(opts.slotId))}&select=price,date,time`)) || [])[0]; if (sl) { if (num(sl.price) > 0) allowed.push(num(sl.price)); if (sl.date) when = new Date(`${sl.date}T${String(sl.time || '00:00').slice(0, 5)}:00`); } }
      // Místní den a čas lekce (zóna kouče, výchozí Praha).
      let hm = '', wd = -1;
      try { const f = new Intl.DateTimeFormat('en-GB', { timeZone: c.timezone || 'Europe/Prague', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }); const parts = {}; f.formatToParts(opts.slotId ? new Date(when.getTime()) : when).forEach((x) => { parts[x.type] = x.value; }); hm = `${parts.hour}:${parts.minute}`; wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday); } catch (e) {}
      if (opts.slotId && when) { hm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`; wd = when.getDay(); }
      let isMember = null;
      const memberOf = async () => {
        if (isMember !== null) return isMember;
        isMember = false;
        if (!opts.memberId) return false;
        const gc = (await sb(`gym_coaches?coach_id=eq.${q(cid)}&status=eq.active&select=gym_id`)) || [];
        const own = (await sb(`gyms?owner_id=eq.${q(cid)}&select=id`)) || [];
        const gids = [...new Set([...gc.map((r) => r.gym_id), ...own.map((r) => r.id)].filter(Boolean))];
        if (gids.length) { const m = (await sb(`gym_memberships?student_id=eq.${q(String(opts.memberId))}&gym_id=in.(${gids.join(',')})&status=in.(active,cancelling)&select=id&limit=1`)) || []; isMember = m.length > 0; }
        return isMember;
      };
      for (const o of parseJson(c.private_offers, [])) {
        if (!o || !(num(o.price) > 0)) continue;
        if (o.member_only && !(await memberOf())) continue;
        if (o.offpeak) {
          const f = String(o.from || '').slice(0, 5), t = String(o.to || '').slice(0, 5);
          if (!hm || (f && hm < f) || (t && hm > t)) continue;
          if (Array.isArray(o.days) && o.days.length && o.days.indexOf(wd) < 0) continue;
        }
        allowed.push(num(o.price));
      }
      if (!allowed.length) return { ok: false, error: 'Kouč nemá nastavenou cenu soukromé lekce.' };
      // Uplatněný referral kredit: student platí o 10 / 20 % méně (rozdíl nese poskytovatel).
      if (Array.isArray(opts.discounts)) { const base0 = allowed.slice(); opts.discounts.forEach((d) => base0.forEach((p) => { allowed.push(roundCur(p * (1 - d), cur)); allowed.push(Math.floor(p * (1 - d))); })); }   // appka u převodu zaokrouhluje dolů (Math.floor)
    } else if (opts.kind === 'coachPrivate') {
      const cid = String(opts.coachProfileId || '');
      const c = ((await sb(`profiles?id=eq.${q(cid)}&select=rate_inperson,currency_inperson,currency,discipline_rates,private_offers`)) || [])[0];
      if (!c) return { ok: false, error: 'coach not found' };
      const defCur = String(c.currency_inperson || c.currency || 'CZK').toUpperCase();
      if (num(c.rate_inperson) > 0 && defCur === cur) allowed.push(num(c.rate_inperson));
      const dr = parseJson(c.discipline_rates, {}); Object.values(dr || {}).forEach((v) => { if (num(v) > 0 && defCur === cur) allowed.push(num(v)); });
      // Skupinová soukromka 1:N: cena ze slotu (v měně kouče).
      if (opts.slotId) { const s = ((await sb(`slots?id=eq.${q(String(opts.slotId))}&select=price`)) || [])[0]; if (s && num(s.price) > 0 && defCur === cur) allowed.push(num(s.price)); }
      // Soukromé nabídky (zlevněné balíčky): price v měně kouče.
      parseJson(c.private_offers, []).forEach((o) => { if (o && num(o.price) > 0 && defCur === cur) allowed.push(num(o.price)); });
    } else if (opts.kind === 'coachOnline') {
      // Online služba: balíčky (každý ve své měně; starší bez měny = měna online), rate_online
      // a ceny po disciplínách v měně online. Porovnává se dvojice cena + měna.
      const c = ((await sb(`profiles?id=eq.${q(String(opts.coachProfileId || ''))}&select=online_services,rate_online,currency_online,currency,discipline_rates_online`)) || [])[0];
      if (!c) return { ok: false, error: 'coach not found' };
      const defCur = String(c.currency_online || c.currency || 'CZK').toUpperCase();
      const tiers = parseJson(c.online_services, []);
      // Převod (PIS / QR) jde jen v měně účtu kouče = hlavní měna online.
      if (opts.bankOnly && cur !== defCur) return { ok: false, error: `Převodem lze platit jen v ${defCur}.` };
      (Array.isArray(tiers) ? tiers : []).forEach((t) => { const pm = offerPrices(t, defCur); if (pm[cur] > 0) allowed.push(pm[cur]); });
      if (num(c.rate_online) > 0 && defCur === cur) allowed.push(num(c.rate_online));
      Object.values(parseJson(c.discipline_rates_online, {}) || {}).forEach((v) => { if (num(v) > 0 && defCur === cur) allowed.push(num(v)); });
      if (!allowed.length) return { ok: false, error: 'Cena neodpovídá aktuální nabídce kouče.' };
      // Uplatněný referral kredit: student platí o 10 / 20 % méně.
      if (Array.isArray(opts.discounts)) { const base0 = allowed.slice(); opts.discounts.forEach((d) => base0.forEach((p) => { allowed.push(roundCur(p * (1 - d), cur)); allowed.push(Math.floor(p * (1 - d))); })); }   // appka u převodu zaokrouhluje dolů (Math.floor)
    } else if (opts.kind === 'coachPlan') {
      // Měsíční online předplatné kouče: cena a měna musí patřit k plánu v online_plans.
      const c = ((await sb(`profiles?id=eq.${q(String(opts.coachProfileId || ''))}&select=online_plans,currency_online,currency`)) || [])[0];
      if (!c) return { ok: false, error: 'coach not found' };
      const defCur = String(c.currency_online || c.currency || 'CZK').toUpperCase();
      // Varianta: 1 měsíc = měsíční cena (prices), 3/6/12 měsíců = cena za celé období (terms).
      const mo = Math.max(1, parseInt(opts.months, 10) || 1);
      if (opts.bankOnly && cur !== defCur) return { ok: false, error: `Převodem lze platit jen v ${defCur}.` };
      parseJson(c.online_plans, []).forEach((p) => { if (!p || (opts.planName && String(p.name || '') !== String(opts.planName))) return; const pm = planTermPrices(p, mo, defCur); if (pm[cur] > 0) allowed.push(pm[cur]); });
      if (!allowed.length) return { ok: false, error: 'Předplatné neodpovídá aktuální nabídce kouče.' };
    } else if (opts.kind === 'gymDropin') {
      const g = ((await sb(`gyms?id=eq.${q(String(opts.gymId || ''))}&select=dropin_price,currency,dropin_plans`)) || [])[0];
      if (!g) return { ok: false, error: 'gym not found' };
      const defCur = String(g.currency || 'CZK').toUpperCase();
      if (num(g.dropin_price) > 0 && defCur === cur) allowed.push(num(g.dropin_price));
      parseJson(g.dropin_plans, []).forEach((p) => { if (p && num(p.price) > 0 && defCur === cur) allowed.push(num(p.price)); });
      // Doplatek grace vstupů = násobek drop-in ceny: povol 1..N × cena.
      if (num(g.dropin_price) > 0 && defCur === cur) { for (let n = 1; n <= 20; n++) allowed.push(roundCur(num(g.dropin_price) * n, cur)); }
    } else if (opts.kind === 'gymMembership') {
      const g = ((await sb(`gyms?id=eq.${q(String(opts.gymId || ''))}&select=membership_plans,membership_price,membership_name,currency`)) || [])[0];
      if (!g) return { ok: false, error: 'gym not found' };
      const defCur = String(g.currency || 'CZK').toUpperCase();
      if (defCur !== cur) return { ok: false, error: 'currency mismatch' };
      let plans = parseJson(g.membership_plans, []);
      if (!(Array.isArray(plans) && plans.length) && num(g.membership_price) > 0) plans = [{ price: num(g.membership_price), months: 1 }];
      const wantMo = opts.months != null ? Math.max(1, parseInt(opts.months, 10) || 1) : null;   // počet měsíců musí patřit k plánu
      (plans || []).forEach((p) => {
        const full = num(p.price); const months = Math.max(1, parseInt(p.months, 10) || 1);
        if (wantMo !== null && months !== wantMo) return;
        if (full > 0) { allowed.push(full); if (months > 1 && p.prorate) { for (let L = 1; L <= months; L++) allowed.push(roundCur((full / months) * L, cur)); } }
      });
    } else if (opts.kind === 'event') {
      const ev = ((await sb(`events?id=eq.${q(String(opts.eventId || ''))}&select=ticket_price,ticket_tiers,currency`)) || [])[0];
      if (!ev) return { ok: false, error: 'event not found' };
      const defCur = String(ev.currency || 'CZK').toUpperCase();
      if (defCur !== cur) return { ok: false, error: 'currency mismatch' };
      const prices = [];
      if (num(ev.ticket_price) > 0) prices.push(num(ev.ticket_price));
      parseJson(ev.ticket_tiers, []).forEach((t) => { if (t && num(t.price) > 0) prices.push(num(t.price)); });
      if (!prices.length) prices.push(0);
      // Akce = košík: povol každou kombinaci 1..qty kusů každého tieru, do stropu.
      const QTY = Math.max(1, Math.min(50, parseInt(opts.qty, 10) || 1));
      const sums = new Set([0]);
      for (const pr of prices) { const add = new Set(); for (const base of sums) for (let k = 1; k <= QTY; k++) add.add(roundCur(base + pr * k, cur)); add.forEach((x) => sums.add(x)); }
      sums.delete(0); allowed = [...sums];
    } else if (opts.kind === 'merch') {
      const m = ((await sb(`gym_merch?id=eq.${q(String(opts.merchId || ''))}&select=price,currency,gym_id`)) || [])[0];
      if (!m) return { ok: false, error: 'merch not found' };
      let mc = String(m.currency || '').toUpperCase();
      if (!mc) { const g = ((await sb(`gyms?id=eq.${q(String(m.gym_id || ''))}&select=currency`)) || [])[0]; mc = String((g && g.currency) || 'CZK').toUpperCase(); }
      if (mc !== cur) return { ok: false, error: 'currency mismatch' };
      const QTY = Math.max(1, Math.min(50, parseInt(opts.qty, 10) || 1));
      if (num(m.price) > 0) for (let k = 1; k <= QTY; k++) allowed.push(roundCur(num(m.price) * k, cur));
    } else {
      return { ok: true };   // neznámý druh neblokujeme (zpětná kompatibilita)
    }
  } catch (e) {
    console.error('[price-check]', opts.kind, e.message);
    return { ok: true };   // výpadek DB nesmí zablokovat poctivou platbu
  }
  if (!allowed.length) return { ok: true };   // u entity nic nenastaveno -> necháme projít (fallback jako dřív)
  if (matches(paid, allowed, cur)) return { ok: true };
  return { ok: false, error: 'Cena neodpovídá aktuální nabídce. Obnov stránku a zkus to znovu.' };
}

// ── PŘEVOD (PIS): ŘÁDEK ZAPSALA APPKA, CENU OVĚŘÍME ──────────────────────────────────────────
// Rezervace, vstupy, členství a merch zakládá u převodu prohlížeč -- včetně částky. PIS pak
// platí částku z řádku, takže bez kontroly šlo převodem zaplatit libovolně málo. Akce (lístky
// píše event-reserve ze serverového ceníku), kurzy (cohort-pay) a poplatky organizace si částku
// zapisují samy na serveru, ty se nekontrolují.
export async function checkRowPrice({ SB, KEY, tbl, row }) {
  if (!row) return { ok: false, error: 'row not found' };
  const base = { SB, KEY, amount: row.amount, currency: row.currency || 'CZK' };
  if (tbl === 'bookings') {
    if (String(row.type || '') === 'online') return checkPrice({ ...base, kind: 'coachOnline', bankOnly: true, coachProfileId: row.coach_id, discounts: (String(row.credit_used || '') === 'student') ? [0.1, 0.2] : null });
    return checkPrice({ ...base, kind: 'coachPrivate', strict: true, coachProfileId: row.coach_id, slotId: row.slot_id, memberId: row.student_id, discounts: (String(row.credit_used || '') === 'student') ? [0.1, 0.2] : null });
  }
  if (tbl === 'gym_bookings') return checkPrice({ ...base, kind: 'gymDropin', gymId: row.gym_id });
  if (tbl === 'merch_orders') return checkPrice({ ...base, kind: 'merch', merchId: row.merch_id, qty: row.qty });
  if (tbl === 'gym_memberships') {
    if (!row.gym_id) return checkPrice({ ...base, kind: 'coachPlan', bankOnly: true, coachProfileId: row.coach_id, planName: row.plan_name, months: row.months });
    return checkPrice({ ...base, kind: 'gymMembership', gymId: row.gym_id, months: row.months });
  }
  return { ok: true };
}
