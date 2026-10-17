// /api/welcome-mail — UVÍTACÍ E-MAIL PO DOKONČENÍ REGISTRACE.
// POST + Authorization: Bearer <token nového uživatele>   (appka volá hned po dokončení registrace)
//
// Obsah: poděkování, přihlašovací e-mail a odkaz do appky. HESLO NE -- appka ho nezná (Supabase
// ukládá jen otisk) a heslo v e-mailu je riziko; místo něj návod, jak si ho obnovit.
// V příloze PDF se zněním podmínek, které uživatel při registraci odsouhlasil -- PŘESNĚ to znění,
// které je uložené jako důkaz souhlasu (consent_versions / consent_acceptances přes
// api/record-consent.js), ne aktuální text. VOP jsou jeden dokument pro všechny (studenty
// i poskytovatele), k tomu zásady ochrany osobních údajů. V testovacím provozu beta podmínky.
// Jednou na účet (profiles.welcome_mail_at, sql/welcome-mail.sql).
import PDFDocument from 'pdfkit';
import { DEJAVU_CZ } from './_dejavu-cz.js';
import { sendMail, shell, para, button, esc, APP_URL } from './_mail.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const q = encodeURIComponent;
const get = async (p) => { try { const r = await fetch(`${SB}/rest/v1/${p}`, { headers: H }); return r.ok ? r.json() : []; } catch (e) { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KINDS = ['terms', 'privacy', 'beta_terms', 'beta_privacy'];
const TITLE = {
  terms: ['Všeobecné obchodní podmínky MTL', 'MTL Terms and Conditions'],
  privacy: ['Zásady ochrany osobních údajů', 'Privacy Policy'],
  beta_terms: ['Podmínky testovacího provozu MTL', 'MTL Beta Terms'],
  beta_privacy: ['Ochrana osobních údajů v testovacím provozu', 'Beta Privacy Notice'],
};

// Text podmínek je v appce HTML (nadpisy, odstavce, odrážky) -> bloky pro PDF.
function blocks(html) {
  const dec = (t) => String(t).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/[ \t]+/g, ' ').trim();
  const src = String(html || '');
  if (!/<[a-z]/i.test(src)) {
    return src.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => (/^[^a-zá-ž]*$/.test(p) && p.length < 120 ? { h: p } : /^[-•]\s/.test(p) ? { li: p.replace(/^[-•]\s*/, '') } : { p }));
  }
  const out = [];
  const re = /<(div|p|li|h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(src))) {
    const t = dec(m[3]); if (!t) continue;
    const tag = m[1].toLowerCase(), st = m[2] || '';
    if (/^h/.test(tag) || /font-weight:\s*(7|8|9)00/.test(st)) out.push({ h: t });
    else if (tag === 'li') out.push({ li: t });
    else out.push({ p: t });
  }
  return out.length ? out : [{ p: dec(src) }];
}

function termsPdf({ title, version, acceptedAt, name, email, html, en }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: title, Author: 'Martial Training Lab s.r.o.' } });
    const chunks = []; doc.on('data', (d) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.registerFont('cz', DEJAVU_CZ); doc.font('cz');
    doc.fontSize(18).fillColor('#141414').text(title, { align: 'left' });
    doc.moveDown(0.3).fontSize(9.5).fillColor('#555')
      .text((en ? 'Version: ' : 'Verze: ') + version)
      .text((en ? 'Accepted: ' : 'Odsouhlaseno: ') + new Date(acceptedAt).toLocaleString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague' }))
      .text((en ? 'Account: ' : 'Účet: ') + [name, email].filter(Boolean).join(' · '))
      .text(en ? 'This is the exact wording you agreed to when creating your account.' : 'Toto je přesné znění, se kterým jsi souhlasil(a) při založení účtu.');
    doc.moveDown(0.8).fillColor('#141414');
    // Písmo v PDF je podmnožina DejaVu bez českých uvozovek -- nahradit rovnými, jinak by zmizely.
    const fx = (t) => String(t).replace(/[„“”]/g, '"').replace(/[‚‘’]/g, "'");
    for (const b0 of blocks(html)) {
      const b = { h: b0.h && fx(b0.h), li: b0.li && fx(b0.li), p: b0.p && fx(b0.p) };
      if (b.h) doc.moveDown(0.5).fontSize(12).text(b.h).moveDown(0.2);
      else if (b.li) doc.fontSize(10).text('•  ' + b.li, { indent: 10, align: 'left' });
      else doc.fontSize(10).text(b.p, { align: 'left' }).moveDown(0.35);
    }
    doc.end();
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!tok) return res.status(401).json({ error: 'no token' });
    const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
    if (!ur.ok) return res.status(401).json({ error: 'bad token' });
    const uid = (await ur.json()).id;
    const p = ((await get(`profiles?id=eq.${q(uid)}&select=id,name,email,lang,welcome_mail_at`)) || [])[0];
    if (!p || !p.email) return res.status(404).json({ error: 'no profile' });
    if (p.welcome_mail_at) return res.status(200).json({ ok: true, already: true });
    const en = p.lang === 'en';

    // Souhlasy zapisuje appka těsně před tímhle voláním -- chvilku na ně počkat.
    let acc = [];
    for (let i = 0; i < 4; i++) {
      acc = (await get(`consent_acceptances?user_id=eq.${q(uid)}&kind=in.(${KINDS.join(',')})&select=kind,version,lang,version_id,accepted_at,meta&order=accepted_at.desc`)) || [];
      if (acc.length) break;
      await sleep(1500);
    }
    const latest = {};
    acc.forEach((a) => { if (!latest[a.kind]) latest[a.kind] = a; });
    const attachments = [];
    for (const kind of KINDS) {
      const a = latest[kind]; if (!a) continue;
      const v = ((await get(`consent_versions?id=eq.${q(a.version_id)}&select=body_text,version,lang`)) || [])[0];
      const html = (a.meta && a.meta.body_text_shown) || (v && v.body_text) || '';
      if (!String(html).trim()) continue;
      const lg = (a.lang || (v && v.lang) || 'cs') === 'en';
      const title = TITLE[kind][lg ? 1 : 0];
      const buf = await termsPdf({ title, version: a.version || (v && v.version) || '', acceptedAt: a.accepted_at, name: p.name, email: p.email, html, en: lg });
      const fn = (lg ? { terms: 'MTL-terms', privacy: 'MTL-privacy', beta_terms: 'MTL-beta-terms', beta_privacy: 'MTL-beta-privacy' } : { terms: 'MTL-VOP', privacy: 'MTL-ochrana-osobnich-udaju', beta_terms: 'MTL-podminky-testovaciho-provozu', beta_privacy: 'MTL-ochrana-udaju-testovaci-provoz' })[kind];
      attachments.push({ filename: `${fn}-${String(a.version || '').replace(/[^A-Za-z0-9-]/g, '')}.pdf`, content: buf.toString('base64') });
    }

    const hi = en ? `Welcome to Martial Training Lab, ${esc(p.name || '')}!` : `Vítej v Martial Training Lab, ${esc(p.name || '')}!`;
    const html = para(en ? 'Thank you for signing up. Your account is ready.' : 'Díky za registraci. Účet máš hotový.')
      + `<table style="width:100%;border-collapse:collapse;margin:0 0 12px;"><tr><td style="padding:7px 0;border-bottom:1px solid #eee;color:#666;font-size:13px;">${en ? 'Sign-in e-mail' : 'Přihlašovací e-mail'}</td><td style="padding:7px 0;border-bottom:1px solid #eee;font-size:13px;font-weight:700;text-align:right;">${esc(p.email)}</td></tr>`
      + `<tr><td style="padding:7px 0;border-bottom:1px solid #eee;color:#666;font-size:13px;">${en ? 'App' : 'Appka'}</td><td style="padding:7px 0;border-bottom:1px solid #eee;font-size:13px;font-weight:700;text-align:right;"><a href="${APP_URL}" style="color:#141414;">${esc(APP_URL.replace(/^https?:\/\//, ''))}</a></td></tr></table>`
      + para(en ? 'For your security we never send passwords by e-mail. Forgot it? On the sign-in screen tap <b>Forgot password</b> and we will send you a link.' : 'Heslo ti z bezpečnostních důvodů e-mailem neposíláme. Zapomeneš ho? Na přihlašovací obrazovce klepni na <b>Zapomenuté heslo</b> a pošleme ti odkaz.')
      + (attachments.length ? para(en ? 'Attached (PDF) is the exact wording of the terms you agreed to when signing up. Keep it.' : 'V příloze (PDF) máš přesné znění podmínek, se kterými jsi při registraci souhlasil(a). Uschovej si ho.') : '')
      + para(en ? 'If you did not create this account, write to support@martialtraininglab.com.' : 'Pokud jsi účet nezakládal(a) ty, napiš na support@martialtraininglab.com.')
      + button(APP_URL, en ? 'Open the app' : 'Otevřít appku');
    const out = await sendMail(p.email, en ? 'Welcome to MTL' : 'Vítej v MTL', shell(hi.replace(/<[^>]+>/g, ''), html, en), attachments);
    if (out.ok) { try { await fetch(`${SB}/rest/v1/profiles?id=eq.${q(uid)}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify({ welcome_mail_at: new Date().toISOString() }) }); } catch (e) {} }
    return res.status(200).json({ ok: !!out.ok, attachments: attachments.length, error: out.error || out.reason || null });
  } catch (e) {
    console.error('[welcome-mail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
