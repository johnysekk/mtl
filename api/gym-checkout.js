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
      income,            // 'main' | 'side' — jak si to gym SÁM zařadil (ne daňová rada)
      memberName,        // jméno studenta
      payee,             // komu reálně jde platba (kouč nebo gym) — pro export účetní
      disc,              // disciplíny gymu (pro Ambassador 0,5%)
      level,             // štítek lekce (např. beginner/advanced) — pro export účetní
      partner,           // '1' = gym owner je Exclusive MTL Partner → 2/2 místo 3/3
    } = req.query;

    if (!gymAccount || !amount) {
      return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });
    }

    const P = parseInt(amount, 10);
    const cur = String(currency).toLowerCase();
    const isPartner = (String(partner) === '1');
    const MK   = isPartner ? 1.02 : STUDENT_MARKUP; // Partner gym: student markup 2 %
    const TAKE = isPartner ? 0.04 : MTL_TAKE;       // Partner gym: 2 % markup + 2 % cut

    // minor units. CZK = celé koruny (DOLŮ); EUR/USD = centy.
    const isCZK = cur === 'czk';
    const unitAmount     = isCZK ? Math.floor(P * MK) * 100 : Math.round(P * MK * 100); // co zaplatí student
    const applicationFee = isCZK ? Math.floor(P * TAKE) * 100 : Math.round(P * TAKE * 100); // čistá provize MTL

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
          description: `${className || 'Drop-in'}${level ? ' ['+level+']' : ''} — ${gymName || 'MTL Gym'} (drop-in)`,
          metadata: {
            mtl_payment_type: 'drop_in',
            mtl_plan: className || 'Drop-in',
            mtl_level: level || '',
            mtl_income: income || 'side',           // zařazení deklaruje prodejce (gym)
            gym_name: gymName || '',
            mtl_payee: payee || gymName || '',
            mtl_disc: disc || '',
            mtl_base: String(P),
            mtl_currency: cur,
            member_name: memberName || '',
          },
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
