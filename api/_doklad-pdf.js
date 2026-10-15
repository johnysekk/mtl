// /api/_doklad-pdf.js — PDF DOKLADU ZE SNÍMKU (tabulka doklady).
//
// Kreslí se ze SNÍMKU vystaveného při platbě (nic z dnešních údajů) přes /doklad-layout.js --
// tentýž obsah a vzhled jako v appce. Přikládá se k potvrzení objednávky e-mailem u každé
// platby (karta, převod, QR, PIS, hotovost) a k fakturám MTL.

import PDFDocument from 'pdfkit';
import { DEJAVU_CZ } from './_dejavu-cz.js';
import { BEBAS } from './_bebas.js';
import { studentModel, mtlModel, renderPdf } from '../doklad-layout.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
async function one(p) { try { const r = await fetch(`${SB}/rest/v1/${p}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }); if (!r.ok) return null; const j = await r.json(); return (j && j[0]) || null; } catch (e) { return null; } }

// Obsah i rozvržení PDF je v /doklad-layout.js -- stejný model jako doklad v appce.
function dokladPdfFromRow(dk, en) { return renderPdf(studentModel(dk, en ? 'en' : 'cs'), { PDFDocument, font: DEJAVU_CZ, brandFont: BEBAS }); }
// Faktura / doklad MTL (commission_doklady): provize, Exclusive Partner, profil dodavatele, doklad o úhradě.
export function mtlDokladPdf(dk, lang) { return renderPdf(mtlModel(dk, lang), { PDFDocument, font: DEJAVU_CZ, brandFont: BEBAS }); }

// Snímek dokladu k transakci / platbě -> { buffer, filename } nebo null (doklad nevystaven).
export async function dokladPdfFor({ transactionId, paymentIntent, en }) {
  let dk = null;
  if (transactionId) dk = await one(`doklady?transaction_id=eq.${q(transactionId)}&select=*&limit=1`);
  if (!dk && paymentIntent) dk = await one(`doklady?payment_intent=eq.${q(paymentIntent)}&select=*&limit=1`);
  if (!dk) return null;
  const buffer = await dokladPdfFromRow(dk, !!en);
  return { buffer, filename: (en ? 'receipt-' : 'doklad-') + String(dk.doklad_no || 'MTL').replace(/[^A-Za-z0-9-]/g, '') + '.pdf' };
}
