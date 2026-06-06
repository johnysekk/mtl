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
      commission,        // appFee fraction (markup+cut); founding 0.12, jinak 0.17
      nomarkup,          // '1' = referral sleva: student platí bez 10% markupu (1.00)
      credit,            // 'student' | 'coach' | 'none' — který referral kredit se použil
      studentId,         // profiles.id studenta (pro webhook → vytvoření bookingu)
      disc,              // disciplína rezervace (pro 1% ambassador atribuci)
    } = req.query;

    if (!coachId || !amount) {
      return res.status(400).json({ error: 'Chybí coachId nebo amount' });
    }

    const rate = parseInt(amount, 10);
    const cur = String(currency).toLowerCase(); // stripe chce malá písmena
    // appFee fraction = markup (10%) + cut (7% běžně / 2% founding).
    // Při referral kreditu (waiver markupu) je to jen cut: 0.07 běžně / 0.02 founding.
    // Pojistka 0.02–0.25 (musí pustit i founding+kredit 0.02).
    let COMMISSION = commission ? parseFloat(commission) : 0.17;
    if (!(COMMISSION >= 0.02 && COMMISSION <= 0.25)) COMMISSION = 0.17;
    // referral sleva pro studenta = waiver markupu (1.00 místo 1.10); appFee pak jen cut
    const STUDENT_MARKUP = (String(nomarkup) === '1') ? 1.00 : 1.10;

    // Stripe minor units. CZK = celé koruny (zaokrouhlit DOLŮ, žádné haléře); EUR/USD = centy.
    const isCZK = String(currency || 'CZK').toUpperCase() === 'CZK';
    const unitAmount     = isCZK ? Math.floor(rate * STUDENT_MARKUP) * 100 : Math.round(rate * STUDENT_MARKUP * 100);
    const applicationFee = isCZK ? Math.floor(rate * COMMISSION)    * 100 : Math.round(rate * COMMISSION    * 100);

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
      // session-level metadata — čte je stripe-webhook.js, aby spolehlivě vytvořil booking
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
        metadata: {
          credit_type: credit || 'none',                         // student / coach / none
          coach_pct: (STUDENT_MARKUP - COMMISSION).toFixed(2),   // 1.00=kouč 100% (bonus), 0.98=founding, 0.93=běžně
          commission_pct: COMMISSION.toFixed(2),
          coach_name: coachName || '',
        },
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
