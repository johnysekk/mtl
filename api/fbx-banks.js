// /api/fbx-banks.js — FINBRICKS: SEZNAM BANK.
//
// Endpoint /transaction/platform/init chce vedet, ze ktere banky se plati: bud IBAN platce
// (ten od cloveka chtit nechceme), nebo `paymentProvider` -- kod banky. Bez jednoho z nich
// vraci 264 "Add Debtor IBAN or payment provider".
//
// Seznam se bere z /status/bankInfo a vraci se ve STEJNEM TVARU, jaky uz appka zna od
// Neonomics ({ aspsps: [{ name, country, bankId, bic, logo, psu_types }] }) -- vyber banky
// v appce tak nepotrebuje zadnou zmenu, jen jiny zdroj.
//
// GET /api/fbx-banks?country=CZ

import { fbxCall, MERCHANT_ID, FBX_BASE } from './_fbx.js';

export default async function handler(req, res) {
  if (!MERCHANT_ID) return res.status(500).json({ error: 'FINBRICKS_MERCHANT_ID not configured' });
  const cc = String((req.query && req.query.country) || 'CZ').toUpperCase().slice(0, 2);

  try {
    // enabledForMerchant: jen banky, ktere ma tenhle ucet nasmlouvane -- ostatni by pri platbe
    // stejne spadly. domesticPaymentSupported: umi domaci platbu pres tohle API.
    const path = `/status/bankInfo?merchantId=${encodeURIComponent(MERCHANT_ID)}`
      + `&countryCode=${encodeURIComponent(cc)}&domesticPaymentSupported=true&enabledForMerchant=true`;
    const r = await fbxCall('GET', path, null);
    if (!r.ok) {
      const d = r.data || {};
      return res.status(502).json({
        error: d.message ? ('Finbricks ' + (d.code != null ? d.code : r.status) + ': ' + d.message) : ('Finbricks HTTP ' + r.status),
        code: d.code != null ? d.code : null,
        aspsps: [],
      });
    }
    const rows = Array.isArray(r.data) ? r.data : [];

    // BEZ IBANU PLATCE JEN TRI BANKY. /transaction/platform/init prijme samotny kod banky
    // pouze u tech, kde si platce vybere ucet az na strane banky; u ostatnich chce cislo uctu
    // platce a vraci 266 "Add Debtor IBAN or use supported payment provider". Nemelo by smysl
    // nabizet cloveku patnact bank, z nichz dvanact skonci chybou.
    // MOCK_COBS je simulator banky pro sandbox -- prihlasi se testovacimi udaji a plati se
    // nanecisto, takze se da projit cely tok az po potvrzeni a zauctovani. Filtrovat ho pryc
    // bylo to nejhorsi, co se dalo udelat: prave v nem se ma testovat.
    const PLATFORM_OK = ['MBANK', 'RAIFFEISEN', 'UNICREDIT', 'MOCK_COBS'];
    const flow = String((req.query && req.query.flow) || 'platform').toLowerCase();

    const aspsps = rows
      .filter((b) => b && b.paymentProvider)
      .filter((b) => flow !== 'platform' || PLATFORM_OK.includes(String(b.paymentProvider).toUpperCase()))
      .map((b) => ({
        name: b.bankName || b.paymentProvider,
        country: b.countryCode || cc,
        bankId: b.paymentProvider,          // sem appka posila to, co pak jde do paymentProvider
        bic: b.bic || null,
        // logoUrl je relativni cesta na jejich CDN; absolutni, aby ji prohlizec nacetl.
        logo: b.logoUrl ? (String(b.logoUrl).startsWith('http') ? b.logoUrl : (FBX_BASE.replace('api.', 'cdn.') + b.logoUrl)) : null,
        psu_types: ['personal'],
        instant: !!(b.domesticInstantPaymentDebtorSupported),
      }))
      .sort((a, b) => {
        // V sandboxu patri testovaci banka nahoru -- je to jedina, kde jde platba dokoncit.
        const am = a.bankId === 'MOCK_COBS' ? 0 : 1, bm = b.bankId === 'MOCK_COBS' ? 0 : 1;
        return (am - bm) || a.name.localeCompare(b.name, 'cs');
      });

    return res.status(200).json({ ok: true, flow, aspsps, total: rows.length });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e), aspsps: [] });
  }
}
