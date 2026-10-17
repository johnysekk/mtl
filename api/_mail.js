// SPOLEČNÉ ODESÍLÁNÍ E-MAILŮ (Resend) pro nové funkce: výmaz / pozastavení profilu, uvítací
// e-mail po registraci, oznámení MTL. Vzhled stejný jako potvrzení objednávky (_order-mail.js).
// Env: RESEND_API_KEY, MAIL_FROM, APP_URL.
const RESEND_KEY = process.env.RESEND_API_KEY || process.env.RESEND_KEY;
const MAIL_FROM = process.env.MAIL_FROM || process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';
export const APP_URL = (process.env.APP_URL || 'https://app.martialtraininglab.com').replace(/\/+$/, '');

export const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// attachments: [{ filename, content (base64) }]
export async function sendMail(to, subject, html, attachments) {
  if (!RESEND_KEY || !to) return { ok: false, reason: !RESEND_KEY ? 'no RESEND_API_KEY' : 'no recipient' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, ...(attachments && attachments.length ? { attachments } : {}) }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, id: j && j.id, error: r.ok ? null : (j && (j.message || j.name)) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// footer: false = bez věty o potvrzení (oznámení, uvítání).
export function shell(title, body, en, footer) {
  const foot = footer === false ? '' : (en ? 'This e-mail is your confirmation in durable form. Keep it.' : 'Tento e-mail je potvrzení v textové podobě. Uschovej si ho.') + '<br>';
  return `<!doctype html><html><body style="margin:0;background:#f5f2ee;font-family:Arial,Helvetica,sans-serif;color:#141414;">
  <div style="max-width:560px;margin:0 auto;padding:22px 16px;"><div style="background:#fff;border-radius:14px;padding:22px;">
  <div style="font-size:19px;font-weight:800;margin-bottom:14px;">${esc(title)}</div>${body}
  <p style="font-size:12px;color:#888;line-height:1.5;margin:18px 0 0;">${foot}Martial Training Lab · <a href="${APP_URL}" style="color:#888;">${APP_URL.replace(/^https?:\/\//, '')}</a></p>
  </div></div></body></html>`;
}
export const button = (href, label) => `<p style="margin:16px 0 0;"><a href="${esc(href)}" style="display:inline-block;background:#141414;color:#fff;text-decoration:none;padding:11px 16px;border-radius:10px;font-weight:700;font-size:14px;">${esc(label)}</a></p>`;
export const para = (html) => `<p style="font-size:14px;line-height:1.55;margin:0 0 12px;">${html}</p>`;
