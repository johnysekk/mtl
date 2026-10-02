// /api/_fee-window.js — VRACÍ SE PROVIZE MTL?
//
// Pravidlo (stejné pro kartu i převod/QR/hotovost):
//   Provize se vrací (poměrně k vrácené částce), JEN DOKUD NENÍ VYSTAVENÝ DOKLAD o provizi
//   za období, ve kterém platba proběhla. Potom už ne -- student dostane své peníze stejně,
//   ale MTL svou provizi nevrací. Díky tomu vystavený doklad vždy sedí a nevznikají dobropisy.
//
// Období = měsíc platby (YYYY-MM); poskytovatelé s denním dokladem mají období = den (YYYY-MM-DD).
// Doklad hledáme v commission_doklady u subjektu, kterému platba patřila (klub / kouč / organizace).

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

// Podle Stripe payment_intent (karta).
export async function feeRefundableForPI(pi) {
  if (!pi) return true;
  const t = ((await get(`transactions?payment_intent=eq.${q(pi)}&select=created_at,gym_id,coach_id,organization_id,paid_to&limit=1`)) || [])[0];
  return feeRefundableForTx(t);
}

// Převod/QR/hotovost: provize se dá odečíst jen z transakce, jejíž provize ještě není stržená.
export function bankFeeRefundable(tx) {
  return !!tx && ['pending', 'failed'].includes(String(tx.commission_status || ''));
}
