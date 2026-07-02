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
async function sbRpc(fn, args) {
  try {
    const r = await fetch(_SUPA + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// Genuine welcome 0% — same logic as pay.js: provider inside their welcome window pays no MTL fee.
const _WELCOME_FOUNDER = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
async function isWelcomeZero(acct) {
  if (!acct) return false;
  try {
    const ks = await sbGet(`profiles?id=eq.${_WELCOME_FOUNDER}&select=welcome_zero_off`);
    if (ks && ks[0] && ks[0].welcome_zero_off) return false;
    const a = encodeURIComponent(String(acct).trim());
    let prov = (await sbGet(`profiles?stripe_account=eq.${a}&select=id,welcome_free_until,created_at&limit=1`))[0]
            || (await sbGet(`profiles?gym_payout_account=eq.${a}&select=id,welcome_free_until,created_at&limit=1`))[0];
    if (!prov) {
      let g = (await sbGet(`gyms?stripe_account=eq.${a}&select=owner_id&limit=1`))[0]
           || (await sbGet(`gyms?gym_payout_account=eq.${a}&select=owner_id&limit=1`))[0];
      if (g && g.owner_id) prov = (await sbGet(`profiles?id=eq.${g.owner_id}&select=id,welcome_free_until,created_at`))[0];
    }
    if (!prov || !prov.id) return false;
    const now = Date.now();
    if (prov.welcome_free_until) return now < new Date(prov.welcome_free_until).getTime();
    const created = prov.created_at ? new Date(prov.created_at).getTime() : 0;
    if (created && (now - created) < 45 * 86400000) {
      await sbPatch('profiles', `id=eq.${prov.id}`, { welcome_free_until: new Date(now + 30 * 86400000).toISOString() });
      return true;
    }
    return false;
  } catch (e) { console.error('isWelcomeZero', e.message); return false; }
}

// Provider's effective MTL rate from the cohort owner's profile (same ladder as the rest of the app).
async function providerCommission(ownerId) {
  if (!ownerId) return COMMISSION;
  try {
    const p = (await sbGet(`profiles?id=eq.${encodeURIComponent(ownerId)}&select=partner,coach_ref_score`))[0];
    if (!p) return COMMISSION;
    if (p.partner) return 0.01;            // Exclusive Partner
    const sc = p.coach_ref_score || 0;
    if (sc >= 10) return 0.02;             // Bankai
    if (sc >= 3) return 0.03;              // Shikai
    return 0.035;                          // base
  } catch (e) { return COMMISSION; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    // --- per-IP rate limit (fail-open if the limiter itself errors) ---
    const _ip = (function(){ const xr=req.headers['x-real-ip']; if(xr) return String(xr).trim(); const p=(req.headers['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean); return p.length?p[p.length-1]:((req.socket&&req.socket.remoteAddress)||'unknown'); })();
    const _win = Math.floor(Date.now() / (10 * 60 * 1000)); // 10-minute window
    let _rlOk = await sbRpc('rl_hit', { p_key: _ip + ':cohort-pay:' + _win, p_ip: _ip, p_endpoint: 'cohort-pay', p_window: _win, p_limit: 30 });
    if (Array.isArray(_rlOk)) _rlOk = _rlOk[0];
    else if (_rlOk && typeof _rlOk === 'object') _rlOk = Object.values(_rlOk)[0];
    if (_rlOk === false || _rlOk === 'false') return res.status(429).json({ ok: false, error: 'Too many requests — please wait a minute and try again.' });

    let b = req.body || {};
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    // --- honeypot: hidden field only bots fill -> silent no-op (no lead, no Stripe, no pixel) ---
    if (b && (b.hp || b.website)) return res.status(200).json({ ok: false, error: 'rejected' }); // honeypot -> soft fail (no lead/Stripe/pixel/QR); client toasts + re-enables
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
      try { const _a = await stripe.accounts.retrieve(String(coh.stripe_account)); if (!_a.charges_enabled) return res.status(400).json({ ok: false, error: 'Na strane kouce/gymu je chyba v konfiguraci plateb. Pokud jsi s nimi v kontaktu, dej jim o tom vedet.' }); } catch (e) { return res.status(400).json({ ok: false, error: 'Na strane kouce/gymu je chyba v konfiguraci plateb. Pokud jsi s nimi v kontaktu, dej jim o tom vedet.' }); }
      const tierPrice = Number((mem.tier === 'student') ? coh.price_student : coh.price_regular) || 0;
      const dep = Number(coh.deposit_amount || 0);
      const remainder = Math.max(0, tierPrice - dep);
      if (!(remainder > 0)) { await sbPatch('cohort_members', `id=eq.${encodeURIComponent(cmId)}`, { status: 'enrolled' }); return res.status(200).json({ ok: true, enrolled: true, url: null, remainder: 0 }); }
      const cur = String(coh.currency || 'CZK').toUpperCase();
      const isCZK = cur === 'CZK';
      const unit = isCZK ? Math.floor(remainder) * 100 : Math.round(remainder * 100);
      const wz = await isWelcomeZero(coh.stripe_account);
      const rate = wz ? 0 : await providerCommission(coh.owner_id);
      const fee = Math.round(remainder * rate * 100);
      const host = req.headers.host; const proto = host && host.includes('localhost') ? 'http' : 'https';
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        success_url: `${proto}://${host}/?cohort=${encodeURIComponent(mem.cohort_id)}&firstmonth=ok&cm=${encodeURIComponent(cmId)}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${proto}://${host}/?cohortpay=${encodeURIComponent(cmId)}`,
        customer_email: mem.email || undefined,
        metadata: { mtl_payment_type: 'cohort_first_month', cohort_id: String(mem.cohort_id), cohort_member_id: String(cmId), mtl_currency: cur, mtl_welcome: wz ? '1' : '0', mtl_rate: String(rate) },
        line_items: [{ price_data: { currency: cur.toLowerCase(), product_data: { name: `${coh.name || 'Course'} - 1. mesic (doplatek)` }, unit_amount: unit }, quantity: 1 }],
        payment_intent_data: { application_fee_amount: fee, metadata: { mtl_payment_type: 'cohort_first_month', cohort_id: String(mem.cohort_id), cohort_member_id: String(cmId), mtl_rate: String(rate), mtl_welcome: wz ? '1' : '0' } }
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
    // QR/bank deposit (qr_bank gyms): no Stripe; create a claimed member, gym confirms on arrival.
    if (b.method === 'qr') {
      if (c.status === 'draft' || c.status === 'archived') return res.status(403).json({ ok: false, error: 'cohort closed' });
      const depQ = Number(c.deposit_amount || 0);
      if (!(depQ > 0)) return res.status(400).json({ ok: false, error: 'no deposit set' });
      const memberQ = await sbInsert('cohort_members', {
        cohort_id: cohortId, gym_id: c.gym_id, name, email, phone: (b.phone || '').trim() || null,
        tier, status: 'deposit_claimed', attribution: (b.attribution || 'direct'),
        consent_at: new Date().toISOString(), consent_version: (b.consent_version || null),
        fbp: (b.fbp || null), fbc: (b.fbc || null)
      });
      return res.status(200).json({ ok: true, qr: true, cohort_member_id: memberQ && memberQ.id });
    }
    if (!c.stripe_account) return res.status(400).json({ ok: false, error: 'cohort has no payout account' });
    if (c.status === 'draft' || c.status === 'archived') return res.status(403).json({ ok: false, error: 'cohort closed' });
    const deposit = Number(c.deposit_amount || 0);
    if (!(deposit > 0)) return res.status(400).json({ ok: false, error: 'no deposit set' });

    const member = await sbInsert('cohort_members', {
      cohort_id: cohortId, gym_id: c.gym_id, name, email, phone: (b.phone || '').trim() || null,
      tier, status: 'lead', attribution: (b.attribution || 'direct'),
      consent_at: new Date().toISOString(), consent_version: (b.consent_version || null),
      fbp: (b.fbp || null), fbc: (b.fbc || null)
    });
    const memberId = member && member.id;

    const cur = String(c.currency || 'CZK').toUpperCase();
    const isCZK = cur === 'CZK';
    const unitAmount = isCZK ? Math.floor(deposit) * 100 : Math.round(deposit * 100);
    const wz = await isWelcomeZero(c.stripe_account);
    const rate = wz ? 0 : await providerCommission(c.owner_id);
    const applicationFee = Math.round(deposit * rate * 100);

    const host = req.headers.host;
    const proto = host && host.includes('localhost') ? 'http' : 'https';
    const success_url = `${proto}://${host}/?cohort=${encodeURIComponent(cohortId)}&deposit=ok&cm=${encodeURIComponent(memberId)}&session={CHECKOUT_SESSION_ID}`;
    const cancel_url = `${proto}://${host}/?cohort=${encodeURIComponent(cohortId)}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url, cancel_url,
      customer_email: email,
      metadata: { mtl_payment_type: 'cohort_deposit', cohort_id: String(cohortId), cohort_member_id: String(memberId || ''), mtl_currency: cur, tier, mtl_welcome: wz ? '1' : '0', mtl_rate: String(rate) },
      line_items: [{ price_data: { currency: cur.toLowerCase(), product_data: { name: `${c.name || 'Course'} — ${b.gym_name || ''} (deposit)`.trim() }, unit_amount: unitAmount }, quantity: 1 }],
      payment_intent_data: {
        application_fee_amount: applicationFee,
        metadata: { mtl_payment_type: 'cohort_deposit', cohort_id: String(cohortId), cohort_member_id: String(memberId || ''), mtl_rate: String(rate), mtl_welcome: wz ? '1' : '0' }
      }
    }, { stripeAccount: c.stripe_account });

    return res.status(200).json({ ok: true, url: session.url, cohort_member_id: memberId });
  } catch (e) {
    console.error('cohort-pay', e);
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}
