// /api/admin-mtl-subs — PŘEDPLATITELÉ MTL PRO ADMIN: Exclusive Partner (EP) a profil dodavatele (SP),
// současní i minulí, s jejich fakturami a doklady o úhradě. JEN FOUNDER.
//
// Doklady se vracejí tak, jak byly vystaveny (commission_doklady = OTISK): appka je vykreslí stejným
// prohlížečem jako u klubů a nic do nich nedoplňuje z dnešních dat. Dnešní stav předplatného
// (běží / ruší se / skončilo, cena) je zvlášť -- je to stav, ne doklad.
//
// GET -> { ok, test, docs:[...], people:{ id: {...} }, orgs:{ id: {...} } }
import { createClient } from '@supabase/supabase-js';
import { isTestMode } from './_config.js';

const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const FOUNDER = (process.env.FOUNDER_UUID || '').trim();
const KINDS = ['partner_sub', 'supplier_sub'];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    const tok = req.headers['x-access-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tok) return res.status(401).json({ ok: false, error: 'no token' });
    const { data: u, error: ue } = await supa.auth.getUser(tok);
    if (ue || !u || !u.user || u.user.id !== FOUNDER) return res.status(403).json({ ok: false, error: 'forbidden' });

    let test = false; try { test = await isTestMode(); } catch (e) {}
    const inv = await supa.from('commission_doklady').select('*').in('kind', KINDS).eq('test_mode', test).order('charged_at', { ascending: false }).limit(5000);
    if (inv.error) return res.status(200).json({ ok: false, error: inv.error.message });
    const rc = await supa.from('commission_doklady').select('*').eq('kind', 'payment_receipt').in('ref_kind', KINDS).eq('test_mode', test).order('charged_at', { ascending: false }).limit(5000);
    const docs = (inv.data || []).concat(rc.data || []);

    // Dnešní stav: kdo předplatné má teď (i bez dokladu -- třeba začíná až po skončení předchozího)
    // a kdo v dokladech je.
    const pIds = new Set(), oIds = new Set();
    docs.forEach((d) => { if (d.organization_id) oIds.add(String(d.organization_id)); else if (d.coach_id) pIds.add(String(d.coach_id)); });
    const pc = 'id,name,email,coach_status,partner,partner_sub,partner_cancelling,partner_period_end,partner_renews_at,partner_price,partner_currency,partner_until';
    const oc = 'id,name,owner_id,kind,status,supplier_sub,supplier_cancelling,supplier_period_end,supplier_renews_at,supplier_price,supplier_currency,supplier_interval';
    const cur = await supa.from('profiles').select(pc).not('partner_sub', 'is', null).limit(5000);
    (cur.data || []).forEach((p) => pIds.add(String(p.id)));
    const curO = await supa.from('organizations').select(oc).eq('kind', 'supplier').not('supplier_sub', 'is', null).limit(5000);
    (curO.data || []).forEach((o) => oIds.add(String(o.id)));

    const people = {}, orgs = {};
    const pl = [...pIds];
    for (let i = 0; i < pl.length; i += 200) {
      const r = await supa.from('profiles').select(pc).in('id', pl.slice(i, i + 200));
      (r.data || []).forEach((p) => { people[p.id] = p; });
    }
    const ol = [...oIds];
    for (let i = 0; i < ol.length; i += 200) {
      const r = await supa.from('organizations').select(oc).in('id', ol.slice(i, i + 200));
      (r.data || []).forEach((o) => { orgs[o.id] = o; });
    }
    return res.status(200).json({ ok: true, test, docs, people, orgs });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || 'error' });
  }
}
