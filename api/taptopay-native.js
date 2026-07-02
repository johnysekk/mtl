/* MTL Tap to Pay — app-side integration.
 *
 * Runs ONLY inside the native Capacitor app. In the normal PWA, window.Capacitor
 * is undefined, so everything here stays dormant (no effect, zero risk).
 *
 * Include this file in index.html AFTER the main app script:
 *     <script src="taptopay-native.js"></script>
 *
 * It exposes:
 *   window.mtlIsNative()                      -> true only inside the native app
 *   window.mtlChargeTapToPay(opts)            -> runs the full Tap-to-Pay flow
 *
 * Uses @capacitor-community/stripe-terminal (native plugin) + the /api endpoints:
 *   /api/terminal-connection-token   (mints reader token on the gym account)
 *   /api/terminal-location           (ensures the gym's Location)
 *   /api/terminal-payment-intent     (card_present PI with MTL app fee)
 *
 * NATIVE-DEV TODO (verify against the installed plugin version):
 *   - Exact plugin name on window.Capacitor.Plugins (StripeTerminal vs StripeTerminalPlugin).
 *   - Exact enum string for Tap to Pay in discoverReaders (e.g. 'tap-to-pay').
 *   - Event name for the connection-token request.
 *   The flow/shape below matches the v7 community plugin docs; wire the specifics
 *   once the native project is set up and you can run it against a simulated reader.
 */
(function () {
  'use strict';

  window.mtlIsNative = function () {
    return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  };

  function _plugin() {
    var P = (window.Capacitor && window.Capacitor.Plugins) || {};
    return P.StripeTerminal || P.StripeTerminalPlugin || null;
  }

  // Reuse the app's fresh Supabase access token if available, else fall back.
  async function _token() {
    try { if (typeof window._freshTok === 'function') return await window._freshTok(); } catch (e) {}
    try { return (window.currentUser && window.currentUser.access_token) || null; } catch (e) { return null; }
  }

  async function _api(path, body) {
    var r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  /* opts: { gymId, amount(minor units), currency='czk', type='drop_in',
   *         coachId?, memberId?, className?, level?, memberName?, postalCode? } */
  window.mtlChargeTapToPay = async function (opts) {
    if (!window.mtlIsNative()) throw new Error('Tap to Pay funguje jen v nativní appce');
    var T = _plugin();
    if (!T) throw new Error('Stripe Terminal plugin není dostupný');
    if (!opts || !opts.gymId || !opts.amount) throw new Error('chybí gymId nebo amount');

    var token = await _token();
    if (!token) throw new Error('nejsi přihlášený');

    // 1) ensure the gym's Location (regional config)
    var loc = await _api('/api/terminal-location', { token: token, gym_id: opts.gymId, postal_code: opts.postalCode });
    var locationId = loc.location_id;

    // 2) connection-token provider (plugin asks for it; we mint on the gym account)
    try {
      await T.addListener('requestConnectionToken', async function () {
        var ct = await _api('/api/terminal-connection-token', { token: token, gym_id: opts.gymId });
        try { await T.setConnectionToken({ token: ct.secret }); } catch (e) {}
      });
    } catch (e) { /* some plugin versions use initialize({tokenProviderEndpoint}) instead */ }

    // 3) init (test mode while developing; flip to live for go-live)
    await T.initialize({ isTest: true, tokenProviderEndpoint: '/api/terminal-connection-token' });

    // 4) discover + connect the Tap-to-Pay "reader" (the phone itself)
    var disc = await T.discoverReaders({ type: 'tap-to-pay', locationId: locationId });
    var readers = (disc && disc.readers) || [];
    if (!readers.length) throw new Error('Tap to Pay není na tomto zařízení dostupné');
    await T.connectReader({ reader: readers[0], onBehalfOf: loc.account });

    // 5) create the card_present PaymentIntent (MTL app fee applied server-side)
    var pi = await _api('/api/terminal-payment-intent', {
      token: token, gym_id: opts.gymId, amount: opts.amount, currency: opts.currency || 'czk',
      type: opts.type || 'drop_in', coach_id: opts.coachId, member_id: opts.memberId,
      class_name: opts.className, level: opts.level, member_name: opts.memberName,
    });

    // 6) collect (customer taps card) + confirm
    await T.collectPaymentMethod({ paymentIntent: pi.client_secret });
    await T.confirmPaymentIntent();
    try { await T.disconnectReader(); } catch (e) {}

    return { ok: true, id: pi.id };
  };
})();
