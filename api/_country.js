// ZEMĚ JAKO KÓD (ISO 3166-1, např. CZ). Signály nesou zemi jako text v jazyce, ve kterém byla appka
// zrovna puštěná („Česko", „Czechia", „Francie"…), takže se tatáž země rozpadala na víc položek
// a popisek celé oblasti vzala první řádek, který nějakou zemi měl. Tady se text převede na kód
// (názvy ze všech běžných jazyků, které umí Node/ICU) a oblast dostane zemi, kterou uvádí
// většina lidí v ní. Název pro zobrazení si appka udělá z kódu v jazyce uživatele.
export const normName = (x) => String(x || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const _CC = (() => {
  const map = {}, A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const l of ['cs', 'en', 'sk', 'de', 'pl', 'fr', 'es', 'it', 'pt', 'nl', 'hu', 'ja', 'ru', 'uk']) {
    let dn; try { dn = new Intl.DisplayNames([l], { type: 'region' }); } catch (e) { continue; }
    for (const a of A) for (const b of A) { const c = a + b; let n = null; try { n = dn.of(c); } catch (e) {} if (n && n !== c && !map[normName(n)]) map[normName(n)] = c; }
  }
  [['ceska republika', 'CZ'], ['czech republic', 'CZ'], ['cesko', 'CZ'], ['slovenska republika', 'SK'], ['usa', 'US'], ['united states of america', 'US'], ['uk', 'GB'], ['great britain', 'GB'], ['anglie', 'GB'], ['england', 'GB']]
    .forEach(([k, v]) => { map[k] = v; });
  return map;
})();
export const ccOf = (x) => { const t = String(x || '').trim(); if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase(); return _CC[normName(t)] || ''; };

