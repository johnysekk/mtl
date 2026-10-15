// SLEVA ZA DOCHÁZKU U PERMANENTKY / ČLENSTVÍ. Klub si ji zapíná u každé permanentky zvlášť
// (gyms.membership_plans[].att = { on, pct, amt, min }):
//   pct -- kolik procent rezervovaných lekcí musí člen opravdu odchodit,
//   amt -- sleva v měně klubu za každý měsíc dalšího období (u 3/6/12 měsíců × počet měsíců),
//   min -- aspoň tolik rezervací za měsíc (bez minima by stačila jedna rezervace a jedna účast).
// DOCHÁZKA = rezervace (gym_class_reservations) + docházka, kterou zapsal kouč, recepce nebo
// majitel (gym_attendance, marked_by někdo jiný než člen; sql/att-discount.sql vynucuje, že
// marked_by je vždy ten, kdo zápis udělal). Omluvená lekce (rezervace 'released') je absence.
// Rezervace držená do zaplacení převodem ('reserved') se nepočítá.
// OBDOBÍ = zaplacené období posunuté o 3 dny dřív: lekce do 3. dne před koncem. Vyhodnocuje se
// 2 dny před koncem, takže kouč má aspoň den na zápis poslední lekce. Každá lekce se tak
// počítá právě do jednoho období. U 3/6/12 měsíců celé období platnosti.
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
// Pravidlo z plánu, nebo null (vypnuté / bez částky).
export function attRule(plan) {
  const a = plan && plan.att;
  if (!a || !a.on) return null;
  const amt = Math.max(0, Number(a.amt) || 0);
  if (!(amt > 0)) return null;
  return { pct: Math.min(100, Math.max(1, Number(a.pct) || 80)), amt, min: Math.max(0, parseInt(a.min, 10) || 0) };
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
  return { from, to, months, days: Math.max(1, (pe - start) / DAY) };
}

// Rezervace a z nich odchozené lekce v okně [from, to).
export async function attStats(sbGet, { gymId, studentId, childName, from, to }) {
  if (!(to > from)) return { reserved: 0, attended: 0 };
  const ch = childName ? `child_name=eq.${enc(childName)}` : 'child_name=is.null';
  const rng = `class_date=gte.${ymd(from)}&class_date=lt.${ymd(to)}`;
  const res = (await sbGet(`gym_class_reservations?gym_id=eq.${enc(gymId)}&student_id=eq.${enc(studentId)}&${ch}&${rng}&select=class_date,class_time,class_name,status&limit=3000`)) || [];
  const att = (await sbGet(`gym_attendance?gym_id=eq.${enc(gymId)}&student_id=eq.${enc(studentId)}&${ch}&${rng}&marked_by=not.is.null&marked_by=neq.${enc(studentId)}&select=class_date,class_time,class_name&limit=3000`)) || [];
  const t5 = (t) => String(t || '').slice(0, 5);
  const nm = (n) => String(n || '').trim().toLowerCase();
  const full = new Set(att.map((a) => `${String(a.class_date).slice(0, 10)}|${t5(a.class_time)}|${nm(a.class_name)}`));
  const slot = new Set(att.map((a) => `${String(a.class_date).slice(0, 10)}|${t5(a.class_time)}`));
  const seen = new Set(); let reserved = 0, attended = 0;
  for (const r of res) {
    if (r.status === 'reserved') continue;                       // držené do zaplacení převodem
    const k = `${String(r.class_date).slice(0, 10)}|${t5(r.class_time)}|${nm(r.class_name)}`;
    if (seen.has(k)) continue; seen.add(k);
    reserved++;
    if (r.status === 'released') continue;                       // omluvená = absence
    if (full.has(k) || slot.has(`${String(r.class_date).slice(0, 10)}|${t5(r.class_time)}`)) attended++;
  }
  return { reserved, attended };
}

// Splněno? need = minimum rezervací za okno (min za měsíc × délka okna).
export function attEval(rule, stats, days) {
  const need = rule.min ? Math.max(1, Math.round(rule.min * days / 30.44)) : 1;
  const pct = stats.reserved ? Math.round((stats.attended / stats.reserved) * 1000) / 10 : 0;
  return { ok: stats.reserved >= need && pct >= rule.pct, pct, need };
}

const PAID = 'status=in.(active,cancelling,ended,expired)';
// Kdo slevu za období DRŽÍ: zaplacené řádky, nezaplacený převod / QR (dokud ho člen nezruší)
// a rozdělaná platba kartou do vypršení (pay.js: Checkout se slevou platí 31 minut).
const ATT_HOLD_MIN = 35;
const holdQ = (nowMs) => `or=(status.in.(active,cancelling,ended,expired,pending_offline),and(status.eq.pending,created_at.gte.${enc(new Date(nowMs - ATT_HOLD_MIN * 60000).toISOString())}))`;

// SLEVA PŘI KOUPI NAVAZUJÍCÍHO OBDOBÍ (jednorázová platba). Vrací null (nic) nebo
// { ok, amount, pct, reserved, attended, need, rule, prevId, prevEnd, plan }. ok=false = pravidlo
// platí, ale nesplnil ho (appka to ukáže jako motivaci).
export async function attDiscForPurchase(sbGet, { gym, studentId, childName, newMonths, price, excludeId, nowMs }) {
  if (!gym || !studentId) return null;
  const now = nowMs || Date.now();
  const ch = childName ? `child_name=eq.${enc(childName)}` : 'child_name=is.null';
  const prev = ((await sbGet(`gym_memberships?gym_id=eq.${enc(gym.id)}&student_id=eq.${enc(studentId)}&${ch}&${PAID}`
    + `${excludeId ? `&id=neq.${enc(excludeId)}` : ''}&period_end=not.is.null&select=id,plan_name,months,period_end,created_at,stripe_subscription,status,cancelled_at,att_disc_for&order=period_end.desc&limit=1`)) || [])[0];
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
  const st = await attStats(sbGet, { gymId: gym.id, studentId, childName, from: w.from, to: w.to });
  const ev = attEval(rule, st, w.days);
  const months = Math.min(Math.max(1, parseInt(prev.months, 10) || 1), Math.max(1, parseInt(newMonths, 10) || 1));
  let amount = rule.amt * months;
  if (price > 0) amount = Math.min(amount, price);
  return { ok: ev.ok, amount: ev.ok ? amount : 0, would: amount, pct: ev.pct, reserved: st.reserved, attended: st.attended, need: ev.need,
    rule, prevId: prev.id, prevEnd: prev.period_end, plan: prev.plan_name || '' };
}

// PRŮBĚH V BĚŽÍCÍM OBDOBÍ (pro appku člena): stejné okno, jen do včerejška.
export async function attProgress(sbGet, { gym, row, nowMs }) {
  const rule = attRule(planByName(gym, row.plan_name));
  if (!rule || !row.period_end) return null;
  const w = attWindow(row, nowMs);
  const st = await attStats(sbGet, { gymId: gym.id, studentId: row.student_id, childName: row.child_name || null, from: w.from, to: w.to });
  const ev = attEval(rule, st, w.days);
  return { rule, pct: ev.pct, need: ev.need, reserved: st.reserved, attended: st.attended, ok: ev.ok,
    amount: rule.amt * Math.max(1, parseInt(row.months, 10) || 1), until: new Date(Date.parse(row.period_end) - 3 * DAY).toISOString() };
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
    + `&period_end=gt.${enc(lo)}&period_end=lte.${enc(hi)}&select=id,gym_id,gym_name,student_id,child_name,plan_name,months,period_end,created_at,amount,currency,stripe_subscription,att_eval_for,att_disc_for&limit=500`)) || [];
  const gyms = {}; let applied = 0, missed = 0;
  for (const m of rows) {
    if (m.att_eval_for && Date.parse(m.att_eval_for) === Date.parse(m.period_end)) continue;   // toto období už vyhodnocené
    try {
      if (!(m.gym_id in gyms)) gyms[m.gym_id] = ((await sbGet(`gyms?id=eq.${enc(m.gym_id)}&select=id,name,stripe_account,membership_plans,currency`)) || [])[0] || null;
      const g = gyms[m.gym_id];
      const rule = g && attRule(planByName(g, m.plan_name));
      const thisPeriod = `gym_memberships?id=eq.${enc(m.id)}&or=(att_eval_for.is.null,att_eval_for.neq.${enc('"' + m.period_end + '"')})`;
      if (!rule || !g.stripe_account) { await sbPatch(thisPeriod, { att_eval_for: m.period_end }); continue; }
      const w = attWindow(m, now);
      const st = await attStats(sbGet, { gymId: g.id, studentId: m.student_id, childName: m.child_name || null, from: w.from, to: w.to });
      const ev = attEval(rule, st, w.days);
      let amount = ev.ok ? Math.min(rule.amt * Math.max(1, parseInt(m.months, 10) || 1), Number(m.amount) || Infinity) : 0;
      // NEJDŘÍV ZAPSAT, ŽE JE OBDOBÍ VYHODNOCENÉ (jen pokud ještě není), PAK STRIPE. Opačně by
      // nepovedený zápis znamenal další zápornou položku při příštím běhu.
      if (!(await sbPatch(thisPeriod, { att_eval_for: m.period_end, att_disc_next: amount || null, att_eval_pct: ev.pct }))) continue;
      if (amount) {
        try {
          const sub = await stripe.subscriptions.retrieve(m.stripe_subscription, {}, { stripeAccount: g.stripe_account });
          const cust = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
          const cur = String(sub.currency || (sub.items && sub.items.data[0] && sub.items.data[0].price.currency) || m.currency || 'czk').toLowerCase();
          await stripe.invoiceItems.create({ customer: cust, subscription: sub.id, currency: cur, amount: -Math.round(amount * 100),
            description: `Sleva za docházku (${String(ev.pct).replace('.', ',')} %)`,
            metadata: { mtl_att_disc: String(amount), mtl_att_pct: String(ev.pct), membership_id: m.id } },
            { stripeAccount: g.stripe_account });
        } catch (e) {
          console.error('att renewal stripe', m.id, e && e.message);
          amount = 0; await sbPatch(`gym_memberships?id=eq.${enc(m.id)}`, { att_disc_next: null });
          continue;                                          // bez zprávy -- sleva se nepřidala
        }
      }
      if (notify) await notify(m, g, { ...ev, ...st, amount, rule });
      if (amount) applied++; else missed++;
    } catch (e) { console.error('att renewal', m.id, e && e.message); }
  }
  return { checked: rows.length, applied, missed };
}
