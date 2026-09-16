// /api/org-fee-record — zaúčtování členského poplatku asociaci.
//
// Volá se ve chvíli, kdy je poplatek zaplacený (PIS webhook, návrat z banky, nebo ručně
// označená hotovost/převod). Dělá tři věci a všechny stejně jako u poskytovatele:
//   1) zapíše transakci, aby měla asociace z čeho postavit přehled vybraných peněz
//   2) vystaví DOKLAD jako snímek v čase vystavení -- klub zaplatil, tak musí něco dostat
//   3) provize MTL je NULOVÁ: členské poplatky a vzdělávací činnost se nezpoplatňují
//
// Doklad vystavuje ASOCIACE KLUBU. MTL v tom není smluvní stranou, stejně jako u dokladu
// poskytovatele studentovi.

import { isTestMode } from './_config.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── FAKTURAČNÍ ADRESA ────────────────────────────────────────────────────────────────────
// Pravda je v rozpadu billing_line1/line2/city/postal (potřebuje ho DAC7). Jednořádkový
// tvar je jen pro zobrazení na dokladu, takže se SKLÁDÁ při čtení, ne ukládá zvlášť --
// dvě kopie téže adresy se vždy rozejdou.
// Prefix pokrývá druhou fakturační identitu kouče (payout_).
function _billAddr(row, prefix) {
  try {
    if (!row) return null;
    const p = prefix || '';
    const g = (k) => {
      const v = row[p + k];
      return (v == null) ? '' : String(v).trim();
    };
    const l1 = g('billing_line1'), l2 = g('billing_line2');
    const city = g('billing_city'), zip = g('billing_postal');
    const parts = [l1, l2, ((zip ? zip + ' ' : '') + city).trim()]
      .filter((x) => x && x.trim());
    if (parts.length) return parts.join(', ');
    // Záloha pro řádky z doby před rozpadem, kde je jen složený tvar.
    const legacy = g('billing_address');
    return legacy || null;
  } catch (e) { return null; }
}

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    ...(opts.body ? { body: opts.body } : {}),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 180)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// Číslo dokladu i klíč řady se počítají STEJNĚ jako u poskytovatele: IČO + účet.
// Asociace je samostatný účetní subjekt, takže má vlastní souvislou řadu.
async function issueOrgDoklad(oc, org, amount, currency, method, testMode, transactionId) {
  try {
    const ico = String(org.tax_id || '').replace(/\s/g, '');
    if (!ico || !org.owner_id) return null;
    const key = 'ico:' + ico + ':acct:' + org.owner_id;

    const r = await fetch(`${SB}/rest/v1/rpc/doklad_next`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: key }),
    });
    if (!r.ok) return null;
    let no = await r.json();
    if (no && typeof no === 'object') no = Array.isArray(no) ? no[0] : Object.values(no)[0];
    if (!no) return null;

    // Odběratel: klub v MTL, nebo klub vedený jen asociací. Údaje se OPISUJÍ -- pozdější
    // změna názvu nebo adresy nesmí přepsat už vystavený doklad.
    let cust = { name: oc.ext_legal_name || oc.ext_name || null, email: oc.ext_email || oc.guest_email || null,
                 ico: oc.ext_tax_id || null, address: oc.ext_address || null };
    if (oc.gym_id) {
      const g = (await sb(`gyms?id=eq.${encodeURIComponent(oc.gym_id)}&select=name,legal_name,tax_id,vat_id,billing_line1,billing_line2,billing_city,billing_postal,invoice_email`))[0];
      if (g) cust = { name: g.legal_name || g.name || null, email: g.invoice_email || null,
                      ico: g.tax_id || null, address: _billAddr(g) || null };
    }

    const label = oc.fee_label || 'Členský poplatek';
    await sb('doklady', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({
        doklad_no: String(no), series_key: key,
        transaction_id: transactionId || null, payment_intent: oc.fee_payment_intent || null,
        sup_name: org.legal_name || org.name || null,
        sup_ico: ico, sup_dic: org.vat_id || null, sup_address: _billAddr(org) || null,
        sup_vat_payer: !!org.vat_payer, sup_vat_rate: (org.vat_rate != null ? org.vat_rate : null),
        cust_name: cust.name, cust_email: cust.email,
        item_label: label,
        amount: Math.round(Number(amount) || 0), currency: String(currency || 'CZK').toUpperCase(),
        payment_method: method || null, test_mode: !!testMode,
      }),
    });
    return String(no);
  } catch (e) { console.error('issueOrgDoklad', e && e.message); return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    if (!SB || !KEY) return res.status(500).json({ error: 'server not configured' });
    const { oc_id, method, test_mode } = req.body || {};

    // Testovací režim si server zjistí sám (viz org-ticket-record.js).
    let _test = !!test_mode;
    try { _test = _test || (await isTestMode()); } catch (e) {}
    if (!oc_id) return res.status(400).json({ error: 'oc_id required' });

    const oc = (await sb(`organization_clubs?id=eq.${encodeURIComponent(oc_id)}&select=*`))[0];
    if (!oc) return res.status(404).json({ error: 'not found' });

    // Pozastavená organizace nic neúčtuje. Stejné pravidlo jako u klubu a kouče -- jinak by
    // stačilo obejít appku přímým voláním a inkasovat dál.
    try {
      if (oc.organization_id) {
        const _o = (await sb(`organizations?id=eq.${encodeURIComponent(oc.organization_id)}&select=account_suspended`))[0];
        if (_o && _o.account_suspended) return res.status(403).json({ error: 'organization suspended' });
      }
    } catch (e) { /* nedostupná databáze platbu neblokuje */ }
    if (!oc.fee_paid_at) return res.status(409).json({ error: 'not paid yet' });

    // Dvakrát zaúčtovat nejde: doklad je nevratný a druhé číslo v řadě by nešlo vzít zpět.
    const dup = await sb(`transactions?org_fee_id=eq.${encodeURIComponent(oc_id)}&select=id&limit=1`);
    if (dup && dup.length) return res.status(200).json({ ok: true, already: true });

    const org = (await sb(`organizations?id=eq.${encodeURIComponent(oc.organization_id)}&select=id,name,legal_name,tax_id,vat_id,vat_payer,vat_rate,billing_line1,billing_line2,billing_city,billing_postal,owner_id`))[0];
    if (!org) return res.status(404).json({ error: 'org not found' });

    // Popis se opíše z období, aby na dokladu stálo, ZA CO klub platil.
    let label = 'Členský poplatek';
    let amount = Number(oc.fee_amount || 0);
    let currency = oc.fee_currency || 'CZK';

    // ── KDYŽ ŘÁDEK NEMÁ ANI CENU, ANI fee_id ──────────────────────────────────────────
    // Tohle je reálný stav dat: platba se označí jako zaplacená (fee_paid_at), ale cena ani
    // odkaz na ceníkovou položku se na řádek klubu nezapíšou. Zaúčtování pak nemá z čeho
    // vzít částku, skončí na „no amount" a po platbě nezůstane účetně nic.
    // Dohledáme položku ceníku, jejíž období pokrývá den platby; když žádná nesedí, vezmeme
    // nejnovější aktivní. Lepší zaúčtovat podle ceníku než nezaúčtovat vůbec.
    if (!oc.fee_id && !(amount > 0) && oc.organization_id) {
      try {
        const day = String(oc.fee_paid_at || new Date().toISOString()).slice(0, 10);
        let f = (await sb(`org_member_fees?organization_id=eq.${encodeURIComponent(oc.organization_id)}` +
          `&period_from=lte.${day}&period_to=gte.${day}&order=period_from.desc&limit=1`))[0];
        if (!f) {
          f = (await sb(`org_member_fees?organization_id=eq.${encodeURIComponent(oc.organization_id)}` +
            `&active=is.true&order=period_from.desc&limit=1`))[0];
        }
        if (f) {
          amount = Number(f.amount || 0);
          currency = f.currency || currency;
          oc.fee_id = f.id;   // ať se popis níž složí ze stejné položky
          console.log('[org-fee-record] fee_id doplněn z ceníku:', f.id, amount, currency);
        }
      } catch (e) { /* když ceník nedohledáme, spadne to níž na „no amount" jako dřív */ }
    }

    if (oc.fee_id) {
      const f = (await sb(`org_member_fees?id=eq.${encodeURIComponent(oc.fee_id)}&select=name,amount,currency,period_from,period_to`))[0];
      if (f) {
        if (!amount) { amount = Number(f.amount || 0); currency = f.currency || currency; }
        const _d = (v) => { try { return new Date(v).toLocaleDateString('cs-CZ'); } catch (e) { return v; } };
        label = (f.name ? f.name : 'Členský poplatek') + ' · ' + _d(f.period_from) + ' – ' + _d(f.period_to);
      }
    }
    if (!(amount > 0)) return res.status(400).json({ error: 'no amount' });

    // PROVIZE MTL JE NULOVÁ. Členské poplatky a vzdělávací činnost se nezpoplatňují --
    // není to prodej tréninku, je to vnitřní chod asociace.
    const tx = await sb('transactions', {
      method: 'POST', prefer: 'return=representation',
      body: JSON.stringify({
        organization_id: org.id, org_fee_id: oc.id,
        gym_id: oc.gym_id || null,
        type: 'org_fee', status: 'completed',
        // Provize je nulova, takze neni co vybirat -- rovnou uzavreno, aby commission-cron
        // nepocital nuly a nechodily prazdne vyzvy.
        commission_status: 'collected', commission_month: new Date().toISOString().slice(0, 7),
        gross_amount: Math.round(amount), currency: String(currency).toUpperCase(),
        mtl_fee: 0, base_rate: 0,
        payment_method: method || 'pis',
        paid_to: 'organization',
        created_at: oc.fee_paid_at || new Date().toISOString(),
        test_mode: _test,
      }),
    });
    const txId = (tx && tx[0] && tx[0].id) || null;

    const no = await issueOrgDoklad({ ...oc, fee_label: label }, org, amount, currency, method || 'pis', _test, txId);
    return res.status(200).json({ ok: true, transaction_id: txId, doklad_no: no, mtl_fee: 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
