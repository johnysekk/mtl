// _provider-mail.js — KOMU A JAK NAPSAT POSKYTOVATELI (klub, kouč, organizace).
// Používá admin-suspend.js (pozastavení / obnovení účtu) a dac7-cron.js (žádost o údaje pro DAC7).
// Jedno místo pro: kdo je adresát (majitel klubu / organizace, kouč sám), jeho jazyk, e-mail,
// in-app notifikace a e-mail se stejnou stavbou jako ostatní e-maily MTL (_sub-mail.js).
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MTL <noreply@martialtraininglab.com>';
export const APP = (process.env.APP_URL || 'https://app.martialtraininglab.com').replace(/\/+$/, '');
const q = encodeURIComponent;

export async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }); return r.ok ? await r.json() : []; }
  catch (e) { return []; }
}
export async function sbWrite(method, path, body) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`SB ${r.status} ${t.slice(0, 200)}`); }
}
export const esc = (x) => String(x == null ? '' : x).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

// kind: 'gym' | 'coach' | 'org'. Vrátí { table, ownerId, name, email, lang } nebo null.
export async function providerTarget(kind, id) {
  if (!id) return null;
  if (kind === 'gym') {
    const g = ((await sbGet(`gyms?id=eq.${q(id)}&select=id,name,owner_id,invoice_email,contact_email`)) || [])[0];
    if (!g) return null;
    const p = g.owner_id ? (((await sbGet(`profiles?id=eq.${q(g.owner_id)}&select=email,lang`)) || [])[0] || {}) : {};
    return { table: 'gyms', ownerId: g.owner_id, name: g.name || 'Klub', email: p.email || g.invoice_email || g.contact_email || null, lang: p.lang || 'cs' };
  }
  if (kind === 'coach') {
    const p = ((await sbGet(`profiles?id=eq.${q(id)}&select=id,name,email,lang`)) || [])[0];
    if (!p) return null;
    return { table: 'profiles', ownerId: p.id, name: p.name || 'Kouč', email: p.email || null, lang: p.lang || 'cs' };
  }
  if (kind === 'org') {
    const o = ((await sbGet(`organizations?id=eq.${q(id)}&select=id,name,owner_id,kind,invoice_email,contact_email`)) || [])[0];
    if (!o) return null;
    const p = o.owner_id ? (((await sbGet(`profiles?id=eq.${q(o.owner_id)}&select=email,lang`)) || [])[0] || {}) : {};
    return { table: 'organizations', ownerId: o.owner_id, name: o.name || 'Organizace', email: p.email || o.invoice_email || o.contact_email || null, lang: p.lang || 'cs', orgKind: o.kind };
  }
  return null;
}

// In-app notifikace. data = objekt s kind a vším pro proklik; msg_cs / msg_en v datech, message česky.
export async function providerNotify(userId, data) {
  if (!userId) return;
  try {
    await sbWrite('POST', 'notifications', { user_id: userId, type: 'system', read: false, data: JSON.stringify(data), message: data.msg_cs || '' });
  } catch (e) { console.error('[provider-notify]', e.message); }
}

// E-mail. paras = pole HTML odstavců (už escapovaných), btn = { text, url }.
export async function providerMail(to, subject, paras, btn) {
  if (!RESEND || !to) return;
  try {
    const ps = ((await sbGet('platform_settings?id=eq.1&select=name,contact_email,contact_phone')) || [])[0] || {};
    const P = (t) => '<p style="margin:0 0 10px;">' + t + '</p>';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:14px;line-height:1.6;">'
      + paras.map(P).join('')
      + (btn ? ('<p style="margin:14px 0;"><a href="' + esc(btn.url) + '" style="display:inline-block;padding:11px 20px;background:#E63946;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">' + esc(btn.text) + '</a></p>') : '')
      + '<p style="margin:18px 0 0;color:#888;font-size:12px;">' + esc(ps.name || 'Martial Training Lab') + (ps.contact_email ? (' · ' + esc(ps.contact_email)) : '') + (ps.contact_phone ? (' · ' + esc(ps.contact_phone)) : '') + '</p></div>';
    await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }) });
  } catch (e) { console.error('[provider-mail]', e.message); }
}

export const FOUNDER_UUID = (process.env.FOUNDER_UUID || '').trim();
