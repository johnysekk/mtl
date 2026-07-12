// /api/terminal-payment-intent
// Creates a card_present PaymentIntent on the gym's connected account for a
// Tap-to-Pay charge at reception. The native Terminal SDK then collects the card
// and confirms this PI. MTL commission is taken via application_fee_amount, exactly
// like the online flow.
//
// Body: {
//   token, gym_id, amount (MINOR units, e.g. haléře/grosz), currency='czk',
//   type='drop_in', coach_id?, member_id?, class_name?, level?, member_name?
// }
// Auth: token must be the gym OWNER's access token (gyms.owner_id === uid).
//
// PAYEE: reception collects on behalf of the GYM, so the charge lands on the gym's
// connected account and the recorded tx carries payee_account = gym.stripe_account.
// (This matches our "money follows payee_account" rule — reception cash/QR/card are
// all gym-collected. An autonomous coach's OWN takings go through their own flow.)
//
// Env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// TODO(before go-live):
//  1. Fee parity: mirror pay.js/record-cash exactly — welcome-zero (isWelcomeZero),
//     acquisitionRate (first-lesson 10%), and the full ladder. Right now this uses
//     the base/partner ladderRate only.
//  2. Webhook: confirm stripe-webhook.js records card_present charges into
//     `transactions` with payment_method='card_present' and payee_account=gym.
//     A card_present PI fires payment_intent.succeeded + charge.succeeded — make sure
//     one of those paths writes the row (idempotently) using this metadata.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body,
  });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
}

// Tap-to-Pay / terminal is a card_present PaymentIntent = a STRIPE direct charge, so it belongs
// on the STRIPE track, not the bank one. It used to return a FLAT 3.5% (the old bank base) for
// everybody except EP - it never even selected coach_ref_score or bankai_eligible - so Shikai
// and Bankai were silently ignored and a Bankai provider (2%) was charged 3.5% on every
// in-person card payment. Must match _ladderRate('stripe', ...).
function ladderRate(profile) {
  if (!profile) return 0.03;                                   // Stripe base 3%
  if (profile.partner) return 0.01;                            // EP
  const s = profile.coach_ref_score || 0;
  if (s >= 5 && profile.bankai_eligible) return 0.02;          // Bankai
  if (s >= 2) return 0.025;                                    // Shikai
  return 0.03;                                                 // base
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { token, gym_id, coach_id, member_id, amount, currency = 'czk', type = 'drop_in', class_name, level, member_name } = b;
    if (!token || !gym_id || !amount) return res.status(400).json({ error: 'missing fields' });
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive integer (minor units)' });

    // --- auth: token -> uid ---
    const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!ur.ok) return res.status(401).json({ error: 'bad token' });
    const u = await ur.json(); const uid = u && u.id;
    if (!uid) return res.status(401).json({ error: 'bad token' });

    // --- verify gym ownership + get connected account + owner rate ---
    const gyms = await sb(`gyms?id=eq.${gym_id}&select=id,owner_id,stripe_account,currency,account_suspended`);
    const gym = gyms && gyms[0];
    if (!gym) return res.status(404).json({ error: 'gym not found' });
    if (gym.owner_id !== uid) return res.status(403).json({ error: 'not your gym' });
    if (gym.account_suspended) return res.status(403).json({ error: 'account suspended' });
    if (!gym.stripe_account) return res.status(400).json({ error: 'gym has no Stripe connected account' });

    const owners = await sb(`profiles?id=eq.${gym.owner_id}&select=id,partner,coach_ref_score,bankai_eligible`);
    const rate = ladderRate((owners && owners[0]) || null);
    const applicationFee = Math.round(amount * rate); // amount is already minor units

    const cur = (currency || gym.currency || 'czk').toLowerCase();

    // --- card_present PaymentIntent ON the gym's connected account ---
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: cur,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      application_fee_amount: applicationFee,
      metadata: {
        mtl_payment_type: type,            // drop_in / membership / merch / ...
        mtl_plan: class_name || 'Drop-in',
        mtl_level: level || '',
        gym_id: String(gym_id),
        coach_id: coach_id || '',          // who taught (attribution)
        member_id: member_id || '',
        member_name: member_name || '',
        mtl_currency: cur,
        payee_account: gym.stripe_account, // reception collects for the gym
        source: 'tap_to_pay',
      },
    }, { stripeAccount: gym.stripe_account });

    return res.status(200).json({ ok: true, id: pi.id, client_secret: pi.client_secret, account: gym.stripe_account });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
