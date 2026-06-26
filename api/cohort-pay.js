// /api/cohort-pay — accountless cohort signup + non-refundable deposit checkout.
// POST { cohort_id, name, email, phone, tier, consent_version, attribution }
//  -> creates a cohort_members lead, then a Stripe Checkout for the deposit charged DIRECTLY to the
//     cohort owner's connected account with MTL's application_fee (3.5%). No MTL login needed.
//  -> { ok, url, cohort_member_id }
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COMMISSION = 0.035; // MTL take on cohort payments (welcome-0% window is a noted follow-up)

async function sbGet(path) {
  try { const r = await fetch(_SUPA + '/rest/v1/' + path, { headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY } }); return r.ok ? await r.json() : []; } catch (e) { return []; }
}
async function sbPatch(table, q, body) {
  try { await fetch(_SUPA + '/rest/v1/' + table + '?' + q, { method: 'PATCH', headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) }); } catch (e) { console.error('sbPatch', e.message); }
}
async function sbInsert(table, body) {
  const r = await fetch(_SUPA + '/rest/v1/' + table, {
    method: 'POST',
    headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error('insert ' + table + ' ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j[0] : j;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const kind = b.kind || 'deposit';

    // First-month remainder paid on-site via QR (member already exists; charge tier price minus deposit)
    if (kind === 'first_month') {
      const cmId = b.cohort_member_id;
      if (!cmId) return res.status(400).json({ ok: false, error: 'missing cohort_member_id' });
      const mrows = await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=*`);
      const mem = mrows && mrows[0];
      if (!mem) return res.status(404).json({ ok: false, error: 'member not found' });
      const crows = await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(mem.cohort_id)}&select=*`);
      const coh = crows && crows[0];
      if (!coh || !coh.stripe_account) return res.status(400).json({ ok: false, error: 'cohort/account missing' });
      const tierPrice = Number((mem.tier === 'student') ? coh.price_student : coh.price_regular) || 0;
      const dep = Number(coh.deposit_amount || 0);
      const remainder = Math.max(0, tierPrice - dep);
      if (!(remainder > 0)) { await sbPatch('cohort_members', `id=eq.${encodeURIComponent(cmId)}`, { status: 'enrolled' }); return res.status(200).json({ ok: true, enrolled: true, url: null, remainder: 0 }); }
      const cur = String(coh.currency || 'CZK').toUpperCase();
      const isCZK = cur === 'CZK';
      const unit = isCZK ? Math.floor(remainder) * 100 : Math.round(remainder * 100);
      const fee = Math.round(remainder * COMMISSION * 100);
      const host = req.headers.host; const proto = host && host.includes('localhost') ? 'http' : 'https';
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: `${proto}://${host}/?cohort=${encodeURIComponent(mem.cohort_id)}&firstmonth=ok&cm=${encodeURIComponent(cmId)}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${proto}://${host}/?cohortpay=${encodeURIComponent(cmId)}`,
        customer_email: mem.email || undefined,
        metadata: { mtl_payment_type: 'cohort_first_month', cohort_id: String(mem.cohort_id), cohort_member_id: String(cmId), mtl_currency: cur },
        line_items: [{ price_data: { currency: cur.toLowerCase(), product_data: { name: `${coh.name || 'Course'} - 1. mesic (doplatek)` }, unit_amount: unit }, quantity: 1 }],
        payment_intent_data: { application_fee_amount: fee, metadata: { mtl_payment_type: 'cohort_first_month', cohort_id: String(mem.cohort_id), cohort_member_id: String(cmId), commission_pct: COMMISSION.toFixed(3) } }
      }, { stripeAccount: coh.stripe_account });
      return res.status(200).json({ ok: true, url: session.url, remainder });
    }

    const cohortId = b.cohort_id;
    if (!cohortId) return res.status(400).json({ ok: false, error: 'missing cohort_id' });
    const email = (b.email || '').trim();
    const name = (b.name || '').trim();
    if (!name || !email) return res.status(400).json({ ok: false, error: 'name + email required' });
    const tier = (b.tier === 'student') ? 'student' : 'regular';

    const rows = await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohortId)}&select=*`);
    const c = rows && rows[0];
    if (!c) return res.status(404).json({ ok: false, error: 'cohort not found' });
    if (!c.stripe_account) return res.status(400).json({ ok: false, error: 'cohort has no payout account' });
    if (c.status === 'draft' || c.status === 'archived') return res.status(403).json({ ok: false, error: 'cohort closed' });
    const deposit = Number(c.deposit_amount || 0);
    if (!(deposit > 0)) return res.status(400).json({ ok: false, error: 'no deposit set' });

    const member = await sbInsert('cohort_members', {
      cohort_id: cohortId, gym_id: c.gym_id, name, email, phone: (b.phone || '').trim() || null,
      tier, status: 'lead', attribution: (b.attribution || 'direct'),
      consent_at: new Date().toISOString(), consent_version: (b.consent_version || null)
    });
    const memberId = member && member.id;

    const cur = String(c.currency || 'CZK').toUpperCase();
    const isCZK = cur === 'CZK';
    const unitAmount = isCZK ? Math.floor(deposit) * 100 : Math.round(deposit * 100);
    const applicationFee = Math.round(deposit * COMMISSION * 100);

    const host = req.headers.host;
    const proto = host && host.includes('localhost') ? 'http' : 'https';
    const success_url = `${proto}://${host}/?cohort=${encodeURIComponent(cohortId)}&deposit=ok&cm=${encodeURIComponent(memberId)}&session={CHECKOUT_SESSION_ID}`;
    const cancel_url = `${proto}://${host}/?cohort=${encodeURIComponent(cohortId)}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url, cancel_url,
      customer_email: email,
      metadata: { mtl_payment_type: 'cohort_deposit', cohort_id: String(cohortId), cohort_member_id: String(memberId || ''), mtl_currency: cur, tier },
      line_items: [{ price_data: { currency: cur.toLowerCase(), product_data: { name: `${c.name || 'Course'} — ${b.gym_name || ''} (deposit)`.trim() }, unit_amount: unitAmount }, quantity: 1 }],
      payment_intent_data: {
        application_fee_amount: applicationFee,
        metadata: { mtl_payment_type: 'cohort_deposit', cohort_id: String(cohortId), cohort_member_id: String(memberId || ''), commission_pct: COMMISSION.toFixed(3) }
      }
    }, { stripeAccount: c.stripe_account });

    return res.status(200).json({ ok: true, url: session.url, cohort_member_id: memberId });
  } catch (e) {
    console.error('cohort-pay', e);
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}
