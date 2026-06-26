// /api/cohort-public — public, accountless read for a cohort signup page (?cohort=<id>).
// Returns the course details + the provider's LEGAL name from the connected Stripe account
// (data controller for the signup) + the gym's Meta Pixel id. No PII, no auth required.
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function sbGet(path) {
  try { const r = await fetch(_SUPA + '/rest/v1/' + path, { headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY } }); return r.ok ? await r.json() : []; } catch (e) { return []; }
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    // Member lookup (?cm=<id>) for the on-site first-month remainder page
    const cm = (req.query && req.query.cm) || '';
    if (cm) {
      const mr = await sbGet(`cohort_members?id=eq.${encodeURIComponent(cm)}&select=id,cohort_id,name,tier,status`);
      const mem = mr && mr[0];
      if (!mem) return res.status(404).json({ ok: false, error: 'member not found' });
      const cr = await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(mem.cohort_id)}&select=id,gym_id,name,currency,deposit_amount,price_student,price_regular`);
      const co = cr && cr[0];
      if (!co) return res.status(404).json({ ok: false, error: 'cohort not found' });
      let gymName = '';
      try { const g = await sbGet(`gyms?id=eq.${encodeURIComponent(co.gym_id)}&select=name`); gymName = (g && g[0] && g[0].name) || ''; } catch (e) {}
      const tierPrice = Number((mem.tier === 'student') ? co.price_student : co.price_regular) || 0;
      const remainder = Math.max(0, tierPrice - Number(co.deposit_amount || 0));
      return res.status(200).json({ ok: true, member: { id: mem.id, name: mem.name, tier: mem.tier, status: mem.status }, cohort: { id: co.id, name: co.name, gym_name: gymName, currency: co.currency || 'CZK', tier_price: tierPrice }, remainder });
    }

    const id = (req.query && req.query.cohort) || '';
    if (!id) return res.status(400).json({ ok: false, error: 'missing cohort' });
    const rows = await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(id)}&select=id,gym_id,stripe_account,name,discipline,start_date,months,capacity,deposit_amount,price_student,price_regular,currency,description,gym_meta_pixel,status`);
    const c = rows && rows[0];
    if (!c) return res.status(404).json({ ok: false, error: 'not found' });
    if (c.status === 'draft' || c.status === 'archived') return res.status(403).json({ ok: false, error: 'closed' });

    let gymName = '';
    try { const g = await sbGet(`gyms?id=eq.${encodeURIComponent(c.gym_id)}&select=name`); gymName = (g && g[0] && g[0].name) || ''; } catch (e) {}

    // provider legal name from the connected Stripe account (controller for the lead's data)
    let providerName = '';
    if (c.stripe_account) {
      try {
        const acct = await stripe.accounts.retrieve(c.stripe_account);
        providerName = (acct.company && acct.company.name)
          || ([acct.individual && acct.individual.first_name, acct.individual && acct.individual.last_name].filter(Boolean).join(' '))
          || (acct.business_profile && acct.business_profile.name) || '';
      } catch (e) { /* leave blank */ }
    }

    // current signup count (for capacity display only; no PII)
    let taken = 0;
    try { const cm = await sbGet(`cohort_members?cohort_id=eq.${encodeURIComponent(id)}&status=neq.cancelled&select=id`); taken = Array.isArray(cm) ? cm.length : 0; } catch (e) {}

    return res.status(200).json({
      ok: true,
      cohort: {
        id: c.id, name: c.name, discipline: c.discipline, start_date: c.start_date, months: c.months,
        capacity: c.capacity, taken, deposit_amount: c.deposit_amount, price_student: c.price_student,
        price_regular: c.price_regular, currency: c.currency, description: c.description,
        gym_name: gymName, provider_name: providerName, meta_pixel: c.gym_meta_pixel || ''
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}
