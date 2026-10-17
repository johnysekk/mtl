// NÁKUP NA FIRMU -- napojení platby na údaje firmy (sql/doklad-buyer.sql).
// Student vyplní firmu u platby kartou; uloží se k Checkoutu (doklad_buyers). Než se k platbě
// vystaví doklad, server řekne databázi, která platba k té objednávce patří -- doklad pak firmu
// dostane jako Odběratele. Když doklad mezitím už vznikl (souběh webhooku a návratu ze Stripe),
// databáze firmu do něj doplní. Nikdy nesmí shodit platbu ani doklad: chyby se jen zalogují.
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = () => ({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
const _id = (v) => (typeof v === 'string' ? v : (v && v.id)) || null;

async function _rpcBind(session, pi, sub) {
  const r = await fetch(`${SB}/rest/v1/rpc/doklad_buyer_bind`, { method: 'POST', headers: H(), body: JSON.stringify({ p_session: session || null, p_pi: pi || null, p_sub: sub || null }) });
  if (!r.ok) throw new Error(`bind ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return r.json().catch(() => 0);
}

// Checkout (první platba): jen když k němu někdo vyplnil firmu -- jinak žádné volání Stripe navíc.
export async function bindBuyerForSession(stripe, session, acct, knownPi) {
  try {
    if (!session || !session.id || !SB || !KEY) return 0;
    const r = await fetch(`${SB}/rest/v1/doklad_buyers?session_id=eq.${encodeURIComponent(session.id)}&select=session_id`, { headers: H() });
    const rows = r.ok ? await r.json() : [];
    if (!(rows && rows.length)) return 0;
    let pi = knownPi || _id(session.payment_intent);
    const sub = _id(session.subscription);
    if (!pi) {
      const opts = acct ? { stripeAccount: acct } : undefined;
      let invId = _id(session.invoice);
      if (!invId && sub) { try { const so = await stripe.subscriptions.retrieve(sub, opts); invId = _id(so && so.latest_invoice); } catch (e) {} }
      if (invId) { try { const inv = await stripe.invoices.retrieve(invId, opts); pi = _id(inv.payment_intent) || _id(inv.charge); } catch (e) {} }
    }
    return await _rpcBind(session.id, pi, sub);
  } catch (e) { console.error('[doklad-buyer] bind session', e && e.message); return 0; }
}

// Obnova předplatného (invoice.paid): firma z první objednávky platí dál.
export async function bindBuyerForRenewal(pi, sub) {
  try {
    if (!pi || !sub || !SB || !KEY) return 0;
    return await _rpcBind(null, pi, sub);
  } catch (e) { console.error('[doklad-buyer] bind renewal', e && e.message); return 0; }
}
