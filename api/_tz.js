// /api/_tz.js — JEDNOTNÝ ČAS PLATFORMY: Europe/Prague (letní i zimní čas řeší Intl sám).
// Časy se ukládají v UTC (ISO). Do KTERÉHO DNE a MĚSÍCE platba patří (měsíc provize, den
// dokladu, rozsah měsíce) se ale počítá podle pražského času -- jinak platba 1. 11. ve 0:30
// spadla do října (UTC je o 1–2 h pozadu). Stejné pravidlo pro všechny poskytovatele.
export const MTL_TZ = 'Europe/Prague';
function parts(d) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: MTL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d instanceof Date ? d : new Date(d || Date.now())).forEach((x) => { p[x.type] = x.value; });
  return p;
}
export function pragueMonth(d = new Date()) { const p = parts(d); return `${p.year}-${p.month}`; }
export function pragueDate(d = new Date()) { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; }
// Měsíc posunutý o n (YYYY-MM, n může být záporné) -- čistá aritmetika nad řetězcem.
export function shiftMonth(ym, n) { const [y, m] = String(ym).split('-').map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`; }
