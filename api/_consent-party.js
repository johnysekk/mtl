// /api/_consent-party.js — VŮČI KOMU BYL SOUHLAS UDĚLEN.
//
// Souhlas bez druhé strany je u sporu poloviční důkaz. Strana se odvodí ze záznamu:
//   • scope = null            -> PROVOZOVATEL platformy (MTL): podmínky, ochrana údajů, marketing,
//                                smlouva s poskytovatelem...
//   • scope = id klubu        -> POSKYTOVATEL (klub): pravidla klubu, přihláška, kurz...
//   • scope = id kouče        -> POSKYTOVATEL (kouč): soukromky mladistvých, online služby...
// U souhlasů, které si údaje prodávajícího uložily už v okamžiku souhlasu (meta.seller,
// meta.seller_ico -- online koučing), má přednost tento SNÍMEK před dnešními údaji.

export const MTL_PARTY = {
  role: 'operator', name: 'Martial Training Lab s.r.o.', ico: '29836000',
  address: 'Jičínská 226/17, Žižkov, 130 00 Praha 3',
};
const addr = (r) => [r.billing_line1, r.billing_line2, [r.billing_postal, r.billing_city].filter(Boolean).join(' '), r.billing_country].filter(Boolean).join(', ');

// sbGet: (path) => Promise<rows>. scopes: pole hodnot scope / gym_id. Vrací mapu scope -> party.
export async function resolveParties(sbGet, scopes) {
  const ids = [...new Set((scopes || []).filter(Boolean).map(String))];
  const out = {};
  if (!ids.length) return out;
  const list = ids.map(encodeURIComponent).join(',');
  try {
    const gs = await sbGet(`gyms?id=in.(${list})&select=id,name,legal_name,tax_id,billing_line1,billing_line2,billing_city,billing_postal,billing_country`);
    (gs || []).forEach((g) => { out[g.id] = { role: 'provider', kind: 'club', name: g.legal_name || g.name || '', ico: g.tax_id || null, address: addr(g) || null }; });
  } catch (e) {}
  const rest = ids.filter((i) => !out[i]);
  if (rest.length) {
    try {
      const ps = await sbGet(`profiles?id=in.(${rest.map(encodeURIComponent).join(',')})&select=id,name,legal_name,tax_id,billing_line1,billing_line2,billing_city,billing_postal,billing_country`);
      (ps || []).forEach((p) => { out[p.id] = { role: 'provider', kind: 'coach', name: p.legal_name || p.name || '', ico: p.tax_id || null, address: addr(p) || null }; });
    } catch (e) {}
  }
  return out;
}

// Strana pro jeden záznam souhlasu (consent_acceptances).
export function partyFor(row, parties) {
  const m = (row && row.meta) || {};
  if (m.seller) return { role: 'provider', kind: 'coach', name: m.seller, ico: m.seller_ico || null, address: (row.scope && parties[row.scope] && parties[row.scope].address) || null, snapshot: true };
  if (!row || !row.scope) return MTL_PARTY;
  return parties[row.scope] || { role: 'provider', name: null, ico: null, address: null };
}
