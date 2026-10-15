// /api/_receipt.js — DOKLAD O UHRAZENÉ PROVIZI MTL k fakturám, které byly vystaveny jako neuhrazené.
//
// PROČ DVA DOKUMENTY. Vystavená faktura se už NIKDY nemění -- ani jejím „stavem". Když se
// provizi (nebo předplatné EP) nepodaří strhnout včas, vznikne faktura s částkou „K úhradě".
// Až se dlužná částka později strhne nebo zaplatí, vystaví se k ní SAMOSTATNÉ potvrzení
// o úhradě (vlastní číslo, odkaz na fakturu, částka, kdy a jak se zaplatilo). Stejně to
// dělají Stripe / Resend: invoice + receipt. Faktura zaplacená včas potvrzení nepotřebuje --
// sama říká „Uhrazeno v plné výši".
//
// Doklad je řádek v commission_doklady s kind 'payment_receipt'; line_items vyjmenují uhrazené
// faktury (ref = id faktury), ref_doklad_id = první z nich. Faktura se uvede nejvýš jednou.

// Název dokladu, číslo a částky -- stejné jako na dokladu (/doklad-layout.js).
import { receiptTitle, docNo, money, mtlModel, esc } from '../doklad-layout.js';
import { mtlDokladPdf } from './_doklad-pdf.js';
export { receiptTitle, docNo };

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
async function get(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H() });
  if (!r.ok) throw new Error(`${path}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function post(table, body, prefer) {
  const r = await fetch(`${SB}/rest/v1/${table}`, { method: 'POST', headers: { ...H(), Prefer: prefer || 'return=representation' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${table}: ${(await r.text()).slice(0, 200)}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
// NEUHRAZENÉ A DOSUD NEZDOKUMENTOVANÉ FAKTURY. Faktura s due_amount > 0 je „zdokumentovaná",
// když ji uvádí doklad o úhradě (line_items[].ref) nebo pozdější faktura v rámečku úhrady
// (paid_other[].ref). Faktura sama se nikdy nemění -- stav úhrady říkají jen tyhle odkazy.
export async function undocumentedUnpaid(filter) {
  let inv = [];
  try { inv = (await get(`commission_doklady?${filter}&due_amount=gt.0&kind=neq.payment_receipt&select=*&order=id.asc&limit=100`)) || []; }
  catch (e) { console.error('[receipt] load', e.message); return []; }
  const out = [];
  for (const d of inv) {
    try {
      const j = encodeURIComponent(JSON.stringify([{ ref: d.id }]));
      // Dva dotazy místo or=(...): JSON v or-filtru PostgREST by musel být zvlášť escapovaný.
      const a1 = await get(`commission_doklady?kind=eq.payment_receipt&ref_doklad_id=eq.${d.id}&select=id&limit=1`);
      if (a1 && a1.length) continue;
      const a2 = await get(`commission_doklady?kind=eq.payment_receipt&line_items=cs.${j}&select=id&limit=1`);
      if (a2 && a2.length) continue;
      const b = await get(`commission_doklady?paid_other=cs.${j}&select=id&limit=1`);
      if (b && b.length) continue;
      out.push(d);
    } catch (e) { console.error('[receipt] check', d.id, e.message); }
  }
  return out;
}

// JEDEN DOKLAD O UHRAZENÉ PROVIZI ZA JEDNU PLATBU. Platba (opakované stržení z karty, „Zaplatit
// hned", pozdější platba EP) může zaplatit víc neuhrazených faktur najednou -- doklad je
// vyjmenuje všechny (číslo faktury, období, částka). Vznikne jen tehdy, když platbu neuvede
// nová faktura (viz paid_other v unified-doklad-cron).
// filter = PostgREST filtr na faktury, ke kterým platba patří, např.
//   `gym_id=eq.<id>&kind=eq.unified&currency=ilike.czk`  (provize)
//   `pi_id=eq.<stripe invoice id>&kind=eq.partner_sub`    (EP)
// method: 'card_on_file' | 'card_paynow' | 'stripe_invoice'. Vrací [doklad] nebo [].
export async function issueReceipts(filter, opts = {}) {
  const inv = await undocumentedUnpaid(filter);
  if (!inv.length) return [];
  const d = inv[0];
  const now = new Date().toISOString();
  const total = inv.reduce((a, x) => a + (Number(x.due_amount) || 0), 0);
  const row = {
    kind: 'payment_receipt', ref_doklad_id: d.id, ref_kind: d.kind || null, status: 'issued',
    owner_id: d.owner_id || null, gym_id: d.gym_id || null, coach_id: d.coach_id || null, organization_id: d.organization_id || null,
    billing_identity: d.billing_identity || null,
    period_month: inv[inv.length - 1].period_month, currency: d.currency, amount: total,
    bank_amount: 0, stripe_amount: 0, due_amount: 0,
    charged_at: opts.paidAt || now, issued_at: now, test_mode: !!d.test_mode,
    pi_id: null,
    line_items: inv.map((x) => ({ label: 'Úhrada faktury ' + docNo(x), ref: x.id, doc_no: docNo(x), period: x.period_month,
      amount: Number(x.due_amount) || 0, reason: x.due_reason || null, method: opts.method || null })),
    // Strany se přebírají z faktury: doklad patří k ní a nesmí ukázat jiného odběratele.
    cust_name: d.cust_name, cust_trade_name: d.cust_trade_name, cust_ico: d.cust_ico, cust_dic: d.cust_dic,
    cust_address: d.cust_address, cust_vat_payer: d.cust_vat_payer, cust_country: d.cust_country,
    cust_email: d.cust_email, cust_phone: d.cust_phone,
    sup_name: d.sup_name, sup_ico: d.sup_ico, sup_dic: d.sup_dic, sup_address: d.sup_address,
    sup_vat_payer: d.sup_vat_payer, sup_vat_rate: d.sup_vat_rate, sup_phone: d.sup_phone, sup_email: d.sup_email,
    sup_country: d.sup_country, sup_register: d.sup_register || null,
  };
  let r = null;
  try { const ins = await post('commission_doklady', row); r = Array.isArray(ins) ? ins[0] : ins; }
  catch (e) { console.error('[receipt] issue', e.message); return []; }
  if (!r) return [];
  const nos = inv.map(docNo).join(', ');
  const uid = opts.notifyUserId || d.owner_id || d.coach_id;
  if (uid && !opts.noNotify) {
    const cs = `✅ Uhrazeno ${money(total, d.currency, 'cs')} — ${inv.length > 1 ? 'faktury' : 'faktura'} ${nos}. Vystavili jsme ${receiptTitle(d.kind, false)} ${docNo(r)}.`;
    const en = `✅ Paid ${money(total, d.currency, 'en')} — ${inv.length > 1 ? 'invoices' : 'invoice'} ${nos}. ${receiptTitle(d.kind, true)} ${docNo(r)} has been issued.`;
    try {
      await post('notifications', { user_id: uid, type: 'system', read: false, message: cs,
        data: JSON.stringify({ kind: 'doklad_unified', doklad_id: r.id, gym_id: d.gym_id || null, coach_id: d.coach_id || null,
          organization_id: d.organization_id || null, period: d.period_month, msg_en: en }) }, 'return=minimal');
    } catch (e) {}
  }
  if (typeof opts.mail === 'function' && d.cust_email) {
    try { await opts.mail(d.cust_email, d, r); } catch (e) {}
  }
  return [r];
}

// E-MAIL S DOKLADEM O ÚHRADĚ: krátký dopis a doklad jako PDF v příloze -- stejně jako faktura.
// Doklad do těla e-mailu nepatří (písmo i vzhled tam každá pošta rozbije jinak). Když se PDF
// nepodaří vytvořit, dopis odkáže do appky. Vrací { html, attachments } pro Resend.
export async function receiptMail(r, en, refKind) {
  const lang = en ? 'en' : 'cs', no = esc(docNo(r)), amt = esc(money(r.amount, r.currency, lang)), title = receiptTitle(refKind, lang);
  let attachments = [];
  try { const buf = await mtlDokladPdf(r, lang); attachments = [{ filename: String(docNo(r)).replace(/[^A-Za-z0-9-]/g, '') + '.pdf', content: buf.toString('base64') }]; }
  catch (e) { console.error('[receipt] pdf', e.message); }
  const test = mtlModel(r, lang).test;
  const line = attachments.length
    ? (en ? ('attached is <b>' + esc(title) + '</b> ' + no + ', amount <b>' + amt + '</b>.') : ('v příloze posíláme <b>' + esc(title.charAt(0).toLowerCase() + title.slice(1)) + '</b> ' + no + ', částka <b>' + amt + '</b>.'))
    : (en ? ('we have issued <b>' + esc(title) + '</b> ' + no + ', amount <b>' + amt + '</b>. The PDF could not be attached this time; you will find it in the MTL app under Payments and commission → Invoices.')
          : ('vystavili jsme <b>' + esc(title.charAt(0).toLowerCase() + title.slice(1)) + '</b> ' + no + ', částka <b>' + amt + '</b>. PDF se teď nepodařilo připojit; najdeš ho v appce MTL v Platby a provize → Faktury.'));
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:14px;line-height:1.6;">'
    + (test ? '<div style="background:#FDECEC;border:1px solid #F3C0C0;border-radius:8px;color:#8a1c1c;font:700 12px/1.4 Arial,sans-serif;padding:9px 12px;margin-bottom:14px;">' + esc(test) + '</div>' : '')
    + '<p style="margin:0 0 10px;">' + (en ? 'Hello' : 'Dobrý den') + ',</p><p style="margin:0 0 10px;">' + line + '</p>'
    + '<p style="margin:18px 0 0;color:#888;font-size:12px;">' + esc(r.sup_name || 'Martial Training Lab') + (r.sup_email ? (' · ' + esc(r.sup_email)) : '') + (r.sup_phone ? (' · ' + esc(r.sup_phone)) : '') + '</p></div>';
  return { html, attachments };
}
