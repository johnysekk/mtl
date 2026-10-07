// /api/_fee-window.js — VRACÍ SE PROVIZE MTL?
//
// Pravidlo (stejné pro kartu i převod/QR/hotovost):
//   Provize se vrací (poměrně k vrácené částce), JEN DOKUD NENÍ VYSTAVENÝ DOKLAD o provizi
//   za období, ve kterém platba proběhla. Potom už ne -- student dostane své peníze stejně,
//   ale MTL svou provizi nevrací. Díky tomu vystavený doklad vždy sedí a nevznikají dobropisy.
//
// Období = měsíc platby (YYYY-MM); poskytovatelé s denním dokladem mají období = den (YYYY-MM-DD).
// Doklad hledáme v commission_doklady u subjektu, kterému platba patřila (klub / kouč / organizace).
//
// DRUHÁ PODMÍNKA -- ČAS VRÁCENÍ. U jednorázové lekce (soukromka, vstup do klubu) se provize vrací,
// jen když se peníze vrací PŘED začátkem lekce (storno studentem v lhůtě, zrušení poskytovatelem
// předem). Vrátí-li poskytovatel peníze až po začátku lekce, provize zůstává -- jinak by šlo
// vracet odtrénované lekce, peníze vybrat bokem a stáhnout si tím provizi na nulu.
// Online zpětná vazba nemá čas začátku: provize zůstává, když už ji kouč označil za doručenou.
// Výjimka: SPOR podaný studentem (lekce se podle něj nekonala) -- tam platí jen pravidlo dokladu.
// Členství/permanentky se neřeší tady: vrací se jen poměrná část za nevyužité dny (_prorata.js)
// a Stripe vrací provizi ve stejném poměru jako platbu.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

async function get(path) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    return r.ok ? r.json() : [];
  } catch (e) { return []; }
}

// tx: { created_at, gym_id, coach_id, organization_id, paid_to }
export async function feeRefundableForTx(tx) {
  try {
    if (!tx || !tx.created_at) return true;
    const ym = String(tx.created_at).slice(0, 7), ymd = String(tx.created_at).slice(0, 10);
    let col = null, id = null;
    if (tx.organization_id && tx.paid_to === 'organization') { col = 'organization_id'; id = tx.organization_id; }
    else if (tx.coach_id && (tx.paid_to === 'coach' || !tx.gym_id)) { col = 'coach_id'; id = tx.coach_id; }
    else if (tx.gym_id) { col = 'gym_id'; id = tx.gym_id; }
    if (!col || !id) return true;
    const ex = await get(`commission_doklady?select=id&${col}=eq.${q(id)}&or=(period_month.eq.${ym},period_month.eq.${ymd})&kind=eq.unified&limit=1`);
    return !(ex && ex.length);
  } catch (e) { return true; }
}

// ── Čas začátku lekce: datum + čas jsou místní (časová zóna klubu / kouče) ──
function tzOffsetMs(tz, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; for (const x of dtf.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second) - utcMs;
}
export function localStartMs(date, time, tz) {
  const dm = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!dm) return null;
  const tm = String(time || '').match(/(\d{1,2}):(\d{2})/);
  const naive = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], tm ? +tm[1] : 0, tm ? +tm[2] : 0);
  let off = 0; try { off = tzOffsetMs(tz || 'Europe/Prague', naive); } catch (e) { try { off = tzOffsetMs('Europe/Prague', naive); } catch (e2) {} }
  return naive - off;
}

// Začala už jednorázová lekce? (online: byla doručena)
//   kind 'private' = bookings, 'drop_in' = gym_bookings; row = řádek s potřebnými sloupci.
export async function sessionConsumed(kind, row) {
  try {
    if (!row) return false;
    const now = Date.now();
    if (kind === 'private') {
      if (String(row.type || '') === 'online') return row.fulfilled === true;   // online zpětná vazba: čerpaná = doručená
      let tz = null; if (row.coach_id) { const p = ((await get(`profiles?id=eq.${q(row.coach_id)}&select=timezone&limit=1`)) || [])[0]; tz = p && p.timezone; }
      const st = localStartMs(row.training_date, row.training_time, tz);
      return st != null && st <= now;
    }
    if (kind === 'drop_in') {
      const d = row.class_date || row.date, t = row.class_time || row.time;
      let tz = null; if (row.gym_id) { const g = ((await get(`gyms?id=eq.${q(row.gym_id)}&select=timezone&limit=1`)) || [])[0]; tz = g && g.timezone; }
      const st = localStartMs(d, t, tz);
      return st != null && st <= now;
    }
    return false;
  } catch (e) { return false; }
}

// Jednorázová lekce k platbě kartou (podle payment_intent). Členství, akce, merch -> null.
async function sessionForPI(pi) {
  const b = ((await get(`bookings?payment_intent=eq.${q(pi)}&select=coach_id,training_date,training_time,type,fulfilled,checked_in_at,student_confirmed,dispute_status&limit=1`)) || [])[0];
  if (b) return { kind: 'private', row: b };
  const g = ((await get(`gym_bookings?payment_intent=eq.${q(pi)}&select=gym_id,student_id,class_date,class_time,date,time,reception_checkin&limit=1`)) || [])[0];
  if (g) return { kind: 'drop_in', row: g };
  return null;
}

// Podle Stripe payment_intent (karta).
//   opts.dispute = true  -> vrácení po sporu podaném studentem: platí jen pravidlo dokladu.
export async function feeRefundableForPI(pi, opts = {}) {
  if (!pi) return true;
  const t = ((await get(`transactions?payment_intent=eq.${q(pi)}&select=created_at,gym_id,coach_id,organization_id,paid_to&limit=1`)) || [])[0];
  if (!(await feeRefundableForTx(t))) return false;
  if (opts.dispute) return true;
  const ses = await sessionForPI(pi);
  if (ses && ses.kind === 'private' && String(ses.row.dispute_status || '') === 'open') return true;   // otevřený spor = podal ho student
  return !(ses && await sessionConsumed(ses.kind, ses.row));
}

// Převod/QR/hotovost: provize se dá odečíst jen z transakce, jejíž provize ještě není stržená.
export function bankFeeRefundable(tx) {
  return !!tx && ['pending', 'failed'].includes(String(tx.commission_status || ''));
}
