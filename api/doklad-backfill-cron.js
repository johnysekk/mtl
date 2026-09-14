// /api/doklad-backfill-cron.js — dovystaví doklady k platbám, u kterých chybí.
//
// PROČ: doklad vzniká ve chvíli platby (stripe-webhook / record-cash). Když to selže —
// nedoručený webhook, spadlý server v půlce, chybějící IČO poskytovatele — platba zůstane
// bez dokladu a dřív se to už nikdy nedohnalo. Tohle je ta pojistka.
//
// Číslo dokladu přiděluje databázová funkce doklad_issue (sql-49) a přiděluje ho AŽ SE
// ZÁPISEM, takže tady nemůže vzniknout díra v číselné řadě ani druhý doklad k jedné platbě.
// Doklad dostane číslo v řadě podle okamžiku vystavení, ne podle data platby — to je běžné
// a datum platby je na dokladu uvedené zvlášť.
//
// Běží každou hodinu. Zpracuje nejvýš 200 plateb za běh, ať se cron nezasekne.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const sbGet = async (path) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
  if (!r.ok) throw new Error(`GET ${path}: ${await r.text()}`);
  return r.json();
};

// Adresa dodavatele z rozpadu — stejně jako ji skládá webhook.
const billAddr = (p) => [p.billing_line1, p.billing_line2, [p.billing_postal, p.billing_city].filter(Boolean).join(' ')]
  .map((x) => String(x || '').trim()).filter(Boolean).join(', ') || null;

const itemLabel = (t) => {
  const M = {
    membership: 'Členství', drop_in: 'Jednorázový vstup', coach_inperson: 'Lekce 1:1',
    coach_online: 'Online lekce', coach_1to1: 'Lekce 1:1', merch: 'Zboží',
    event_ticket: 'Vstupenka', course: 'Kurz', other: 'Platba',
  };
  return t.plan || M[t.type] || 'Platba';
};

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const out = { checked: 0, issued: 0, skipped: [], errors: [] };
  try {
    // Pohled doklady_chybi vytváří sql-49: platby, ke kterým neexistuje doklad.
    const rows = await sbGet('doklady_chybi?select=*&order=created_at.asc&limit=200');
    out.checked = (rows || []).length;

    // Profily dodavatelů načteme jednou, ne pro každou platbu.
    const ownerOf = {};
    const gymIds = [...new Set(rows.map((r) => r.gym_id).filter(Boolean))];
    const gyms = {};
    if (gymIds.length) {
      const gg = await sbGet(`gyms?id=in.(${gymIds.join(',')})&select=id,owner_id,legal_name,name,tax_id,vat_id,vat_payer,vat_rate,billing_line1,billing_line2,billing_city,billing_postal`);
      (gg || []).forEach((g) => { gyms[g.id] = g; });
    }
    const coachIds = [...new Set(rows.map((r) => r.coach_id).filter(Boolean))];
    const coaches = {};
    if (coachIds.length) {
      const cc = await sbGet(`profiles?id=in.(${coachIds.join(',')})&select=id,legal_name,name,tax_id,vat_id,vat_payer,vat_rate,billing_line1,billing_line2,billing_city,billing_postal`);
      (cc || []).forEach((c) => { coaches[c.id] = c; });
    }

    for (const t of rows) {
      try {
        // Dodavatel: u klubové platby klub, jinak kouč. Organizace se tu neřeší — jejich
        // doklady vystavuje org-ticket-record / org-fee-record vlastní cestou.
        const isGym = !!t.gym_id;
        const sup = isGym ? gyms[t.gym_id] : coaches[t.coach_id];
        if (!sup) { out.skipped.push({ tx: t.transaction_id, why: 'no-supplier' }); continue; }

        const ico = String(sup.tax_id || '').replace(/\s/g, '');
        if (!ico) { out.skipped.push({ tx: t.transaction_id, why: 'no-tax-id' }); continue; }

        const ownerId = isGym ? (sup.owner_id || null) : (t.coach_id || null);
        if (!ownerId) { out.skipped.push({ tx: t.transaction_id, why: 'no-owner' }); continue; }
        ownerOf[t.transaction_id] = ownerId;

        // Odběratel: jméno z profilu plátce, když ho transakce nenese.
        let cust = null;
        if (t.member_id) {
          const c = await sbGet(`profiles?id=eq.${encodeURIComponent(t.member_id)}&select=name,email`);
          cust = (c || [])[0] || null;
        }

        const r = await fetch(`${SB}/rest/v1/rpc/doklad_issue`, {
          method: 'POST', headers: svc,
          body: JSON.stringify({
            p_key: 'ico:' + ico + ':acct:' + ownerId,
            p_row: {
              transaction_id: t.transaction_id, payment_intent: t.payment_intent || null,
              sup_name: sup.legal_name || sup.name || null,
              sup_ico: ico, sup_dic: sup.vat_id || null, sup_address: billAddr(sup),
              sup_vat_payer: !!sup.vat_payer, sup_vat_rate: (sup.vat_rate != null ? sup.vat_rate : null),
              cust_name: (cust && cust.name) || null, cust_email: (cust && cust.email) || null,
              item_label: itemLabel(t),
              amount: Math.round(Number(t.gross_amount) || 0),
              currency: String(t.currency || 'CZK').toUpperCase(),
              payment_method: t.payment_method || null, test_mode: !!t.test_mode,
            },
          }),
        });
        if (!r.ok) { out.errors.push({ tx: t.transaction_id, error: (await r.text()).slice(0, 200) }); continue; }
        out.issued++;
      } catch (e) {
        out.errors.push({ tx: t.transaction_id, error: (e && e.message) || 'error' });
      }
    }

    // Co se opakovaně nepodaří, je chyba v datech (typicky chybějící IČO) a sama se nespraví.
    if (out.skipped.length || out.errors.length) {
      console.error('[doklad-backfill] nedokončeno', { skipped: out.skipped, errors: out.errors });
    }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error', ...out });
  }
}
