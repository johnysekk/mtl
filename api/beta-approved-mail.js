// /api/beta-approved-mail
//
// E-MAIL PO SCHVÁLENÍ PŘÍSTUPU DO TESTOVACÍHO PROVOZU.
// Tester se zaregistruje, čeká na schválení a dosud se o něm nedozvěděl jinak než tím, že
// to sám znovu zkusil. Appka mu po schválení pošle zprávu s odkazem.
//
// Volá se z adminu hned po přepnutí beta_status na 'approved'. Pošle se jen jednou:
// hlídá to sloupec beta_mail_at, takže opakované kliknutí druhý e-mail nevyvolá.
//
// POSÍLÁ JEN V TESTOVACÍM REŽIMU. V ostrém provozu se na schválení nečeká, takže by zpráva
// přišla bez důvodu.

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MTL <noreply@martialtraininglab.com>';
const APP = process.env.APP_URL || 'https://app.martialtraininglab.com';

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
  return r.ok ? r.json() : [];
}
async function sbPatch(path, body) {
  await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
}

function html(lang, name) {
  const en = lang === 'en';
  const hi = name ? (en ? `Hi ${name},` : `Ahoj ${name},`) : (en ? 'Hi,' : 'Ahoj,');
  const lines = en
    ? [`Your access to the Martial Training Lab test run has been approved.`,
       `You can log in with the e-mail and password you registered with.`,
       `This is a test run: payments are simulated and no real money moves. If anything looks wrong, use the bug report button in the app \u2014 that is what we need from you most.`]
    : [`Tv\u016fj p\u0159\u00edstup do testovac\u00edho provozu Martial Training Lab byl schv\u00e1len.`,
       `P\u0159ihl\u00e1s\u00ed se e-mailem a heslem, kter\u00e9 jsi zadal p\u0159i registraci.`,
       `Jde o testovac\u00ed provoz: platby jsou simulovan\u00e9 a \u017e\u00e1dn\u00e9 skute\u010dn\u00e9 pen\u00edze se nep\u0159esouvaj\u00ed. Kdy\u017e ti n\u011bco nebude sedět, pou\u017eij v appce tla\u010d\u00edtko pro hl\u00e1\u0161en\u00ed chyby \u2014 to je to, co od tebe pot\u0159ebujeme nejv\u00edc.`];
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
    <div style="font-size:20px;font-weight:800;color:#111;margin-bottom:14px;">${en ? 'Your access is ready' : 'M\u00e1\u0161 p\u0159\u00edstup'}</div>
    <p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 10px;">${hi}</p>
    ${lines.map((l) => `<p style="font-size:15px;color:#333;line-height:1.6;margin:0 0 10px;">${l}</p>`).join('')}
    <a href="${APP}" style="display:inline-block;margin-top:12px;padding:13px 22px;background:#D22;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">${en ? 'Open the app' : 'Otev\u0159\u00edt appku'}</a>
    <p style="font-size:12px;color:#888;line-height:1.5;margin-top:22px;">Martial Training Lab</p>
  </div>`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const { user_id } = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
    if (!user_id) return res.status(400).json({ error: 'missing user_id' });

    // Jen zakladatel smi tenhle e-mail vyvolat.
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) return res.status(401).json({ error: 'unauthorized' });
    const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${auth}` } });
    if (!ur.ok) return res.status(401).json({ error: 'unauthorized' });
    const me = (await ur.json()).id;
    const mine = await sbGet(`profiles?id=eq.${encodeURIComponent(me)}&select=role`);
    if (!mine[0] || mine[0].role !== 'founder') return res.status(403).json({ error: 'founder only' });

    // Posila se jen v testovacim rezimu.
    const cfg = await sbGet('platform_config?id=eq.1&select=test_mode');
    if (!cfg[0] || !cfg[0].test_mode) return res.status(200).json({ ok: true, skipped: 'not test mode' });

    const rows = await sbGet(`profiles?id=eq.${encodeURIComponent(user_id)}&select=email,name,lang,beta_status,beta_mail_at`);
    const p = rows[0];
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.beta_status !== 'approved') return res.status(200).json({ ok: true, skipped: 'not approved' });
    if (p.beta_mail_at) return res.status(200).json({ ok: true, skipped: 'already sent' });
    if (!p.email) return res.status(200).json({ ok: true, skipped: 'no email' });
    if (!RESEND) return res.status(200).json({ ok: true, skipped: 'no mail provider' });

    const en = String(p.lang || 'cs').toLowerCase().startsWith('en');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM, to: [p.email],
        subject: en ? 'Your Martial Training Lab access is ready' : 'M\u00e1\u0161 p\u0159\u00edstup do Martial Training Lab',
        html: html(en ? 'en' : 'cs', p.name || ''),
      }),
    });
    if (!r.ok) return res.status(502).json({ error: 'mail failed: ' + (await r.text()).slice(0, 200) });

    await sbPatch(`profiles?id=eq.${encodeURIComponent(user_id)}`, { beta_mail_at: new Date().toISOString() });
    return res.status(200).json({ ok: true, sent: p.email });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
