// SLEVA ZA DOCHÁZKU U PERMANENTKY / ČLENSTVÍ. Klub si ji zapíná u každé permanentky zvlášť
// (gyms.membership_plans[].att = { on, amt, maxAbs, minVisits }), obě čísla ZA MĚSÍC:
//   amt       -- sleva v měně klubu za každý měsíc dalšího období (u 3/6/12 měsíců × počet měsíců),
//   maxAbs    -- nejvýš tolik absencí (nepovinné),
//   minVisits -- aspoň tolik tréninků (nepovinné); vyplněné musí být aspoň jedno z nich.
// LEKCE PERMANENTKY = lekce rozvrhu, které permanentka pokrývá (vybrané lekce, nebo úrovně;
// stejně jako seznam lidí v docházce lekce -- permanentkář je na nich „předrezervovaný").
// ABSENCE = proběhlá lekce permanentky bez docházky člena; omluvená lekce je taky absence.
// PROBĚHLÁ = klub u ní zapsal docházku aspoň jednomu člověku, nebo ji označil za odučenou.
// Lekce, u které klub nezapsal nikoho, se nepočítá (zapomenutá docházka nesmí rozdat absence);
// zrušená lekce se nepočítá nikdy. TRÉNINKY = všechna docházka člena v klubu (i na jiných lekcích).
// Docházku zapisuje jen klub (sql/att-discount.sql); řádky, které si člen zapsal sám, se nepočítají.
// OBDOBÍ = zaplacené období posunuté o 3 dny dřív: lekce do 3. dne před koncem. Vyhodnocuje se
// 2 dny před koncem, takže kouč má aspoň den na zápis poslední lekce. Každá lekce se tak
// počítá právě do jednoho období. U 3/6/12 měsíců celé období platnosti (čísla × měsíce);
// neúplné první období (kalendářní měsíc koupený v půlce) poměrně podle dnů.
// KDE SE UPLATNÍ:
//   * předplatné kartou: membership-expiry-cron 2 dny před obnovou přidá k příští faktuře ve
//     Stripe zápornou položku (attRenewalPass), řádek si zapamatuje období (att_eval_for);
//   * jednorázová platba (kartou, převodem, QR, hotově na recepci): při koupi navazujícího období
//     (attDiscForPurchase) -- nejpozději 7 dní po konci předchozího, nejdřív 10 dní před ním.
//     Jedno období dá slevu jen jednou (att_disc_from + att_disc_for na zaplaceném řádku).
// Server cenu vždy spočítá sám; appka jen ukazuje, co jí server řekl.

const DAY = 86400000;
// „ (sleva za docházku −200 Kč)" do názvu položky dokladu (karta i převod); jinak prázdné.
export function attDiscLabel(v, cur) {
  const n = Number(v); if (!(n > 0)) return '';
  const c = String(cur || 'CZK').toUpperCase();
  return ` (sleva za docházku −${n.toLocaleString('cs-CZ')} ${c === 'CZK' ? 'Kč' : (c === 'EUR' ? '€' : c)})`;
}
const enc = encodeURIComponent;

export function plansOf(g) {
  let pl = [];
  try { pl = typeof g.membership_plans === 'string' ? JSON.parse(g.membership_plans || '[]') : (g.membership_plans || []); } catch (e) {}
  return Array.isArray(pl) ? pl : [];
}
export function planByName(g, name) {
  const n = String(name || '').trim();
  return plansOf(g).find((p) => p && String(p.name || '').trim() === n) || null;
}
// Pravidlo z plánu, nebo null (vypnuté / bez částky / bez obou podmínek).
export function attRule(plan) {
  const a = plan && plan.att;
  if (!a || !a.on) return null;
  const amt = Math.max(0, Number(a.amt) || 0);
  const num = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? null : Math.max(0, Math.floor(Number(v)));
  // Platí JEDNO pravidlo (klub ho vybírá přepínačem): nejvýš absencí, nebo aspoň tréninků.
  const kind = a.kind === 'visits' ? 'visits' : 'abs';
  const maxAbs = kind === 'abs' ? num(a.maxAbs) : null;
  const minVisits = kind === 'visits' ? num(a.minVisits) : null;
  if (!(amt > 0) || (maxAbs === null && !(minVisits > 0))) return null;
  return { amt, maxAbs, minVisits: minVisits > 0 ? minVisits : null };
}
const plTr = (n) => (n === 1 ? 'trénink' : (n >= 2 && n <= 4 ? 'tréninky' : 'tréninků'));
const plAbs = (n) => (n === 1 ? 'absence' : (n >= 2 && n <= 4 ? 'absence' : 'absencí'));
// Podmínka slevy pro texty: „max. 2 absence" / „min. 8 tréninků".
export function attReq(ev, en) {
  if (ev.allowAbs !== null && ev.allowAbs !== undefined) return en ? `max. ${ev.allowAbs} absence${ev.allowAbs === 1 ? '' : 's'}` : `max. ${ev.allowAbs} ${plAbs(ev.allowAbs)}`;
  return en ? `min. ${ev.needVisits} session${ev.needVisits === 1 ? '' : 's'}` : `min. ${ev.needVisits} ${plTr(ev.needVisits)}`;
}
// Krátké shrnutí výsledku pro texty, Stripe a doklad -- jen to, co pravidlo počítá:
// „1 absence" (pravidlo Max. absence), nebo „8 tréninků" (pravidlo Min. tréninků).
export function attSummary(ev, en) {
  if (ev.allowAbs !== null && ev.allowAbs !== undefined) return en ? `${ev.absences} absence${ev.absences === 1 ? '' : 's'}` : `${ev.absences} ${plAbs(ev.absences)}`;
  return en ? `${ev.visits} session${ev.visits === 1 ? '' : 's'}` : `${ev.visits} ${plTr(ev.visits)}`;
}
function addMonths(ms, n) {
  const d = new Date(ms); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// Okno období řádku členství: od začátku (konec − měsíce, ne dřív než vznik řádku) do konce,
// obojí posunuté o 3 dny dřív; nikdy ne za včerejšek.
export function attWindow(row, nowMs) {
  const pe = Date.parse(row.period_end);
  const months = Math.max(1, parseInt(row.months, 10) || 1);
  const created = Date.parse(row.created_at) || 0;
  // Období, za které tenhle řádek slevu už dostal (att_disc_for = jeho konec), se znovu nepočítá:
  // řádek koupený předem nebo prodloužený na recepci by jinak sbíral tytéž lekce podruhé.
  const earned = Date.parse(row.att_disc_for) || 0;
  const start = Math.max(created, addMonths(pe, -months), earned);
  const from = start - 3 * DAY;
  const to = Math.min(pe - 3 * DAY, (nowMs || Date.now()) - DAY);
  // Podíl plného období (neúplný první kalendářní měsíc); 90 % a víc = celé (měsíce mají 28–31 dní).
  const frac = Math.min(1, Math.max(0, (pe - start) / DAY) / (months * 30.44));
  return { from, to, months, scale: months * (frac >= 0.9 ? 1 : frac) };
}

const parseArr = (v) => { try { const x = typeof v === 'string' ? JSON.parse(v || '[]') : v; return Array.isArray(x) ? x : []; } catch (e) { return []; } };
// Termíny lekce rozvrhu -- stejně jako _classSlots v appce (starý tvar day/time jen když slots chybí).
function slotsOf(c) {
  if (c && !Array.isArray(c.slots) && c.day != null && c.time) return [{ day: Number(c.day), time: c.time }];
  return (c && Array.isArray(c.slots) ? c.slots : []).filter((x) => x && x.day != null && x.time).map((x) => ({ day: Number(x.day), time: x.time }));
}
// „Jen tyto lekce" v permanentce = seznam cid lekcí (stejně jako _clsKey v appce).
const clsKey = (c) => String((c && c.cid) || '');

// Pokrývá permanentka (řádek členství: plan_access, plan_classes, discipline, child_name) lekci?
// Stejně jako seznam lidí v docházce lekce (index.html openClassAttendance _covers + planCovers).
function covers(row, c) {
  if (!c) return false;
  if (c.once && c.memb !== true) return false;
  const cls = parseArr(row.plan_classes);
  const acc = parseArr(row.plan_access); const access = acc.length ? acc : ['all'];
  const lvl = c.level || 'all';
  const ok = cls.length ? cls.indexOf(clsKey(c)) >= 0 && !!clsKey(c) : (access.indexOf('all') >= 0 || access.indexOf(lvl) >= 0);
  if (!ok) return false;
  if (lvl === 'kids' && !row.child_name && access.indexOf('kids') < 0) return false;
  if (row.discipline && (c.disc || null) !== row.discipline) return false;
  return true;
}
const t5 = (t) => String(t || '').slice(0, 5);
const nm = (n) => String(n || '').trim().toLowerCase();

// Lekce permanentky v okně [from, to), kolik z nich proběhlo a kolik člen odchodil, absence
// a všechny tréninky člena v klubu. gym musí mít schedule; row = řádek členství.
export async function attStats(sbGet, { gym, row, from, to }) {
  const out = { expected: 0, attended: 0, absences: 0, visits: 0 };
  if (!(to > from) || !gym || !row) return out;
  const sid = row.student_id, child = row.child_name || null;
  const ch = child ? `child_name=eq.${enc(child)}` : 'child_name=is.null';
  const rng = `class_date=gte.${ymd(from)}&class_date=lt.${ymd(to)}`;
  // Docházka celého klubu v okně (podle ní se pozná, že lekce proběhla) a záznamy o lekcích.
  const all = (await sbGet(`gym_attendance?gym_id=eq.${enc(gym.id)}&${rng}&marked_by=not.is.null&select=class_date,class_time,class_name,class_id,student_id,child_name,marked_by&limit=20000`)) || [];
  const log = (await sbGet(`gym_class_log?gym_id=eq.${enc(gym.id)}&${rng}&select=class_date,class_time,class_name,class_id,status&limit=5000`)) || [];
  // Termín = datum + cid lekce (bez cid -- lekce mimo rozvrh -- postaru čas + název).
  const K = (d, cid, t, n) => (cid ? `${String(d).slice(0, 10)}|#${cid}` : `${String(d).slice(0, 10)}|${t5(t)}|${nm(n)}`);
  const RK = (r) => K(r.class_date, r.class_id, r.class_time, r.class_name);
  const held = new Set(), cancelled = new Set();
  all.forEach((a) => held.add(RK(a)));
  log.forEach((l) => { const k = RK(l); if (l.status === 'cancelled') cancelled.add(k); else if (l.status === 'held') held.add(k); });
  // Docházka člena, kterou zapsal klub (ne on sám).
  const mine = all.filter((a) => String(a.student_id) === String(sid) && (a.child_name || null) === child && String(a.marked_by) !== String(sid));
  const mineFull = new Set(mine.map(RK));
  const mineSlot = new Set(mine.map((a) => `${String(a.class_date).slice(0, 10)}|${t5(a.class_time)}`));
  out.visits = new Set(mine.map((a) => `${String(a.class_date).slice(0, 10)}|${t5(a.class_time)}`)).size;
  const sched = parseArr(gym.schedule).filter((c) => covers(row, c));
  const lastDay = ymd(to);                                        // den `to` už do okna nepatří (dotazy: class_date < ymd(to))
  for (let t = Date.parse(ymd(from) + 'T12:00:00Z'); ymd(t) < lastDay; t += DAY) {
    const d = ymd(t), dow = new Date(t).getUTCDay();
    for (const c of sched) {
      const times = c.once ? (String(c.date || '').slice(0, 10) === d ? [c.time] : [])
        : (((c.since && d < c.since) || (c.until && d > c.until)) ? [] : slotsOf(c).filter((x) => x.day === dow).map((x) => x.time));
      for (const tm of times) {
        const k = K(d, c.cid, tm, c.name);
        if (cancelled.has(k) || !held.has(k)) continue;           // zrušená, nebo bez jediného zápisu
        out.expected++;
        if (mineFull.has(k) || mineSlot.has(`${d}|${t5(tm)}`)) out.attended++;
      }
    }
  }
  out.absences = out.expected - out.attended;
  return out;
}

// Splněno? Limity za měsíc × délka období (scale). Jen „nejvýš absencí" bez jediné proběhlé
// lekce nestačí -- bez lekcí není co hodnotit.
export function attEval(rule, st, scale) {
  const sc = scale > 0 ? scale : 1;
  const needVisits = rule.minVisits ? Math.max(1, Math.ceil(rule.minVisits * sc - 1e-9)) : null;
  const allowAbs = rule.maxAbs !== null ? Math.max(0, Math.round(rule.maxAbs * sc)) : null;
  const okVisits = needVisits === null || st.visits >= needVisits;
  const okAbs = allowAbs === null || (st.absences <= allowAbs && st.expected > 0);
  return { ok: okVisits && okAbs, needVisits, allowAbs, visits: st.visits, absences: st.absences, expected: st.expected, attended: st.attended };
}

const PAID = 'status=in.(active,cancelling,ended,expired)';
// Kdo slevu za období DRŽÍ: zaplacené řádky, nezaplacený převod / QR (dokud ho člen nezruší)
// a rozdělaná platba kartou do vypršení (pay.js: Checkout se slevou platí 31 minut).
const ATT_HOLD_MIN = 35;
const holdQ = (nowMs) => `or=(status.in.(active,cancelling,ended,expired,pending_offline),and(status.eq.pending,created_at.gte.${enc(new Date(nowMs - ATT_HOLD_MIN * 60000).toISOString())}))`;

// SLEVA PŘI KOUPI NAVAZUJÍCÍHO OBDOBÍ (jednorázová platba). Vrací null (nic) nebo
// { ok, amount, ...attEval, rule, prevId, prevEnd, plan }. gym musí mít schedule. ok=false = pravidlo
// platí, ale nesplnil ho (appka to ukáže jako motivaci).
export async function attDiscForPurchase(sbGet, { gym, studentId, childName, newMonths, price, excludeId, nowMs }) {
  if (!gym || !studentId) return null;
  const now = nowMs || Date.now();
  const ch = childName ? `child_name=eq.${enc(childName)}` : 'child_name=is.null';
  const prev = ((await sbGet(`gym_memberships?gym_id=eq.${enc(gym.id)}&student_id=eq.${enc(studentId)}&${ch}&${PAID}`
    + `${excludeId ? `&id=neq.${enc(excludeId)}` : ''}&period_end=not.is.null&select=id,student_id,child_name,plan_name,plan_access,plan_classes,discipline,months,period_end,created_at,stripe_subscription,status,cancelled_at,att_disc_for&order=period_end.desc&limit=1`)) || [])[0];
  if (!prev) return null;
  const pe = Date.parse(prev.period_end);
  if (!(pe >= now - 7 * DAY && pe <= now + 10 * DAY)) return null;
  // Běžící předplatné kartou se obnovuje samo (slevu mu dá attRenewalPass), koupě navíc ne.
  if (prev.stripe_subscription && prev.status === 'active' && !prev.cancelled_at) return null;
  const rule = attRule(planByName(gym, prev.plan_name));
  if (!rule) return null;
  // Za tohle období už sleva byla (nový řádek, nebo tentýž řádek prodloužený na recepci).
  const used = (await sbGet(`gym_memberships?att_disc_from=eq.${enc(prev.id)}&att_disc_for=eq.${enc(prev.period_end)}&${holdQ(now)}${excludeId ? `&id=neq.${enc(excludeId)}` : ''}&select=id&limit=1`)) || [];
  if (used.length) return null;
  const w = attWindow(prev, now);
  const st = await attStats(sbGet, { gym, row: prev, from: w.from, to: w.to });
  const ev = attEval(rule, st, w.scale);
  const months = Math.min(Math.max(1, parseInt(prev.months, 10) || 1), Math.max(1, parseInt(newMonths, 10) || 1));
  let amount = rule.amt * months;
  if (price > 0) amount = Math.min(amount, price);
  return { ...ev, amount: ev.ok ? amount : 0, would: amount, summary: attSummary(ev),
    rule, prevId: prev.id, prevEnd: prev.period_end, plan: prev.plan_name || '' };
}

// PRŮBĚH V BĚŽÍCÍM OBDOBÍ (pro appku člena): stejné okno, jen do včerejška.
export async function attProgress(sbGet, { gym, row, nowMs }) {
  const rule = attRule(planByName(gym, row.plan_name));
  if (!rule || !row.period_end) return null;
  const w = attWindow(row, nowMs);
  const st = await attStats(sbGet, { gym, row, from: w.from, to: w.to });
  const ev = attEval(rule, st, w.scale);
  return { rule, ...ev, amount: rule.amt * Math.max(1, parseInt(row.months, 10) || 1), until: new Date(Date.parse(row.period_end) - 3 * DAY).toISOString() };
}

// PŘEDPLATNÉ KARTOU: 2 dny před obnovou vyhodnotit a slevu přidat k příští faktuře ve Stripe
// (záporná položka na účtu klubu -- provize MTL se počítá z toho, co se opravdu strhne).
// sb = fetch na Supabase (service role), sbGet = čtení; notify(row, text) pošle zprávu.
// sbGet MUSÍ při chybě vyhodit výjimku (ne vrátit []): výpadek čtení by jinak vyhodnotil docházku
// jako nulovou a člen by o slevu přišel. sbPatch vrací true, jen když řádek opravdu změnil.
// Předplatné je na Stripe účtu klubu (inkasuje vždy klub); starší řádky placené kouči se přeskočí.
export async function attRenewalPass({ sbGet, sbPatch, stripe, notify, nowMs }) {
  const now = nowMs || Date.now();
  const lo = new Date(now).toISOString(), hi = new Date(now + 2 * DAY).toISOString();
  const rows = (await sbGet(`gym_memberships?status=eq.active&stripe_subscription=not.is.null&cancelled_at=is.null&or=(paid_to.is.null,paid_to.eq.gym)`
    + `&period_end=gt.${enc(lo)}&period_end=lte.${enc(hi)}&select=id,gym_id,gym_name,student_id,child_name,plan_name,plan_access,plan_classes,discipline,months,period_end,created_at,amount,currency,stripe_subscription,att_eval_for,att_disc_for&limit=500`)) || [];
  const gyms = {}; let applied = 0, missed = 0;
  for (const m of rows) {
    if (m.att_eval_for && Date.parse(m.att_eval_for) === Date.parse(m.period_end)) continue;   // toto období už vyhodnocené
    try {
      if (!(m.gym_id in gyms)) gyms[m.gym_id] = ((await sbGet(`gyms?id=eq.${enc(m.gym_id)}&select=id,name,stripe_account,membership_plans,currency,schedule`)) || [])[0] || null;
      const g = gyms[m.gym_id];
      const rule = g && attRule(planByName(g, m.plan_name));
      const thisPeriod = `gym_memberships?id=eq.${enc(m.id)}&or=(att_eval_for.is.null,att_eval_for.neq.${enc('"' + m.period_end + '"')})`;
      if (!rule || !g.stripe_account) { await sbPatch(thisPeriod, { att_eval_for: m.period_end }); continue; }
      const w = attWindow(m, now);
      const st = await attStats(sbGet, { gym: g, row: m, from: w.from, to: w.to });
      const ev = attEval(rule, st, w.scale);
      let amount = ev.ok ? Math.min(rule.amt * Math.max(1, parseInt(m.months, 10) || 1), Number(m.amount) || Infinity) : 0;
      // NEJDŘÍV ZAPSAT, ŽE JE OBDOBÍ VYHODNOCENÉ (jen pokud ještě není), PAK STRIPE. Opačně by
      // nepovedený zápis znamenal další zápornou položku při příštím běhu.
      if (!(await sbPatch(thisPeriod, { att_eval_for: m.period_end, att_disc_next: amount || null, att_eval_abs: ev.absences, att_eval_visits: ev.visits }))) continue;
      if (amount) {
        try {
          const sub = await stripe.subscriptions.retrieve(m.stripe_subscription, {}, { stripeAccount: g.stripe_account });
          const cust = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
          const cur = String(sub.currency || (sub.items && sub.items.data[0] && sub.items.data[0].price.currency) || m.currency || 'czk').toLowerCase();
          await stripe.invoiceItems.create({ customer: cust, subscription: sub.id, currency: cur, amount: -Math.round(amount * 100),
            description: `Sleva za docházku (${attSummary(ev)})`,
            metadata: { mtl_att_disc: String(amount), mtl_att_info: attSummary(ev), membership_id: m.id } },
            { stripeAccount: g.stripe_account });
        } catch (e) {
          console.error('att renewal stripe', m.id, e && e.message);
          amount = 0; await sbPatch(`gym_memberships?id=eq.${enc(m.id)}`, { att_disc_next: null });
          continue;                                          // bez zprávy -- sleva se nepřidala
        }
      }
      if (notify) await notify(m, g, { ...ev, amount, rule });
      if (amount) applied++; else missed++;
    } catch (e) { console.error('att renewal', m.id, e && e.message); }
  }
  return { checked: rows.length, applied, missed };
}
