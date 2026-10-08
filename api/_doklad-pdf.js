// /api/_doklad-pdf.js — PDF DOKLADU ZE SNÍMKU (tabulka doklady).
//
// Stejný doklad jako v appce (showReceipt v index.html): stejné řádky, stejné pořadí, stejné texty,
// a VŠE ZE SNÍMKU vystaveného při platbě -- nic se nedokresluje z dnešních údajů. Přikládá se
// k potvrzení objednávky e-mailem u každé platby (karta, převod, QR, PIS, hotovost).

import PDFDocument from 'pdfkit';
import { DEJAVU_CZ } from './_dejavu-cz.js';
import { itemLabelEn } from './_sell-kind.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
async function one(p) { try { const r = await fetch(`${SB}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }); if (!r.ok) return null; const j = await r.json(); return (j && j[0]) || null; } catch (e) { return null; } }

const SYM = (c) => { c = String(c || 'CZK').toUpperCase(); return c === 'CZK' ? 'Kč' : c === 'EUR' ? '€' : c === 'USD' ? '$' : c === 'GBP' ? '£' : c; };

export function dokladPdfFromRow(dk, en) {
  return new Promise((resolve, reject) => {
    try {
      const fmt = (n) => { const v = Math.round((Number(n) || 0) * 100) / 100; return v.toLocaleString(en ? 'en-US' : 'cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
      const d = (v) => { try { return v ? new Date(v).toLocaleDateString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague' }) : ''; } catch (e) { return ''; } };
      const cur = dk.currency || 'CZK', sym = SYM(cur);
      const amt = (Number(dk.amount) || 0) / 100;
      const isPayer = !!dk.sup_vat_payer, rate = isPayer ? (dk.sup_vat_rate != null ? Number(dk.sup_vat_rate) : 21) : 0;
      const base = isPayer ? Math.round((amt / (1 + rate / 100)) * 100) / 100 : amt, vat = isPayer ? Math.round((amt - base) * 100) / 100 : 0;
      const payer = String(dk.cust_name || '').trim(), part = String(dk.participant_name || '').trim();
      const buyer = payer || part || '—', participant = (part && part !== payer) ? part : '';
      const sess = String(dk.session_at || '').trim(), sDate = sess.slice(0, 10), sTime = sess.slice(11).trim();
      const isCard = !!dk.payment_intent && !String(dk.payment_intent).startsWith('pis');

      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      doc.registerFont('cz', DEJAVU_CZ); doc.font('cz');
      doc.fontSize(20).fillColor('#1a1a1a').text(en ? 'Payment confirmation' : 'Potvrzení o platbě');
      if (dk.doklad_no) doc.moveDown(0.1).fontSize(10).fillColor('#777777').text(dk.doklad_no + (dk.issued_at ? (' · ' + (en ? 'issued ' : 'vystaveno ') + d(dk.issued_at)) : ''));
      if (dk.test_mode) { doc.moveDown(0.6).fontSize(10).fillColor('#8a1c1c').text(en ? 'TEST MODE — not a formal tax document; no actual transaction took place' : 'TESTOVACÍ REŽIM — nejde o formální daňový doklad a k žádné skutečné transakci nedošlo'); }
      doc.moveDown(1);
      const row = (l, v, bold) => { if (v == null || v === '') return; const y = doc.y; doc.fontSize(11).fillColor('#777777').text(l, 50, y, { width: 220 }); const yl = doc.y; doc.fillColor('#1a1a1a').fontSize(bold ? 13 : 11).text(String(v), 280, y, { width: 265, align: 'right' }); doc.y = Math.max(yl, doc.y) + 5; doc.moveTo(50, doc.y - 2).lineTo(545, doc.y - 2).strokeColor('#eeeeee').stroke(); };
      row(en ? 'Provider (seller)' : 'Poskytovatel (prodejce)', dk.sup_name || '');
      row(en ? 'Issue date' : 'Datum vystavení', d(dk.issued_at));
      row(en ? 'Reg. number' : 'IČO', dk.sup_ico);
      row(en ? 'VAT ID' : 'DIČ', dk.sup_dic);
      row(en ? 'Address' : 'Sídlo', dk.sup_address);
      row(en ? 'Customer' : 'Odběratel', buyer);
      row(en ? 'Participant' : 'Účastník', participant);
      row(en ? 'Item' : 'Položka', (en ? itemLabelEn(String(dk.item_label || '').trim()) : String(dk.item_label || '').trim()) || (en ? 'Payment' : 'Platba'));
      if (sDate) row(en ? 'Session date' : 'Termín lekce', (d(sDate + 'T12:00:00') || sDate) + (sTime ? ' ' + sTime : ''));
      if (isCard) row(en ? 'Payment ref (Stripe)' : 'Reference platby (Stripe)', dk.payment_intent);
      if (isPayer) { row(en ? 'Net amount' : 'Základ daně', fmt(base) + ' ' + sym); row((en ? 'VAT ' : 'DPH ') + rate + '%', fmt(vat) + ' ' + sym); }
      else row(en ? 'VAT' : 'DPH', '0 ' + sym);
      row(en ? 'Total' : 'Celkem', fmt(amt) + ' ' + sym, true);
      if (!isPayer) doc.moveDown(0.3).fontSize(10).fillColor('#444444').text(en ? 'The provider is not a VAT payer.' : 'Poskytovatel není plátcem DPH.', 50);
      if (dk.vat_note) doc.moveDown(0.2).fontSize(9.5).fillColor('#444444').text(String(dk.vat_note), 50);
      doc.moveDown(1.2).fontSize(9).fillColor('#999999').text(en
        ? 'A valid proof of payment for your records. The seller of the service is the provider named above — MTL is the platform that facilitated the payment. Need a formal tax invoice? Request it from the provider. Generated via MTL.'
        : 'Platné potvrzení o zaplacení pro tvé účely. Prodejcem služby je výše uvedený poskytovatel — MTL je platforma, která platbu zprostředkovala. Potřebuješ formální daňový doklad (fakturu)? Vyžádej si ho u poskytovatele. Vygenerováno přes MTL.', 50, doc.y, { width: 495 });
      doc.end();
    } catch (e) { reject(e); }
  });
}

// Snímek dokladu k transakci / platbě -> { buffer, filename } nebo null (doklad nevystaven).
export async function dokladPdfFor({ transactionId, paymentIntent, en }) {
  let dk = null;
  if (transactionId) dk = await one(`doklady?transaction_id=eq.${q(transactionId)}&select=*&limit=1`);
  if (!dk && paymentIntent) dk = await one(`doklady?payment_intent=eq.${q(paymentIntent)}&select=*&limit=1`);
  if (!dk) return null;
  const buffer = await dokladPdfFromRow(dk, !!en);
  return { buffer, filename: (en ? 'receipt-' : 'doklad-') + String(dk.doklad_no || 'MTL').replace(/[^A-Za-z0-9-]/g, '') + '.pdf' };
}
