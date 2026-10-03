// /api/_sell-kind.js — ČLENSTVÍ, NEBO PERMANENTKA?
//
// Jediný zdroj pravdy pro to, jak se prodaná „členská" položka jmenuje a jak se chová. Rozhoduje,
// KDO prodává (komu jdou peníze), ne jak se tarif v klubu jmenuje:
//   • prodává SPOLEK (klub s org_form='nonprofit', peníze jdou klubu)  -> 'membership' (Členství)
//   • prodává podnikatel: klub OSVČ / s.r.o., nebo kouč na svůj účet  -> 'pass' (Permanentka)
//   • organizace (asociace, federace)                                 -> 'membership'
// Interní klíče se NEMĚNÍ: tabulka gym_memberships, typ transakce 'membership' (stejně jako
// v databázi zůstalo „gym", i když appka všude říká „klub"). Mění se jen texty, které člověk vidí.
// Stejná logika je v index.html (_sellKind) -- při změně upravit obě.

export function sellKind({ orgForm, paidTo } = {}) {
  const p = String(paidTo || '');
  if (p === 'organization' || p === 'org') return 'membership';
  if (p === 'coach') return 'pass';
  return orgForm === 'nonprofit' ? 'membership' : 'pass';
}

export function sellLabel(kind, lang) {
  const en = lang === 'en';
  return kind === 'membership' ? (en ? 'Membership' : 'Členství') : (en ? 'Pass' : 'Permanentka');
}

// Pohodlná varianta podle klubu z databáze (u transakcí a plateb, kde máme gym_id + paid_to).
export async function sellKindFor(sbGet, { gymId, paidTo }) {
  let orgForm = null;
  try {
    if (gymId) { const g = ((await sbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=org_form`)) || [])[0]; orgForm = g && g.org_form; }
  } catch (e) {}
  return sellKind({ orgForm, paidTo });
}
