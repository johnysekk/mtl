// NÁKUP NA FIRMU -- údaje firmy k objednávce a jejich cesta do dokladu (sql/doklad-buyer.sql).
//
// Klíč objednávky (doklad_buyers.session_id):
//   karta    -> id Stripe Checkoutu (cs_…); než se k platbě vystaví doklad, server řekne databázi,
//               která platba (payment intent) k objednávce patří, a doklad firmu dostane sám,
//   QR / PIS -> 'src:<tabulka>:<id řádku>' (rezervace, členství, vstupenka, kurz, zboží); doklad
//               vystavuje record-cash a firmu si k řádku najde sám (buyerForSource).
// Nikdy nesmí shodit platbu ani doklad: chyby se jen zalogují.
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
const _id = (v) => (typeof v === 'string' ? v : (v && v.id)) || null;
const str = (v, n) => (v == null ? null : (String(v).replace(/\s+/g, ' ').trim().slice(0, n) || null));

// Řádky, za které student platí převodem / z účtu (stejný seznam jako v pis-create).
export const BUYER_TABLES = ['gym_bookings', 'gym_memberships', 'bookings', 'event_tickets', 'cohort_members', 'merch_orders'];
// Druh platby v record-cash -> kde leží řádek, ke kterému student firmu vyplnil.
const TYPE_TABLES = {
  drop_in: ['gym_bookings'], membership: ['gym_memberships'], merch: ['merch_orders'],
  coach_1to1: ['bookings', 'gym_memberships'], coach_inperson: ['bookings'], coach_online: ['bookings', 'gym_memberships'],
  course: ['cohort_members'], event_ticket: ['event_tickets'],
};
export const srcKey = (table, id) => `src:${table}:${id}`;

// Kontrola a úprava údajů firmy. Vrací { ok, row } nebo { ok:false, error }.
export function cleanBuyer(b) {
  b = b || {};
  const company = str(b.company, 200);
  const country = String(b.country || 'CZ').trim().toUpperCase();
  const ico = str(b.ico, 20) ? String(b.ico).replace(/\s+/g, '') : null;
  const dic = str(b.dic, 20) ? String(b.dic).replace(/\s+/g, '').toUpperCase() : null;
  const address = str(b.address, 300);
  if (!company) return { ok: false, error: 'Vyplň název firmy.' };
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, error: 'Vyber zemi firmy.' };
  if (country === 'CZ' && !(ico && /^\d{8}$/.test(ico))) return { ok: false, error: 'IČO má 8 číslic.' };
  if (dic && !/^[A-Z]{2}[0-9A-Z+*.]{2,14}$/.test(dic)) return { ok: false, error: 'DIČ začíná kódem země (např. CZ12345678).' };
  if (!address) return { ok: false, error: 'Vyplň sídlo firmy.' };
  return { ok: true, row: { company, ico, dic, address, country } };
}

export async function saveBuyer(key, clean, extra) {
  const row = { session_id: key, ...clean, ...(extra || {}), updated_at: new Date().toISOString() };
  const r = await fetch(`${SB}/rest/v1/doklad_buyers?on_conflict=session_id`, { method: 'POST', headers: { ...H(), Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) throw new Error(`SB ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return true;
}
export async function clearBuyer(key) {
  await fetch(`${SB}/rest/v1/doklad_buyers?session_id=eq.${encodeURIComponent(key)}`, { method: 'DELETE', headers: H() });
}

// QR / PIS: firma k řádku, za který se platí. Pro record-cash -> sloupce cust_* do dokladu.
export async function buyerForSource(type, ids) {
  try {
    if (!SB || !KEY) return null;
    const tables = TYPE_TABLES[String(type || '')] || BUYER_TABLES;
    const keys = [];
    (ids || []).filter((x) => x != null && String(x).trim()).forEach((id) => tables.forEach((t) => keys.push(srcKey(t, String(id).trim()))));
    if (!keys.length) return null;
    const r = await fetch(`${SB}/rest/v1/doklad_buyers?session_id=in.(${keys.map((k) => `"${k.replace(/"/g, '')}"`).map(encodeURIComponent).join(',')})&select=company,ico,dic,address,country,updated_at&order=updated_at.desc&limit=1`, { headers: H() });
    const rows = r.ok ? await r.json() : [];
    const b = rows && rows[0];
    if (!b) return null;
    return { cust_company: b.company, cust_ico: b.ico || null, cust_dic: b.dic || null, cust_address: b.address || null, cust_country: b.country || null };
  } catch (e) { console.error('[doklad-buyer] source', e && e.message); return null; }
}

async function _rpcBind(session, pi, sub) {
  const r = await fetch(`${SB}/rest/v1/rpc/doklad_buyer_bind`, { method: 'POST', headers: H(), body: JSON.stringify({ p_session: session || null, p_pi: pi || null, p_sub: sub || null }) });
  if (!r.ok) throw new Error(`bind ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return r.json().catch(() => 0);
}

// Karta, první platba: jen když k Checkoutu někdo vyplnil firmu -- jinak žádné volání Stripe navíc.
export async function bindBuyerForSession(stripe, session, acct, knownPi) {
  try {
    if (!session || !session.id || !SB || !KEY) return 0;
    const r = await fetch(`${SB}/rest/v1/doklad_buyers?session_id=eq.${encodeURIComponent(session.id)}&select=session_id`, { headers: H() });
    const rows = r.ok ? await r.json() : [];
    if (!(rows && rows.length)) return 0;
    let pi = knownPi || _id(session.payment_intent);
    const sub = _id(session.subscription);
    if (!pi) {
      const opts = acct ? { stripeAccount: acct } : undefined;
      let invId = _id(session.invoice);
      if (!invId && sub) { try { const so = await stripe.subscriptions.retrieve(sub, opts); invId = _id(so && so.latest_invoice); } catch (e) {} }
      if (invId) { try { const inv = await stripe.invoices.retrieve(invId, opts); pi = _id(inv.payment_intent) || _id(inv.charge); } catch (e) {} }
    }
    return await _rpcBind(session.id, pi, sub);
  } catch (e) { console.error('[doklad-buyer] bind session', e && e.message); return 0; }
}

// Obnova předplatného kartou (invoice.paid): firma z první objednávky platí dál.
export async function bindBuyerForRenewal(pi, sub) {
  try {
    if (!pi || !sub || !SB || !KEY) return 0;
    return await _rpcBind(null, pi, sub);
  } catch (e) { console.error('[doklad-buyer] bind renewal', e && e.message); return 0; }
}
