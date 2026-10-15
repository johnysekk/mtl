// APPLE PAY / GOOGLE PAY / LINK VE VLOŽENÉ PLATBĚ STRIPE.
// Vložený formulář běží na doméně MTL, ne na stránce Stripe, a peněženky se v něm ukážou jen na
// doméně registrované u účtu, který platbu přijímá. U přímé platby klubu / kouče (direct charge)
// je to JEHO účet, u EP a profilu dodavatele účet MTL. Bez registrace jde platit kartou, jen
// tlačítka Apple Pay / Google Pay chybí. Registruje se jednou na doménu a účet (Stripe API
// payment_method_domains), výsledek si pamatuje instance funkce. Chyba platbu nikdy nezastaví.
const _done = new Set();

export async function ensurePmDomain(stripe, host, stripeAccount) {
  const domain = String(host || '').split(':')[0].trim().toLowerCase();
  if (!domain || domain === 'localhost' || /^[\d.]+$/.test(domain)) return;
  const key = (stripeAccount || 'platform') + '|' + domain;
  if (_done.has(key)) return;
  const opt = stripeAccount ? { stripeAccount } : undefined;
  try {
    const l = await stripe.paymentMethodDomains.list({ domain_name: domain, limit: 1 }, opt);
    const d = l && l.data && l.data[0];
    if (!d) await stripe.paymentMethodDomains.create({ domain_name: domain }, opt);
    else if (!d.enabled) await stripe.paymentMethodDomains.update(d.id, { enabled: true }, opt);
    _done.add(key);
  } catch (e) { console.error('pm domain', stripeAccount || 'platform', domain, e.message); }
}
