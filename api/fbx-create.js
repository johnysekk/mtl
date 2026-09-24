// /api/fbx-create.js — FINBRICKS: ZALOZENI PLATBY.
//
// Pouziva E-COMMERCE endpoint (/ecommerce/transaction/init), ne cisty PIS. Rozdil je zasadni:
// banku si vybira uzivatel az na strance Finbricks, takze NEPOTREBUJEME vlastni seznam bank,
// nepotrebujeme od cloveka IBAN platce a odpada cela autentizace uzivatele u banky na nasi
// strane. Oproti Neonomics, kde jsme museli resit seznam bank, session, device-id i narodni
// ID platce, je tohle jeden POST a presmerovani.
//
// MTL penize nikdy nedrzi: creditorAccountIban je ucet KLUBU nebo KOUCE, platba jde primo
// tam. My si jen vedeme, ze probehla.
//
// PAROVANI: merchantTransactionId je NASE UUID, ktere si ulozime na radek objednavky. Zadne
// hledani podle castky a symbolu, zadne ukladani ciziho identifikatoru. Duplicitni zalozeni
// tehoz ID vraci 409 -- idempotence zdarma.
//
// ENV: FINBRICKS_ENV, FINBRICKS_MERCHANT_ID, FINBRICKS_PRIVATE_KEY,
//      APP_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { fbxCall, psuIpFrom, FBX_SANDBOX, FBX_MAX_SANDBOX, MERCHANT_ID } from './_fbx.js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const APP_URL = process.env.APP_URL || 'https://app.martialtraininglab.com';

// Tabulky, ze kterych se da platit. Stejny seznam jako u ostatnich kolejí.
const TABLES = ['gym_bookings', 'gym_memberships', 'bookings', 'event_tickets', 'cohort_members', 'merch_orders'];

// Symboly: banka bere nejvys 10 znaku a prazdny retezec odmita.
const sym = (v) => {
  const s = String(v == null ? '' : v).replace(/\D/g, '').slice(0, 10);
  return s || undefined;
};
// Popis: 140 znaku a jen povolena sada (diakritika ano, emoji ne).
const desc = (v) => String(v || '')
  .replace(/[^a-zA-Z0-9áčďéěíňóřšťúůýžäĺľôŕÁČĎÉĚÍŇÓŘŠŤÚŮÝŽÄĹĽÔŔ()_\-@".,/':+\s]/g, ' ')
  .trim().slice(0, 140) || 'Platba MTL';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!MERCHANT_ID) return res.status(500).json({ error: 'FINBRICKS_MERCHANT_ID not configured' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const rowId = String(b.id || '');
    if (!rowId) return res.status(400).json({ error: 'no id' });

    // NEHADAT TABULKU PODLE DRUHU PLATBY. Appka vola tenhle endpoint z peti ruznych mist a
    // "kind" se u nich nepouziva jednotne -- soukroma lekce 1:1 ho neposila vubec, takze
    // odhad spadl na gym_bookings a radek se nenasel ("row not found"), i kdyz existoval
    // v bookings. Napoveda se pouzije, kdyz sedi; jinak se radek najde podle id.
    const hint = String(b.table || '');
    let table = null, row = null;
    if (TABLES.includes(hint)) {
      const r = await sb.from(hint).select('*').eq('id', rowId).maybeSingle();
      if (r.data) { table = hint; row = r.data; }
    }
    if (!row) {
      for (const t of TABLES) {
        if (t === hint) continue;
        const r = await sb.from(t).select('*').eq('id', rowId).maybeSingle();
        if (r.data) { table = t; row = r.data; break; }
      }
    }
    if (!row) return res.status(404).json({ error: 'row not found', id: rowId });

    // KOMU PENIZE JDOU. IBAN prijemce se bere z klubu nebo kouce, nikdy z pozadavku prohlizece
    // -- jinak by si kdokoli mohl presmerovat cizi platbu na svuj ucet.
    let iban = null, payeeName = null;
    if (row.gym_id) {
      const g = (await sb.from('gyms').select('receiver_id_value,legal_name,name').eq('id', row.gym_id).maybeSingle()).data;
      iban = g && g.receiver_id_value; payeeName = g && (g.legal_name || g.name);
    } else if (row.coach_id) {
      const c = (await sb.from('profiles').select('receiver_id_value,payout_receiver_id_value,legal_name,name').eq('id', row.coach_id).maybeSingle()).data;
      iban = c && (c.payout_receiver_id_value || c.receiver_id_value); payeeName = c && (c.legal_name || c.name);
    }
    if (!iban) return res.status(400).json({ error: 'payee has no IBAN' });

    const amountReal = Number(row.amount || b.amount || 0);
    if (!(amountReal > 0)) return res.status(400).json({ error: 'bad amount' });
    // V sandboxu se posila 1 Kc, ale na radku zustava skutecna castka -- jinak by se do
    // uctovani a dokladu propsala koruna.
    const amount = FBX_SANDBOX ? Math.min(amountReal, FBX_MAX_SANDBOX) : amountReal;

    const mtid = crypto.randomUUID();
    const payload = {
      merchantId: MERCHANT_ID,
      merchantTransactionId: mtid,
      amount: amount,
      creditorAccountIban: String(iban).replace(/\s+/g, ''),
      creditorName: payeeName ? String(payeeName).slice(0, 100) : undefined,
      variableSymbol: sym(b.variableSymbol || row.variable_symbol),
      description: desc(b.description || row.class_name || row.item_name || 'Platba MTL'),
      initiatorName: 'Martial Training Lab',
      // INST = okamzita platba: penize jsou na uctu klubu hned a potvrzeni prijde v radu vterin.
      // Kdyz banka INST neumi, Finbricks to resi vlastni logikou.
      instructionPriority: 'INST',
      // Sem se clovek vrati z banky. Finbricks sem zaroven posila oznameni o dokonceni.
      callbackUrl: APP_URL + '/api/fbx-callback?mtid=' + mtid,
      shoppingCartUrl: APP_URL + '/?fbxcancel=1',
    };
    Object.keys(payload).forEach((k) => payload[k] === undefined && delete payload[k]);

    const r = await fbxCall('POST', '/ecommerce/transaction/init', payload, {
      psuIp: psuIpFrom(req),
      psuUa: req.headers['user-agent'] || 'MTL/1.0',
      lang: (b.lang === 'en' ? 'en' : 'cs'),
    });
    if (!r.ok || !r.data || !r.data.redirectUrl) {
      // CHYBA OD FINBRICKS PATRI VEN, ne schovana pod "init failed". Jejich odpoved ma tvar
      // { code, message, xrequestId } -- podle kodu se pozna, jestli nesedi podpis (100/106),
      // chybi parametr (2xx) nebo nesmime poslat penize na cizi IBAN (301/10000).
      const d = r.data || {};
      console.error('[fbx-create]', r.status, JSON.stringify(d));
      return res.status(502).json({
        error: d.message ? ('Finbricks ' + (d.code != null ? d.code : r.status) + ': ' + d.message)
                         : ('Finbricks HTTP ' + r.status),
        code: d.code != null ? d.code : null,
        httpStatus: r.status,
        xrequestId: d.xrequestId || null,
        detail: d,
      });
    }

    // Az kdyz Finbricks platbu prijal, zapiseme si ji k objednavce.
    await sb.from(table).update({
      pis_payment_id: mtid,
      pis_provider: 'finbricks',
      pis_started_at: new Date().toISOString(),
    }).eq('id', rowId);

    return res.status(200).json({ ok: true, redirectUrl: r.data.redirectUrl, merchantTransactionId: mtid });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
