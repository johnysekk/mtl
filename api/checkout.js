import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  try {
    const {
      coachId,           // Stripe connected account (acct_...)
      coachName,
      amount,            // koučova cena (jeho podíl 100 %)
      currency = 'CZK',  // CZK | EUR | USD
      slotId,            // pro in-person
      online,            // '1' pro online coaching (bez slotu)
      coachProfileId,    // profiles.id kouče (pro online booking)
      fmt,               // formát/tier online objednávky (label)
      commission,        // appFee fraction (markup+cut); founding 0.13, jinak 0.15
    } = req.query;

    if (!coachId || !amount) {
      return res.status(400).json({ error: 'Chybí coachId nebo amount' });
    }

    const rate = parseInt(amount, 10);
    const cur = String(currency).toLowerCase(); // stripe chce malá písmena
    // appFee fraction = markup (10%) + cut (5% běžně / 3% founding). Pojistka 0.05–0.25.
    let COMMISSION = commission ? parseFloat(commission) : 0.15;
    if (!(COMMISSION >= 0.05 && COMMISSION <= 0.25)) COMMISSION = 0.15;
    const STUDENT_MARKUP = 1.10; // student platí +10 %

    // Stripe minor units (×100 platí pro CZK i EUR i USD)
    const unitAmount = Math.round(rate * STUDENT_MARKUP * 100);
    const applicationFee = Math.round(rate * COMMISSION * 100);

    const host = req.headers.host;
    const proto = host && host.includes('localhost') ? 'http' : 'https';

    const isOnline = String(online) === '1';

    // success_url podle typu objednávky
    let successUrl;
    if (isOnline) {
      successUrl = `${proto}://${host}/?platba=ok&online=1&coach=${encodeURIComponent(coachProfileId || '')}&amount=${rate}&currency=${currency}&fmt=${encodeURIComponent(fmt || '')}&session={CHECKOUT_SESSION_ID}`;
    } else {
      successUrl = `${proto}://${host}/?platba=ok&slot=${encodeURIComponent(slotId || '')}&session={CHECKOUT_SESSION_ID}`;
    }

    const productName = isOnline
      ? `Online coaching${fmt ? ' — ' + fmt : ''} — ${coachName || 'Kouč'}`
      : `Lekce s ${coachName || 'Kouč'}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: cur,
            product_data: { name: productName },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFee,
        on_behalf_of: coachId,
        transfer_data: { destination: coachId },
      },
      success_url: successUrl,
      cancel_url: `${proto}://${host}/`,
    });

    res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
}
