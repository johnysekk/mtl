import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  try {
    const { paymentIntent, amount, hoursUntil } = req.query;
    if(!paymentIntent){ return res.status(400).json({ error: 'Chybí payment intent' }); }

    const amt = parseInt(amount);
    const hours = parseFloat(hoursUntil);

    // Urči procento refundu podle času
    let refundPct;
    if(hours >= 16) refundPct = 1.0;      // 100%
    else if(hours >= 0) refundPct = 0.5;  // 50%
    else refundPct = 0;                    // no-show

    if(refundPct === 0){
      return res.status(200).json({ refunded: 0, pct: 0, message: 'Žádný refund (no-show nebo po termínu)' });
    }

    const refundAmount = Math.round(amt * 100 * refundPct); // v haléřích

    // Vytvoř refund
    const refundParams = {
      payment_intent: paymentIntent,
      amount: refundAmount,
    };
    // při 100% refundu vrátit i MTL provizi a obrátit transfer ke koučovi
    if(refundPct === 1.0){
      refundParams.refund_application_fee = true;
      refundParams.reverse_transfer = true;
    } else {
      // při částečném refundu obrátit poměrnou část transferu
      refundParams.reverse_transfer = true;
    }
    const refund = await stripe.refunds.create(refundParams);

    res.status(200).json({ refunded: refundAmount/100, pct: refundPct*100, refundId: refund.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
