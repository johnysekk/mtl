// /api/_prorata.js — POMĚRNÁ ČÁST ČLENSTVÍ / PERMANENTKY ZA NEVYUŽITÉ DNY.
//
// Při ukončení členství s vrácením peněz se vrací jen to, co student ještě nevyčerpal:
//   ponechá si klub = cena × využité dny / všechny dny (den nákupu se počítá jako využitý)
//   vrací se        = cena − ponechaná část
// Stejný výpočet jako u odstoupení do 14 dnů (withdraw-membership.js). Stripe pak vrací provizi
// MTL ve stejném poměru jako platbu, takže provize z odtrénovaných dnů zůstává.

const DAY = 86400000;

// grossMinor = zaplaceno (haléře/centy), startMs/endMs = zaplacené období.
// Vrací { unused, keep, usedDays, totalDays } v haléřích, nebo null, když období neznáme.
export function prorata(grossMinor, startMs, endMs, nowMs = Date.now()) {
  const gross = Math.max(0, Math.round(Number(grossMinor) || 0));
  if (!(startMs > 0) || !(endMs > startMs)) return null;
  const totalDays = Math.max(1, Math.round((endMs - startMs) / DAY));
  const usedDays = nowMs >= endMs ? totalDays : Math.min(totalDays, Math.max(1, Math.ceil((nowMs - startMs) / DAY)));
  const keep = Math.round(gross * usedDays / totalDays);
  return { unused: Math.max(0, gross - keep), keep, usedDays, totalDays };
}

// Zaplacené období jednorázového členství k transakci: od platby do period_end členství.
// sbGet(path) -> pole řádků. Vrací { startMs, endMs } nebo null.
export async function membershipPeriodForTx(sbGet, tx) {
  if (!tx || !tx.gym_id || !tx.member_id || !tx.created_at) return null;
  const startMs = new Date(tx.created_at).getTime();
  const upto = new Date(startMs + DAY).toISOString();
  const m = ((await sbGet(`gym_memberships?gym_id=eq.${encodeURIComponent(tx.gym_id)}&student_id=eq.${encodeURIComponent(tx.member_id)}&created_at=lte.${encodeURIComponent(upto)}&order=created_at.desc&limit=1&select=period_end,months,created_at`)) || [])[0];
  if (!m) return null;
  // Konec zaplaceného období. Při ukončení se period_end přepíše na „teď", proto bereme i délku
  // podle počtu měsíců -- jinak by vrácení zapsané až po ukončení vyšlo jako nula.
  const byMonths = startMs + Math.max(1, parseInt(m.months, 10) || 1) * 30 * DAY;
  const endMs = Math.max(m.period_end ? new Date(m.period_end).getTime() : 0, byMonths);
  return { startMs, endMs };
}
