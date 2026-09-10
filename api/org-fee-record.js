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

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
      const g = (await sb(`gyms?id=eq.${encodeURIComponent(oc.gym_id)}&select=name,legal_name,tax_id,vat_id,billing_address,invoice_email`))[0];
      if (g) cust = { name: g.legal_name || g.name || null, email: g.invoice_email || null,
                      ico: g.tax_id || null, address: g.billing_address || null };
    }

    const label = oc.fee_label || 'Členský poplatek';
    await sb('doklady', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({
        doklad_no: String(no), series_key: key,
        transaction_id: transactionId || null, payment_intent: oc.fee_payment_intent || null,
        sup_name: org.legal_name || org.name || null,
        sup_ico: ico, sup_dic: org.vat_id || null, sup_address: org.billing_address || null,
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
    if (!oc_id) return res.status(400).json({ error: 'oc_id required' });

    const oc = (await sb(`organization_clubs?id=eq.${encodeURIComponent(oc_id)}&select=*`))[0];
    if (!oc) return res.status(404).json({ error: 'not found' });
    if (!oc.fee_paid_at) return res.status(409).json({ error: 'not paid yet' });

    // Dvakrát zaúčtovat nejde: doklad je nevratný a druhé číslo v řadě by nešlo vzít zpět.
    const dup = await sb(`transactions?org_fee_id=eq.${encodeURIComponent(oc_id)}&select=id&limit=1`);
    if (dup && dup.length) return res.status(200).json({ ok: true, already: true });

    const org = (await sb(`organizations?id=eq.${encodeURIComponent(oc.organization_id)}&select=id,name,legal_name,tax_id,vat_id,vat_payer,vat_rate,billing_address,owner_id`))[0];
    if (!org) return res.status(404).json({ error: 'org not found' });

    // Popis se opíše z období, aby na dokladu stálo, ZA CO klub platil.
    let label = 'Členský poplatek';
    let amount = Number(oc.fee_amount || 0);
    let currency = oc.fee_currency || 'CZK';
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
        amount: Math.round(amount), currency: String(currency).toUpperCase(),
        mtl_fee: 0, base_rate: 0,
        payment_method: method || 'pis',
        paid_to: 'organization',
        created_at: oc.fee_paid_at || new Date().toISOString(),
        test_mode: !!test_mode,
      }),
    });
    const txId = (tx && tx[0] && tx[0].id) || null;

    const no = await issueOrgDoklad({ ...oc, fee_label: label }, org, amount, currency, method || 'pis', !!test_mode, txId);
    return res.status(200).json({ ok: true, transaction_id: txId, doklad_no: no, mtl_fee: 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
