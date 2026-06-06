import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── MTL Gym MEMBERSHIP — opakované předplatné přes DIRECT CHARGE na účtu gymu ──
// Model: BEZ studentského markupu (student platí přesně cenu gymu),
// MTL bere application_fee_percent z KAŽDÉHO invoicu. Gym nese Stripe fee.
// Recurring => předvídatelné MRR pro MTL, gym si nechá 95 %.
const MTL_PERCENT = 5; // % z každého měsíčního/ročního invoicu

export default async function handler(req, res) {
  try {
    const {
      gymAccount,        // Stripe connected account gymu (acct_...)
      gymName,
      planName,          // název členství
      amount,            // cena členství (gym ji zadává) — student ji platí 1:1
      currency = 'CZK',
      interval = 'month',// 'month' | 'year'
      membershipId,      // id záznamu v DB (pro success callback)
      income,            // 'main' | 'side' — jak si to gym SÁM zařadil (ne daňová rada)
      memberName,        // jméno studenta
      payee,             // komu reálně jde platba (kouč nebo gym) — pro export účetní
    } = req.query;

    if (!gymAccount || !amount) {
      return res.status(400).json({ error: 'Chybí gymAccount nebo amount' });
    }

    const P = parseInt(amount, 10);
    const cur = String(currency).toLowerCase();
    const ivl = interval === 'year' ? 'year' : 'month';

    const host = req.headers.host;
    const proto = host && host.includes('localhost') ? 'http' : 'https';

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: cur,
              product_data: { name: `${planName || 'Membership'} — ${gymName || 'MTL Gym'}` },
              unit_amount: Math.round(P * 100), // bez markupu
              recurring: { interval: ivl },
            },
            quantity: 1,
          },
        ],
        subscription_data: {
          application_fee_percent: MTL_PERCENT, // MTL bere 5 % z každého invoicu; Stripe fee nese gym
          metadata: {
            mtl_payment_type: 'membership',
            mtl_plan: planName || 'Membership',
            mtl_income: income || 'side',           // zařazení deklaruje prodejce (gym)
            gym_name: gymName || '',
            mtl_payee: payee || gymName || '',
            member_name: memberName || '',
          },
        },
        success_url: `${proto}://${host}/?gym_sub=ok&membership=${encodeURIComponent(membershipId || '')}&acct=${encodeURIComponent(gymAccount)}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${proto}://${host}/`,
      },
      { stripeAccount: gymAccount } // ← DIRECT CHARGE na účtu gymu
    );

    res.redirect(303, session.url);
  } catch (err) {
    console.error('membership-checkout error:', err);
    res.status(500).json({ error: err.message });
  }
}
