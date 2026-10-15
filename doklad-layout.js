// /doklad-layout.js — JEDINÝ OBSAH A VZHLED VŠECH DOKLADŮ. Oct 15, 2026.
//
// Faktury MTL (provize, Exclusive Partner, profil dodavatele), doklady o úhradě a doklady
// studentům od klubu / kouče. Odsud bere:
//   appka      -- <script type="module"> v index.html -> window.MTLDoklad (zobrazení + Tisk / PDF)
//   e-mail     -- api/unified-doklad-cron.js, api/ep-doklad.js, api/_receipt.js (HTML i rámeček stavu)
//   PDF        -- api/_doklad-pdf.js (příloha e-mailu) přes renderPdf()
// Dřív měl každý z nich vlastní kopii textů a rozvržení a rozcházely se (PDF psalo „DUZP",
// appka „Datum uskutečnění plnění"; jiné pořadí, jiné řádky). Teď existuje jedna:
//   1) model (mtlModel / studentModel) -- CO na dokladu je: nadpis, strany, údaje, položky,
//      DPH, celkem, stav úhrady, poznámky. Všechny texty a pořadí jsou jen tady.
//   2) renderHtml / renderPdf -- JAK se to nakreslí. Neznají žádný konkrétní doklad, jen bloky
//      modelu, takže se HTML a PDF nemůžou obsahově rozejít.
// Změna vzhledu nebo textu dokladu = změna tady, nikde jinde.
//
// Doklad se kreslí VÝHRADNĚ ZE SNÍMKU (commission_doklady / doklady). Nic se nedoplňuje
// z dnešních dat.

// ── POMOCNÉ ──────────────────────────────────────────────────────────────────────────────────
const _isEn = (lang) => lang === 'en';
export function esc(x) { return String(x == null ? '' : x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]); }

// Částka v haléřích / centech -> „4 990,00 Kč" / „4,990.00 CZK".
export function money(minor, cur, lang) {
  const en = _isEn(lang), C = String(cur || 'CZK').toUpperCase();
  const v = Math.round(Number(minor || 0)) / 100;
  let s; try { s = v.toLocaleString(en ? 'en-GB' : 'cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (e) { s = v.toFixed(2); }
  return s + ' ' + ((!en && C === 'CZK') ? 'Kč' : C);
}
// Datum: „YYYY-MM-DD" se bere doslova (žádný posun časovou zónou), okamžik v zóně dodavatele.
export function fmtDate(v, lang, tz) {
  const en = _isEn(lang);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (m) return en ? (+m[3] + '/' + (+m[2]) + '/' + m[1]) : (+m[3] + '. ' + (+m[2]) + '. ' + m[1]);
  if (!v) return '';
  try { return new Date(v).toLocaleDateString(en ? 'en-GB' : 'cs-CZ', { timeZone: tz || 'Europe/Prague' }); } catch (e) { return ''; }
}
const _MO = { cs: ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] };
// Období: „2026-10" -> „říjen 2026", „2026-10-15" (denní režim) -> „15. 10. 2026".
export function periodLabel(p, lang) {
  p = String(p || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return fmtDate(p, lang);
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  return m ? (_MO[_isEn(lang) ? 'en' : 'cs'][+m[2] - 1] + ' ' + m[1]) : p;
}
export function countryName(cc, lang) {
  const v = String(cc || '').trim().toUpperCase(); if (!v) return '';
  try { return new Intl.DisplayNames([_isEn(lang) ? 'en' : 'cs'], { type: 'region' }).of(v) || v; } catch (e) { return v; }
}
// Číslo dokladu: přidělené při vystavení (doc_no), u starších postaru MTL-<id>.
export function docNo(d) { return (d && d.doc_no) || ('MTL-' + (d && d.id != null ? d.id : 'X')); }

// VĚTA O DAŇOVÉM REŽIMU. Snímek nese českou větu (vat_note); anglický doklad ji podle režimu
// přeloží. Neznámý režim (starší snímky) = původní věta.
const _NOTE_EN = {
  no_vat_supplier: 'The supplier is not a VAT payer.',
  reverse_charge: 'Reverse charge — VAT is accounted for by the customer in their own country; the supplier does not charge it.',
  reverse_charge_np: 'The supplier is not a VAT payer. Reverse charge — VAT is accounted for by the customer in their own country; the supplier does not charge it.',
  oss_pending: 'Customer in another EU state without a VAT ID — under review by the accountant.',
  b2c_eu_small_legacy: 'The supplier is not a VAT payer. Place of supply: Czech Republic — cross-border electronic services to EU consumers did not exceed EUR 10,000 (Art. 59c of Directive 2006/112/EC).',
  need_vat: 'Customer in another EU state without a VAT ID — the VAT treatment cannot be determined.',
  outside_eu: 'Supply outside the EU — no Czech VAT (Section 9 of the Czech VAT Act).',
  exempt_membership: 'VAT exempt — supply in return for a membership fee to own members (Section 61(a) of the Czech VAT Act).',
};
export function vatNoteFor(mode, note, lang) {
  if (!_isEn(lang)) return note || null;
  if (mode === 'reverse_charge' && /není plátcem/.test(String(note || ''))) return _NOTE_EN.reverse_charge_np;
  if (mode === 'b2c_eu_small') return /Místo plnění/.test(String(note || '')) ? _NOTE_EN.b2c_eu_small_legacy : (note ? _NOTE_EN.no_vat_supplier : null);
  return _NOTE_EN[mode] || note || null;
}
// Druh položky je ve snímku česky; anglicky se přeloží jen druh, název od poskytovatele zůstává.
const _KIND_EN = { 'Online předplatné': 'Online subscription', 'Permanentka': 'Pass', 'Členství': 'Membership',
  'Jednorázový vstup': 'Drop-in', 'Soukromá lekce 1:1': '1:1 lesson', 'Online lekce': 'Online lesson',
  'Vstupenka': 'Ticket', 'Zboží': 'Merchandise', 'Kurz pro členy': 'Members course', 'Kurz': 'Course' };
export function itemLabelEn(label) {
  const s = String(label || ''); const i = s.indexOf(' · ');
  const head = i >= 0 ? s.slice(0, i) : s, tail = i >= 0 ? s.slice(i) : '';
  return (_KIND_EN[head] || head) + tail;
}
// Název dokladu o pozdější úhradě podle toho, co uhrazuje.
export function receiptTitle(refKind, lang) {
  const en = _isEn(lang);
  if (refKind === 'partner_sub') return en ? 'Receipt for paid Exclusive Partner subscription' : 'Doklad o uhrazeném předplatném Exclusive Partner';
  if (refKind === 'supplier_sub') return en ? 'Receipt for paid MTL supplier profile subscription' : 'Doklad o uhrazeném předplatném profilu dodavatele MTL';
  return en ? 'Receipt for paid MTL commission' : 'Doklad o uhrazené provizi MTL';
}
// Faktury uhrazené dokladem o úhradě (starší doklady bez line_items mají jen ref_doklad_id).
export function rcptItems(dk) {
  const li = (Array.isArray(dk.line_items) ? dk.line_items : []).filter((it) => it && it.ref != null);
  if (li.length) return li;
  return dk.ref_doklad_id != null ? [{ ref: dk.ref_doklad_id, doc_no: 'MTL-' + dk.ref_doklad_id, period: dk.period_month, amount: dk.amount }] : [];
}

// ── TEXTY ────────────────────────────────────────────────────────────────────────────────────
const TX = {
  cs: { supplier: 'Dodavatel', customer: 'Odběratel', provider: 'Poskytovatel služby', participant: 'Účastník',
    invNo: 'Číslo faktury', docNo: 'Číslo dokladu', issued: 'Datum vystavení', duzp: 'Datum uskutečnění plnění',
    period: 'Období', subPeriod: 'Období předplatného', billedAs: 'Fakturováno za', method: 'Způsob úhrady', card: 'Platební karta',
    session: 'Termín lekce', payRef: 'Reference platby (Stripe)',
    regno: 'IČO', vatid: 'DIČ', register: 'Zapsáno v obchodním rejstříku', registerStudent: 'Zápis v rejstříku', phone: 'Tel.', email: 'E-mail',
    inOrg: 'Organizace v MTL', inGym: 'Klub v MTL', inCoach: 'Kouč v MTL',
    kOrg: 'organizace', kGym: 'klub', kCoachPayout: 'kouč · režim klub', kCoach: 'kouč',
    payForm: 'Forma platby', rate: 'Sazba', count: 'Plateb', volume: 'Objem plateb', fee: 'Provize',
    item: 'Položka', amount: 'Částka', invPaid: 'Uhrazená faktura', amountPaid: 'Uhrazeno',
    base: 'Základ daně', vat: 'DPH', total: 'Celkem', totalPaid: 'Uhrazeno celkem',
    notVatSup: 'Dodavatel není plátcem DPH.', notVatProv: 'Poskytovatel není plátcem DPH.',
    payments: 'Zprostředkovaných plateb', vol: 'objem',
    mStripe: 'Stripe (karta)', mPis: 'Platba z banky', mQr: 'QR platba', mCash: 'Hotovost', acq: 'akvizice (nový člen z MTL)',
    storeFee: 'Poplatek App Store / Google Play (10 % + 21 % DPH) · online koučink koupený v mobilní aplikaci',
    tCommission: 'Faktura — provize MTL', tEp: 'Faktura — předplatné Exclusive Partner', tSup: 'Faktura — předplatné profilu dodavatele MTL',
    tStudent: 'Potvrzení o platbě', iEp: 'Exclusive MTL Partner — předplatné', iSup: 'Profil dodavatele MTL — předplatné',
    test: 'TESTOVACÍ REŽIM — nejde o formální daňový doklad a k žádné skutečné transakci nedošlo',
    preview: 'NÁHLED — částky jsou ukázkové',
    noSnapT: 'Tenhle doklad nemá snímek',
    noSnap: 'Nebudeme ho skládat z dnešních dat — nebyl by to doklad, který byl vystaven. Částky najdeš v účetnictví.',
    studentNote: 'Platné potvrzení o zaplacení pro tvé účely. Poskytovatel služby je uveden výše. MTL platbu jen zprostředkovává. Potřebuješ formální daňový doklad (fakturu)? Vyžádej si ho u poskytovatele. Vygenerováno přes MTL.',
    payment: 'Platba', invoice: 'faktura', invoices: 'faktury' },
  en: { supplier: 'Supplier', customer: 'Customer', provider: 'Service provider', participant: 'Participant',
    invNo: 'Invoice no.', docNo: 'Document no.', issued: 'Issued', duzp: 'Date of supply',
    period: 'Period', subPeriod: 'Subscription period', billedAs: 'Billed as', method: 'Payment method', card: 'Payment card',
    session: 'Session date', payRef: 'Payment ref (Stripe)',
    regno: 'Reg. number', vatid: 'VAT ID', register: 'Commercial register', registerStudent: 'Registration', phone: 'Phone', email: 'E-mail',
    inOrg: 'Organisation in MTL', inGym: 'Club in MTL', inCoach: 'Coach in MTL',
    kOrg: 'organisation', kGym: 'club', kCoachPayout: 'coach · club mode', kCoach: 'coach',
    payForm: 'Payment form', rate: 'Rate', count: 'Payments', volume: 'Volume', fee: 'Commission',
    item: 'Item', amount: 'Amount', invPaid: 'Invoice paid', amountPaid: 'Amount paid',
    base: 'Tax base', vat: 'VAT', total: 'Total', totalPaid: 'Total paid',
    notVatSup: 'The supplier is not a VAT payer.', notVatProv: 'The provider is not a VAT payer.',
    payments: 'Payments intermediated', vol: 'volume',
    mStripe: 'Stripe (card)', mPis: 'Bank payment', mQr: 'QR payment', mCash: 'Cash', acq: 'acquisition (new member from MTL)',
    storeFee: 'App Store / Google Play fee (10 % + 21 % VAT) · online coaching bought in the mobile app',
    tCommission: 'Invoice — MTL commission', tEp: 'Invoice — Exclusive Partner subscription', tSup: 'Invoice — MTL supplier profile subscription',
    tStudent: 'Payment confirmation', iEp: 'Exclusive MTL Partner — subscription', iSup: 'MTL supplier profile — subscription',
    test: 'TEST MODE — not a formal tax document; no actual transaction took place',
    preview: 'PREVIEW — sample amounts',
    noSnapT: 'This receipt has no snapshot',
    noSnap: 'We will not rebuild it from today’s data — that would not be the document that was issued. The amounts are in Accounting.',
    studentNote: 'A valid proof of payment for your records. The service provider is named above. MTL only mediates the payment. Need a formal tax invoice? Request it from the provider. Generated via MTL.',
    payment: 'Payment', invoice: 'invoice', invoices: 'invoices' },
};
const _t = (lang) => TX[_isEn(lang) ? 'en' : 'cs'];
function _method(m, lang) { const T = _t(lang); return m === 'stripe' ? T.mStripe : (m === 'pis' ? T.mPis : (m === 'qr' ? T.mQr : (m === 'cash' ? T.mCash : (m || '—')))); }
function _pct(r, lang) { return r != null ? (Math.round(r * 1000) / 10).toString().replace('.', _isEn(lang) ? '.' : ',') + ' %' : '—'; }

// ── STAV ÚHRADY FAKTURY MTL ──────────────────────────────────────────────────────────────────
// Vystavená faktura se NIKDY nemění. due_amount = co v okamžiku vystavení nebylo stržené;
// pozdější úhradu dokládá samostatný doklad o úhradě (kind 'payment_receipt').
export function mtlStatus(dk, lang) {
  const en = _isEn(lang), cur = dk.currency, M = (x) => money(x, cur, lang), D = (v) => fmtDate(v, lang);
  if (dk.kind === 'payment_receipt') {
    const it = rcptItems(dk), li = it.map((x) => (x.doc_no || ('MTL-' + x.ref)) + (x.period ? (' (' + periodLabel(x.period, lang) + ')') : '')).join(', ');
    return { paid: true, head: (en ? 'PAID: ' : 'UHRAZENO: ') + M(dk.amount),
      body: en ? ('Payment of ' + (it.length > 1 ? 'invoices ' : 'invoice ') + li + ', received on ' + D(dk.charged_at) + '. This is not a request for payment.')
               : ('Úhrada ' + (it.length > 1 ? 'faktur ' : 'faktury ') + li + ', přijata dne ' + D(dk.charged_at) + '. Nejde o výzvu k platbě.') };
  }
  if (dk.kind === 'partner_sub' || dk.kind === 'supplier_sub') {
    if (Number(dk.due_amount) > 0) {
      const li = (Array.isArray(dk.line_items) ? dk.line_items[0] : null) || {};
      return { paid: false, unpaid: true, failed: true, payUrl: li.pay_url || null, head: (en ? 'AMOUNT DUE: ' : 'K ÚHRADĚ: ') + M(dk.due_amount),
        body: en ? 'The subscription could not be charged to your card. We will retry automatically; you can also pay right away.'
                 : 'Předplatné se nepodařilo strhnout z karty. Platbu zkusíme strhnout znovu automaticky; zaplatit můžeš i hned.' };
    }
    return { paid: true, head: en ? 'PAID IN FULL' : 'UHRAZENO V PLNÉ VÝŠI',
      body: en ? ('The amount was paid by payment card on ' + D(dk.issued_at || dk.charged_at) + '. This is not a request for payment.')
               : ('Částka byla uhrazena platební kartou dne ' + D(dk.issued_at || dk.charged_at) + '. Nejde o výzvu k platbě.') };
  }
  // Provize: Stripe se strhává průběžně, banka / QR / hotovost z uložené karty po uzávěrce.
  const due = Math.max(0, Number(dk.due_amount) || 0);
  const bankPaid = Math.max(0, (Number(dk.bank_amount) || 0) - due), stripePaid = Math.max(0, Number(dk.stripe_amount) || 0);
  const parts = [];
  if (bankPaid > 0) parts.push(en ? (M(bankPaid) + ' was charged to the saved card on ' + D(dk.charged_at)) : (M(bankPaid) + ' bylo strženo z uložené karty dne ' + D(dk.charged_at)));
  if (stripePaid > 0) parts.push(en ? (M(stripePaid) + ' was taken directly with each card payment') : (M(stripePaid) + ' bylo strženo přímo při každé platbě kartou'));
  // Stejné stržení uhradilo i zbytek starších faktur (paid_other) -- informace o platbě, ne položka.
  const po = (Array.isArray(dk.paid_other) ? dk.paid_other : []).map((o) => (en ? 'invoice ' : 'faktura ') + (o.doc_no || ('MTL-' + o.ref)) + ' (' + periodLabel(o.period, lang) + ') ' + M(o.amount) + ' — '
    + (o.reason === 'below_min' ? (en ? 'not charged earlier, below the 50 CZK minimum for a card charge' : 'dříve nestrženo, nedosáhlo minima 50 Kč pro platbu kartou')
                                : (en ? 'outstanding after an unsuccessful charge' : 'doplatek po neúspěšném stržení')));
  const poT = po.length ? ((en ? 'The same charge also paid the remainder of older invoices: ' : 'Stejným stržením byl uhrazen i zbytek starších faktur: ') + po.join('; ') + '. ') : '';
  if (!due) return { paid: true, head: en ? 'PAID IN FULL' : 'UHRAZENO V PLNÉ VÝŠI',
    body: (parts.length ? ((en ? 'The amount has already been charged: ' : 'Částka už byla stržena: ') + parts.join('; ') + '. ') : '') + poT + (en ? 'This is not a request for payment.' : 'Nejde o výzvu k platbě.') };
  const dd = dk.due_date ? fmtDate(String(dk.due_date).slice(0, 10), lang) : '';
  const rs = dk.due_reason || (dk.due_date ? 'failed' : 'below_min');
  // KDE TO V APPCE JE -- podle toho, komu faktura patří (ověřeno v index.html):
  //   Zaplatit hned: u faktury v appce; u klubu i nahoře ve Spravovat klub, u kouče v Přehledu kouče.
  //   Karta na provizi: klub -> Nastavení klubu → Režim plateb a výplatní účet, kouč -> Nastavení
  //   kouče → Režim plateb a výplatní účet, organizace -> Platby a provize organizace → Karta na provizi.
  const ent = dk.organization_id ? 'org' : (dk.gym_id ? 'gym' : 'coach');
  const payWhere = ent === 'org' ? (en ? 'on this invoice in the app' : 'u této faktury v appce')
    : ent === 'gym' ? (en ? 'on this invoice in the app or at the top of Manage club' : 'u této faktury v appce nebo nahoře ve Spravovat klub')
    : (en ? 'on this invoice in the app or in Coach overview' : 'u této faktury v appce nebo v Přehledu kouče');
  const cardWhere = ent === 'org' ? (en ? 'the organisation’s Payments & commission → Commission card' : 'Platby a provize organizace → Karta na provizi')
    : ent === 'gym' ? (en ? 'Club settings → Payment mode and payout account' : 'Nastavení klubu → Režim plateb a výplatní účet')
    : (en ? 'Coach settings → Payment mode and payout account' : 'Nastavení kouče → Režim plateb a výplatní účet');
  const why = rs === 'failed'
    ? (en ? ('The remaining amount could not be charged to the saved card. We will try again automatically; you can also pay it right away with the Pay now button ' + payWhere + '.')
          : ('Zbývající částku se nepodařilo strhnout z uložené karty. Zkusíme to znovu automaticky; uhradit ji můžeš i hned tlačítkem Zaplatit hned ' + payWhere + '.'))
    : rs === 'not_charged'
    ? (en ? ('The remaining amount has not been charged yet. We will charge it to the saved card automatically; you can also pay it right away with the Pay now button ' + payWhere + '.')
          : ('Zbývající částka zatím nebyla stržena. Strhneme ji z uložené karty automaticky; uhradit ji můžeš i hned tlačítkem Zaplatit hned ' + payWhere + '.'))
    : rs === 'no_card'
    ? (en ? ('There is no saved payment card to charge the remaining amount. Add one in ' + cardWhere + ', or pay right away with the Pay now button ' + payWhere + '.')
          : ('Zbývající částku nebylo z čeho strhnout — chybí uložená platební karta. Doplň ji v ' + cardWhere + ', nebo zaplať hned tlačítkem Zaplatit hned ' + payWhere + '.'))
    : (en ? 'The remaining amount is below the minimum for a card charge; it will be charged to the saved card together with the next commission. There is nothing to pay manually.'
          : 'Zbývající částka je pod minimem pro platbu kartou; strhneme ji z uložené karty spolu s další provizí. Ručně není potřeba nic platit.');
  return { paid: false, unpaid: true, failed: rs !== 'below_min',
    head: (en ? 'AMOUNT DUE: ' : 'K ÚHRADĚ: ') + M(due) + (dd ? ((en ? ' — due ' : ' — splatnost ') + dd) : ''),
    body: (parts.length ? ((en ? 'Already paid: ' : 'Už uhrazeno: ') + parts.join('; ') + '. ') : '') + why };
}

// Období předplatného od–do. Stripe dává konec jako začátek dalšího období, proto o den méně.
export function subPeriod(dk, lang) {
  const li = (Array.isArray(dk.line_items) ? dk.line_items[0] : null) || {};
  try { if (li.period_start && li.period_end) return fmtDate(li.period_start, lang) + ' – ' + fmtDate(new Date(new Date(li.period_end).getTime() - 86400000).toISOString(), lang); } catch (e) {}
  return periodLabel(dk.period_month, lang);
}

// ── MODEL: FAKTURA / DOKLAD MTL (commission_doklady) ─────────────────────────────────────────
// opts.preview = ukázka v nastavení (pruh „NÁHLED").
export function mtlModel(dk, lang, opts) {
  opts = opts || {};
  const T = _t(lang), en = _isEn(lang), cur = dk.currency, M = (x) => money(x, cur, lang), D = (v) => fmtDate(v, lang);
  // BRANDING: faktury a doklady vystavuje MTL -> červené „MTL" nad nadpisem. Doklad studentovi ho nemá:
  // tam je prodejcem klub / kouč, MTL jen zprostředkovává.
  const m = { lang, preview: !!opts.preview, test: dk.test_mode ? T.test : null, docTitle: docNo(dk), brand: true };
  m.hasSnap = !!((dk.cust_name || dk.cust_ico) && (dk.sup_name || dk.sup_ico));
  if (!m.hasSnap) { m.title = T.noSnapT; m.notes = [T.noSnap]; return m; }
  const sup = [dk.sup_name, dk.sup_address, dk.sup_country ? countryName(dk.sup_country, lang) : '', dk.sup_ico ? (T.regno + ': ' + dk.sup_ico) : '',
    dk.sup_dic ? (T.vatid + ': ' + dk.sup_dic) : '', dk.sup_register ? (T.register + ': ' + dk.sup_register) : '',
    dk.sup_phone ? (T.phone + ': ' + dk.sup_phone) : '', dk.sup_email ? (T.email + ': ' + dk.sup_email) : ''].filter(Boolean);
  const inMtl = dk.organization_id ? T.inOrg : (dk.gym_id ? T.inGym : T.inCoach);
  const cust = [dk.cust_name || '—', dk.cust_trade_name ? (inMtl + ': ' + dk.cust_trade_name) : '', dk.cust_address, dk.cust_country ? countryName(dk.cust_country, lang) : '',
    dk.cust_ico ? (T.regno + ': ' + dk.cust_ico) : '', dk.cust_dic ? (T.vatid + ': ' + dk.cust_dic) : '',
    dk.cust_phone ? (T.phone + ': ' + dk.cust_phone) : '', dk.cust_email ? (T.email + ': ' + dk.cust_email) : ''].filter(Boolean);
  m.parties = [{ label: T.supplier, lines: sup }, { label: T.customer, lines: cust }];
  m.status = mtlStatus(dk, lang);
  const duzp = dk.duzp ? D(String(dk.duzp).slice(0, 10)) : '';
  // DPH: rozpis jen u plátce s domácím plněním (a u EP spotřebiteli z EU pod limitem); jinak věta o režimu.
  const rate = dk.sup_vat_rate != null ? Number(dk.sup_vat_rate) : 21;
  const vatShow = !!dk.sup_vat_payer && rate > 0 && (!dk.vat_mode || dk.vat_mode === 'domestic' || dk.vat_mode === 'b2c_eu_small');
  const vatLines = () => { const amt = Number(dk.amount || 0), base = amt / (1 + rate / 100); return [[T.base, M(base)], [T.vat + ' ' + rate + ' %', M(amt - base)]]; };
  const vatNote = () => vatNoteFor(dk.vat_mode, dk.vat_note, lang) || (dk.sup_vat_payer ? null : T.notVatSup);
  const items = Array.isArray(dk.line_items) ? dk.line_items : [];

  if (dk.kind === 'payment_receipt') {
    m.title = receiptTitle(dk.ref_kind, lang);
    m.facts = [[T.docNo, docNo(dk)], [T.issued, D(dk.issued_at || dk.charged_at)]];
    m.table = { cols: [{ t: T.invPaid, w: 2 }, { t: T.period, w: 2 }, { t: T.amountPaid, a: 'r', w: 1.4 }],
      rows: rcptItems(dk).map((it) => [it.doc_no || ('MTL-' + it.ref), periodLabel(it.period, lang), M(it.amount)]) };
    m.total = [T.totalPaid, M(dk.amount)];
    return m;
  }
  if (dk.kind === 'partner_sub' || dk.kind === 'supplier_sub') {
    const isSup = dk.kind === 'supplier_sub', li = items[0] || {};
    m.title = isSup ? T.tSup : T.tEp;
    // Období od–do; Stripe dává konec jako začátek dalšího období, proto o den méně.
    const per = subPeriod(dk, lang);
    m.facts = [[T.invNo, docNo(dk)], [T.issued, D(dk.issued_at || dk.charged_at)], [T.subPeriod, per], [T.duzp, duzp], [T.method, m.status.paid ? T.card : '']];
    // Položka podle snímku (česky label, anglicky label_en -- má ho doklad od stupňů EP); starší
    // doklady bez anglického názvu: druh + měsíc.
    const label = en ? (li.label_en || ((isSup ? T.iSup : T.iEp) + ' ' + String(dk.period_month || ''))) : (li.label || ((isSup ? T.iSup : T.iEp) + ' ' + String(dk.period_month || '')));
    m.table = { cols: [{ t: T.item, w: 3 }, { t: T.subPeriod, a: 'c', w: 2 }, { t: T.amount, a: 'r', w: 1.4 }], rows: [[label, per, M(dk.amount)]] };
  } else {
    m.title = T.tCommission;
    const kind = dk.organization_id ? T.kOrg : (dk.gym_id ? T.kGym : (dk.billing_identity === 'payout' ? T.kCoachPayout : T.kCoach));
    m.facts = [[T.invNo, docNo(dk)], [T.issued, D(dk.charged_at)], [T.period, periodLabel(dk.period_month, lang)], [T.duzp, duzp], [T.billedAs, kind]];
    // Řádek obchodu s aplikacemi (online koučink z nativní appky) není provize MTL -- poplatek Apple / Google.
    const lbl = (i) => i.store ? (T.storeFee + ((i.method && i.method !== 'stripe') ? (' · ' + _method(i.method, lang)) : ''))
                               : (_method(i.method, lang) + (i.acq ? (' · ' + T.acq) : ''));
    m.table = { cols: [{ t: T.payForm, w: 2.6 }, { t: T.rate, a: 'c', w: 1 }, { t: T.count, a: 'c', w: 1 }, { t: T.volume, a: 'r', w: 1.6 }, { t: T.fee, a: 'r', w: 1.5 }],
      rows: items.map((i) => [lbl(i), _pct(i.rate, lang), String(i.count || 0), M(i.gross), M(i.fee)]) };
    const cnt = items.filter((i) => !i.store).reduce((a, i) => a + (i.count || 0), 0);
    const vol = items.reduce((a, i) => a + (i.store ? (i.cut || 0) : (i.gross || 0)), 0);
    m.notes = [T.payments + ': ' + cnt + ' · ' + T.vol + ' ' + M(vol)];
  }
  m.facts = m.facts.filter((f) => f[1]);
  if (vatShow) m.sums = vatLines(); else m.vatNote = vatNote();
  m.total = [T.total, M(dk.amount)];
  return m;
}

// ── MODEL: DOKLAD STUDENTOVI OD KLUBU / KOUČE (doklady) ──────────────────────────────────────
export function studentModel(dk, lang, opts) {
  opts = opts || {};
  const T = _t(lang), en = _isEn(lang), tz = dk.sup_tz || 'Europe/Prague', cur = dk.currency || 'CZK';
  const D = (v) => fmtDate(v, lang, tz);
  const m = { lang, preview: !!opts.preview, test: dk.test_mode ? T.test : null, docTitle: dk.doklad_no || T.tStudent, hasSnap: true, title: T.tStudent };
  const sup = [dk.sup_name || (en ? 'Provider' : 'Poskytovatel'), dk.sup_address, dk.sup_country ? countryName(dk.sup_country, lang) : '',
    dk.sup_ico ? (T.regno + ': ' + dk.sup_ico) : '', dk.sup_dic ? (T.vatid + ': ' + dk.sup_dic) : '',
    dk.sup_register ? (T.registerStudent + ': ' + dk.sup_register) : '',
    dk.sup_phone ? (T.phone + ': ' + dk.sup_phone) : '', dk.sup_email ? (T.email + ': ' + dk.sup_email) : ''].filter(Boolean);
  // Odběratel = kdo platil; účastník jen když se liší (zástupce platí za mladistvého).
  const payer = String(dk.cust_name || '').trim(), part = String(dk.participant_name || '').trim();
  const buyer = payer || part || '—', participant = (part && part !== payer) ? part : '';
  m.parties = [{ label: T.provider, lines: sup }, { label: T.customer, lines: [buyer, participant ? (T.participant + ': ' + participant) : ''].filter(Boolean) }];
  const isPayer = !!dk.sup_vat_payer, rate = isPayer ? (dk.sup_vat_rate != null ? Number(dk.sup_vat_rate) : 21) : 0;
  // Termín lekce, ne datum plnění: platba předem = plnění dnem platby; termín se přesunem mění.
  const sess = String(dk.session_at || '').trim(), sDate = sess.slice(0, 10), sTime = sess.slice(11).trim();
  const ref = (dk.payment_intent && !String(dk.payment_intent).startsWith('pis')) ? String(dk.payment_intent) : '';
  m.facts = [[T.docNo, dk.doklad_no || ''], [T.issued, D(dk.issued_at)],
    // Datum uskutečnění plnění jen u plátce DPH (povinný údaj daňového dokladu).
    [T.duzp, (dk.duzp && isPayer) ? fmtDate(String(dk.duzp).slice(0, 10), lang) : ''],
    [T.session, sDate ? ((fmtDate(sDate, lang) || sDate) + (sTime ? (' ' + sTime) : '')) : ''],
    [T.payRef, ref]].filter((f) => f[1]);
  let item = String(dk.item_label || '').trim() || T.payment;
  if (en) item = itemLabelEn(item);
  m.table = { cols: [{ t: T.item, w: 4 }, { t: T.amount, a: 'r', w: 1.4 }], rows: [[item, money(dk.amount, cur, lang)]] };
  if (isPayer) { const amt = Number(dk.amount || 0), base = Math.round(amt / (1 + rate / 100)); m.sums = [[T.base, money(base, cur, lang)], [T.vat + ' ' + rate + ' %', money(amt - base, cur, lang)]]; }
  const vn = dk.vat_note ? vatNoteFor(dk.vat_mode, dk.vat_note, lang) : null;
  m.vatNote = vn || (isPayer ? null : T.notVatProv);
  m.total = [T.total, money(dk.amount, cur, lang)];
  m.notes = [T.studentNote];
  return m;
}

// ── HTML ─────────────────────────────────────────────────────────────────────────────────────
// Jen inline styly, takže stejné HTML funguje v appce, při tisku i v těle e-mailu.
const BRAND = '#E8001D';   // červená appky (index.html --red)
const C = { ink: '#1a1a1a', mid: '#555', lbl: '#777', line: '#e6e6e6', line2: '#eee', head: '#f5f2ee',
  ok: { bg: '#EAF7EE', bd: '#A8E6C0', fg: '#0E6B3A' }, due: { bg: '#FFF4E5', bd: '#F0C674', fg: '#8a5a00' }, test: { bg: '#FDECEC', bd: '#F3C0C0', fg: '#8a1c1c' } };
export function statusBoxHtml(st) {
  if (!st) return '';
  const c = st.paid ? C.ok : C.due;
  return '<div style="margin:14px 0 4px;padding:8px 12px;border-radius:8px;background:' + c.bg + ';border:1px solid ' + c.bd + ';color:' + c.fg + ';">'
    + '<div style="font-weight:800;font-size:12.5px;letter-spacing:.02em;">' + esc(st.head) + '</div>'
    + '<div style="font-size:12px;line-height:1.45;margin-top:2px;">' + esc(st.body) + '</div></div>';
}
// Celá stránka dokladu (appka, tisk). Do e-mailu se doklad nevkládá -- jde jako PDF v příloze.
export function renderHtml(m) {
  const align = (a) => a === 'r' ? 'right' : (a === 'c' ? 'center' : 'left');
  let b = '';
  if (m.preview) b += '<div style="font-size:11px;font-weight:800;color:#999;letter-spacing:.05em;margin-bottom:10px;">' + esc(_t(m.lang).preview) + '</div>';
  if (m.test) b += '<div style="margin:0 0 12px;padding:9px 12px;background:' + C.test.bg + ';border:1px solid ' + C.test.bd + ';border-radius:8px;color:' + C.test.fg + ';font-size:12px;font-weight:700;">🧪 ' + esc(m.test) + '</div>';
  // Logo stejným písmem jako v appce (Bebas Neue, načte se v hlavičce stránky).
  if (m.brand) b += '<div style="font-family:\'Bebas Neue\',Impact,\'Arial Narrow\',sans-serif;font-weight:400;font-size:36px;line-height:1;color:' + BRAND + ';letter-spacing:.06em;margin:0 0 6px;">MTL</div>';
  b += '<h1 style="font-size:20px;margin:0 0 4px;line-height:1.3;">' + esc(m.title) + '</h1>';
  if (m.parties) b += '<div style="display:flex;flex-wrap:wrap;gap:12px 24px;margin:18px 0 8px;">' + m.parties.map((p) =>
    '<div style="flex:1;min-width:220px;font-size:13px;line-height:1.55;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#888;margin-bottom:4px;">' + esc(p.label) + '</div>'
    + p.lines.map((l, i) => i === 0 ? ('<b>' + esc(l) + '</b>') : esc(l)).join('<br>') + '</div>').join('') + '</div>';
  if (m.facts && m.facts.length) b += '<div style="display:flex;flex-wrap:wrap;column-gap:28px;margin:14px 0 4px;font-size:13px;border-top:1px solid ' + C.line + ';">' + m.facts.map((f) =>
    '<div class="mtl-f" style="flex:1 1 calc(50% - 14px);min-width:240px;display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid ' + C.line2 + ';"><span style="color:' + C.lbl + ';">' + esc(f[0]) + '</span><b style="font-weight:600;text-align:right;">' + esc(f[1]) + '</b></div>').join('') + '</div>';
  if (m.table) b += '<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:13px;"><thead><tr>' + m.table.cols.map((c) =>
    '<th style="background:' + C.head + ';padding:8px 10px;font-size:11px;color:#666;font-weight:700;text-align:' + align(c.a) + ';">' + esc(c.t) + '</th>').join('') + '</tr></thead><tbody>'
    + m.table.rows.map((r) => '<tr>' + r.map((v, i) => '<td style="padding:7px 10px;border-bottom:1px solid ' + C.line2 + ';text-align:' + align(m.table.cols[i].a) + ';' + (i > 0 ? 'white-space:nowrap;' : '') + '">' + esc(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
  if (m.sums || m.vatNote || m.total) {
    b += '<table style="width:100%;border-collapse:collapse;margin-top:4px;font-size:14px;">';
    (m.sums || []).forEach((s) => { b += '<tr><td style="padding:6px 0;color:' + C.mid + ';">' + esc(s[0]) + '</td><td style="padding:6px 0;text-align:right;">' + esc(s[1]) + '</td></tr>'; });
    if (m.vatNote) b += '<tr><td colspan="2" style="padding:6px 0;font-size:11.5px;color:#666;">' + esc(m.vatNote) + '</td></tr>';
    if (m.total) b += '<tr><td style="padding:8px 0;font-weight:800;font-size:16px;border-top:2px solid #333;">' + esc(m.total[0]) + '</td><td style="padding:8px 0;font-weight:800;font-size:16px;border-top:2px solid #333;text-align:right;">' + esc(m.total[1]) + '</td></tr>';
    b += '</table>';
  }
  b += statusBoxHtml(m.status);
  (m.notes || []).forEach((n) => { b += '<div style="margin-top:10px;font-size:12px;color:' + C.mid + ';line-height:1.55;">' + esc(n) + '</div>'; });
  const font = m.brand ? '<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap" rel="stylesheet">' : '';
  const body = '<div style="font-family:Arial,Helvetica,sans-serif;color:' + C.ink + ';max-width:700px;margin:0 auto;line-height:1.5;">' + b + '</div>';
  return '<!doctype html><html lang="' + (_isEn(m.lang) ? 'en' : 'cs') + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(m.docTitle || m.title) + '</title>' + font
    + '<style>body{margin:0;padding:24px 18px;background:#fff;}.mtl-f{flex:0 0 calc(50% - 14px)!important;min-width:0!important;}@media (max-width:560px){.mtl-f{flex:1 1 100%!important;}}@media print{body{padding:0;}}</style></head><body>' + body + '</body></html>';
}

// ── PDF ──────────────────────────────────────────────────────────────────────────────────────
// Kreslí TÝŽ model jako renderHtml. PDFDocument (pdfkit) a písmo dodá server.
export function renderPdf(m, deps) {
  const PDFDocument = deps.PDFDocument;
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = []; doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      if (deps.font) { doc.registerFont('cz', deps.font); doc.font('cz'); }
      const X = 50, W = 495, S = (s) => String(s == null ? '' : s).replace(/[  ]/g, ' ');
      const box = (y, h, c) => { doc.rect(X, y, W, h).lineWidth(0.8).fillAndStroke(c.bg, c.bd); doc.lineWidth(1); };
      const ensure = (h) => { if (doc.y + h > doc.page.height - 50) { doc.addPage(); doc.y = 50; } };
      if (m.preview) { doc.fontSize(8.5).fillColor('#999999').text(S(_t(m.lang).preview), X, doc.y, { width: W }); doc.moveDown(0.6); }
      if (m.test) {
        const y = doc.y; doc.fontSize(9); const h = doc.heightOfString(S(m.test), { width: W - 16 }) + 14;
        box(y, h, C.test); doc.fillColor(C.test.fg).text(S(m.test), X + 8, y + 7, { width: W - 16, align: 'center' });
        doc.y = y + h + 12;
      }
      // Logo písmem appky (Bebas Neue, deps.brandFont); bez něj základním písmem.
      if (m.brand) {
        if (deps.brandFont) { doc.registerFont('brand', deps.brandFont); doc.font('brand'); }
        doc.fontSize(30).fillColor(BRAND).text('MTL', X, doc.y, { width: W, characterSpacing: 1.6 });
        if (deps.brandFont) doc.font(deps.font ? 'cz' : 'Helvetica');
        doc.moveDown(0.15);
      }
      doc.fontSize(16).fillColor('#111111').text(S(m.title), X, doc.y, { width: W });
      doc.moveDown(0.8);
      if (m.parties) {
        const yTop = doc.y; let yMax = yTop;
        m.parties.forEach((p, ix) => {
          const x = ix === 0 ? X : 315; doc.y = yTop;
          doc.fontSize(8.5).fillColor('#888888').text(S(p.label).toUpperCase(), x, yTop, { width: 230 });
          p.lines.forEach((l, i) => { doc.fontSize(i === 0 ? 11 : 9.5).fillColor(i === 0 ? '#111111' : C.mid).text(S(l), x, doc.y, { width: 230 }); });
          yMax = Math.max(yMax, doc.y);
        });
        doc.y = yMax + 14;
      }
      if (m.facts && m.facts.length) {
        // Údaje po dvou na řádek, ve stejném pořadí jako v HTML.
        let y = doc.y; doc.moveTo(X, y).lineTo(X + W, y).strokeColor(C.line).stroke();
        for (let i = 0; i < m.facts.length; i += 2) {
          let hRow = 0; const cells = [m.facts[i], m.facts[i + 1]];
          cells.forEach((f, k) => { if (!f) return; const x = k === 0 ? X : 315, cw = 230;
            doc.fontSize(8.5); const lw = doc.widthOfString(S(f[0])); doc.fontSize(9); const vw = doc.widthOfString(S(f[1]));
            if (lw + vw + 10 <= cw) {
              doc.fontSize(8.5).fillColor(C.lbl).text(S(f[0]), x, y + 6, { width: cw, lineBreak: false });
              doc.fontSize(9).fillColor('#111111').text(S(f[1]), x, y + 5.5, { width: cw, align: 'right', lineBreak: false });
              hRow = Math.max(hRow, 20);
            } else {   // dlouhá hodnota: popisek nahoře, hodnota pod ním
              doc.fontSize(8.5).fillColor(C.lbl).text(S(f[0]), x, y + 6, { width: cw });
              const vy = doc.y + 1; doc.fontSize(9).fillColor('#111111').text(S(f[1]), x, vy, { width: cw, align: 'right' });
              hRow = Math.max(hRow, doc.y - y + 6);
            } });
          y += hRow; doc.moveTo(X, y).lineTo(X + 230, y).strokeColor(C.line2).stroke();
          if (m.facts[i + 1]) doc.moveTo(315, y).lineTo(315 + 230, y).strokeColor(C.line2).stroke();
        }
        doc.y = y + 14;
      }
      if (m.table) {
        const tw = m.table.cols.reduce((a, c) => a + (c.w || 1), 0); let cx = X;
        const cols = m.table.cols.map((c) => { const w = W * (c.w || 1) / tw, o = { x: cx, w, a: c.a === 'r' ? 'right' : (c.a === 'c' ? 'center' : 'left') }; cx += w; return o; });
        let y = doc.y; doc.rect(X, y, W, 20).fill(C.head);
        doc.fontSize(8.5).fillColor('#666666'); m.table.cols.forEach((c, i) => doc.text(S(c.t), cols[i].x + 6, y + 6, { width: cols[i].w - 12, align: cols[i].a, lineBreak: false }));
        y += 20;
        m.table.rows.forEach((r) => {
          doc.fontSize(9.5); const h = Math.max(...r.map((v, i) => doc.heightOfString(S(v), { width: cols[i].w - 12 }))) + 12;
          if (y + h > doc.page.height - 50) { doc.addPage(); y = 50; }
          doc.fillColor('#111111'); r.forEach((v, i) => doc.text(S(v), cols[i].x + 6, y + 6, { width: cols[i].w - 12, align: cols[i].a }));
          y += h; doc.moveTo(X, y).lineTo(X + W, y).strokeColor(C.line2).stroke();
        });
        doc.y = y + 6;
      }
      (m.sums || []).forEach((s) => { ensure(18); const y = doc.y; doc.fontSize(10).fillColor(C.mid).text(S(s[0]), X, y, { width: 300 }); doc.text(S(s[1]), X + 300, y, { width: W - 300, align: 'right' }); doc.y = y + 17; });
      if (m.vatNote) { ensure(20); doc.fontSize(9).fillColor('#666666').text(S(m.vatNote), X, doc.y + 2, { width: W }); doc.moveDown(0.4); }
      if (m.total) {
        ensure(30); const y = doc.y + 2; doc.moveTo(X, y).lineTo(X + W, y).lineWidth(1.6).strokeColor('#333333').stroke(); doc.lineWidth(1);
        doc.fontSize(13).fillColor('#111111').text(S(m.total[0]), X, y + 7, { width: 250 }); doc.text(S(m.total[1]), X + 250, y + 7, { width: W - 250, align: 'right' });
        doc.y = y + 30;
      }
      if (m.status) {
        const c = m.status.paid ? C.ok : C.due; doc.fontSize(8.5);
        const hB = doc.heightOfString(S(m.status.body), { width: W - 16 }), h = 8 + 13 + hB + 8;
        ensure(h + 4); const y = doc.y + 4; box(y, h, c);
        doc.fillColor(c.fg).fontSize(10).text(S(m.status.head), X + 8, y + 7, { width: W - 16 });
        doc.fontSize(8.5).text(S(m.status.body), X + 8, doc.y + 1, { width: W - 16 });
        doc.y = y + h + 10;
      }
      (m.notes || []).forEach((n) => { doc.fontSize(9).fillColor(C.mid).text(S(n), X, doc.y + 4, { width: W }); });
      doc.end();
    } catch (e) { reject(e); }
  });
}
