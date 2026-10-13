// _oss.js — LIMIT 10 000 EUR PRO PŘESHRANIČNÍ B2C ELEKTRONICKÉ SLUŽBY (čl. 59c směrnice 2006/112/ES).
//
// MTL prodává EP a profil dodavatele (elektronicky poskytované služby). Odběratel z jiného státu
// EU BEZ PLATNÉHO DIČ je pro DPH spotřebitel. Dokud součet takových prodejů do celé EU nepřekročí
// v letošním ani loňském roce 10 000 EUR, je místem plnění ČR -- faktura jde bez DPH jako od
// neplátce, žádné OSS. Finanční správa uvádí limit i v korunách: 256 530 Kč (kurz ECB z 5. 12. 2017).
// Po překročení je místem plnění stát zákazníka (OSS) -- pak se bez DIČ znovu neprodává.
//
// Počítají se doklady s vat_mode 'b2c_eu_small' (commission_doklady, vystavuje ep-doklad.js).
// Částky v jiné měně než CZK se přepočtou kurzem ECB z fx_rates.
export const OSS_LIMIT_CZK = 256530;
export const OSS_WARN_SHARE = 0.8;      // upozornění zakladateli při 80 %

export async function b2cSmallState(sbGet) {
  const now = new Date();
  const y = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric' }).format(now));
  let rates = null;
  try { const fx = ((await sbGet('fx_rates?id=eq.ecb-latest&select=data')) || [])[0]; rates = fx && fx.data && fx.data.rates; } catch (e) {}
  const toCzk = (minor, cur) => {
    const a = (Number(minor) || 0) / 100, c = String(cur || 'CZK').toUpperCase();
    if (c === 'CZK') return a;
    if (!rates || !rates.CZK) return null;
    const eur = (c === 'EUR') ? a : (rates[c] ? a / rates[c] : null);
    return eur == null ? null : eur * rates.CZK;
  };
  const rows = (await sbGet(`commission_doklady?vat_mode=eq.b2c_eu_small&issued_at=gte.${y - 1}-01-01&select=amount,currency,issued_at,test_mode&limit=10000`)) || [];
  let cur = 0, prev = 0, unknown = false;
  for (const r of rows) {
    if (r.test_mode) continue;
    const v = toCzk(r.amount, r.currency);
    if (v == null) { unknown = true; continue; }
    if (String(r.issued_at).slice(0, 4) === String(y)) cur += v; else prev += v;
  }
  return { year: y, cur: Math.round(cur), prev: Math.round(prev), limit: OSS_LIMIT_CZK, unknown, toCzk,
    // Prodej o částce amountCzk se ještě vejde pod limit (letos ani loni nepřekročeno).
    fits(amountCzk) { return prev <= OSS_LIMIT_CZK && (cur + (Number(amountCzk) || 0)) <= OSS_LIMIT_CZK; } };
}
