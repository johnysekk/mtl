// /api/org-fee-public — veřejná stránka pro úhradu členského poplatku klubem BEZ účtu v MTL.
//
// Stejný princip jako u hosta na jednorázovce: kdo má odkaz, vidí jeden jediný poplatek
// a může ho zaplatit. Nic víc se odsud nedá zjistit -- žádný seznam členů, žádné jiné kluby.
//
// Bez tohohle by asociace vybírala peníze mimo appku a evidence členství by se rozešla
// s tím, kdo doopravdy zaplatil.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc }); return r.ok ? await r.json() : []; }
  catch (e) { return []; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });
    const token = String((req.query && req.query.t) || (req.body && req.body.t) || '').trim();

    // VEŘEJNÁ PŘIHLÁŠKA. Klub mimo MTL se přihlásí sám z odkazu asociace; vznikne mu vztah
    // se stavem 'pending' a vlastní klíč, kterým se pak vrátí k platbě. Bez tohohle by
    // asociace musela každého zájemce zapsat ručně dřív, než o sobě vůbec dá vědět.
    if (req.method === 'POST' && String((req.body && req.body.join) || '') === '1') {
      const jt = String((req.body && req.body.j) || '').trim();
      if (!jt || jt.length < 20) return res.status(400).json({ error: 'bad token' });
      const org = (await sbGet(`organizations?join_token=eq.${encodeURIComponent(jt)}&status=eq.approved&select=id,name&limit=1`))[0];
      if (!org) return res.status(404).json({ error: 'not found' });

      const b = req.body || {};
      const t = (v) => (v == null ? null : String(v).trim().slice(0, 200) || null);
      if (!t(b.name)) return res.status(400).json({ error: 'name required' });

      // Vlastní klíč k platbě dostane rovnou -- klub nemá účet, takže se k žádosti musí umět
      // vrátit sám. Asociace mu ho může poslat i mailem.
      let gt = '';
      try { gt = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()) + Math.random().toString(36).slice(2); }
      catch (e) { gt = String(Date.now()) + Math.random().toString(36).slice(2); }

      const row = {
        organization_id: org.id, gym_id: null, status: 'pending',
        ext_name: t(b.name), ext_city: t(b.city), ext_legal_name: t(b.legal_name),
        ext_tax_id: t(b.tax_id), ext_address: t(b.address), ext_email: t(b.email), ext_phone: t(b.phone),
        guest_token: gt, guest_name: t(b.name), guest_email: t(b.email),
      };
      try {
        const r = await fetch(`${SB}/rest/v1/organization_clubs`, {
          method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(row),
        });
        if (!r.ok) return res.status(500).json({ error: 'save failed' });
      } catch (e) { return res.status(500).json({ error: 'save failed' }); }

      // Asociaci to musí dojít, jinak by žádost čekala, dokud si někdo nevšimne.
      try {
        const o2 = (await sbGet(`organizations?id=eq.${encodeURIComponent(org.id)}&select=owner_id&limit=1`))[0];
        if (o2 && o2.owner_id) {
          await fetch(`${SB}/rest/v1/notifications`, {
            method: 'POST', headers: { ...svc, Prefer: 'return=minimal' },
            body: JSON.stringify({ user_id: o2.owner_id, type: 'system', read: false,
              data: JSON.stringify({ kind: 'org_join_req', msg_en: `\u{1F3C5} The club ${t(b.name)} wants to join your association.` }),
              message: `\u{1F3C5} Klub ${t(b.name)} se chce p\u0159ipojit k tv\u00e9 asociaci.` }),
          });
        }
      } catch (e) {}
      return res.status(200).json({ ok: true, token: gt });
    }

    // Veřejná hlavička asociace pro přihlašovací stránku -- jen to, co smí vidět kdokoli.
    if (req.method === 'GET' && req.query && req.query.j) {
      const jt = String(req.query.j).trim();
      if (!jt || jt.length < 20) return res.status(400).json({ error: 'bad token' });
      const org = (await sbGet(`organizations?join_token=eq.${encodeURIComponent(jt)}&status=eq.approved&select=id,name,abbr,city,description,website&limit=1`))[0];
      if (!org) return res.status(404).json({ error: 'not found' });
      const today = new Date().toISOString().slice(0, 10);
      const fee = (await sbGet(`org_member_fees?organization_id=eq.${encodeURIComponent(org.id)}&period_from=lte.${today}&period_to=gte.${today}&select=name,amount,currency,period_from,period_to&limit=1`))[0] || null;
      return res.status(200).json({ ok: true, join: true, org, fee });
    }

    // KROK 1 PŘIHLÁŠKY PRO KLUB BEZ ÚČTU. Vyplňuje tytéž údaje, které z appky předává klub
    // s účtem -- jinak by asociace měla u poloviny členů jiný rozsah dat než u druhé.
    // Zapisuje se jen do JEDNOHO řádku, který ke klíči patří; nic jiného odsud nejde změnit.
    if (req.method === 'POST') {
      if (!token || token.length < 20) return res.status(400).json({ error: 'bad token' });
      const cur = (await sbGet(`organization_clubs?guest_token=eq.${encodeURIComponent(token)}&select=id,fee_paid_at&limit=1`))[0];
      if (!cur) return res.status(404).json({ error: 'not found' });
      // Po zaplacení se údaje nemění -- doklad už je vystavený na to, co v nich bylo.
      if (cur.fee_paid_at) return res.status(409).json({ error: 'already paid' });

      const b = req.body || {};
      const t = (v) => (v == null ? null : String(v).trim().slice(0, 200) || null);
      if (!t(b.name)) return res.status(400).json({ error: 'name required' });
      const patch = {
        ext_name: t(b.name), ext_legal_name: t(b.legal_name), ext_tax_id: t(b.tax_id),
        ext_address: t(b.address), ext_city: t(b.city),
        ext_email: t(b.email), ext_phone: t(b.phone),
        guest_name: t(b.name), guest_email: t(b.email),
      };
      try {
        const r = await fetch(`${SB}/rest/v1/organization_clubs?id=eq.${encodeURIComponent(cur.id)}`, {
          method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
        });
        if (!r.ok) return res.status(500).json({ error: 'save failed' });
      } catch (e) { return res.status(500).json({ error: 'save failed' }); }
      return res.status(200).json({ ok: true, saved: true });
    }

    // Klíč musí vypadat jako klíč. Bez téhle kontroly by šlo tabulku prohledávat dotazem.
    if (!token || token.length < 20) return res.status(400).json({ error: 'bad token' });

    const oc = (await sbGet(`organization_clubs?guest_token=eq.${encodeURIComponent(token)}&select=id,organization_id,status,ext_name,ext_legal_name,ext_tax_id,ext_email,fee_amount,fee_currency,fee_id,fee_paid_at,valid_until,guest_email,guest_name&limit=1`))[0];
    if (!oc) return res.status(404).json({ error: 'not found' });

    const org = (await sbGet(`organizations?id=eq.${encodeURIComponent(oc.organization_id)}&select=id,name,abbr,legal_name,tax_id,payment_mode,stripe_account,receiver_id_type,receiver_id_value,receiver_name,pis_test&limit=1`))[0];
    if (!org) return res.status(404).json({ error: 'not found' });

    // Částka: snímek na vztahu, jinak poplatek za období platné ke dnešku.
    let fee = null;
    if (oc.fee_amount == null) {
      const t = new Date().toISOString().slice(0, 10);
      fee = (await sbGet(`org_member_fees?organization_id=eq.${encodeURIComponent(org.id)}&period_from=lte.${t}&period_to=gte.${t}&select=id,name,amount,currency,period_from,period_to&limit=1`))[0] || null;
    }
    const amount = (oc.fee_amount != null) ? Number(oc.fee_amount) : (fee ? Number(fee.amount) : 0);
    const currency = oc.fee_currency || (fee && fee.currency) || 'CZK';

    return res.status(200).json({
      ok: true,
      paid: !!oc.fee_paid_at,
      valid_until: oc.valid_until || null,
      club: { name: oc.ext_name, legal_name: oc.ext_legal_name, tax_id: oc.ext_tax_id, email: oc.guest_email || oc.ext_email },
      org: { id: org.id, name: org.name, abbr: org.abbr, legal_name: org.legal_name, tax_id: org.tax_id,
             payment_mode: org.payment_mode, stripe_account: org.stripe_account,
             receiver_id_type: org.receiver_id_type, receiver_id_value: org.receiver_id_value,
             receiver_name: org.receiver_name, pis_test: !!org.pis_test },
      fee: { amount, currency, name: (fee && fee.name) || null,
             period_from: (fee && fee.period_from) || null, period_to: (fee && fee.period_to) || null },
      oc_id: oc.id,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
