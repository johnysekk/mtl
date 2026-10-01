// /api/beta-signup-mail
//
// E-MAIL ZAKLADATELI O NOVÉ REGISTRACI DO TESTOVACÍHO PROVOZU.
// Dosud vznikla jen notifikace v appce, kterou zakladatel uvidí, až ji sám otevře --
// a registrace zatím čeká. Mail dorazí na telefon během vteřin.
//
// Volá se z appky hned po dokončení registrace. Žadatel v tu chvíli nemá roli zakladatele,
// takže endpoint NEOVĚŘUJE volajícího rolí: ověřuje, že ten účet opravdu existuje, že má
// beta_status 'pending' a že mail o něm ještě neodešel. Víc poslat nejde.

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MTL <noreply@martialtraininglab.com>';
const APP = process.env.APP_URL || 'https://app.martialtraininglab.com';
const FOUNDER = process.env.FOUNDER_UUID || '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
  return r.ok ? r.json() : [];
}
async function sbPatch(path, body) {
  await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const { user_id } = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
    if (!user_id) return res.status(400).json({ error: 'missing user_id' });
    if (!RESEND) return res.status(200).json({ ok: true, skipped: 'no mail provider' });

    const rows = await sbGet(`profiles?id=eq.${encodeURIComponent(user_id)}&select=name,email,phone,billing_country,is_minor,beta_status,beta_signup_mail_at,created_at`);
    const p = rows[0];
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.beta_status !== 'pending') return res.status(200).json({ ok: true, skipped: 'not pending' });
    if (p.beta_signup_mail_at) return res.status(200).json({ ok: true, skipped: 'already sent' });

    // Kolik jich uz ceka -- at je z predmetu videt, jestli se to hromadi.
    let waiting = 0;
    try {
      const r = await fetch(`${SB}/rest/v1/profiles?beta_status=eq.pending&select=id`, { headers: { ...svc, Prefer: 'count=exact' } });
      waiting = Number(String(r.headers.get('content-range') || '').split('/')[1] || 0) || 0;
    } catch (e) {}

    const fr = await sbGet(`profiles?id=eq.${encodeURIComponent(FOUNDER)}&select=email`);
    const to = (fr[0] && fr[0].email) || process.env.FOUNDER_EMAIL;
    if (!to) return res.status(200).json({ ok: true, skipped: 'no founder email' });

    const row = (l, v) => `<tr><td style="padding:4px 10px 4px 0;color:#888;font-size:13px;">${l}</td><td style="padding:4px 0;color:#111;font-size:14px;font-weight:600;">${v || '\u2014'}</td></tr>`;
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <div style="font-size:19px;font-weight:800;color:#111;margin-bottom:12px;">Nov\u00e1 registrace do bety</div>
      <table style="border-collapse:collapse;margin-bottom:16px;">
        ${row('Jm\u00e9no', p.name)}
        ${row('E-mail', p.email)}
        ${row('Telefon', p.phone)}
        ${row('Zem\u011b', p.billing_country)}
        ${p.is_minor ? row('Pozn\u00e1mka', 'Nezletil\u00fd \u2014 pot\u0159ebuje souhlas z\u00e1stupce') : ''}
      </table>
      <a href="${APP}" style="display:inline-block;padding:13px 22px;background:#111;color:#F4D87A;text-decoration:none;border-radius:10px;font-weight:700;">Otev\u0159\u00edt admin</a>
      <p style="font-size:12px;color:#888;line-height:1.5;margin-top:20px;">\u010cek\u00e1 na schv\u00e1len\u00ed celkem: ${waiting}</p>
    </div>`;

    const r2 = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM, to: [to],
        subject: `Nov\u00e1 registrace do bety: ${p.name || p.email || ''}${waiting > 1 ? ` (\u010dek\u00e1 ${waiting})` : ''}`,
        html,
      }),
    });
    if (!r2.ok) return res.status(502).json({ error: 'mail failed: ' + (await r2.text()).slice(0, 200) });

    await sbPatch(`profiles?id=eq.${encodeURIComponent(user_id)}`, { beta_signup_mail_at: new Date().toISOString() });
    return res.status(200).json({ ok: true, sent: to, waiting });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
