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
export async function subMail(who, what, until) {
  if (!RESEND) return;
  try {
    let to = null, lang = 'cs', product, productEn, name = '';
    if (who.orgId) {
      const o = ((await sbGet(`organizations?id=eq.${q(who.orgId)}&select=name,owner_id,invoice_email,contact_email`)) || [])[0] || {};
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
    const T = {
      cancel: en
        ? ['Subscription cancelled — ' + productEn, 'Your ' + productEn + ' subscription is cancelled. ' + (ds ? ('It stays active until <b>' + ds + '</b>; ') : '') + 'no further payments will be taken. Changed your mind? You can renew it in the app until then.']
        : ['Předplatné zrušeno — ' + product, 'Předplatné ' + product + ' je zrušené. ' + (ds ? ('Platí do <b>' + ds + '</b>, ') : '') + 'další platby už se strhávat nebudou. Kdyby sis to rozmyslel/a, do té doby ho v appce obnovíš jedním klepnutím.'],
      resume: en
        ? ['Subscription renewed — ' + productEn, 'Your ' + productEn + ' subscription continues. Payments will be taken as before.']
        : ['Předplatné obnoveno — ' + product, 'Předplatné ' + product + ' pokračuje. Platby se strhávají jako dřív.'],
      ended: en
        ? ['Subscription ended — ' + productEn, who.orgId ? 'Your supplier profile is no longer shown in MTL. Your details stay saved; pay again in the app and the profile goes live right away.' : 'You are no longer an Exclusive MTL Partner; standard rates apply from the next invoice. You can subscribe again in the app at any time.']
        : ['Předplatné skončilo — ' + product, who.orgId ? 'Profil dodavatele se v MTL přestal zobrazovat. Údaje zůstávají uložené; po novém zaplacení v appce se profil hned ukáže.' : 'Už nejsi Exclusive MTL Partner, od další faktury platí standardní sazby. Předplatné si v appce můžeš kdykoliv obnovit.'],
    }[what];
    if (!T) return;
    // Stejná stavba jako e-mail k faktuře za provizi: oslovení, věcný text, patička s kontaktem MTL.
    // Bez velkého nadpisu -- ten už je v předmětu.
    const ps = ((await sbGet('platform_settings?id=eq.1&select=name,contact_email,contact_phone')) || [])[0] || {};
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:14px;line-height:1.6;">'
      + '<p style="margin:0 0 10px;">' + (en ? 'Hello' : 'Dobrý den') + ',</p>'
      + '<p style="margin:0 0 10px;">' + T[1] + '</p>'
      + '<p style="margin:14px 0;"><a href="' + APP + '/" style="display:inline-block;padding:11px 20px;background:#E63946;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">' + (en ? 'Open MTL' : 'Otevřít MTL') + '</a></p>'
      + '<p style="margin:18px 0 0;color:#888;font-size:12px;">' + esc(ps.name || 'Martial Training Lab') + (ps.contact_email ? (' · ' + esc(ps.contact_email)) : '') + (ps.contact_phone ? (' · ' + esc(ps.contact_phone)) : '') + '</p></div>';
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: T[0], html }) });
  } catch (e) { console.error('[sub-mail]', e.message); }
}
