// /api/ep-doklad.js — doklad za zaplacené Exclusive Partner předplatné.
//
// Za provizi vystavuje doklad unified-doklad-cron. Za EP se dosud nevystavovalo nic: klub
// měl jen fakturu od Stripe, kde dodavatelem není MTL. Pro účetnictví ani pro dotace to
// nestačí -- klub potřebuje doklad od toho, komu platí.
//
// Volá se ze stripe-webhooku při invoice.paid na partnerském předplatném.
// Interní endpoint: POST { intSecret, invoice_id, user_id, amount, currency, period_start,
//                          period_end, test_mode }

import { vatMode, vatNoteFor } from './_vat.js';
import { issueReceipts, receiptMailHtml } from './_receipt.js';

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
async function _mail(to, subject, html) {
  if (!RESEND || !to) return;
  try { await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }) }); }
  catch (e) { console.error('[ep-doklad] mail', e.message); }
}
// Faktura za EP do e-mailu. Stejný obsah a stejný rámeček stavu jako v appce.
function _epInvoiceHtml(r, en, payUrl) {
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
    + '<h2 style="margin:0 0 4px;">' + (en ? 'Invoice — Exclusive Partner subscription' : 'Faktura — předplatné Exclusive Partner') + '</h2>'
    + '<div style="font-size:13px;color:#555;">MTL-' + r.id + ' · ' + (en ? 'Period ' : 'Období ') + esc(r.period_month) + '</div>' + box
    + '<table style="width:100%;font-size:13px;"><tr><td style="vertical-align:top;width:50%;"><div style="font-size:11px;color:#888;text-transform:uppercase;">' + (en ? 'Supplier' : 'Dodavatel') + '</div>' + sup + '</td><td style="vertical-align:top;"><div style="font-size:11px;color:#888;text-transform:uppercase;">' + (en ? 'Customer' : 'Odběratel') + '</div>' + cust + '</td></tr></table>'
    + '<p style="margin-top:14px;"><b>' + (en ? 'Exclusive MTL Partner — subscription ' : 'Exclusive MTL Partner — předplatné ') + esc(r.period_month) + ':</b> ' + esc(m(r.amount)) + '</p>'
    + (note ? '<p style="font-size:12px;color:#555;">' + esc(note) + '</p>' : '')
    + '</div>';
}
function _amt(v, cur, lang) {
  try { return Number(v).toLocaleString(lang === 'en' ? 'en-GB' : 'cs-CZ', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ' + (String(cur).toUpperCase() === 'CZK' ? 'Kč' : String(cur).toUpperCase()); }
  catch (e) { return v + ' ' + cur; }
}
function _vatForEp(supCountry, custCountry, custDic, supIsVatPayer) {
  return vatMode(supCountry, custCountry, custDic, { kind: 'electronic', supIsVatPayer });
}


export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const b = req.body || {};
    if (!process.env.PIS_INTERNAL_SECRET || b.intSecret !== process.env.PIS_INTERNAL_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const uid = b.user_id;
    const amount = Number(b.amount || 0);
    const cur = String(b.currency || 'CZK').toUpperCase();
    if (!uid || !(amount > 0)) return res.status(400).json({ error: 'bad_input' });

    // Dvakrát ten samý doklad nevystavíme (unique index na pi_id to drží i v databázi).
    // FAKTURA UŽ JE A BYLA NEUHRAZENÁ (předplatné se napoprvé nepodařilo strhnout) a teď přišla
    // platba -> faktura se NEMĚNÍ, vystaví se k ní potvrzení o úhradě (_receipt.js).
    if (b.invoice_id) {
      const ex = await sb(`commission_doklady?select=id,due_amount&pi_id=eq.${encodeURIComponent(b.invoice_id)}&kind=eq.partner_sub&limit=1`);
      if (ex && ex.length) {
        if (!b.unpaid && Number(ex[0].due_amount) > 0) {
          const rc = await issueReceipts(`pi_id=eq.${encodeURIComponent(b.invoice_id)}&kind=eq.partner_sub`, {
            method: 'stripe_invoice', notifyUserId: uid, paidAt: new Date().toISOString(),
            mail: async (to, inv, r) => {
              let en = false; try { const p = (await sb(`profiles?id=eq.${encodeURIComponent(uid)}&select=lang`))[0]; en = !!(p && p.lang === 'en'); } catch (e) {}
              await _mail(to, en ? `Payment receipt MTL-${r.id} — invoice MTL-${inv.id}` : `Potvrzení o úhradě MTL-${r.id} — faktura MTL-${inv.id}`, receiptMailHtml(inv, r, en));
            },
          });
          return res.status(200).json({ ok: true, receipt: (rc[0] && rc[0].id) || null, invoice: ex[0].id });
        }
        return res.status(200).json({ ok: true, skipped: 'already_issued', id: ex[0].id });
      }
    }

    // Odběratel: fakturační identita poskytovatele.
    const pr = (await sb(`profiles?id=eq.${encodeURIComponent(uid)}&select=id,name,email,phone,legal_name,`
      + `tax_id,vat_id,vat_payer,billing_line1,billing_line2,billing_city,billing_postal,billing_country,country_code,invoice_email,lang`))[0];
    if (!pr) return res.status(404).json({ error: 'user_not_found' });

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

    // Status odberatele (ICO) na rezim nema vliv: rozhoduje zeme a DIC, proto se uz nepredava.
    const V = _vatForEp(ME.country, custCountry, pr.vat_id, ME.vat_payer);

    // OSS NECHCEME. Odběratel z jiné země EU bez DIČ = doklad se nevystaví, stejně jako to
    // dělá doklad za provizi (require_vat_foreign). Platba zůstává evidovaná a doklad
    // vystavíme zpětně, jak DIČ doplní.
    if (V.mode === 'oss_pending' && ME.require_vat_foreign) {
      try {
        await sb('notifications', { method: 'POST', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ user_id: uid, type: 'system', read: false,
            message: '⚠️ Faktura za Exclusive MTL Partner zatím nevystavena — doplň DIČ (VAT ID), ať ji můžeme vystavit podle EU pravidel.',
            data: JSON.stringify({ kind: 'doklad_vat_needed', needs: 'vat_id', period: String(b.period_start || '').slice(0,7),
              amount, currency: cur,
              msg_en: '⚠️ The Exclusive MTL Partner invoice is not issued yet — add your VAT ID so we can issue it under EU rules.' }) }) });
      } catch (e) {}
      return res.status(200).json({ ok: true, deferred: 'vat_id_required' });
    }

    const period = String(b.period_start || new Date().toISOString()).slice(0, 7);
    const label = 'Exclusive MTL Partner — předplatné ' + period;
    // ČÁSTKA V HALÉŘÍCH/CENTECH, stejně jako každý jiný řádek commission_doklady (doklad o
    // provizi). Webhook posílá celé koruny (amount_paid/100); dřív se uložily tak, jak přišly,
    // a appka (dělí stovkou) by ukázala 5,00 Kč místo 500 Kč.
    const amountMinor = Math.round(amount * 100);

    const row = {
      owner_id: uid, coach_id: uid,
      period_month: period, currency: cur, amount: amountMinor,
      pi_id: b.invoice_id || null,
      kind: 'partner_sub',
      status: (V.mode === 'oss_pending' ? 'review' : 'issued'),   // OSS ruční kontrola
      charged_at: new Date().toISOString(),
      issued_at: new Date().toISOString(),
      test_mode: !!b.test_mode,
      // Neuhrazená faktura (stržení předplatného selhalo): celá částka „K úhradě".
      due_amount: b.unpaid ? amountMinor : 0,
      // Pole, ne JSON.stringify -- jinak se do jsonb uložil řetězec a appka z něj nečetla položku.
      line_items: [{ label, amount: amountMinor, currency: cur,
        period_start: b.period_start || null, period_end: b.period_end || null,
        pay_url: b.unpaid ? (b.pay_url || null) : undefined, next_attempt: b.unpaid ? (b.next_attempt || null) : undefined }],
      // odběratel
      cust_name: pr.legal_name || pr.name || '—',
      cust_trade_name: (pr.name && pr.name !== pr.legal_name) ? pr.name : null,
      cust_ico: pr.tax_id || null, cust_dic: pr.vat_id || null,
      cust_address: custAddr || null, cust_vat_payer: !!pr.vat_payer,
      cust_country: custCountry, cust_email: pr.invoice_email || pr.email || null, cust_phone: pr.phone || null,
      // dodavatel
      sup_name: ME.name, sup_ico: ME.ico, sup_dic: ME.dic, sup_address: ME.address,
      // DPH jen u domácího plnění. U ostatních režimů nula a důvod je v vat_note.
      sup_vat_payer: ME.vat_payer, sup_vat_rate: (V.mode === 'domestic' ? ME.vat_rate : 0),
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
      if (!/sup_register|due_amount/.test(String(e && e.message))) throw e;
      // Neuhrazenou fakturu bez sloupce due_amount vystavit nejde -- vypadala by jako uhrazená.
      if (row.due_amount > 0) return res.status(200).json({ ok: true, deferred: 'run_sql_doklad_register' });
      delete row.sup_register; delete row.due_amount;
      ins = await sb('commission_doklady', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
    }
    const id = (ins && ins[0] && ins[0].id) || null;

    // Poskytovatel se to má dozvědět stejně jako u dokladu za provizi.
    try {
      await sb('notifications', { method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: uid, type: 'system', read: false,
          // kind 'doklad_unified' -- stejná notifikace jako u dokladu o provizi: proklik otevře
          // rovnou tenhle doklad (showCommissionDoklad). Dřív 'ep_doklad', na který appka neuměla kliknout.
          message: b.unpaid
            ? ('⚠️ Předplatné Exclusive MTL Partner za ' + period + ' (' + _amt(amount, cur, 'cs') + ') se nepodařilo strhnout z karty. Faktura je vystavená s částkou k úhradě; Stripe platbu zkusí znovu, zaplatit můžeš i hned odkazem ve faktuře.')
            : ('🧾 Exclusive MTL Partner za ' + period + ': ' + _amt(amount, cur, 'cs') + ' uhrazeno kartou. Faktura je vystavená.'),
          data: JSON.stringify({ kind: 'doklad_unified', doklad_id: id, coach_id: uid, period, amount: amountMinor, currency: cur,
            msg_en: b.unpaid
              ? ('⚠️ The Exclusive MTL Partner subscription for ' + period + ' (' + _amt(amount, cur, 'en') + ') could not be charged to your card. The invoice has been issued with the amount due; Stripe will retry, or you can pay right away via the link in the invoice.')
              : ('🧾 Exclusive MTL Partner for ' + period + ': ' + _amt(amount, cur, 'en') + ' paid by card. The invoice has been issued.') }) }) });
    } catch (e) {}

    // E-MAIL s fakturou (dřív žádný -- faktura za EP byla jen v appce).
    try {
      const en = pr.lang === 'en';
      if (row.cust_email && id) await _mail(row.cust_email,
        (en ? 'Invoice MTL-' + id + ' — Exclusive Partner ' : 'Faktura MTL-' + id + ' — Exclusive Partner ') + period,
        _epInvoiceHtml(Object.assign({}, row, { id }), en, b.unpaid ? (b.pay_url || null) : null));
    } catch (e) {}

    return res.status(200).json({ ok: true, id, vat_mode: V.mode });
  } catch (e) {
    console.error('[ep-doklad]', (e && e.message) || e);
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
