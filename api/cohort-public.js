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
      const cr = await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(mem.cohort_id)}&select=id,gym_id,name,discipline,currency,deposit_amount,price_student,price_regular,price_tiers,start_date,end_date,months,schedule,schedule_note`);
      const co = cr && cr[0];
      if (!co) return res.status(404).json({ ok: false, error: 'cohort not found' });
      let gymName = '';
      let _cmPay = { payment_mode:null, receiver_id_type:null, receiver_id_value:null, receiver_name:null };
      try { const g = await sbGet(`gyms?id=eq.${encodeURIComponent(co.gym_id)}&select=name,payment_mode,receiver_id_type,receiver_id_value,receiver_name`); const gg = g && g[0]; if (gg) { _hideLeaders = !!gg.hide_leaders; gymName = gg.name || ''; _cmPay = { payment_mode: gg.payment_mode || null, receiver_id_type: gg.receiver_id_type || null, receiver_id_value: gg.receiver_id_value || null, receiver_name: gg.receiver_name || null }; } } catch (e) {}
      // Named offers: mem.tier holds the offer name. Look it up in price_tiers; fall back to the
      // legacy student/regular columns for cohorts created before price_tiers existed.
      let tierPrice = 0;
      const _tiers = Array.isArray(co.price_tiers) ? co.price_tiers : null;
      if (_tiers && _tiers.length) {
        const hit = _tiers.find(t => t && String(t.name) === String(mem.tier));
        tierPrice = Number(hit ? hit.price : _tiers[0].price) || 0;
      } else {
        tierPrice = Number((mem.tier === 'student') ? co.price_student : co.price_regular) || 0;
      }
      const remainder = Math.max(0, tierPrice - Number(co.deposit_amount || 0));
      return res.status(200).json({ ok: true, member: { id: mem.id, name: mem.name, tier: mem.tier, status: mem.status }, cohort: { id: co.id, name: co.name, leader_name: (Array.isArray(co.schedule)?((co.schedule.find(r=>r&&r.leaderName)||{}).leaderName||null):null), discipline: co.discipline || null, gym_name: gymName, currency: co.currency || 'CZK', tier_price: tierPrice, start_date: co.start_date || null, end_date: co.end_date || null, months: co.months || null, schedule: (Array.isArray(co.schedule) ? co.schedule : []), schedule_note: co.schedule_note || null, stripe_account: co.stripe_account || null, payment_mode: _cmPay.payment_mode, receiver_id_type: _cmPay.receiver_id_type, receiver_id_value: _cmPay.receiver_id_value, receiver_name: _cmPay.receiver_name }, remainder });
    }

    const id = (req.query && req.query.cohort) || '';
    if (!id) return res.status(400).json({ ok: false, error: 'missing cohort' });
    const rows = await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(id)}&select=id,gym_id,stripe_account,name,discipline,start_date,end_date,months,capacity,deposit_amount,price_student,price_regular,price_tiers,currency,description,schedule,schedule_note,gym_meta_pixel,marketing_note,poster,status`);
    const c = rows && rows[0];
    if (!c) return res.status(404).json({ ok: false, error: 'not found' });
    // Same gate as cohort-pay: whitelist on `open`, and signups shut SIGNUPS_GRACE_DAYS after the
    // course has started. Better to say so on arrival than after they have filled in the form.
    const SIGNUPS_GRACE_DAYS = 2;
    const _started = c.start_date && (Date.now() > new Date(c.start_date).getTime() + SIGNUPS_GRACE_DAYS * 86400000);
    if (c.status !== 'open' || _started) {
      return res.status(403).json({ ok: false, error: 'closed', closed: true, reason: _started ? 'started' : 'closed' });
    }

    let gymName = '', gymPay = {};
    try { const g = await sbGet(`gyms?id=eq.${encodeURIComponent(c.gym_id)}&select=name,payment_mode,receiver_id_type,receiver_id_value,receiver_name,hide_leaders`); const gg = g && g[0]; if (gg) { _hideLeaders = !!gg.hide_leaders; gymName = gg.name || ''; gymPay = { payment_mode: gg.payment_mode || null, receiver_id_type: gg.receiver_id_type || null, receiver_id_value: gg.receiver_id_value || null, receiver_name: gg.receiver_name || null }; } } catch (e) {}

    // provider legal name from the connected Stripe account (controller for the lead's data)
    let providerName = ''; let _hideLeaders = false;
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
    try { const cm = await sbGet(`cohort_members?cohort_id=eq.${encodeURIComponent(id)}&status=not.in.(cancelled,waitlist)&select=id`); taken = Array.isArray(cm) ? cm.length : 0; } catch (e) {}

    return res.status(200).json({
      ok: true,
      cohort: {
        id: c.id, name: c.name, leader_name: (Array.isArray(c.schedule)?((c.schedule.find(r=>r&&r.leaderName)||{}).leaderName||null):null), discipline: c.discipline, start_date: c.start_date, end_date: c.end_date, months: c.months, schedule: (Array.isArray(c.schedule) ? c.schedule : []), schedule_note: c.schedule_note || null,
        capacity: c.capacity, taken, deposit_amount: c.deposit_amount, price_student: c.price_student,
        price_regular: c.price_regular, price_tiers: (Array.isArray(c.price_tiers) ? c.price_tiers : null), currency: c.currency, description: c.description, poster: c.poster || null,
        gym_name: gymName, provider_name: providerName, hide_leaders: _hideLeaders, meta_pixel: c.gym_meta_pixel || '', marketing_note: c.marketing_note || '',
        payment_mode: gymPay.payment_mode || null, receiver_id_type: gymPay.receiver_id_type || null, receiver_id_value: gymPay.receiver_id_value || null, receiver_name: gymPay.receiver_name || null
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}
