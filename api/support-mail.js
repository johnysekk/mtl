// /api/support-mail
//
// DOTAZ NA PODPORU PŘEPOSLANÝ NA E-MAIL.
// Notifikace v appce čeká, až si ji někdo otevře; dotaz od uživatele má přijít hned, a to
// na schránku, kde se dá rovnou odpovědět. Reply-To je nastavené na tazatele, takže
// odpověď jde přímo jemu a nemusí se nic kopírovat.
//
// Záznam zůstává v `support_tickets` (vlastní obrazovka v Adminu); tohle je jen doručení.

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MTL <noreply@martialtraininglab.com>';
const SUPPORT_TO = process.env.SUPPORT_EMAIL || process.env.FOUNDER_EMAIL || '';
const APP = process.env.APP_URL || 'https://app.martialtraininglab.com';

const CATS = {
  general: 'Obecný dotaz', payment: 'Platby', booking: 'Rezervace / členství',
  coach: 'Účet kouče', gym: 'Klub', bug: 'Nahlásit chybu', translation: 'Překlad', other: 'Jiné',
};

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
  return r.ok ? r.json() : [];
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const { ticket_id } = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}));
    if (!ticket_id) return res.status(400).json({ error: 'missing ticket_id' });
    if (!RESEND) return res.status(200).json({ ok: true, skipped: 'no mail provider' });

    // Příjemce: SUPPORT_EMAIL, jinak e-mail zakladatele z profilu.
    let to = SUPPORT_TO;
    if (!to) {
      const f = await sbGet(`profiles?role=eq.founder&select=email&limit=1`);
      to = (f[0] && f[0].email) || '';
    }
    if (!to) return res.status(200).json({ ok: true, skipped: 'no recipient' });

    const rows = await sbGet(`support_tickets?id=eq.${encodeURIComponent(ticket_id)}&select=*`);
    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'not found' });

    const cat = CATS[t.category] || t.category || 'Obecný dotaz';
    const esc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
      <div style="font-size:18px;font-weight:800;color:#111;margin-bottom:4px;">${esc(cat)}</div>
      <div style="font-size:13px;color:#888;margin-bottom:14px;">${esc(t.name || 'Neznámý')}${t.email ? ' · ' + esc(t.email) : ''}</div>
      <div style="font-size:15px;color:#222;line-height:1.6;white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px;margin-bottom:18px;">${esc(t.message || '')}</div>
      ${t.email ? `<a href="mailto:${esc(t.email)}" style="display:inline-block;padding:11px 18px;background:#111;color:#fff;text-decoration:none;border-radius:9px;font-weight:700;font-size:14px;">Odpovědět</a>` : ''}
      <p style="font-size:12px;color:#999;margin-top:20px;">Vyřídit v appce: ${APP} → Admin → Dotazy na podporu</p>
    </div>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM, to: [to],
        // Odpověď jde rovnou tazateli, ne do prázdna.
        ...(t.email ? { reply_to: t.email } : {}),
        subject: `[Podpora] ${cat} — ${t.name || t.email || 'uživatel'}`,
        html,
      }),
    });
    if (!r.ok) return res.status(502).json({ error: 'mail failed: ' + (await r.text()).slice(0, 200) });
    return res.status(200).json({ ok: true, sent: to });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
