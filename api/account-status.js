import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vrátí stav connected accountu, aby klient mohl PŘED přepsáním stripe_account /
// gym_payout_account / gyms.stripe_account ověřit, že nový účet umí přijímat platby.
// Zabraňuje díře: swap na nedokončený (charges_enabled=false) účet by jinak shodil
// rezervace (direct charge by selhal). charges_enabled = může přijímat platby.
export default async function handler(req, res) {
  try {
    const acct = String(req.query.acct || '').trim();
    if (!acct) return res.status(400).json({ error: 'missing acct' });
    // Stripe id ma tvar acct_XXXX. Cokoli jineho (IBAN, prazdny retezec, "undefined", cesta s "..")
    // Stripe odmitne jako blokovany pozadavek a v logu z toho je 500 -- desitky za den.
    // Radeji to poznáme tady a vratime klidnou odpoved, kterou volajici umi zpracovat.
    if (!/^acct_[A-Za-z0-9]+$/.test(acct)) {
      return res.status(200).json({ ok: false, error: 'not a stripe account id', charges_enabled: false });
    }
    const a = await stripe.accounts.retrieve(acct);
    res.status(200).json({
      id: a.id,
      type: a.type || null,
      charges_enabled: !!a.charges_enabled,
      details_submitted: !!a.details_submitted,
      payouts_enabled: !!a.payouts_enabled,
      country: a.country || null,
    });
  } catch (err) {
    console.error('account-status error:', err);
    res.status(500).json({ error: err.message, charges_enabled: false });
  }
}
