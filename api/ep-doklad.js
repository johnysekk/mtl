// /api/ep-doklad.js — doklad za zaplacené předplatné na účtu MTL: Exclusive Partner (profil)
// a profil dodavatele (organizace, kind 'supplier_sub'). Obojí stejná faktura, liší se odběratel
// a název položky.
//
// Za provizi vystavuje doklad unified-doklad-cron. Za EP se dosud nevystavovalo nic: klub
// měl jen fakturu od Stripe, kde dodavatelem není MTL. Pro účetnictví ani pro dotace to
// nestačí -- klub potřebuje doklad od toho, komu platí.
//
// Volá se ze stripe-webhooku při invoice.paid na partnerském předplatném.
// Interní endpoint: POST { intSecret, invoice_id, user_id, org_id?, amount, currency, period_start,
//                          period_end, test_mode }   (org_id = profil dodavatele)

import PDFDocument from 'pdfkit';
import { DEJAVU_CZ } from './_dejavu-cz.js';
import { vatMode, vatNoteFor, isEU } from './_vat.js';
import { viesCheck } from './tax-verify.js';
import { b2cSmallState, OSS_LIMIT_CZK, OSS_WARN_SHARE } from './_oss.js';
import { issueReceipts, receiptMailHtml, receiptTitle, docNo } from './_receipt.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// Země EU. Rozhoduje o tom, jestli jde o běžné plnění, přenesenou daňovou povinnost,
// nebo plnění mimo EU.
// Seznam statu EU je v _vat.js -- jedna definice pro cely system.

const sb = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...svc, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${path}: ${(await r.text()).slice(0, 200)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
};

// DAŇOVÝ REŽIM. Rozhoduje v tomhle pořadí:
//   1) MTL není plátce DPH  -> doma a mimo EU bez DPH; odběratel v jiném státě EU s DIČ
//      -> přenesená daňová povinnost (MTL je identifikovaná osoba, § 6i), bez DIČ jako bod 4
//   2) odběratel v ČR       -> česká DPH (status odběratele na tom nic nemění)
//   3) odběratel v EU s DIČ -> přenesená daňová povinnost, daň odvede on
//   4) odběratel v EU bez DIČ -> nelze účtovat českou DPH: místem plnění je jeho zem
//      (elektronicky poskytovaná služba). Doklad se označí 'oss_pending' a NEVYSTAVÍ se
//      automaticky s českou daní -- tohle musí projít účetní a režimem OSS.
//   5) odběratel mimo EU    -> bez české DPH
// Tohle je mechanika, ne daňové poradenství: sazby a režim si nech potvrdit účetní.
// Rezim urcuje spolecna funkce v _vat.js -- stejna pro doklad za EP, za clensky poplatek
// federace i za listek. Drive tahle logika zila jen tady a doklad organizace zadny rezim
// nenesl. Predplatne EP je elektronicky poskytovana sluzba, proto kind 'electronic'.
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MTL <noreply@martialtraininglab.com>';
async function _mail(to, subject, html, attachments) {
  if (!RESEND || !to) return;
  try { await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ from: MAIL_FROM, to: [to], subject, html }, (attachments && attachments.length) ? { attachments } : {})) }); }
  catch (e) { console.error('[ep-doklad] mail', e.message); }
}
// TEXTY E-MAILU A PDF -- stejná stavba jako faktura za provizi (unified-doklad-cron): krátký
// dopis, rámeček stavu úhrady, faktura v příloze jako PDF.
const _T = (en, isSup) => en ? {
  title: isSup ? 'Invoice — MTL supplier profile subscription' : 'Invoice — Exclusive Partner subscription',
  item: isSup ? 'MTL supplier profile — subscription' : 'Exclusive MTL Partner — subscription',
  issued: 'Issued', duzp: 'Date of supply', period: 'Subscription period', supplier: 'Supplier', customer: 'Customer',
  colItem: 'Item', colPeriod: 'Period', colAmount: 'Amount', total: 'Total', base: 'Tax base', vat: 'VAT', regno: 'Reg. number', vatid: 'VAT ID', reg: 'Commercial register',
  hello: 'Hello', attached: (no, per, amt) => 'attached is invoice <b>' + no + '</b> for the period ' + per + ', amount <b>' + amt + '</b>.',
  forWhom: (n, ico) => 'Customer: <b>' + n + '</b>' + (ico ? (', Reg. number ' + ico) : '') + '.',
  paidHead: 'PAID IN FULL', paidBody: 'The amount was paid by card (Stripe). This is not a request for payment — there is nothing to pay.',
  dueHead: 'AMOUNT DUE: ', dueBody: 'The subscription could not be charged to your card. Stripe will retry automatically; you can also pay right away.', pay: 'Pay now',
} : {
  title: isSup ? 'Faktura — předplatné profilu dodavatele MTL' : 'Faktura — předplatné Exclusive Partner',
  item: isSup ? 'Profil dodavatele MTL — předplatné' : 'Exclusive MTL Partner — předplatné',
  issued: 'Vystaveno', duzp: 'Datum uskutečnění plnění', period: 'Období předplatného', supplier: 'Dodavatel', customer: 'Odběratel',
  colItem: 'Položka', colPeriod: 'Období', colAmount: 'Částka', total: 'Celkem', base: 'Základ daně', vat: 'DPH', regno: 'IČO', vatid: 'DIČ', reg: 'Zapsáno v obchodním rejstříku',
  hello: 'Dobrý den', attached: (no, per, amt) => 'v příloze posíláme fakturu <b>' + no + '</b> za období ' + per + ', částka <b>' + amt + '</b>.',
  forWhom: (n, ico) => 'Odběratel: <b>' + n + '</b>' + (ico ? (', IČO ' + ico) : '') + '.',
  paidHead: 'UHRAZENO V PLNÉ VÝŠI', paidBody: 'Částka byla uhrazena kartou (Stripe). Nejde o výzvu k platbě — není co platit.',
  dueHead: 'K ÚHRADĚ: ', dueBody: 'Předplatné se nepodařilo strhnout z karty. Stripe platbu zkusí znovu automaticky; zaplatit můžeš i hned.', pay: 'Zaplatit hned',
};
const _esc = (x) => String(x == null ? '' : x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
const _supL = (r, T) => [r.sup_name, r.sup_address, r.sup_ico ? (T.regno + ': ' + r.sup_ico) : '', r.sup_dic ? (T.vatid + ': ' + r.sup_dic) : '', r.sup_register ? (T.reg + ': ' + r.sup_register) : ''].filter(Boolean);
const _custL = (r, T) => [r.cust_name, r.cust_address, r.cust_ico ? (T.regno + ': ' + r.cust_ico) : '', r.cust_dic ? (T.vatid + ': ' + r.cust_dic) : ''].filter(Boolean);
// E-mail k faktuře: dopis + stav úhrady (+ tlačítko k úhradě), faktura je v příloze.
function _epMailHtml(r, en, payUrl, isSup) {
  const T = _T(en, isSup), m = (minor) => _amt(Number(minor || 0) / 100, r.currency, en ? 'en' : 'cs');
  const due = Number(r.due_amount) > 0;
  const box = due
    ? '<div style="margin:14px 0;padding:11px 14px;border-radius:10px;background:#FFF4E5;border:1.5px solid #F0C674;color:#8a5a00;"><div style="font-weight:800;">' + T.dueHead + _esc(m(r.due_amount)) + '</div><div style="font-size:12.5px;margin-top:3px;">' + T.dueBody + '</div></div>'
    : '<div style="margin:14px 0;padding:11px 14px;border-radius:10px;background:#EAF7EE;border:1.5px solid #A8E6C0;color:#0E6B3A;"><div style="font-weight:800;">' + T.paidHead + '</div><div style="font-size:12.5px;margin-top:3px;">' + T.paidBody + '</div></div>';
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:14px;line-height:1.6;">'
    + (r.test_mode ? '<div style="background:#FDECEC;border:1px solid #F3C0C0;border-radius:8px;color:#8a1c1c;font:700 12px/1.4 Arial,sans-serif;padding:9px 12px;margin-bottom:14px;">' + (en ? 'TEST MODE — not a real invoice' : 'TESTOVACÍ REŽIM — nejde o skutečnou fakturu') + '</div>' : '')
    + '<p style="margin:0 0 10px;">' + T.hello + ',</p>'
    + '<p style="margin:0 0 10px;">' + T.attached(_esc(r.doc_no), _esc(_perRange(r, en)), _esc(m(r.amount))) + '</p>'
    + (r.cust_name ? ('<p style="margin:0 0 10px;">' + T.forWhom(_esc(r.cust_name), r.cust_ico ? _esc(r.cust_ico) : '') + '</p>') : '')
    + box
    + ((due && payUrl) ? ('<p style="margin:14px 0;"><a href="' + _esc(payUrl) + '" style="display:inline-block;padding:12px 22px;background:#E63946;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">' + T.pay + '</a></p>') : '')
    + '<p style="margin:18px 0 0;color:#888;font-size:12px;">' + _esc(r.sup_name || 'Martial Training Lab') + (r.sup_email ? (' · ' + _esc(r.sup_email)) : '') + (r.sup_phone ? (' · ' + _esc(r.sup_phone)) : '') + '</p></div>';
}
// PDF faktury -- stejné rozvržení jako PDF faktury za provizi.
function _epPdf(r, en, isSup) {
  const T = _T(en, isSup), cur = r.currency, money = (minor) => _amt(Number(minor || 0) / 100, cur, en ? 'en' : 'cs');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = []; doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      doc.registerFont('cz', DEJAVU_CZ); doc.font('cz');
      if (r.test_mode) {
        const ty = doc.y; doc.rect(50, ty, 495, 24).fillAndStroke('#FDECEC', '#F3C0C0');
        doc.fillColor('#8a1c1c').fontSize(9).text(en ? 'TEST MODE — not a real invoice' : 'TESTOVACÍ REŽIM — nejde o skutečnou fakturu', 58, ty + 8, { width: 479, align: 'center', lineBreak: false });
        doc.y = ty + 38; doc.x = 50;
      }
      doc.fontSize(22).fillColor('#E11111').text('MTL', 50, doc.y);
      doc.moveDown(0.15).fontSize(15).fillColor('#111111').text(T.title);
      doc.moveDown(0.1).fontSize(10).fillColor('#555555').text(String(r.doc_no || '') + '  ·  ' + T.issued + ' ' + new Date(r.issued_at || r.charged_at || Date.now()).toLocaleDateString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague' })
        + (r.duzp ? ('  ·  ' + T.duzp + ' ' + _d(r.duzp, en)) : '') + '  ·  ' + T.period + ' ' + _perRange(r, en));
      doc.moveDown(0.7);
      { const due = Number(r.due_amount) > 0, c = due ? { bg: '#FFF4E5', bd: '#F0C674', fg: '#8a5a00' } : { bg: '#EAF7EE', bd: '#A8E6C0', fg: '#0E6B3A' };
        const head = due ? (T.dueHead + money(r.due_amount)) : T.paidHead, body = due ? T.dueBody : T.paidBody;
        const y0 = doc.y; doc.fontSize(9.5); const hB = doc.heightOfString(body, { width: 475 }), hBox = 14 + 15 + hB + 10;
        doc.rect(50, y0, 495, hBox).fillAndStroke(c.bg, c.bd);
        doc.fillColor(c.fg).fontSize(12).text(head, 60, y0 + 9, { width: 475 });
        doc.fontSize(9.5).text(body, 60, doc.y + 2, { width: 475 });
        doc.y = y0 + hBox + 14; doc.x = 50; }
      const yTop = doc.y;
      const col = (x, label, lines) => { doc.fontSize(9).fillColor('#888888').text(label, x, yTop, { width: 230 });
        lines.forEach((l, ix) => { if (ix === 0) doc.fontSize(11).fillColor('#111111').text(l, x, doc.y, { width: 230 }); else doc.fontSize(10).fillColor('#555555').text(l, x, doc.y, { width: 230 }); });
        return doc.y; };
      const yL = col(50, T.supplier.toUpperCase(), _supL(r, T)), yR = col(315, T.customer.toUpperCase(), _custL(r, T));
      doc.y = Math.max(yL, yR) + 18;
      let y = doc.y; doc.fontSize(9).fillColor('#888888');
      doc.text(T.colItem, 50, y, { width: 250 }); doc.text(T.colPeriod, 300, y, { width: 140, align: 'center' }); doc.text(T.colAmount, 440, y, { width: 105, align: 'right' });
      y = doc.y + 4; doc.moveTo(50, y).lineTo(545, y).strokeColor('#dddddd').stroke(); y += 6;
      doc.fontSize(10).fillColor('#111111');
      doc.text(T.item, 50, y, { width: 250 }); doc.text(_perRange(r, en), 300, y, { width: 140, align: 'center' }); doc.text(money(r.amount), 440, y, { width: 105, align: 'right' });
      y = doc.y + 5; doc.moveTo(50, y).lineTo(545, y).strokeColor('#eeeeee').stroke(); doc.y = y + 9;
      const rate = Number(r.sup_vat_rate) || 0;
      if (rate > 0) { const base = Number(r.amount) / (1 + rate / 100);
        doc.fontSize(10).fillColor('#555555').text(T.base + ': ' + money(base) + '   ·   ' + T.vat + ' ' + rate + ' %: ' + money(Number(r.amount) - base), 50, doc.y, { width: 495 }); }
      else { const note = vatNoteFor(r.vat_mode, r.vat_note, en ? 'en' : 'cs'); if (note) doc.fontSize(9).fillColor('#777777').text(note, 50, doc.y, { width: 495 }); }
      doc.moveDown(0.5);
      const yT = doc.y; doc.fontSize(13).fillColor('#111111').text(T.total, 50, yT, { width: 230 }); doc.text(money(r.amount), 315, yT, { width: 230, align: 'right' });
      doc.end();
    } catch (e) { reject(e); }
  });
}
// Faktura za EP do e-mailu. Stejný obsah a stejný rámeček stavu jako v appce.
function _d(ymd, en) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || '')); if (!m) return String(ymd || ''); return en ? (Number(m[3]) + '/' + Number(m[2]) + '/' + m[1]) : (Number(m[3]) + '. ' + Number(m[2]) + '. ' + m[1]); }
// Období předplatného od–do. Stripe dává konec jako začátek dalšího období, proto o den míň.
function _perRange(r, en) {
  try {
    const li = Array.isArray(r.line_items) ? r.line_items[0] : null;
    if (!li || !li.period_start || !li.period_end) return r.period_month;
    const end = new Date(new Date(li.period_end).getTime() - 86400000).toISOString();
    return _d(String(li.period_start).slice(0, 10), en) + ' – ' + _d(end.slice(0, 10), en);
  } catch (e) { return r.period_month; }
}
function _epInvoiceHtml(r, en, payUrl, isSup) {
  const esc = (x) => String(x == null ? '' : x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const m = (minor) => _amt(Number(minor || 0) / 100, r.currency, en ? 'en' : 'cs');
  const due = Number(r.due_amount) > 0;
  const box = due
    ? '<div style="margin:14px 0;padding:11px 14px;border-radius:10px;background:#FFF4E5;border:1.5px solid #F0C674;color:#8a5a00;"><div style="font-weight:800;">' + (en ? 'AMOUNT DUE: ' : 'K ÚHRADĚ: ') + esc(m(r.due_amount)) + '</div><div style="font-size:12.5px;margin-top:3px;">'
      + (en ? 'The subscription could not be charged to your card. Stripe will retry automatically; you can also pay right away.' : 'Předplatné se nepodařilo strhnout z karty. Stripe platbu zkusí znovu automaticky; zaplatit můžeš i hned.') + '</div></div>'
      + (payUrl ? '<p><a href="' + esc(payUrl) + '" style="display:inline-block;padding:12px 22px;background:#E63946;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">' + (en ? 'Pay now' : 'Zaplatit hned') + '</a></p>' : '')
    : '<div style="margin:14px 0;padding:11px 14px;border-radius:10px;background:#EAF7EE;border:1.5px solid #A8E6C0;color:#0E6B3A;"><div style="font-weight:800;">' + (en ? 'PAID IN FULL' : 'UHRAZENO V PLNÉ VÝŠI') + '</div><div style="font-size:12.5px;margin-top:3px;">'
      + (en ? 'The amount was paid by card (Stripe). This is not a request for payment — there is nothing to pay.' : 'Částka byla uhrazena kartou (Stripe). Nejde o výzvu k platbě — není co platit.') + '</div></div>';
  const sup = [r.sup_name, r.sup_address, r.sup_ico ? ((en ? 'Reg. number: ' : 'IČO: ') + r.sup_ico) : '', r.sup_dic ? ((en ? 'VAT ID: ' : 'DIČ: ') + r.sup_dic) : '', r.sup_register ? ((en ? 'Commercial register: ' : 'Zapsáno v obchodním rejstříku: ') + r.sup_register) : ''].filter(Boolean).map(esc).join('<br>');
  const cust = [r.cust_name, r.cust_address, r.cust_ico ? ((en ? 'Reg. number: ' : 'IČO: ') + r.cust_ico) : '', r.cust_dic ? ((en ? 'VAT ID: ' : 'DIČ: ') + r.cust_dic) : ''].filter(Boolean).map(esc).join('<br>');
  const note = vatNoteFor(r.vat_mode, r.vat_note, en ? 'en' : 'cs');
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:620px;margin:0 auto;color:#1a1a1a;font-size:14px;line-height:1.55;">'
    + '<h2 style="margin:0 0 4px;">' + (isSup ? (en ? 'Invoice — MTL supplier profile subscription' : 'Faktura — předplatné profilu dodavatele MTL') : (en ? 'Invoice — Exclusive Partner subscription' : 'Faktura — předplatné Exclusive Partner')) + '</h2>'
    + '<div style="font-size:13px;color:#555;">' + esc(r.doc_no || ('MTL-' + r.id)) + (r.duzp ? (' · ' + (en ? 'Date of supply ' : 'Datum uskutečnění plnění ') + esc(_d(r.duzp, en))) : '') + ' · ' + (en ? 'Subscription period ' : 'Období předplatného ') + esc(_perRange(r, en)) + '</div>' + box
    + '<table style="width:100%;font-size:13px;"><tr><td style="vertical-align:top;width:50%;"><div style="font-size:11px;color:#888;text-transform:uppercase;">' + (en ? 'Supplier' : 'Dodavatel') + '</div>' + sup + '</td><td style="vertical-align:top;"><div style="font-size:11px;color:#888;text-transform:uppercase;">' + (en ? 'Customer' : 'Odběratel') + '</div>' + cust + '</td></tr></table>'
    + '<p style="margin-top:14px;"><b>' + (isSup ? (en ? 'MTL supplier profile — subscription ' : 'Profil dodavatele MTL — předplatné ') : (en ? 'Exclusive MTL Partner — subscription ' : 'Exclusive MTL Partner — předplatné ')) + esc(r.period_month) + ':</b> ' + esc(m(r.amount)) + '</p>'
    + (note ? '<p style="font-size:12px;color:#555;">' + esc(note) + '</p>' : '')
    + '</div>';
}
function _amt(v, cur, lang) {
  try { return Number(v).toLocaleString(lang === 'en' ? 'en-GB' : 'cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ' + (String(cur).toUpperCase() === 'CZK' ? 'Kč' : String(cur).toUpperCase()); }
  catch (e) { return v + ' ' + cur; }
}
function _vatForEp(supCountry, custCountry, custDic, supIsVatPayer, b2cSmall) {
  return vatMode(supCountry, custCountry, custDic, { kind: 'electronic', supIsVatPayer, b2cSmall: !!b2cSmall });
}


export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const b = req.body || {};
    if (!process.env.PIS_INTERNAL_SECRET || b.intSecret !== process.env.PIS_INTERNAL_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const uid = b.user_id;
    const orgId = b.org_id || null;                       // profil dodavatele
    const KIND = orgId ? 'supplier_sub' : 'partner_sub';
    const amount = Number(b.amount || 0);
    const cur = String(b.currency || 'CZK').toUpperCase();
    if (!uid || !(amount > 0)) return res.status(400).json({ error: 'bad_input' });

    // Dvakrát ten samý doklad nevystavíme (unique index na pi_id to drží i v databázi).
    // FAKTURA UŽ JE A BYLA NEUHRAZENÁ (předplatné se napoprvé nepodařilo strhnout) a teď přišla
    // platba -> faktura se NEMĚNÍ, vystaví se k ní potvrzení o úhradě (_receipt.js).
    if (b.invoice_id) {
      const ex = await sb(`commission_doklady?select=id,due_amount&pi_id=eq.${encodeURIComponent(b.invoice_id)}&kind=eq.${KIND}&limit=1`);
      if (ex && ex.length) {
        if (!b.unpaid && Number(ex[0].due_amount) > 0) {
          const rc = await issueReceipts(`pi_id=eq.${encodeURIComponent(b.invoice_id)}&kind=eq.${KIND}`, {
            method: 'stripe_invoice', notifyUserId: uid, paidAt: new Date().toISOString(),
            mail: async (to, inv, r) => {
              let en = false; try { const p = (await sb(`profiles?id=eq.${encodeURIComponent(uid)}&select=lang`))[0]; en = !!(p && p.lang === 'en'); } catch (e) {}
              await _mail(to, `${receiptTitle(inv.kind, en)} ${docNo(r)}`, receiptMailHtml(inv, r, en));
            },
          });
          return res.status(200).json({ ok: true, receipt: (rc[0] && rc[0].id) || null, invoice: ex[0].id });
        }
        return res.status(200).json({ ok: true, skipped: 'already_issued', id: ex[0].id });
      }
    }

    // Odběratel: fakturační identita poskytovatele -- u dodavatele jeho organizace (stejné
    // sloupce), jazyk e-mailu podle majitele.
    let pr = (await sb(`profiles?id=eq.${encodeURIComponent(uid)}&select=id,name,email,phone,legal_name,`
      + `tax_id,vat_id,vat_payer,vat_verified_id,billing_line1,billing_line2,billing_city,billing_postal,billing_country,country_code,invoice_email,lang`))[0];
    if (!pr) return res.status(404).json({ error: 'user_not_found' });
    if (orgId) {
      const o = (await sb(`organizations?id=eq.${encodeURIComponent(orgId)}&select=id,name,legal_name,tax_id,vat_id,vat_payer,vat_verified_id,`
        + `billing_line1,billing_line2,billing_city,billing_postal,billing_country,country,invoice_email,contact_email,contact_phone`))[0];
      if (!o) return res.status(404).json({ error: 'org_not_found' });
      pr = { id: pr.id, lang: pr.lang, name: o.name, legal_name: o.legal_name, tax_id: o.tax_id, vat_id: o.vat_id, vat_payer: o.vat_payer, vat_verified_id: o.vat_verified_id,
        billing_line1: o.billing_line1, billing_line2: o.billing_line2, billing_city: o.billing_city, billing_postal: o.billing_postal,
        billing_country: o.billing_country || o.country, country_code: null,
        invoice_email: o.invoice_email || o.contact_email, email: o.contact_email || pr.email, phone: o.contact_phone || pr.phone };
    }
    // EP PLACENÝ KLUBEM: odběratelem je klub (volba při nákupu, metadata předplatného ep_bill_gym).
    // Klub musí patřit kupujícímu; jinak se fakturuje jako dřív na kouče.
    let billGym = null;
    if (!orgId && b.bill_gym_id) {
      const g = (await sb(`gyms?id=eq.${encodeURIComponent(b.bill_gym_id)}&owner_id=eq.${encodeURIComponent(uid)}&select=id,name,legal_name,tax_id,vat_id,vat_payer,vat_verified_id,`
        + `billing_line1,billing_line2,billing_city,billing_postal,billing_country,country,invoice_email,contact_email,billing_phone,contact_phone`))[0];
      if (g) {
        billGym = g.id;
        pr = { id: pr.id, lang: pr.lang, name: g.name, legal_name: g.legal_name, tax_id: g.tax_id, vat_id: g.vat_id, vat_payer: g.vat_payer, vat_verified_id: g.vat_verified_id,
          billing_line1: g.billing_line1, billing_line2: g.billing_line2, billing_city: g.billing_city, billing_postal: g.billing_postal,
          billing_country: g.billing_country || g.country, country_code: null,
          invoice_email: g.invoice_email || g.contact_email || pr.invoice_email, email: g.contact_email || pr.email, phone: g.billing_phone || g.contact_phone || pr.phone };
      }
    }

    const custAddr = [pr.billing_line1, pr.billing_line2, [pr.billing_postal, pr.billing_city].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    const custCountry = (pr.billing_country || pr.country_code || 'CZ').toUpperCase();

    // Dodavatel: MTL z platform_settings, aby se údaje neopisovaly na dvou místech.
    // Dodavatel z platform_settings -- ta samá tabulka i sloupce, které používá Admin
    // (plátce DPH, sazba, požadovat DIČ u cizinců) a doklad za provizi.
    const ps = (await sb('platform_settings?id=eq.1&select=*'))[0] || {};
    const ME = {
      name: ps.name || 'Martial Training Lab s.r.o.',
      ico: ps.ico || null, dic: ps.dic || null, address: ps.sidlo || null,
      vat_payer: !!ps.vat_payer, vat_rate: (ps.vat_rate != null ? ps.vat_rate : null),
      phone: ps.contact_phone || null, email: ps.contact_email || null,
      register: (ps.register_entry && String(ps.register_entry).trim()) || null,
      country: String(ps.home_country || 'CZ').toUpperCase(),
      require_vat_foreign: !!ps.require_vat_foreign,
    };

    // DIČ ZNOVU VE VIES PŘED KAŽDOU FAKTUROU. Brána v pay.js ho ověří při nákupu, jenže
    // předplatné běží měsíce a DIČ mezitím může zaniknout. Přenesení daně smíme uplatnit jen
    // s DIČ platným v den plnění (čl. 18 nařízení 282/2011), proto se ověří u každé faktury
    // a uloží se kdy (vat_verified_*). Neplatné = jako bez DIČ. VIES mimo provoz = platí
    // poslední úspěšné ověření téhož DIČ; když žádné není, jako bez DIČ.
    let custDic = pr.vat_id || null, vatProblem = null;
    if (custDic && custCountry !== ME.country && isEU(custCountry) && isEU(ME.country)) {
      const _norm = String(custDic).replace(/\s+/g, '').toUpperCase();
      const vv = await viesCheck(_norm, custCountry, ME.dic);
      if (vv.ok && vv.valid) {
        try { await sb(`${orgId ? 'organizations' : (billGym ? 'gyms' : 'profiles')}?id=eq.${encodeURIComponent(orgId || billGym || uid)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ vat_verified_id: _norm, vat_verified_at: new Date().toISOString(), vat_vies_ref: vv.ref || null }) }); } catch (e) {}
      } else if (vv.ok || String(pr.vat_verified_id || '').toUpperCase() !== _norm) {
        vatProblem = vv.ok ? 'invalid' : 'unverified'; custDic = null;
      }
    }

    // SPOTŘEBITEL Z JINÉHO STÁTU EU (bez platného DIČ): pod limitem 10 000 EUR je místem plnění
    // ČR a faktura vznikne hned (_oss.js). Nad limitem zůstává odložení níž (OSS).
    let b2c = null, b2cSmall = false;
    if (!custDic && custCountry !== ME.country && isEU(custCountry) && isEU(ME.country)) {
      try { b2c = await b2cSmallState((path) => sb(path)); } catch (e) { b2c = null; }
      const _czk = b2c ? b2c.toCzk(Math.round(amount * 100), cur) : null;
      b2cSmall = !!(b2c && _czk != null && b2c.fits(_czk));
      if (b2c && _czk != null) b2c.thisCzk = _czk;
    }

    // Status odberatele (ICO) na rezim nema vliv: rozhoduje zeme a DIC, proto se uz nepredava.
    const V = _vatForEp(ME.country, custCountry, custDic, ME.vat_payer, b2cSmall);

    // OSS NECHCEME. Odběratel z jiné země EU bez DIČ = doklad se nevystaví, stejně jako to
    // dělá doklad za provizi (require_vat_foreign). Platba zůstává evidovaná a doklad
    // vystavíme zpětně, jak DIČ doplní.
    if (V.mode === 'oss_pending' && ME.require_vat_foreign) {
      try {
        await sb('notifications', { method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: uid, type: 'system', read: false,
            message: '⚠️ Faktura za ' + (orgId ? 'profil dodavatele' : 'Exclusive MTL Partner') + ' za ' + String(b.period_start || '').slice(0,7) + ' zatím nevystavena — '
              + (vatProblem === 'invalid' ? ('tvoje DIČ ' + pr.vat_id + ' už není platné v evropském registru VIES. Oprav ho ve fakturačních údajích, ať ji můžeme vystavit podle EU pravidel.')
                : vatProblem === 'unverified' ? ('tvoje DIČ teď nešlo ověřit v registru VIES (výpadek). Zkontroluj ho ve fakturačních údajích.')
                : 'doplň DIČ (VAT ID) ve fakturačních údajích, ať ji můžeme vystavit podle EU pravidel.'),
            data: JSON.stringify({ kind: 'doklad_vat_needed', needs: 'vat_id', reason: vatProblem || 'missing', org_id: orgId, period: String(b.period_start || '').slice(0,7),
              amount, currency: cur,
              msg_en: '⚠️ The ' + (orgId ? 'supplier profile' : 'Exclusive MTL Partner') + ' invoice for ' + String(b.period_start || '').slice(0,7) + ' is not issued yet — '
                + (vatProblem === 'invalid' ? ('your VAT ID ' + pr.vat_id + ' is no longer valid in the EU VIES register. Fix it in your billing details so we can issue it under EU rules.')
                  : vatProblem === 'unverified' ? 'your VAT ID could not be checked in VIES right now (outage). Check it in your billing details.'
                  : 'add your VAT ID in your billing details so we can issue it under EU rules.') }) }) });
      } catch (e) {}
      return res.status(200).json({ ok: true, deferred: 'vat_id_required' });
    }

    const period = String(b.period_start || new Date().toISOString()).slice(0, 7);
    const label = (orgId ? 'Profil dodavatele MTL — předplatné ' : 'Exclusive MTL Partner — předplatné ') + period;
    const PRODUCT = orgId ? 'profil dodavatele MTL' : 'Exclusive MTL Partner', PRODUCT_EN = orgId ? 'MTL supplier profile' : 'Exclusive MTL Partner';
    // ČÁSTKA V HALÉŘÍCH/CENTECH, stejně jako každý jiný řádek commission_doklady (doklad o
    // provizi). Webhook posílá celé koruny (amount_paid/100); dřív se uložily tak, jak přišly,
    // a appka (dělí stovkou) by ukázala 5,00 Kč místo 500 Kč.
    const amountMinor = Math.round(amount * 100);

    const row = {
      owner_id: uid, coach_id: orgId ? null : uid, organization_id: orgId,
      gym_id: billGym,          // EP placený klubem: doklad patří i do dokladů toho klubu
      period_month: period, currency: cur, amount: amountMinor,
      pi_id: b.invoice_id || null,
      kind: KIND,
      status: (V.mode === 'oss_pending' ? 'review' : 'issued'),   // OSS ruční kontrola
      charged_at: new Date().toISOString(),
      issued_at: new Date().toISOString(),
      test_mode: !!b.test_mode,
      // DUZP: předplatné se platí předem -> den, od kterého běží zaplacené období.
      duzp: String(b.period_start || new Date().toISOString()).slice(0, 10),
      // Neuhrazená faktura (stržení předplatného selhalo): celá částka „K úhradě".
      due_amount: b.unpaid ? amountMinor : 0,
      // Pole, ne JSON.stringify -- jinak se do jsonb uložil řetězec a appka z něj nečetla položku.
      line_items: [{ label, amount: amountMinor, currency: cur,
        period_start: b.period_start || null, period_end: b.period_end || null,
        pay_url: b.unpaid ? (b.pay_url || null) : undefined, next_attempt: b.unpaid ? (b.next_attempt || null) : undefined }],
      // odběratel
      cust_name: pr.legal_name || pr.name || '—',
      cust_trade_name: (pr.name && pr.name !== pr.legal_name) ? pr.name : null,
      cust_ico: pr.tax_id || null, cust_dic: custDic,
      cust_address: custAddr || null, cust_vat_payer: !!pr.vat_payer,
      cust_country: custCountry, cust_email: pr.invoice_email || pr.email || null, cust_phone: pr.phone || null,
      // dodavatel
      sup_name: ME.name, sup_ico: ME.ico, sup_dic: ME.dic, sup_address: ME.address,
      // DPH jen u domácího plnění. U ostatních režimů nula a důvod je v vat_note.
      sup_vat_payer: ME.vat_payer, sup_vat_rate: ((V.mode === 'domestic' || (V.mode === 'b2c_eu_small' && ME.vat_payer)) ? ME.vat_rate : 0),
      sup_phone: ME.phone, sup_email: ME.email, sup_country: ME.country,
      sup_register: ME.register,   // spisová značka (§ 435 OZ)
      // daňový režim
      vat_mode: V.mode, vat_note: V.note,
    };

    let ins;
    try {
      ins = await sb('commission_doklady', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    } catch (e) {
      // Bez sloupce sup_register (SQL ještě nespuštěné) se doklad vystaví bez něj, ne vůbec.
      if (!/sup_register|due_amount|duzp/.test(String(e && e.message))) throw e;
      // Neuhrazenou fakturu bez sloupce due_amount vystavit nejde -- vypadala by jako uhrazená.
      if (row.due_amount > 0) return res.status(200).json({ ok: true, deferred: 'run_sql_doklad_register' });
      delete row.sup_register; delete row.due_amount; delete row.duzp;
      ins = await sb('commission_doklady', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    }
    const id = (ins && ins[0] && ins[0].id) || null;
    const docNoStr = (ins && ins[0] && ins[0].doc_no) || ('MTL-' + id);   // číslo přidělila databáze

    // Poskytovatel se to má dozvědět stejně jako u dokladu za provizi.
    try {
      await sb('notifications', { method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: uid, type: 'system', read: false,
          // kind 'doklad_unified' -- stejná notifikace jako u dokladu o provizi: proklik otevře
          // rovnou tenhle doklad (showCommissionDoklad). Dřív 'ep_doklad', na který appka neuměla kliknout.
          message: b.unpaid
            ? ('⚠️ Předplatné ' + PRODUCT + ' za ' + period + ' (' + _amt(amount, cur, 'cs') + ') se nepodařilo strhnout z karty. Faktura je vystavená s částkou k úhradě; Stripe platbu zkusí znovu, zaplatit můžeš i hned odkazem ve faktuře.')
            : ('🧾 ' + (orgId ? 'Profil dodavatele MTL' : PRODUCT) + ' za ' + period + ': ' + _amt(amount, cur, 'cs') + ' uhrazeno kartou. Faktura je vystavená.'),
          data: JSON.stringify({ kind: 'doklad_unified', doklad_id: id, coach_id: orgId ? null : uid, organization_id: orgId, period, amount: amountMinor, currency: cur,
            msg_en: b.unpaid
              ? ('⚠️ The ' + PRODUCT_EN + ' subscription for ' + period + ' (' + _amt(amount, cur, 'en') + ') could not be charged to your card. The invoice has been issued with the amount due; Stripe will retry, or you can pay right away via the link in the invoice.')
              : ('🧾 ' + PRODUCT_EN + ' for ' + period + ': ' + _amt(amount, cur, 'en') + ' paid by card. The invoice has been issued.') }) }) });
    } catch (e) {}

    // E-MAIL s fakturou (dřív žádný -- faktura za EP byla jen v appce).
    try {
      const en = pr.lang === 'en';
      const _r = Object.assign({}, row, { id, doc_no: docNoStr });
      let _att = [];
      try { const _buf = await _epPdf(_r, en, !!orgId);
        _att = [{ filename: docNoStr + '-' + (orgId ? (en ? 'supplier-profile' : 'profil-dodavatele') : 'exclusive-partner') + '-' + String(period).replace(/-/g, '') + '.pdf', content: _buf.toString('base64') }];
      } catch (e) { console.error('[ep-doklad] pdf', e.message); }
      // Bez PDF (selhalo) jde faktura celá v těle e-mailu, ať o ni odběratel nepřijde.
      if (row.cust_email && id) await _mail(row.cust_email,
        ((row.test_mode ? '[TEST] ' : '') + (en ? 'Invoice ' + docNoStr + ' — ' + PRODUCT_EN + ' ' : 'Faktura ' + docNoStr + ' — ' + PRODUCT + ' ')) + period,
        _att.length ? _epMailHtml(_r, en, b.unpaid ? (b.pay_url || null) : null, !!orgId) : _epInvoiceHtml(_r, en, b.unpaid ? (b.pay_url || null) : null, !!orgId), _att);
    } catch (e) {}

    // HLÍDÁNÍ LIMITU: zakladateli přijde upozornění, když tahle faktura posunula letošní součet
    // přes 80 % a přes 100 % limitu. Notifikace s proklikem do Adminu.
    if (V.mode === 'b2c_eu_small' && b2c && b2c.thisCzk != null && !b.test_mode) {
      try {
        const before = b2c.cur, after = b2c.cur + b2c.thisCzk, warn = OSS_LIMIT_CZK * OSS_WARN_SHARE;
        const hit = (after >= OSS_LIMIT_CZK && before < OSS_LIMIT_CZK) ? 'limit' : ((after >= warn && before < warn) ? 'warn' : null);
        if (hit) {
          const fmt = (v) => Math.round(v).toLocaleString('cs-CZ');
          await sb('notifications', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
            user_id: '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c', type: 'system', read: false,
            data: JSON.stringify({ kind: 'oss_threshold', level: hit, year: b2c.year, total_czk: Math.round(after), limit_czk: OSS_LIMIT_CZK }),
            message: (hit === 'limit' ? '🚨 ' : '⚠️ ') + 'Přeshraniční prodeje spotřebitelům v EU (EP a dodavatelé bez DIČ) za rok ' + b2c.year + ': ' + fmt(after) + ' Kč z limitu ' + fmt(OSS_LIMIT_CZK) + ' Kč (10 000 EUR). '
              + (hit === 'limit' ? 'Limit je překročený — další prodeje bez DIČ appka zastaví a je potřeba registrace do OSS.' : 'Blíží se limit — po jeho překročení bude potřeba registrace do OSS.') }) });
        }
      } catch (e) { console.error('[ep-doklad] oss alert', e.message); }
    }
    return res.status(200).json({ ok: true, id, vat_mode: V.mode });
  } catch (e) {
    console.error('[ep-doklad]', (e && e.message) || e);
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
