import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ════════════════════════════════════════════════════════════════════════
// MTL — sloučený platební router (Vercel Hobby má limit serverless funkcí).
// Nahrazuje: checkout.js (coach) + gym-checkout.js + membership-checkout.js
// + partner-checkout.js. Větví se podle ?type=coach|gym|membership|partner.
// Každá větev je 1:1 přenesená logika z původního souboru — nic se nemění.
// ════════════════════════════════════════════════════════════════════════

const GYM_STUDENT_MARKUP = 1.00;  // no markup
const GYM_MTL_TAKE       = 0.04;  // drop-in: MTL provize 4 %
const MEMB_MTL_PERCENT   = 4;     // membership: 4 % z invoicu

export default async function handler(req, res) {
  const type = String(req.query.type || 'coach');
  try {
    if (type === 'coach')      return await coachCheckout(req, res);
    if (type === 'gym')        return await gymCheckout(req, res);
    if (type === 'membership') return await membershipCheckout(req, res);
    if (type === 'partner')    return await partnerCheckout(req, res);
    if (type === 'event')      return await eventCheckout(req, res);
    return res.status(400).json({ error: 'Neznámý type: ' + type });
  } catch (err) {
    console.error('pay error [' + type + ']:', err);
    res.status(500).json({ error: err.message });
  }
}

// ───────────────────────── COACH (lekce / online) ─────────────────────────
async function coachCheckout(req, res) {
  const {
    coachId, coachName, amount, currency = 'CZK', slotId, online,
    coachProfileId, fmt, commission, nomarkup, credit, studentId, disc, markup,
  } = req.query;

  if (!coachId || !amount) return res.status(400).json({ error: 'Chybí coachId nebo amount' });

  const rate = parseInt(amount, 10);
  const cur = String(currency).toLowerCase();
  let COMMISSION = commission ? parseFloat(commission) : 0.04;
  if (!(COMMISSION >= 0.02 && COMMISSION <= 0.25)) COMMISSION = 0.10;
  let MK = 1.00; // no markup — student pays exactly the listed price
  let STUDENT_MARKUP = MK;
  if (String(credit) === 'student') {
    // Referral reward: student pays exactly the coach's keep, MTL takes 0, coach untouched (~10% off)
    STUDENT_MARKUP = Math.max(0, MK - COMMISSION);
    COMMISSION = 0;
  } else if (String(nomarkup) === '1') {
    STUDENT_MARKUP = 1.00;
  }

  const isCZK = String(currency || 'CZK').toUpperCase() === 'CZK';
  const unitAmount     = isCZK ? Math.floor(rate * STUDENT_MARKUP) * 100 : Math.round(rate * STUDENT_MARKUP * 100);
  const applicationFee = isCZK ? Math.floor(rate * COMMISSION)    * 100 : Math.round(rate * COMMISSION    * 100);

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';
  const isOnline = String(online) === '1';

  let successUrl;
  if (isOnline) {
    successUrl = `${proto}://${host}/?platba=ok&online=1&coach=${encodeURIComponent(coachProfileId || '')}&amount=${rate}&currency=${currency}&fmt=${encodeURIComponent(fmt || '')}&acct=${encodeURIComponent(coachId)}&session={CHECKOUT_SESSION_ID}`;
  } else {
    successUrl = `${proto}://${host}/?platba=ok&slot=${encodeURIComponent(slotId || '')}&acct=${encodeURIComponent(coachId)}&session={CHECKOUT_SESSION_ID}`;
  }

  const productName = isOnline
    ? `Online coaching${fmt ? ' — ' + fmt : ''} — ${coachName || 'Kouč'}`
    : `Lekce s ${coachName || 'Kouč'}`;

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    metadata: {
      booking_type: isOnline ? 'online' : 'inperson',
      student_id: studentId || '',
      slot_id: slotId || '',
      coach_profile_id: coachProfileId || '',
      base_amount: String(rate),
      booking_currency: currency,
      online_fmt: fmt || '',
      coach_name: coachName || '',
      discipline: disc || '',
    },
    line_items: [
      { price_data: { currency: cur, product_data: { name: productName }, unit_amount: unitAmount }, quantity: 1 },
    ],
    payment_intent_data: {
      application_fee_amount: applicationFee,
      metadata: {
        credit_type: credit || 'none',
        coach_pct: (STUDENT_MARKUP - COMMISSION).toFixed(2),
        commission_pct: COMMISSION.toFixed(2),
        coach_name: coachName || '',
      },
    },
    success_url: successUrl,
    cancel_url: `${proto}://${host}/`,
  }, { stripeAccount: coachId });

  res.redirect(303, session.url);
}

// ───────────────────────── GYM drop-in (direct charge) ─────────────────────────
async function gymCheckout(req, res) {
  const {
    gymAccount, gymName, className, amount, currency = 'CZK', bookingId,
    income, memberName, payee, disc, level, partner, guest, token, founding,
  } = req.query;

  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });

  const P = parseInt(amount, 10);
  const cur = String(currency).toLowerCase();
  const isPartner = (String(partner) === '1');
  const MK   = 1.00;
  const TAKE = (String(partner)==='1') ? 0.01 : ((String(founding)==='1') ? 0.02 : GYM_MTL_TAKE); // EP 1%, founding 2%, else flat 4%

  const isCZK = cur === 'czk';
  const unitAmount     = isCZK ? Math.floor(P * MK) * 100 : Math.round(P * MK * 100);
  const applicationFee = isCZK ? Math.floor(P * TAKE) * 100 : Math.round(P * TAKE * 100);

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      line_items: [
        { price_data: { currency: cur, product_data: { name: `${className || 'Drop-in lekce'} — ${gymName || 'MTL Gym'}` }, unit_amount: unitAmount }, quantity: 1 },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFee,
        description: `${className || 'Drop-in'}${level ? ' [' + level + ']' : ''} — ${gymName || 'MTL Gym'} (drop-in)`,
        metadata: {
          mtl_payment_type: 'drop_in',
          mtl_plan: className || 'Drop-in',
          mtl_level: level || '',
          mtl_income: income || 'side',
          gym_name: gymName || '',
          mtl_payee: payee || gymName || '',
          mtl_disc: disc || '',
          mtl_base: String(P),
          mtl_currency: cur,
          member_name: memberName || '',
        },
      },
      success_url: (String(guest)==='1')
        ? `${proto}://${host}/?guest_drop=ok&booking=${encodeURIComponent(bookingId || '')}&acct=${encodeURIComponent(gymAccount)}&token=${encodeURIComponent(token || '')}&session={CHECKOUT_SESSION_ID}`
        : `${proto}://${host}/?gym_pay=ok&booking=${encodeURIComponent(bookingId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${proto}://${host}/`,
      ...(String(guest)==='1' ? { customer_creation: 'always' } : {}),
    },
    { stripeAccount: gymAccount }
  );

  res.redirect(303, session.url);
}

// ───────────────────────── GYM membership (direct charge subscription) ─────────────────────────
// ───────────────────────── EVENT TICKET (flat 6% = 3% markup + 3% cut, no partner discount) ─────────────────────────
async function eventCheckout(req, res) {
  const { gymAccount, eventTitle, tierName, amount, currency = 'CZK', ticketId, buyerName, qty, qrToken, eventId, founding, partner } = req.query;
  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });
  const P = parseInt(amount, 10);
  const Q = Math.max(1, parseInt(qty, 10) || 1);
  const cur = String(currency).toLowerCase();
  const MK = 1.00, TAKE = (String(partner)==='1') ? 0.01 : ((String(founding)==='1') ? 0.02 : 0.04);
  const isCZK = cur === 'czk';
  const unit = isCZK ? Math.floor(P * MK) * 100 : Math.round(P * MK * 100);
  const fee  = isCZK ? Math.floor(P * TAKE) * 100 : Math.round(P * TAKE * 100);
  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      line_items: [
        { price_data: { currency: cur, product_data: { name: `${eventTitle || 'Event'}${tierName ? ' — ' + tierName : ''}` }, unit_amount: unit }, quantity: Q },
      ],
      payment_intent_data: {
        application_fee_amount: fee * Q,
        description: `${eventTitle || 'Event'}${tierName ? ' [' + tierName + ']' : ''} (MTL event ticket)`,
        metadata: {
          mtl_payment_type: 'event_ticket',
          mtl_event: eventTitle || '',
          mtl_tier: tierName || '',
          mtl_base: String(P),
          mtl_currency: cur,
          buyer_name: buyerName || '',
          ticket_id: ticketId || '',
          qr_token: qrToken || '',
          mtl_event_id: eventId || '',
        },
      },
      metadata: {
        mtl_payment_type: 'event_ticket',
        ticket_id: ticketId || '',
        qr_token: qrToken || '',
        mtl_event_id: eventId || '',
        mtl_event: eventTitle || '',
        buyer_name: buyerName || '',
      },
      success_url: `${proto}://${host}/?event_pay=ok&ticket=${encodeURIComponent(ticketId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${proto}://${host}/`,
    },
    { stripeAccount: gymAccount } // DIRECT CHARGE on the chosen payee account (gym or coach)
  );
  res.redirect(303, session.url);
}

async function membershipCheckout(req, res) {
  const {
    gymAccount, gymName, planName, amount, currency = 'CZK', interval = 'month',
    membershipId, income, memberName, payee, disc, access, partner, refPct, refUser, founding,
  } = req.query;

  if (!gymAccount || !amount) return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });

  const P = parseInt(amount, 10);
  const cur = String(currency).toLowerCase();
  const ivl = interval === 'year' ? 'year' : 'month';
  const FEE_PCT = (String(partner)==='1') ? 1 : ((String(founding)==='1') ? 2 : MEMB_MTL_PERCENT); // EP 1%, founding 2%, else flat 4%

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';

  // Gym member referral: new member gets a one-time first-month discount.
  // Coupon is created on the CONNECTED account (charges are direct on the gym).
  let discounts;
  const refPctN = parseInt(refPct, 10) || 0;
  if (refPctN > 0 && refPctN <= 100) {
    try {
      const coupon = await stripe.coupons.create(
        { percent_off: refPctN, duration: 'once', name: `MTL referral -${refPctN}%` },
        { stripeAccount: gymAccount }
      );
      discounts = [{ coupon: coupon.id }];
    } catch (e) { console.error('referral coupon failed', e && e.message); }
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      tax_id_collection: { enabled: true },
      line_items: [
        { price_data: { currency: cur, product_data: { name: `${planName || 'Membership'}${access ? ' [' + access + ']' : ''} — ${gymName || 'MTL Gym'}` }, unit_amount: Math.round(P * 100), recurring: { interval: ivl } }, quantity: 1 },
      ],
      subscription_data: {
        application_fee_percent: FEE_PCT,
        metadata: {
          mtl_payment_type: 'membership',
          mtl_plan: planName || 'Membership',
          mtl_access: access || '',
          mtl_income: income || 'side',
          gym_name: gymName || '',
          mtl_payee: payee || gymName || '',
          mtl_disc: disc || '',
          mtl_base: String(P),
          mtl_currency: cur,
          member_name: memberName || '',
          mtl_ref_user: refUser || '',
          mtl_ref_pct: String(refPctN || 0),
        },
      },
      ...(discounts ? { discounts } : {}),
      success_url: `${proto}://${host}/?gym_sub=ok&membership=${encodeURIComponent(membershipId || '')}&acct=${encodeURIComponent(gymAccount)}&refuser=${encodeURIComponent(refUser || '')}&refpct=${encodeURIComponent(refPctN || 0)}&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${proto}://${host}/`,
    },
    { stripeAccount: gymAccount }
  );

  res.redirect(303, session.url);
}

// ───────────────────────── Exclusive MTL Partner ($499/mo, platform account) ─────────────────────────
async function partnerCheckout(req, res) {
  const { userId, email } = req.query;
  if (!userId) return res.status(400).json({ error: 'Chybí userId' });

  const host = req.headers.host;
  const proto = host && host.includes('localhost') ? 'http' : 'https';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true, required: 'if_supported' },
    client_reference_id: userId,
    customer_email: email || undefined,
    line_items: [
      { price_data: { currency: 'usd', product_data: { name: 'Exclusive MTL Partner — coach & gym rates' }, unit_amount: 49900, recurring: { interval: 'month' } }, quantity: 1 },
    ],
    subscription_data: { metadata: { mtl_payment_type: 'partner_sub', user_id: userId } },
    metadata: { mtl_payment_type: 'partner_sub', user_id: userId },
    success_url: `${proto}://${host}/?partner_sub=ok&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${proto}://${host}/`,
  }, { apiVersion: '2024-09-30.acacia' });

  res.redirect(303, session.url);
}
