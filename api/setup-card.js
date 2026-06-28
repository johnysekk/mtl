import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// MTL commission card-on-file.
// This is the card the PROVIDER PAYS FROM for off-Stripe (cash/QR) commission — NOT a Stripe Connect
// merchant account, so there is NO identity verification / "identified person" trigger here.
// Flow: startSetup() -> Stripe Checkout in mode:'setup' -> on return ?card_setup=ok the client calls
// ?action=save which retrieves the PaymentMethod and stores it (off-session default) on the gym/profile row.

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function _sbGet(path){
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if(!r.ok) return [];
  return await r.json();
}
async function _sbPatch(path, body){
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  return r.ok;
}

function tableFor(kind){ return String(kind) === 'coach' ? 'profiles' : 'gyms'; }

export default async function handler(req, res){
  try{
    const { action } = req.query;
    if(action === 'save') return await saveCard(req, res);
    return await startSetup(req, res);
  }catch(err){
    console.error('setup-card error:', err);
    res.status(500).json({ error: err.message });
  }
}

// ── 1) Begin: create/reuse a Stripe Customer and open a Checkout Session in setup mode ──
async function startSetup(req, res){
  const { kind = 'gym', id, userId, email } = req.query;
  if(!id) return res.status(400).json({ error: 'Chybí id' });
  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';
  const table = tableFor(kind);

  // reuse existing customer if we already created one for this gym/profile
  let customer = '';
  try{
    const row = (await _sbGet(`${table}?id=eq.${encodeURIComponent(id)}&select=commission_card_customer`))[0] || {};
    customer = row.commission_card_customer || '';
  }catch(e){}
  if(!customer){
    const c = await stripe.customers.create({
      ...(email ? { email: String(email) } : {}),
      metadata: { mtl_kind: String(kind), mtl_id: String(id), mtl_user: String(userId || '') },
    });
    customer = c.id;
    try{ await _sbPatch(`${table}?id=eq.${encodeURIComponent(id)}`, { commission_card_customer: customer }); }catch(e){}
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    payment_method_types: ['card'],
    customer,
    metadata: { mtl_kind: String(kind), mtl_id: String(id) },
    success_url: `${proto}://${host}/?card_setup=ok&kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${proto}://${host}/?card_setup=cancel`,
  }, { apiVersion: '2024-09-30.acacia' });

  res.redirect(303, session.url);
}

// ── 2) Return: retrieve the saved card, set it as off-session default, store summary on the row ──
async function saveCard(req, res){
  const { session: sid, kind = 'gym', id } = req.query;
  if(!sid || !id) return res.status(400).json({ error: 'Chybí session/id' });
  const table = tableFor(kind);

  const cs = await stripe.checkout.sessions.retrieve(String(sid));
  const siId = cs.setup_intent;
  if(!siId) return res.status(400).json({ error: 'Setup intent nenalezen' });
  const si = await stripe.setupIntents.retrieve(String(siId));
  const pmId = si.payment_method;
  if(!pmId) return res.status(400).json({ error: 'Karta nenalezena' });
  const pm = await stripe.paymentMethods.retrieve(String(pmId));
  const card = pm.card || {};
  const customer = cs.customer || pm.customer || '';

  // make this card the default for future OFF-SESSION charges (the monthly commission pull)
  try{ if(customer) await stripe.customers.update(String(customer), { invoice_settings: { default_payment_method: String(pmId) } }); }catch(e){}

  const exp = (card.exp_month && card.exp_year) ? (String(card.exp_month).padStart(2, '0') + '/' + card.exp_year) : '';
  const patch = {
    commission_card_customer: String(customer || ''),
    commission_card_pm: String(pmId),
    commission_card_brand: card.brand || 'card',
    commission_card_last4: card.last4 || '',
    commission_card_exp: exp,
    commission_card_status: 'active',
    commission_card_added_at: new Date().toISOString(),
  };
  await _sbPatch(`${table}?id=eq.${encodeURIComponent(id)}`, patch);

  res.status(200).json({ ok: true, brand: patch.commission_card_brand, last4: patch.commission_card_last4, exp: patch.commission_card_exp });
}
