import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── MTL Gym — JEDNORÁZOVÁ lekce (drop-in), model 3/3 přes DIRECT CHARGE ──
// Klíč: { stripeAccount: gymAccount } => charge vznikne NA účtu gymu (direct charge),
// gym nese Stripe processing fee, MTL dostane application_fee_amount ČISTOU.
// (Žádné transfer_data / on_behalf_of — to je jen coach destination flow.)
const STUDENT_MARKUP = 1.03;  // student platí +3 %
const MTL_TAKE       = 0.06;  // MTL hrubá provize = 3 % markup + 3 % cut z báze

export default async function handler(req, res) {
  try {
    const {
      gymAccount,        // Stripe connected account gymu (acct_...)
      gymName,
      className,         // název lekce/drop-inu
      amount,            // ZÁKLADNÍ cena drop-inu (gym ji zadává)
      currency = 'CZK',  // měna gymu (settluje ve své měně)
      bookingId,         // id rezervace v DB (pro success callback)
    } = req.query;

    if (!gymAccount || !amount) {
      return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });
    }

    const P = parseInt(amount, 10);
    const cur = String(currency).toLowerCase();

    // minor units (×100 pro CZK/EUR/USD)
    const unitAmount     = Math.round(P * STUDENT_MARKUP * 100); // co zaplatí student
    const applicationFee = Math.round(P * MTL_TAKE * 100);       // čistá provize MTL

    const host = req.headers.host;
    const proto = host && host.includes('localhost') ? 'http' : 'https';

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: cur,
              product_data: { name: `${className || 'Drop-in lekce'} — ${gymName || 'MTL Gym'}` },
              unit_amount: unitAmount,
            },
            quantity: 1,
          },
        ],
        payment_intent_data: {
          application_fee_amount: applicationFee, // jde MTL; Stripe fee strhne Stripe z podílu gymu
        },
        success_url: `${proto}://${host}/?gym_pay=ok&booking=${encodeURIComponent(bookingId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${proto}://${host}/`,
      },
      { stripeAccount: gymAccount } // ← DIRECT CHARGE: charge vzniká na účtu gymu
    );

    res.redirect(303, session.url);
  } catch (err) {
    console.error('gym-checkout error:', err);
    res.status(500).json({ error: err.message });
  }
}
