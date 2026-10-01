// /api/support — DOTAZY NA PODPORU, celá cesta přes server.
//
// Proč: `support_tickets` se dosud zapisoval i četl přímo z prohlížeče. Aby to fungovalo,
// musela tabulka buď být bez RLS (pak si každý přihlášený mohl přečíst cizí dotazy včetně
// e-mailů), nebo zakladatelův seznam vracel nulu. A /api/support-mail poslal e-mail komukoli,
// kdo znal id dotazu -- bez přihlášení, bez limitu.
//
// Teď: tabulka je za RLS bez jediné politiky (čte a píše jen service key odtud).
//   POST { action:'create', category, message, lang }   → přihlášený uživatel založí dotaz
//   GET  ?status=open|done|all                          → seznam, jen zakladatel
//   POST { action:'status', id, status }                → změna stavu, jen zakladatel
//
// Jméno a e-mail tazatele se NEBEROU z požadavku -- e-mail je z ověřeného tokenu, jméno
// z profilu. Jinak by šlo poslat dotaz „za někoho" a odpověď by odešla cizímu člověku.

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDER = process.env.FOUNDER_UUID || '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MTL <noreply@martialtraininglab.com>';
const SUPPORT_TO = (process.env.SUPPORT_EMAIL || process.env.FOUNDER_EMAIL || '').trim();
const APP = process.env.APP_URL || 'https://app.martialtraininglab.com';

// Denní strop na uživatele. Zakladatel ho nemá (testuje).
const DAILY_LIMIT = Number(process.env.SUPPORT_DAILY_LIMIT || 5);
const MIN_LEN = 5;
const MAX_LEN = 4000;

// Musí odpovídat SUP_CATS v index.html. Neznámá kategorie spadne do 'general'.
const CATS = {
  general: 'Obecný dotaz', payment: 'Platby', booking: 'Rezervace / členství',
  coach: 'Účet kouče', gym: 'Klub', bug: 'Nahlásit chybu', translation: 'Překlad', other: 'Jiné',
};
const STATUSES = ['open', 'done'];

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}

async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return (u && u.id) ? { id: u.id, email: String(u.email || '').trim() || null } : null;
}

const esc = (x) => String(x == null ? '' : x)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function sendMail(t) {
  if (!RESEND) return 'no mail provider';
  let to = SUPPORT_TO;
  if (!to) {
    const f = await sb(`profiles?id=eq.${FOUNDER}&select=email&limit=1`).catch(() => []);
    to = String((f[0] && f[0].email) || '').trim();
  }
  if (!to) return 'no recipient';
  const cat = CATS[t.category] || 'Obecný dotaz';
  // Předmět nese i začátek zprávy, ať je ve schránce vidět, o co jde, bez otevírání.
  const one = String(t.message || '').replace(/\s+/g, ' ').trim();
  const preview = one.length > 60 ? one.slice(0, 60) + '…' : one;
  const subject = `[Podpora] ${cat} — ${t.name || t.email || 'uživatel'}${preview ? ': ' + preview : ''}`;
  // Tlačítko Odpovědět: předmět Re: a původní zpráva v citaci. Dřív to byl holý mailto
  // bez předmětu i bez historie. Citace je zkrácená -- dlouhé mailto některé aplikace neotevřou.
  const when = t.created_at ? new Date(t.created_at).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }) : '';
  const msg = String(t.message || '');
  const quoted = (msg.length > 1500 ? msg.slice(0, 1500) + '…' : msg).split('\n').map((l) => '> ' + l).join('\r\n');
  const replyHref = t.email ? ('mailto:' + t.email + '?subject=' + encodeURIComponent('Re: ' + subject)
    + '&body=' + encodeURIComponent('\r\n\r\n———\r\n' + (t.name || t.email) + (when ? ', ' + when : '') + ':\r\n' + quoted)) : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
    <div style="font-size:18px;font-weight:800;color:#111;margin-bottom:4px;">${esc(cat)}</div>
    <div style="font-size:13px;color:#888;margin-bottom:14px;">${esc(t.name || 'Neznámý')}${t.email ? ' · ' + esc(t.email) : ''}</div>
    <div style="font-size:15px;color:#222;line-height:1.6;white-space:pre-wrap;border-left:3px solid #ddd;padding-left:12px;margin-bottom:18px;">${esc(t.message || '')}</div>
    ${t.email ? `<a href="${esc(replyHref)}" style="display:inline-block;padding:11px 18px;background:#111;color:#fff;text-decoration:none;border-radius:9px;font-weight:700;font-size:14px;">Odpovědět</a>` : ''}
    <p style="font-size:12px;color:#999;margin-top:20px;">Vyřídit v appce: ${APP} → Admin → Dotazy na podporu</p>
  </div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: MAIL_FROM, to: [to],
      ...(t.email ? { reply_to: t.email } : {}),
      subject,
      html,
    }),
  });
  return r.ok ? 'sent' : ('mail failed: ' + (await r.text()).slice(0, 200));
}

async function create(me, b, res) {
  const raw = String(b.message || '').trim();
  if (raw.length < MIN_LEN) return res.status(400).json({ error: 'too_short' });
  const category = CATS[b.category] ? b.category : 'general';
  const lang = String(b.lang || '').trim().slice(0, 5);
  let message = raw.slice(0, MAX_LEN);
  if (category === 'translation' && lang) message = `[ ${lang}] ` + message;

  const isFounder = String(me.id) === String(FOUNDER);
  if (!isFounder) {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recent = await sb(`support_tickets?user_id=eq.${me.id}&created_at=gte.${encodeURIComponent(since)}&select=id`);
    if ((recent || []).length >= DAILY_LIMIT) return res.status(429).json({ error: 'rate_limit' });
  }

  const prof = await sb(`profiles?id=eq.${me.id}&select=name&limit=1`).catch(() => []);
  const name = String((prof[0] && prof[0].name) || '').trim() || null;

  const ins = await sb('support_tickets?select=id,created_at', {
    method: 'POST', prefer: 'return=representation',
    body: JSON.stringify({ user_id: me.id, name, email: me.email, category, message, status: 'open' }),
  });
  const id = ins && ins[0] && ins[0].id;
  const t = { id, name, email: me.email, category, message, created_at: ins && ins[0] && ins[0].created_at };

  // Doručení zakladateli. Selhání e-mailu ani notifikace nesmí shodit už uložený dotaz.
  let mail = null;
  try { mail = await sendMail(t); } catch (e) { mail = 'mail error'; }
  try {
    await sb('notifications', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({
        user_id: FOUNDER, type: 'system', read: false,
        data: JSON.stringify({ kind: 'support_ticket', ticket_id: id, category, cat_label: CATS[category], who: name || 'User', preview: raw.slice(0, 140) }),
        message: `✉️ Support: ${category} — ${name || 'user'}`,
      }),
    });
  } catch (e) { /* zůstane v Adminu i bez notifikace */ }

  return res.status(200).json({ ok: true, id, mail });
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });
  try {
    const me = await whoami(req);
    if (!me) return res.status(401).json({ error: 'no token' });
    const isFounder = String(me.id) === String(FOUNDER);

    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (b.action === 'create') return await create(me, b, res);
      if (b.action === 'status') {
        if (!isFounder) return res.status(403).json({ error: 'forbidden' });
        if (!b.id || !STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad request' });
        await sb(`support_tickets?id=eq.${encodeURIComponent(String(b.id).trim())}`, {
          method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: b.status }),
        });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'unknown action' });
    }

    if (req.method === 'GET') {
      if (!isFounder) return res.status(403).json({ error: 'forbidden' });
      const st = String((req.query && req.query.status) || 'open');
      const filter = st === 'open' ? '&status=eq.open' : (st === 'done' ? '&status=neq.open' : '');
      const rows = await sb(`support_tickets?select=*${filter}&order=created_at.desc&limit=200`);
      return res.status(200).json({ ok: true, rows: rows || [] });
    }

    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}
