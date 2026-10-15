// _sub-mail.js — E-MAIL O PŘEDPLATNÉM NA ÚČTU MTL (Exclusive Partner, profil dodavatele).
// Potvrzení zrušení (běží do konce zaplaceného období), obnovení a skutečného konce.
// Posílá cancel-membership.js (zrušení / obnovení) a stripe-webhook.js (konec předplatného).
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MTL <noreply@martialtraininglab.com>';
const APP = (process.env.APP_URL || 'https://app.martialtraininglab.com').replace(/\/+$/, '');
const q = encodeURIComponent;

async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }); return r.ok ? await r.json() : []; }
  catch (e) { return []; }
}
const esc = (x) => String(x == null ? '' : x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

// who: { userId } pro EP, { orgId } pro dodavatele. what: 'cancel' | 'resume' | 'ended'.
// until: konec zaplaceného období (unix s nebo ISO), jen u 'cancel'.
// info (jen 'ended'): { reason, endedAt } ze Stripe -- reason = cancellation_details.reason
// ('cancellation_requested' zrušil sám, 'payment_failed' platba neprošla ani po opakování).
// Tlačítko vede rovnou do správy předplatného v appce (?go=supplier / ?go=partner).
export async function subMail(who, what, until, info) {
  if (!RESEND) return;
  try {
    let to = null, lang = 'cs', product, productEn, name = '', price = '', priceEn = '';
    if (who.orgId) {
      const o = ((await sbGet(`organizations?id=eq.${q(who.orgId)}&select=name,owner_id,invoice_email,contact_email,supplier_price,supplier_currency,supplier_interval`)) || [])[0] || {};
      if (Number(o.supplier_price) > 0) {
        const cur = String(o.supplier_currency || 'CZK').toUpperCase(), yr = o.supplier_interval === 'year';
        price = Number(o.supplier_price).toLocaleString('cs-CZ') + ' ' + (cur === 'CZK' ? 'Kč' : cur) + (yr ? ' za rok' : ' měsíčně') + ' bez DPH';
        priceEn = Number(o.supplier_price).toLocaleString('en-GB') + ' ' + cur + (yr ? ' a year' : ' a month') + ' excl. VAT';
      }
      const p = o.owner_id ? (((await sbGet(`profiles?id=eq.${q(o.owner_id)}&select=email,lang`)) || [])[0] || {}) : {};
      to = o.invoice_email || o.contact_email || p.email; lang = p.lang || 'cs'; name = o.name || '';
      product = 'profilu dodavatele ' + name; productEn = 'supplier profile ' + name;
    } else {
      const p = ((await sbGet(`profiles?id=eq.${q(who.userId)}&select=email,invoice_email,lang,name`)) || [])[0] || {};
      to = p.invoice_email || p.email; lang = p.lang || 'cs'; name = p.name || '';
      product = 'Exclusive MTL Partner'; productEn = 'Exclusive MTL Partner';
    }
    if (!to) return;
    const en = lang === 'en';
    const d = until ? new Date(typeof until === 'number' ? until * 1000 : until) : null;
    const ds = (d && !isNaN(d)) ? d.toLocaleDateString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague' }) : '';
    const I = info || {};
    const ed = I.endedAt ? new Date(typeof I.endedAt === 'number' ? I.endedAt * 1000 : I.endedAt) : null;
    const eds = (ed && !isNaN(ed)) ? ed.toLocaleString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const why = I.reason === 'payment_failed'
      ? (en ? 'The payment for the next period could not be charged to your card, not even after repeated attempts.' : 'Platbu za další období se nepodařilo strhnout z karty ani po opakovaných pokusech.')
      : (I.reason === 'cancellation_requested'
        ? (en ? 'You cancelled the subscription, so it ended when the paid period ran out.' : 'Předplatné jsi zrušil/a, proto skončilo s koncem zaplaceného období.')
        : (I.reason === 'payment_disputed' ? (en ? 'The payment was disputed with your bank.' : 'Platba byla u banky rozporována.') : ''));
    const P = (t) => '<p style="margin:0 0 10px;">' + t + '</p>';
    const T = {
      cancel: en
        ? ['Subscription cancelled — ' + productEn, 'Your ' + productEn + ' subscription is cancelled. ' + (ds ? ('It stays active until <b>' + ds + '</b>; ') : '') + 'no further payments will be taken. Changed your mind? You can renew it in the app until then.']
        : ['Předplatné zrušeno — ' + product, 'Předplatné ' + product + ' je zrušené. ' + (ds ? ('Platí do <b>' + ds + '</b>, ') : '') + 'další platby už se strhávat nebudou. Kdyby sis to rozmyslel/a, do té doby ho v appce obnovíš jedním klepnutím.'],
      resume: en
        ? ['Subscription renewed — ' + productEn, 'Your ' + productEn + ' subscription continues. Payments will be taken as before.']
        : ['Předplatné obnoveno — ' + product, 'Předplatné ' + product + ' pokračuje. Platby se strhávají jako dřív.'],
      ended: who.orgId
        ? (en
          ? ['Your supplier profile ' + name + ' is no longer visible — subscription ended',
             P('The subscription for the supplier profile <b>' + esc(name) + '</b> ended' + (eds ? (' on <b>' + eds + '</b>') : '') + '.' + (why ? (' ' + why) : ''))
             + P('<b>What this means:</b> clubs, coaches and organizers no longer find you under Suppliers, and if you offer a discount with the MTL Card, students no longer see it. Nothing is deleted — your description, categories, photos and offers stay saved.')
             + P('<b>How to bring it back:</b> open the supplier profile in the app and pay the subscription again' + (priceEn ? (' (' + priceEn + ')') : '') + '. The profile goes live within a minute.')]
          : ['Profil dodavatele ' + name + ' už není vidět — předplatné skončilo',
             P('Předplatné profilu dodavatele <b>' + esc(name) + '</b> skončilo' + (eds ? (' <b>' + eds + '</b>') : '') + '.' + (why ? (' ' + why) : ''))
             + P('<b>Co to znamená:</b> kluby, kouči ani pořadatelé tě v sekci Dodavatelé nenajdou, a pokud nabízíš slevu s Kartou MTL, studenti ji už neuvidí. Nic se nemaže — popis, kategorie, fotky i nabídka zůstávají uložené.')
             + P('<b>Jak profil vrátit:</b> v appce otevři profil dodavatele a předplatné znovu zaplať' + (price ? (' (' + price + ')') : '') + '. Profil se ukáže do minuty.')])
        : (en
          ? ['Exclusive MTL Partner ended',
             P('Your Exclusive MTL Partner subscription ended' + (eds ? (' on <b>' + eds + '</b>') : '') + '.' + (why ? (' ' + why) : ''))
             + P('<b>What this means:</b> commission is back on your own rate from now on — base 2 % for card payments and 2.5 % for transfers, lower with Shikai, Bankai or an organization rate. A member found through the app costs 10 % of the first payment. Promotion by MTL is only for Exclusive Partners, so your club drops out of MTL ads; partners on your club card are hidden (not deleted).')
             + P('You can subscribe again in the app at any time; the partner rate applies from the next payment.')]
          : ['Exclusive MTL Partner skončil',
             P('Předplatné Exclusive MTL Partner skončilo' + (eds ? (' <b>' + eds + '</b>') : '') + '.' + (why ? (' ' + why) : ''))
             + P('<b>Co to znamená:</b> od teď platíš provizi podle své vlastní sazby — základ 2 % u plateb kartou a 2,5 % u převodu, nižší se Shikai, Bankai nebo sazbou organizace. Člen, kterého ti najde appka, stojí 10 % z první platby. Reklama od MTL je jen pro Exclusive Partnery, tvůj klub z ní vypadne; partneři na kartě klubu se skryjí (nesmažou).')
             + P('Předplatné si v appce můžeš kdykoliv obnovit, partnerská sazba pak platí od další platby.')]),
    }[what];
    if (!T) return;
    // Stejná stavba jako e-mail k faktuře za provizi: oslovení, věcný text, patička s kontaktem MTL.
    // Bez velkého nadpisu -- ten už je v předmětu.
    const ps = ((await sbGet('platform_settings?id=eq.1&select=name,contact_email,contact_phone')) || [])[0] || {};
    // TESTOVACÍ REŽIM: EP i profil dodavatele se v testu obnovují DENNĚ (pay.js), ať je celý cyklus
    // vidět druhý den. Zrušené předplatné tak skončí do 24 hodin -- bez téhle věty to vypadá jako chyba.
    const testNote = I.test ? ('<div style="background:#FDECEC;border:1px solid #F3C0C0;border-radius:8px;color:#8a1c1c;font:700 12px/1.4 Arial,sans-serif;padding:9px 12px;margin-bottom:12px;">'
      + (en ? 'TEST MODE — in test, subscriptions renew every day instead of every month, so a cancelled one ends within 24 hours.' : 'TESTOVACÍ REŽIM — v testu se předplatné obnovuje každý den místo každý měsíc, takže zrušené skončí do 24 hodin.') + '</div>') : '';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:14px;line-height:1.6;">'
      + testNote
      + '<p style="margin:0 0 10px;">' + (en ? 'Hello' : 'Dobrý den') + ',</p>'
      + (what === 'ended' ? T[1] : P(T[1]))
      + '<p style="margin:14px 0;"><a href="' + APP + '/?go=' + (who.orgId ? 'supplier' : 'partner') + '" style="display:inline-block;padding:11px 20px;background:#E63946;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">'
      + (who.orgId ? (what === 'ended' ? (en ? 'Renew supplier profile' : 'Obnovit profil dodavatele') : (en ? 'Supplier profile' : 'Profil dodavatele'))
                   : (what === 'ended' ? (en ? 'Renew Exclusive Partner' : 'Obnovit Exclusive Partnera') : 'Exclusive MTL Partner')) + '</a></p>'
      + '<p style="margin:18px 0 0;color:#888;font-size:12px;">' + esc(ps.name || 'Martial Training Lab') + (ps.contact_email ? (' · ' + esc(ps.contact_email)) : '') + (ps.contact_phone ? (' · ' + esc(ps.contact_phone)) : '') + '</p></div>';
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: T[0], html }) });
  } catch (e) { console.error('[sub-mail]', e.message); }
}
