// /api/ep-doklad.js — doklad za zaplacené Exclusive Partner předplatné.
//
// Za provizi vystavuje doklad unified-doklad-cron. Za EP se dosud nevystavovalo nic: klub
// měl jen fakturu od Stripe, kde dodavatelem není MTL. Pro účetnictví ani pro dotace to
// nestačí -- klub potřebuje doklad od toho, komu platí.
//
// Volá se ze stripe-webhooku při invoice.paid na partnerském předplatném.
// Interní endpoint: POST { intSecret, invoice_id, user_id, amount, currency, period_start,
//                          period_end, test_mode }

import { vatMode } from './_vat.js';

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
//   1) MTL není plátce DPH  -> na dokladu žádná DPH, ať je odběratel kdekoli
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
    if (b.invoice_id) {
      const ex = await sb(`commission_doklady?select=id&pi_id=eq.${encodeURIComponent(b.invoice_id)}&limit=1`);
      if (ex && ex.length) return res.status(200).json({ ok: true, skipped: 'already_issued', id: ex[0].id });
    }

    // Odběratel: fakturační identita poskytovatele.
    const pr = (await sb(`profiles?id=eq.${encodeURIComponent(uid)}&select=id,name,email,phone,legal_name,`
      + `tax_id,vat_id,vat_payer,billing_line1,billing_line2,billing_city,billing_postal,billing_country,country_code`))[0];
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
            message: '⚠️ Doklad za Exclusive MTL Partner zatím nevystaven — doplň DIČ (VAT ID), ať ho můžeme vystavit podle EU pravidel.',
            data: JSON.stringify({ kind: 'doklad_vat_needed', needs: 'vat_id', period: String(b.period_start || '').slice(0,7),
              amount, currency: cur,
              msg_en: '⚠️ The Exclusive MTL Partner receipt is not issued yet — add your VAT ID so we can issue it under EU rules.' }) }) });
      } catch (e) {}
      return res.status(200).json({ ok: true, deferred: 'vat_id_required' });
    }

    const period = String(b.period_start || new Date().toISOString()).slice(0, 7);
    const label = 'Exclusive MTL Partner — předplatné ' + period;

    const row = {
      owner_id: uid, coach_id: uid,
      period_month: period, currency: cur, amount,
      pi_id: b.invoice_id || null,
      kind: 'partner_sub',
      status: (V.mode === 'oss_pending' ? 'review' : 'issued'),   // OSS ruční kontrola
      charged_at: new Date().toISOString(),
      issued_at: new Date().toISOString(),
      test_mode: !!b.test_mode,
      line_items: JSON.stringify([{ label, amount, currency: cur,
        period_start: b.period_start || null, period_end: b.period_end || null }]),
      // odběratel
      cust_name: pr.legal_name || pr.name || '—',
      cust_trade_name: (pr.name && pr.name !== pr.legal_name) ? pr.name : null,
      cust_ico: pr.tax_id || null, cust_dic: pr.vat_id || null,
      cust_address: custAddr || null, cust_vat_payer: !!pr.vat_payer,
      cust_country: custCountry, cust_email: pr.email || null, cust_phone: pr.phone || null,
      // dodavatel
      sup_name: ME.name, sup_ico: ME.ico, sup_dic: ME.dic, sup_address: ME.address,
      // DPH jen u domácího plnění. U ostatních režimů nula a důvod je v vat_note.
      sup_vat_payer: ME.vat_payer, sup_vat_rate: (V.mode === 'domestic' ? ME.vat_rate : 0),
      sup_phone: ME.phone, sup_email: ME.email, sup_country: ME.country,
      // daňový režim
      vat_mode: V.mode, vat_note: V.note,
    };

    const ins = await sb('commission_doklady', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row),
    });
    const id = (ins && ins[0] && ins[0].id) || null;

    // Poskytovatel se to má dozvědět stejně jako u dokladu za provizi.
    try {
      await sb('notifications', { method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: uid, type: 'system', read: false,
          message: '🧾 Doklad za Exclusive MTL Partner (' + period + ') je připravený',
          data: JSON.stringify({ kind: 'ep_doklad', doklad_id: id, period, amount, currency: cur }) }) });
    } catch (e) {}

    return res.status(200).json({ ok: true, id, vat_mode: V.mode });
  } catch (e) {
    console.error('[ep-doklad]', (e && e.message) || e);
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
