import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── Exclusive MTL Partner — $99/mo subscription na PLATFORMOVÉM účtu MTL ──
// (MTL účtuje kouči/gym ownerovi přímo; není to Connect/direct-charge.)
// Po zaplacení stripe-webhook.js (checkout.session.completed, mtl_payment_type=partner_sub)
// nastaví profiles.partner = true. Při zrušení (customer.subscription.deleted) → partner = false.
export default async function handler(req, res) {
  try {
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
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Exclusive MTL Partner — coach & gym rates' },
            unit_amount: 9900, // $99.00
            recurring: { interval: 'month' },
          },
          quantity: 1,
        },
      ],
      // metadata na subscription i session — webhook čte oboje
      subscription_data: { metadata: { mtl_payment_type: 'partner_sub', user_id: userId } },
      metadata: { mtl_payment_type: 'partner_sub', user_id: userId },
      success_url: `${proto}://${host}/?partner_sub=ok&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${proto}://${host}/`,
    }, { apiVersion: '2024-09-30.acacia' });

    res.redirect(303, session.url);
  } catch (err) {
    console.error('partner-checkout error:', err);
    res.status(500).json({ error: err.message });
  }
}
