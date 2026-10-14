// /api/partner-revenue.js — PŘÍJMY MTL Z PŘEDPLATNÉHO: Exclusive Partner (EP) a profil dodavatele (SP).
// JEN FOUNDER (ověřený token). Dřív endpoint nic neověřoval a kdokoli dostal jména, e-maily, IČO,
// DIČ, sídla a tržby všech partnerů.
//
// ZDROJ = VYSTAVENÉ DOKLADY (commission_doklady, kind partner_sub / supplier_sub), ne dnešní stav
// profilů. Dřív se braly jen profily, které předplatné mají TEĎ -- kdo skončil, zmizel i se všemi
// minulými platbami, a dodavatelé chyběli úplně. Každá faktura nese id faktury Stripe (pi_id);
// u zaplacené se ze Stripe dočte skutečně připsaná částka a poplatek (balance transaction).
// Odběratel, IČO, DIČ a adresa v exportu jsou OTISK z dokladu -- nikdy dnešní údaje z profilu.
//
// GET ?month=YYYY-MM (podle data vystavení dokladu)
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { isTestMode } from './_config.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const FOUNDER = process.env.FOUNDER_UUID || '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const KINDS = ['partner_sub', 'supplier_sub'];
const r2 = (x) => Math.round(Number(x || 0) * 100) / 100;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(200).json({ ok: false, error: 'server not configured' });
    const tok = req.headers['x-access-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tok) return res.status(401).json({ ok: false, error: 'no token' });
    const { data: u, error: ue } = await supa.auth.getUser(tok);
    if (ue || !u || !u.user || u.user.id !== FOUNDER) return res.status(403).json({ ok: false, error: 'forbidden' });

    // Testovací doklady jen v Testovacím režimu (a naopak) -- jinak by se míchaly s ostrými.
    let test = false; try { test = await isTestMode(); } catch (e) {}
    const month = String((req.query && req.query.month) || '');
    let q = supa.from('commission_doklady').select('*').in('kind', KINDS).eq('test_mode', test);
    if (/^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      q = q.gte('charged_at', new Date(Date.UTC(y, m - 1, 1)).toISOString()).lt('charged_at', new Date(Date.UTC(y, m, 1)).toISOString());
    }
    const { data: invs, error } = await q.order('charged_at', { ascending: true }).limit(5000);
    if (error) return res.status(200).json({ ok: false, error: error.message });

    // Zaplacená = bez dlužné částky, nebo uhrazená pozdějším dokladem o úhradě.
    const paidLater = new Set();
    if ((invs || []).some((d) => Number(d.due_amount) > 0)) {
      const { data: rc } = await supa.from('commission_doklady').select('ref_doklad_id,line_items').eq('kind', 'payment_receipt').in('ref_kind', KINDS).limit(5000);
      (rc || []).forEach((r) => {
        if (r.ref_doklad_id) paidLater.add(Number(r.ref_doklad_id));
        (Array.isArray(r.line_items) ? r.line_items : []).forEach((it) => { if (it && it.ref != null) paidLater.add(Number(it.ref)); });
      });
    }

    const byKind = { ep: {}, sp: {} };
    const subs = { ep: new Set(), sp: new Set() };
    const rows = [];
    let payments = 0;
    for (const d of (invs || [])) {
      if (Number(d.due_amount) > 0 && !paidLater.has(Number(d.id))) continue;   // nezaplaceno = není příjem
      const k = d.kind === 'supplier_sub' ? 'sp' : 'ep';
      subs[k].add(k === 'sp' ? String(d.organization_id) : String(d.coach_id));
      // Skutečně připsáno a poplatek: faktura Stripe -> platba -> balance transaction.
      let cur = String(d.currency || 'CZK').toUpperCase(), gross = r2(Number(d.amount || 0) / 100), fee = 0, net = gross, exact = false;
      if (d.pi_id && String(d.pi_id).startsWith('in_')) {
        try {
          const inv = await stripe.invoices.retrieve(d.pi_id, { expand: ['charge.balance_transaction'] });
          const bt = inv && inv.charge && typeof inv.charge === 'object' ? inv.charge.balance_transaction : null;
          if (bt && typeof bt === 'object') { cur = String(bt.currency).toUpperCase(); gross = r2(bt.amount / 100); fee = r2(bt.fee / 100); net = r2(bt.net / 100); exact = true; }
        } catch (e) { /* bez Stripe zůstane částka z dokladu */ }
      }
      const b = byKind[k][cur] || (byKind[k][cur] = { gross: 0, fee: 0, net: 0, count: 0 });
      b.gross = r2(b.gross + gross); b.fee = r2(b.fee + fee); b.net = r2(b.net + net); b.count += 1;
      payments += 1;
      rows.push({ doc_no: d.doc_no || ('MTL-' + d.id), issued_at: d.issued_at || d.charged_at, kind: k, period: d.period_month || null,
        cust_name: d.cust_name || '', cust_ico: d.cust_ico || '', cust_dic: d.cust_dic || '', cust_address: d.cust_address || '', cust_country: d.cust_country || '',
        invoiced: r2(Number(d.amount || 0) / 100), invoiced_currency: String(d.currency || 'CZK').toUpperCase(), currency: cur, gross, fee, net, exact });
    }
    return res.status(200).json({ ok: true, month: month || 'all', test, partners: subs.ep.size, suppliers: subs.sp.size, payments, byKind, rows });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || 'error' });
  }
}
