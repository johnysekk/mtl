// /api/stripe-account-info.js — returns identifying details for a connected Stripe account
// so the payout-account sheet can show the legal name / IČO / status straight from Stripe.
// Note: Stripe treats the raw tax_id (IČO) as write-only on most accounts, so it usually returns
// only `company.tax_id_provided: true` rather than the value. We surface the value when Stripe
// gives it, otherwise a "provided" flag. The legal/business name is reliably available.

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  const acct = (req.query && req.query.account) || '';
  if (!acct) return res.status(400).json({ error: 'missing account' });
  try {
    const a = await stripe.accounts.retrieve(acct);
    const bp = a.business_profile || {};
    const co = a.company || {};
    const ind = a.individual || {};

    const name =
      bp.name ||
      co.name ||
      [ind.first_name, ind.last_name].filter(Boolean).join(' ') ||
      null;

    // IČO / tax id — usually write-only, so fall back to a "provided" flag
    const taxId = co.tax_id || null;
    const taxIdProvided = !!(co.tax_id_provided || ind.id_number_provided);

    return res.status(200).json({
      name,
      businessType: a.business_type || a.type || null, // 'company' | 'individual' | ...
      taxId,
      taxIdProvided,
      email: a.email || bp.support_email || null,
      country: a.country || null,
      chargesEnabled: !!a.charges_enabled,
      payoutsEnabled: !!a.payouts_enabled,
      detailsSubmitted: !!a.details_submitted,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
