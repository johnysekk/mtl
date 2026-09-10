// /api/org-ticket-record — zaúčtování prodeje lístku na akci pořádanou ORGANIZACÍ.
//
// První patro cesty strhávání. Stejná tři patra jako u klubu a kouče:
//   1) TADY: při platbě se spočítá mtl_fee a uloží ke komu patří
//   2) commission-cron ji po 6. dni měsíce strhne z karty organizace
//   3) unified-doklad-cron na ni vystaví doklad MTL → organizace
//
// PROČ VLASTNÍ SOUBOR A NE TŘETÍ VĚTEV V record-cash.js:
// record-cash má dvě hotové větve (klub, kouč) po několika tisících znacích a je to živá
// peněžní cesta. Třetí větev uvnitř by znamenala zásah do něčeho, co funguje; organizace
// má vlastní sazebník (orgRate) i vlastní řadu dokladů, takže se stejně nechová identicky.
// Struktura je záměrně shodná s org-fee-record.js.

import { orgRate } from './_rate.js';

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

// Řada dokladů: IČO organizace + její účet. Tentýž tvar jako u poskytovatele, aby jeden
// subjekt měl jednu souvislou řadu.
async function issueDoklad(org, cust, amount, currency, method, testMode, transactionId, label, paymentIntent) {
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
    await sb('doklady', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({
        doklad_no: String(no), series_key: key,
        transaction_id: transactionId || null, payment_intent: paymentIntent || null,
        sup_name: org.legal_name || org.name || null,
        sup_ico: ico, sup_dic: org.vat_id || null, sup_address: _billAddr(org) || null,
        sup_vat_payer: !!org.vat_payer, sup_vat_rate: (org.vat_rate != null ? org.vat_rate : null),
        cust_name: (cust && cust.name) || null, cust_email: (cust && cust.email) || null,
        item_label: label || 'Vstupenka',
        amount: Math.round(Number(amount) || 0), currency: String(currency || 'CZK').toUpperCase(),
        payment_method: method || null, test_mode: !!testMode,
      }),
    });
    return String(no);
  } catch (e) { console.error('issueDoklad(org)', e && e.message); return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    if (!SB || !KEY) return res.status(500).json({ error: 'server not configured' });
    const b = req.body || {};
    const { organization_id, event_id, ticket_id, amount, currency, payment_method,
            buyer_name, buyer_email, payment_intent, test_mode } = b;

    // Vnitřní volání: stejná ochrana jako u record-cash, ať to nejde spustit zvenčí.
    const trusted = (b.intSecret && process.env.PIS_INTERNAL_SECRET && b.intSecret === process.env.PIS_INTERNAL_SECRET);
    if (!trusted) return res.status(403).json({ error: 'forbidden' });

    if (!organization_id || !(Number(amount) > 0)) return res.status(400).json({ error: 'bad input' });

    const org = (await sb(`organizations?id=eq.${encodeURIComponent(organization_id)}&select=id,name,legal_name,tax_id,vat_id,vat_payer,vat_rate,billing_address,billing_line1,billing_line2,billing_city,billing_postal,owner_id,status,intro_free_until,kind,account_suspended`))[0];
    if (!org) return res.status(404).json({ error: 'org not found' });
    if (org.status !== 'approved') return res.status(403).json({ error: 'org not approved' });

    // Jeden lístek = jedno zaúčtování. Doklad je nevratný, druhé číslo v řadě nešlo by vzít zpět.
    if (ticket_id) {
      const dup = await sb(`transactions?ticket_id=eq.${encodeURIComponent(ticket_id)}&organization_id=eq.${encodeURIComponent(organization_id)}&select=id&limit=1`);
      if (dup && dup.length) return res.status(200).json({ ok: true, already: true });
    }

    // Sazba podle typu akce. Fight night a soutěž se zpoplatňují, seminář a školení ne --
    // orgRate() to řeší na jednom místě, ať se to nerozejde s tím, co appka ukazuje.
    let evType = null;
    if (event_id) {
      const ev = (await sb(`events?id=eq.${encodeURIComponent(event_id)}&select=event_type,title`))[0];
      evType = (ev && ev.event_type) || null;
    }
    const rate = orgRate(org, evType);
    const gross = Math.round(Number(amount));
    const fee = Math.round(gross * rate);
    const month = new Date().toISOString().slice(0, 7);

    const tx = await sb('transactions', {
      method: 'POST', prefer: 'return=representation',
      body: JSON.stringify({
        organization_id: org.id, event_id: event_id || null, ticket_id: ticket_id || null,
        type: 'event_ticket', status: 'completed',
        gross_amount: gross, currency: String(currency || 'CZK').toUpperCase(),
        mtl_fee: fee, mtl_rate: rate, base_rate: rate,
        payment_method: payment_method || 'pis',
        paid_to: 'organization', payee_id: org.id, payee_kind: 'organization',
        // Nulová provize se nemá co vybírat, takže se rovnou uzavře -- jinak by cron
        // každý měsíc počítal nuly a organizaci chodily prázdné výzvy.
        commission_status: fee > 0 ? 'pending' : 'collected',
        commission_month: month,
        paid_by_name: buyer_name || null,
        test_mode: !!test_mode,
      }),
    });
    const txId = (tx && tx[0] && tx[0].id) || null;

    const label = evType === 'fight_night' ? 'Vstupenka · fight night'
                : evType === 'competition' ? 'Vstupenka · soutěž' : 'Vstupenka';
    const no = await issueDoklad(org, { name: buyer_name, email: buyer_email },
      gross, currency, payment_method || 'pis', !!test_mode, txId, label, payment_intent);

    return res.status(200).json({ ok: true, transaction_id: txId, doklad_no: no, mtl_fee: fee, mtl_rate: rate });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
