// /api/partner-stats-cron.js — MĚSÍČNÍ PŘEHLED PRO PARTNERY KLUBU (výhoda Exclusive Partnera).
//
// Běží 1. dne v měsíci (vercel.json) za předchozí měsíc podle pražského času. Každému klubu, jehož
// majitel má EP a který má partnery (gyms.sponsors), pošle majiteli e-mail se souhrnem a v příloze
// PDF pro každého partnera zvlášť -- klub ho partnerovi přepošle. Čísla:
//   * zobrazení karty klubu v decku (gym_card_views, jednou za den a člověka) -- jen u partnerů,
//     jejichž logo na kartě je (prvních 10 v pořadí majitele); partneři 11–20 (Kage) jsou jen v profilu,
//   * otevření profilu klubu (gym_views, jednou za den a člověka),
//   * kliknutí na logo partnera na profilu klubu (gym_partner_clicks),
//   * nejčastější města lidí, kteří kartu nebo profil viděli (z jejich profilu).
// Kolik partnerů klub ukazuje, určuje stupeň EP majitele (_rate.js EP_TIERS) -- skrytí partneři
// přehled nedostanou. Ruční běh: GET /api/partner-stats-cron?month=YYYY-MM[&gym=<id>][&dry=1]
// (Authorization: Bearer CRON_SECRET; dry=1 jen spočítá a vrátí čísla, e-mail nepošle).
import PDFDocument from 'pdfkit';
import { DEJAVU_CZ } from './_dejavu-cz.js';
import { EP_TIERS, EP_TIER_NAMES, epTierOf } from './_rate.js';
import { pragueMonth, shiftMonth } from './_tz.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MTL <noreply@martialtraininglab.com>';
const CARD_MAX = 10;                       // tolik log je na kartě klubu (index.html SPONSOR_CARD)

async function sbAll(path) {
  const out = [];
  for (let off = 0; off <= 200000; off += 1000) {
    const r = await fetch(`${SB}/rest/v1/${path}&limit=1000&offset=${off}`, { headers: H });
    if (!r.ok) { console.error('[partner-stats]', path.slice(0, 60), r.status); break; }
    const page = await r.json();
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
// Začátek pražského měsíce jako okamžik v UTC (pro created_at).
function pragueStartIso(ym) {
  const [y, m] = ym.split('-').map(Number);
  const g = Date.UTC(y, m - 1, 1);
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Prague', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(g)).forEach((x) => { p[x.type] = x.value; });
  const off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - g;
  return new Date(g - off).toISOString();
}
const sponsorsOf = (g) => {
  try { const raw = g.sponsors; const a = (typeof raw === 'string') ? JSON.parse(raw || '[]') : (raw || []);
    return (Array.isArray(a) ? a : []).filter((x) => x && (x.logo || x.name)); } catch (e) { return []; }
};
const MON = {
  cs: ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};
const monLabel = (ym, en) => { const [y, m] = ym.split('-').map(Number); return MON[en ? 'en' : 'cs'][m - 1] + ' ' + y; };
const num = (v, en) => Number(v || 0).toLocaleString(en ? 'en-GB' : 'cs-CZ');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const T = (en) => en ? {
  title: 'Partner report', club: 'Club', month: 'Month',
  card: 'Club card with your logo shown in the MTL app', cardNo: 'your logo is on the club profile, not on the card',
  people: 'People who saw the card', profile: 'Club profile opened', clicks: 'Clicks on your logo',
  cities: 'Where they were from', noCities: 'not enough data yet',
  foot: (m) => 'Martial Training Lab · martialtraininglab.com · Figures for ' + m + ' (Prague time). A card or profile view counts once a day per person.',
  subj: (c, m) => 'Partner report — ' + c + ', ' + m,
  hello: 'Hello', intro: (c, m) => 'here are last month\'s figures for the partners of <b>' + esc(c) + '</b> (' + esc(m) + '). A PDF for each partner is attached — forward it to them.',
  th: ['Partner', 'Card shown', 'Profile opened', 'Logo clicks'], hidden: (n) => n + ' more partner(s) are over the limit of your tier and are not shown, so they get no report.',
} : {
  title: 'Přehled pro partnera', club: 'Klub', month: 'Měsíc',
  card: 'Zobrazení karty klubu s vaším logem v appce MTL', cardNo: 'vaše logo je v profilu klubu, ne na kartě',
  people: 'Lidí, kteří kartu viděli', profile: 'Otevření profilu klubu', clicks: 'Kliknutí na vaše logo',
  cities: 'Odkud byli', noCities: 'zatím málo údajů',
  foot: (m) => 'Martial Training Lab · martialtraininglab.com · Údaje za ' + m + ' (pražský čas). Zobrazení karty i profilu se počítá jednou za den a člověka.',
  subj: (c, m) => 'Přehled pro partnery — ' + c + ', ' + m,
  hello: 'Dobrý den', intro: (c, m) => 'posíláme čísla za minulý měsíc pro partnery klubu <b>' + esc(c) + '</b> (' + esc(m) + '). V příloze je PDF pro každého partnera — stačí ho přeposlat.',
  th: ['Partner', 'Zobrazení karty', 'Otevření profilu', 'Kliknutí na logo'], hidden: (n) => 'Dalších ' + n + ' partnerů je nad limitem tvého stupně a nezobrazují se, takže přehled nedostanou.',
};

function partnerPdf(d, en) {
  return new Promise((resolve, reject) => {
    const t = T(en);
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const bufs = []; doc.on('data', (b) => bufs.push(b)); doc.on('end', () => resolve(Buffer.concat(bufs))); doc.on('error', reject);
    doc.registerFont('dv', DEJAVU_CZ); doc.font('dv');
    doc.rect(0, 0, doc.page.width, 8).fill('#E8C24A'); doc.fillColor('#141414');
    doc.moveDown(0.5).fontSize(11).fillColor('#8a8a8a').text(t.title.toUpperCase(), { characterSpacing: 1 });
    doc.moveDown(0.2).fontSize(24).fillColor('#141414').text(d.partner);
    doc.moveDown(0.3).fontSize(12).fillColor('#555').text(t.club + ': ' + d.club + '    ' + t.month + ': ' + d.monthLabel);
    doc.moveDown(1.2);
    const rows = [
      [t.card, d.onCard ? num(d.cardViews, en) : '—', d.onCard ? '' : t.cardNo],
      [t.people, d.onCard ? num(d.cardPeople, en) : '—', ''],
      [t.profile, num(d.profileViews, en), ''],
      [t.clicks, num(d.clicks, en), ''],
    ];
    const x = doc.page.margins.left, w = doc.page.width - x * 2;
    rows.forEach((r) => {
      const y = doc.y;
      doc.fontSize(12).fillColor('#141414').text(r[0], x, y, { width: w - 120 });
      doc.fontSize(18).fillColor('#141414').text(r[1], x + w - 110, y - 3, { width: 110, align: 'right' });
      if (r[2]) doc.fontSize(9.5).fillColor('#8a8a8a').text(r[2], x, doc.y, { width: w - 120 });
      doc.moveDown(0.6);
      doc.moveTo(x, doc.y).lineTo(x + w, doc.y).lineWidth(0.5).strokeColor('#E0DDD8').stroke();
      doc.moveDown(0.6);
    });
    doc.moveDown(0.6).fontSize(12).fillColor('#141414').text(t.cities, x);
    doc.moveDown(0.3).fontSize(11).fillColor('#555').text(d.cities.length ? d.cities.map((c) => c[0] + ' (' + num(c[1], en) + ')').join(' · ') : t.noCities, x, doc.y, { width: w });
    doc.fontSize(8.5).fillColor('#8a8a8a').text(t.foot(d.monthLabel), x, doc.page.height - 80, { width: w });
    doc.end();
  });
}

async function mail(to, subject, html, attachments) {
  if (!RESEND) { console.error('[partner-stats] mail: chybí RESEND_API_KEY'); return false; }
  if (!to) { console.error('[partner-stats] mail: majitel nemá e-mail', subject); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, attachments }) });
    if (!r.ok) { console.error('[partner-stats] mail', to, r.status, (await r.text().catch(() => '')).slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error('[partner-stats] mail', to, e.message); return false; }
}

export default async function handler(req, res) {
  {
    const secret = process.env.CRON_SECRET;
    if (!secret) return res.status(500).json({ error: 'CRON_SECRET not configured' });
    if ((req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  }
  if (!SB || !KEY) return res.status(500).json({ error: 'env not set' });
  const q = req.query || {};
  const ym = /^\d{4}-\d{2}$/.test(String(q.month || '')) ? String(q.month) : shiftMonth(pragueMonth(), -1);
  const nextYm = shiftMonth(ym, 1);
  const d0 = ym + '-01', d1 = nextYm + '-01', t0 = pragueStartIso(ym), t1 = pragueStartIso(nextYm);

  const gyms = (await sbAll(`gyms?select=id,name,owner_id,sponsors&deleted_at=is.null${q.gym ? `&id=eq.${encodeURIComponent(q.gym)}` : ''}`))
    .filter((g) => sponsorsOf(g).length && g.owner_id);
  const oids = [...new Set(gyms.map((g) => g.owner_id))];
  const owners = {};
  for (let i = 0; i < oids.length; i += 100) {
    (await sbAll(`profiles?id=in.(${oids.slice(i, i + 100).join(',')})&select=id,name,email,lang,partner,partner_tier`)).forEach((p) => { owners[p.id] = p; });
  }
  const out = [];
  for (const g of gyms) {
    const own = owners[g.owner_id]; const tier = epTierOf(own);
    if (!tier) continue;                                         // bez EP partneři nejsou vidět
    const all = sponsorsOf(g), shown = all.slice(0, EP_TIERS[tier].partners);
    const gid = encodeURIComponent(g.id);
    const cv = await sbAll(`gym_card_views?gym_id=eq.${gid}&view_date=gte.${d0}&view_date=lt.${d1}&select=viewer_id`);
    const pv = await sbAll(`gym_views?gym_id=eq.${gid}&view_date=gte.${d0}&view_date=lt.${d1}&select=viewer_id`);
    const ck = await sbAll(`gym_partner_clicks?gym_id=eq.${gid}&created_at=gte.${encodeURIComponent(t0)}&created_at=lt.${encodeURIComponent(t1)}&select=partner_name,partner_url`);
    // Města lidí, kteří kartu nebo profil viděli (každý člověk jednou).
    const vids = [...new Set(cv.concat(pv).map((r) => r.viewer_id).filter(Boolean))];
    const cityCount = {};
    for (let i = 0; i < vids.length; i += 100) {
      (await sbAll(`profiles?id=in.(${vids.slice(i, i + 100).join(',')})&select=city`)).forEach((p) => { const c = String(p.city || '').trim(); if (c) cityCount[c] = (cityCount[c] || 0) + 1; });
    }
    const cities = Object.entries(cityCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const cardPeople = new Set(cv.map((r) => r.viewer_id)).size;
    const en = own.lang === 'en', ml = monLabel(ym, en), t = T(en);
    const rows = shown.map((sp, i) => ({
      partner: sp.name || ('Partner ' + (i + 1)), club: g.name || '', monthLabel: ml,
      onCard: i < CARD_MAX, cardViews: cv.length, cardPeople, profileViews: pv.length,
      clicks: ck.filter((c) => (sp.url && c.partner_url === sp.url) || (sp.name && c.partner_name === sp.name)).length,
      cities,
    }));
    const attachments = [];
    for (const r of rows) {
      const buf = await partnerPdf(r, en);
      attachments.push({ filename: (en ? 'partner-report-' : 'prehled-partner-') + String(r.partner).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) + '-' + ym + '.pdf', content: buf.toString('base64') });
    }
    const html = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#141414;line-height:1.55;max-width:620px;">'
      + '<p>' + t.hello + ',</p><p>' + t.intro(g.name || '', ml) + '</p>'
      + '<table style="border-collapse:collapse;width:100%;font-size:13px;"><tr>' + t.th.map((h, i) => '<th style="text-align:' + (i ? 'right' : 'left') + ';padding:6px 8px;border-bottom:2px solid #E0DDD8;color:#555;">' + h + '</th>').join('') + '</tr>'
      + rows.map((r) => '<tr><td style="padding:6px 8px;border-bottom:1px solid #EFECE7;">' + esc(r.partner) + '</td><td style="padding:6px 8px;border-bottom:1px solid #EFECE7;text-align:right;">' + (r.onCard ? num(r.cardViews, en) : '—') + '</td><td style="padding:6px 8px;border-bottom:1px solid #EFECE7;text-align:right;">' + num(r.profileViews, en) + '</td><td style="padding:6px 8px;border-bottom:1px solid #EFECE7;text-align:right;">' + num(r.clicks, en) + '</td></tr>').join('')
      + '</table>'
      + (cities.length ? ('<p style="color:#555;">' + t.cities + ': ' + cities.map((c) => esc(c[0]) + ' (' + num(c[1], en) + ')').join(' · ') + '</p>') : '')
      + (all.length > shown.length ? ('<p style="color:#8a5a00;">' + t.hidden(all.length - shown.length) + ' (Exclusive Partner ' + EP_TIER_NAMES[tier] + ')</p>') : '')
      + '<p style="color:#8a8a8a;font-size:12px;">' + t.foot(ml) + '</p></div>';
    const ok = q.dry === '1' ? null : await mail(own.email, t.subj(g.name || '', ml), html, attachments);
    out.push({ gym: g.id, partners: rows.length, sent: ok, cardViews: cv.length, profileViews: pv.length, clicks: ck.length });
  }
  return res.status(200).json({ ok: true, month: ym, gyms: out.length, out });
}
