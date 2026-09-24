// /api/fbx-callback.js — FINBRICKS: POTVRZENI PLATBY.
//
// Finbricks na tuhle adresu (1) presmeruje uzivatele po dokonceni platby a zaroven ji (2)
// vola jako oznameni. Obojí se resi stejne, protoze TELU SE NEVERI: callback je jen spousteč.
// Stav si overime sami podepsanym dotazem na /transaction/platform/status.
//
// Tim padá cely problem s overovanim podpisu webhooku, na kterem stal Enable Banking: kdyz
// nam nekdo cizi zavola tuhle adresu s vymyslenym mtid, nedozvi se nic a nic se nezauctuje --
// rozhoduje odpoved Finbricks na nas vlastni podepsany dotaz, ne to, co prislo.
//
// Zauctovani, notifikace a doklad delá pisSideEffects z pis-return.js -- je to na bance
// nezavisla cast a uz prezila dve migrace poskytovatele.

import { createClient } from '@supabase/supabase-js';
import { fbxCall, fbxOutcome, MERCHANT_ID } from './_fbx.js';
import { pisSideEffects } from './pis-return.js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const APP_URL = process.env.APP_URL || 'https://app.martialtraininglab.com';
const TABLES = ['gym_bookings', 'gym_memberships', 'bookings', 'event_tickets', 'cohort_members', 'merch_orders'];

// Kam se clovek vrati. Prohlizec pozna redirect podle toho, ze prijde GET s Accept: text/html.
const backToApp = (res, q) => {
  res.setHeader('Location', APP_URL + '/?' + q);
  return res.status(302).end();
};

export default async function handler(req, res) {
  const mtid = String((req.query && (req.query.mtid || req.query.merchantTransactionId)) || '');
  const wantsHtml = String(req.headers.accept || '').includes('text/html');
  if (!mtid) return wantsHtml ? backToApp(res, 'fbx=err') : res.status(400).json({ error: 'no mtid' });
  if (!MERCHANT_ID) return res.status(500).json({ error: 'FINBRICKS_MERCHANT_ID not configured' });

  try {
    // 1) Najit objednavku podle NASEHO identifikatoru.
    let tbl = null, rec = null;
    for (const t of TABLES) {
      const r = await sb.from(t).select('*').eq('pis_payment_id', mtid).maybeSingle();
      if (r.data) { tbl = t; rec = r.data; break; }
    }
    if (!rec) return wantsHtml ? backToApp(res, 'fbx=unknown') : res.status(200).json({ ok: true, note: 'unknown mtid' });

    // 2) Zeptat se Finbricks, jak to dopadlo. Query musi byt v podpisu presne tak, jak se posila.
    const path = `/transaction/platform/status?merchantId=${encodeURIComponent(MERCHANT_ID)}&merchantTransactionId=${encodeURIComponent(mtid)}`;
    const r = await fbxCall('GET', path, null);
    const out = fbxOutcome(r.data);

    // 3) Dokud neni stav konecny, NIC se nezauctovava. Uzivatel se vrati do appky s informaci,
    //    ze platba probiha; potvrzeni dorazi pozdeji dalsim volanim teto adresy.
    if (!out.final) {
      return wantsHtml ? backToApp(res, 'fbx=pending') : res.status(200).json({ ok: true, status: out.code, final: false });
    }

    if (out.paid) {
      // Idempotence: kdyz uz je zaplaceno, podruhe se nic nedela (callback muze prijit vicekrat).
      const already = ['paid', 'active', 'confirmed'].includes(String(rec.status || '').toLowerCase());
      if (!already) {
        await sb.from(tbl).update({ status: 'paid', paid_at: new Date().toISOString(), payment_method: 'pis' }).eq('id', rec.id);
        try { await pisSideEffects({ ...rec, status: 'paid' }, tbl); } catch (e) { console.error('[fbx] sideEffects', e && e.message); }
      }
      return wantsHtml ? backToApp(res, 'fbx=ok') : res.status(200).json({ ok: true, status: out.code, paid: true });
    }

    // 4) Konecne neuspesne: uvolnit rezervaci, at misto nezustane blokovane.
    if (out.failed) {
      try { await sb.from(tbl).update({ status: 'cancelled', pis_failed_at: new Date().toISOString() }).eq('id', rec.id); } catch (e) {}
    }
    return wantsHtml ? backToApp(res, 'fbx=fail') : res.status(200).json({ ok: true, status: out.code, paid: false });
  } catch (e) {
    console.error('[fbx-callback]', e && e.message);
    return wantsHtml ? backToApp(res, 'fbx=err') : res.status(500).json({ error: String((e && e.message) || e) });
  }
}
