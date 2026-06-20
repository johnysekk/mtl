import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vrátí stav connected accountu, aby klient mohl PŘED přepsáním stripe_account /
// gym_payout_account / gyms.stripe_account ověřit, že nový účet umí přijímat platby.
// Zabraňuje díře: swap na nedokončený (charges_enabled=false) účet by jinak shodil
// rezervace (direct charge by selhal). charges_enabled = může přijímat platby.
export default async function handler(req, res) {
  try {
    const acct = req.query.acct;
    if (!acct) return res.status(400).json({ error: 'missing acct' });
    const a = await stripe.accounts.retrieve(String(acct));
    res.status(200).json({
      id: a.id,
      type: a.type || null,
      charges_enabled: !!a.charges_enabled,
      details_submitted: !!a.details_submitted,
      payouts_enabled: !!a.payouts_enabled,
    });
  } catch (err) {
    console.error('account-status error:', err);
    res.status(500).json({ error: err.message, charges_enabled: false });
  }
}
