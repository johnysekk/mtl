// DSA čl. 32 — INFORMOVÁNÍ KUPUJÍCÍCH O NEZÁKONNÉ NABÍDCE.
// Když se MTL dozví, že poskytovatel (obchodník) přes MTL nabízel nezákonný produkt nebo službu,
// informuje všechny, kdo si to u něj přes MTL koupili v posledních 6 měsících a na koho má
// kontakt: (a) že produkt / služba je nezákonná, (b) kdo je obchodník (identita z dokladu),
// (c) jaké má prostředky nápravy. Podle VOP: všichni, kdo si u něj v posledních 6 měsících něco
// rezervovali nebo koupili -- proto se kromě transakcí berou i rezervace, členství, lístky a kurzy
// (i bezplatné, např. zkušební trénink). Kdo kontakt nemá (host bez e-mailu), na toho musí MTL
// informaci zveřejnit -- výsledek proto vrací počet lidí bez kontaktu.
// Volá admin-terminate.js a admin-suspend.js (jen zakladatel).
import { get, one, notify, log } from './_entity-close.js';
import { sendMail, shell, para, esc, button, APP_URL } from './_mail.js';

const q = encodeURIComponent;
const DAY = 86400000;

// Transakce poskytovatele za posledních 6 měsíců.
function txFilter(kind, id) {
  if (kind === 'gym') return `gym_id=eq.${q(id)}`;
  if (kind === 'org') return `organization_id=eq.${q(id)}`;
  if (kind === 'coach') return `coach_id=eq.${q(id)}&gym_id=is.null&organization_id=is.null`;
  return null;
}

// Identita obchodníka podle posledního dokladu (snímek: jméno, IČO, adresa), jinak jméno profilu.
async function traderOf(kind, id, name, txIds) {
  let d = null;
  for (let i = 0; i < txIds.length && !d; i += 100) {
    d = await one(`doklady?transaction_id=in.(${txIds.slice(i, i + 100).map(q).join(',')})&sup_name=not.is.null&select=sup_name,sup_ico,sup_address&order=issued_at.desc&limit=1`);
  }
  return { name: (d && d.sup_name) || name, ico: (d && d.sup_ico) || null, address: (d && d.sup_address) || null };
}

export async function dsaInformBuyers({ kind, id, name, illegal, redress, by }) {
  const f = txFilter(kind, id);
  if (!f) return { informed: 0, emailed: 0, noContact: 0 };
  const since = new Date(Date.now() - 183 * DAY).toISOString();
  const txs = (await get(`transactions?${f}&created_at=gte.${q(since)}&select=id,member_id,paid_by,status&limit=20000`)) || [];
  const paid = txs.filter((t) => !/^(failed|pending|cancelled|canceled)$/i.test(String(t.status || '')));
  const txIds = paid.map((t) => t.id);
  const trader = await traderOf(kind, id, name, txIds);
  // Kupující s účtem: kdo platil (paid_by), jinak za koho (member_id).
  const users = new Set();
  paid.forEach((t) => { const u = t.paid_by || t.member_id; if (u) users.add(String(u)); });
  // Rezervace a přihlášky bez platby (zkušební trénink, rezervace lekce, kurz, lístek zdarma).
  const guestMail = new Set();
  const add = (rows, uk, mk) => (rows || []).forEach((r) => { if (r[uk]) users.add(String(r[uk])); else if (mk && r[mk]) guestMail.add(String(r[mk]).trim().toLowerCase()); });
  const S = `created_at=gte.${q(since)}`;
  try {
    if (kind === 'gym') {
      add(await get(`gym_bookings?gym_id=eq.${q(id)}&${S}&select=student_id,guest_email&limit=20000`), 'student_id', 'guest_email');
      add(await get(`gym_class_reservations?gym_id=eq.${q(id)}&${S}&select=student_id&limit=20000`), 'student_id');
      add(await get(`gym_memberships?gym_id=eq.${q(id)}&${S}&select=student_id&limit=20000`), 'student_id');
      const coh = ((await get(`gym_cohorts?gym_id=eq.${q(id)}&select=id&limit=2000`)) || []).map((c) => c.id);
      for (let i = 0; i < coh.length; i += 100) add(await get(`cohort_members?cohort_id=in.(${coh.slice(i, i + 100).map(q).join(',')})&${S}&select=student_id,email&limit=20000`), 'student_id', 'email');
    } else if (kind === 'coach') {
      add(await get(`bookings?coach_id=eq.${q(id)}&${S}&select=student_id&limit=20000`), 'student_id');
      add(await get(`gym_memberships?coach_id=eq.${q(id)}&gym_id=is.null&${S}&select=student_id&limit=20000`), 'student_id');
    }
    const evF = kind === 'gym' ? `gym_id=eq.${q(id)}` : kind === 'org' ? `organization_id=eq.${q(id)}` : `created_by=eq.${q(id)}&gym_id=is.null&organization_id=is.null`;
    const evs = ((await get(`events?${evF}&select=id&limit=2000`)) || []).map((e) => e.id);
    for (let i = 0; i < evs.length; i += 100) add(await get(`event_tickets?event_id=in.(${evs.slice(i, i + 100).map(q).join(',')})&${S}&select=buyer_id,buyer_email&limit=20000`), 'buyer_id', 'buyer_email');
  } catch (e) { console.error('[dsa-inform] reservations', e.message); }
  // Hosté bez účtu u plateb: e-mail z dokladu.
  const withoutUser = paid.filter((t) => !(t.paid_by || t.member_id)).map((t) => t.id);
  let noContact = 0;
  for (let i = 0; i < withoutUser.length; i += 100) {
    const ds = (await get(`doklady?transaction_id=in.(${withoutUser.slice(i, i + 100).map(q).join(',')})&select=transaction_id,cust_email`)) || [];
    const got = new Set();
    ds.forEach((d) => { if (d.cust_email) { guestMail.add(String(d.cust_email).trim().toLowerCase()); got.add(String(d.transaction_id)); } });
    noContact += withoutUser.slice(i, i + 100).filter((x) => !got.has(String(x))).length;
  }
  const who = `${trader.name}${trader.ico ? ', IČO ' + trader.ico : ''}${trader.address ? ', ' + trader.address : ''}`;
  const cs = `⚠️ Důležité upozornění k nákupu přes MTL: ${name} (${who}) přes MTL nabízel produkt nebo službu, která je v rozporu s právem. ${illegal} Co můžeš dělat: ${redress}`;
  const en = `⚠️ Important notice about a purchase through MTL: ${name} (${who}) offered a product or service through MTL that is illegal. ${illegal} What you can do: ${redress}`;
  const data = { kind: 'dsa_illegal_notice', entity_kind: kind, entity_id: id, name, trader, illegal, redress };
  const mailHtml = (en0) => para(en0 ? 'Important notice about your purchase through Martial Training Lab.' : 'Důležité upozornění k tvému nákupu přes Martial Training Lab.')
    + para(`<b>${en0 ? 'What was illegal' : 'Co bylo v rozporu s právem'}:</b> ${esc(illegal)}`)
    + para(`<b>${en0 ? 'Trader' : 'Obchodník (poskytovatel)'}:</b> ${esc(trader.name)}${trader.ico ? (en0 ? ', ID ' : ', IČO ') + esc(trader.ico) : ''}${trader.address ? ', ' + esc(trader.address) : ''}`)
    + para(`<b>${en0 ? 'What you can do' : 'Co můžeš dělat'}:</b> ${esc(redress)}`)
    + para(en0 ? 'We are informing everyone who booked or bought from this trader through MTL in the last 6 months (EU Digital Services Act, Art. 32).'
      : 'Informujeme všechny, kdo si u tohoto obchodníka přes MTL v posledních 6 měsících něco rezervovali nebo koupili (Akt o digitálních službách EU, čl. 32).')
    + button(APP_URL + '/?go=bookings', en0 ? 'My purchases' : 'Moje nákupy');
  let informed = 0, emailed = 0;
  for (const uid of users) {
    await notify(uid, cs, en, data);
    informed++;
    try {
      const p = await one(`profiles?id=eq.${q(uid)}&select=email,lang`);
      if (p && p.email) {
        guestMail.delete(String(p.email).trim().toLowerCase());
        const e0 = p.lang === 'en';
        const r = await sendMail(p.email, e0 ? `Important notice: ${name}` : `Důležité upozornění: ${name}`, shell(e0 ? 'Important notice about your purchase' : 'Důležité upozornění k nákupu', mailHtml(e0), e0, false));
        if (r && r.ok) emailed++;
      }
    } catch (e) {}
  }
  for (const m of guestMail) {
    const r = await sendMail(m, `Důležité upozornění: ${name}`, shell('Důležité upozornění k nákupu', mailHtml(false), false, false));
    if (r && r.ok) emailed++;
  }
  await log({ kind, entity_id: String(id), user_id: by || null, action: 'dsa_inform', reason: String(illegal).slice(0, 1000),
    meta: { redress, trader, users: users.size, guests: guestMail.size, no_contact: noContact, since } });
  return { informed, emailed, guests: guestMail.size, noContact };
}
