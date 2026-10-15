// /api/coach-public — VEŘEJNÁ STRÁNKA KOUČE (?coach=<id>, nebo /coach/<slug> přes vercel.json),
// bez účtu a bez přihlášení. Obdoba stránky klubu (club-public.js), stejný vzhled.
//
// K čemu je: kouč si ji dá do bia nebo na web. Kdo na ni klikne, uvidí, co kouč nabízí (osobní
// lekce, zvýhodněné ceny, online koučink a předplatné), kde trénuje a hodnocení -- a tlačítko do
// appky, které nese ?own=1&coach=<id>, takže se ten člověk připíše kouči (bez akviziční provize).
// Nákup na stránce není: rezervace a platby jsou v appce.
//
// Vrací HOTOVÉ HTML kvůli OG tagům (náhled odkazu v Instagramu / zprávě se bez JavaScriptu
// jinak nesloží). Veřejné je jen to, co kouč sám vystavuje na profilu: jméno, foto, bio,
// disciplíny, město, ceny a kluby. Žádné kontakty, žádní svěřenci.
const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

async function sbGet(path) {
  try { const r = await fetch(_SUPA + '/rest/v1/' + path, { headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY } }); return r.ok ? await r.json() : []; }
  catch (e) { return []; }
}
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const parseJson = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return d; } };
const DISC = {
  muay_thai: 'Muay Thai', bjj: 'Brazilské jiu-jitsu', mma: 'MMA', boxing: 'Box',
  kickboxing: 'Kickbox', judo: 'Judo', karate: 'Karate', wrestling: 'Zápas',
  taekwondo: 'Taekwondo', aikido: 'Aikido', kung_fu: 'Kung-fu', krav_maga: 'Krav Maga',
  sambo: 'Sambo', capoeira: 'Capoeira', grappling: 'Grappling', bare_knuckle: 'Bare-knuckle'
};
const discLabel = (d) => DISC[d] || String(d || '').replace(/_/g, ' ');
const SYM = { CZK: 'Kč', EUR: '€', USD: '$', GBP: '£', PLN: 'zł', HUF: 'Ft' };
const money = (v, c) => { const cur = String(c || 'CZK').toUpperCase(); return Number(v).toLocaleString('cs-CZ', { maximumFractionDigits: 2 }) + ' ' + (SYM[cur] || cur); };
const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">';

function notFound(res, origin) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  return res.status(404).send('<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + FONTS
    + '<title>Kouč nenalezen · MTL</title><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(120% 80% at 50% 0%,#2a2200 0%,#0c0c0c 62%);font-family:\'DM Sans\',system-ui,sans-serif;">'
    + '<div style="text-align:center;padding:0 22px;max-width:420px;"><div style="font-family:\'Bebas Neue\',sans-serif;font-size:16px;letter-spacing:.18em;color:#F4D87A;margin-bottom:22px;">MARTIAL TRAINING LAB</div>'
    + '<h1 style="font-family:\'Bebas Neue\',sans-serif;font-size:36px;color:#fff;margin:0 0 10px;">Kouč nenalezen</h1>'
    + '<p style="color:rgba(255,255,255,.55);line-height:1.6;font-size:14.5px;margin:0 0 24px;">Odkaz může být starý, nebo kouč v MTL momentálně není aktivní.</p>'
    + '<a href="' + esc(origin) + '" style="display:inline-block;padding:14px 26px;background:linear-gradient(135deg,#C9A227,#F4D87A);color:#241c00;border-radius:12px;text-decoration:none;font-weight:700;">Otevřít MTL</a></div></body></html>');
}

export default async function handler(req, res) {
  const q0 = req.query || {};
  const slug = String(q0.slug || '').toLowerCase();
  const id = String(q0.coach || q0.id || '');
  const origin = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'app.martialtraininglab.com');
  // Jen známé parametry (stejně jako stránka klubu): jinak by náhodné parametry obcházely cache
  // a každý požadavek šel do databáze. Neznámé (i fbclid / utm) -> přesměrování na čistou adresu.
  { const _ok = new Set(['coach', 'id', 'slug']);
    if (Object.keys(q0).some((k) => !_ok.has(k))) {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
      res.setHeader('Location', slug ? ('/coach/' + encodeURIComponent(slug)) : ('/api/coach-public?coach=' + encodeURIComponent(id)));
      return res.status(301).end();
    } }
  if (!(slug && SLUG_RE.test(slug)) && !/^[0-9a-f-]{36}$/i.test(id)) return notFound(res, origin);

  const rows = slug ? await sbGet(`profiles?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`)
                    : await sbGet(`profiles?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const c = rows && rows[0];
  // Stará adresa (kouč si ji změnil) -> trvalé přesměrování na novou (sql/share-links.sql).
  if (!c && slug) {
    const hs = await sbGet(`slug_history?kind=eq.coach&old_slug=eq.${encodeURIComponent(slug)}&select=entity_id&limit=1`);
    const nw = hs && hs[0] ? (await sbGet(`profiles?id=eq.${encodeURIComponent(hs[0].entity_id)}&select=slug&limit=1`))[0] : null;
    if (nw && nw.slug && nw.slug !== slug) { res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400'); res.setHeader('Location', '/coach/' + encodeURIComponent(nw.slug)); return res.status(301).end(); }
  }
  // Jen schválený a nepozastavený kouč. Odkaz v biu na neaktivní profil škodí kouči i MTL.
  if (!c || c.coach_status !== 'approved' || c.account_suspended) return notFound(res, origin);

  const discs = parseJson(c.disciplines, []) || [];
  const curIn = c.currency_inperson || c.currency || 'CZK';
  const curOn = c.currency_online || c.currency || 'CZK';

  // ── nabídka ───────────────────────────────────────────────────────────────────────────
  const inRows = [];
  if (Number(c.rate_inperson) > 0) inRows.push(['Osobní lekce 1:1', money(c.rate_inperson, curIn), '']);
  Object.entries(parseJson(c.discipline_rates, {}) || {}).forEach(([d, v]) => { if (Number(v) > 0 && Number(v) !== Number(c.rate_inperson)) inRows.push([discLabel(d) + ' · lekce 1:1', money(v, curIn), '']); });
  (parseJson(c.private_offers, []) || []).forEach((o) => {
    if (!o || !(Number(o.price) > 0)) return;
    const cond = [o.member_only ? 'pro členy klubu' : '', o.offpeak ? ('mimo špičku' + ((o.from || o.to) ? (' ' + (o.from || '') + '–' + (o.to || '')) : '')) : ''].filter(Boolean).join(' · ');
    inRows.push([o.name || 'Zvýhodněná lekce', money(o.price, curIn), cond]);
  });
  const onRows = [];
  (parseJson(c.online_services, []) || []).forEach((t) => { if (t && Number(t.price) > 0) onRows.push([t.label || t.name || 'Online', money(t.price, t.cur || curOn), t.days ? ('dodání do ' + t.days + ' dní') : '']); });
  (parseJson(c.online_plans, []) || []).forEach((p) => { if (p && Number(p.price) > 0) onRows.push([(p.name || 'Online předplatné'), money(p.price, p.cur || curOn) + ' / měsíc', p.desc || '']); });
  const priceList = (title, list) => list.length ? ('<section><h2>' + title + '</h2><div class="prices">'
    + list.map((r) => '<div class="pr"><span>' + esc(r[0]) + (r[2] ? '<small>' + esc(r[2]) + '</small>' : '') + '</span><strong>' + esc(r[1]) + '</strong></div>').join('')
    + '</div></section>') : '';

  // ── kluby, kde trénuje ────────────────────────────────────────────────────────────────
  let clubs = [];
  try {
    const links = await sbGet(`gym_coaches?coach_id=eq.${encodeURIComponent(c.id)}&status=eq.active&select=gym_id&limit=20`);
    const own = await sbGet(`gyms?owner_id=eq.${encodeURIComponent(c.id)}&select=id&limit=10`);
    const gids = [...new Set([...(links || []).map((l) => l.gym_id), ...(own || []).map((g) => g.id)].filter(Boolean))];
    if (gids.length) clubs = ((await sbGet(`gyms?id=in.(${gids.join(',')})&status=eq.approved&select=id,name,city,slug,account_suspended&limit=20`)) || []).filter((g) => !g.account_suspended);
  } catch (e) { /* stránka se ukáže i bez nich */ }

  const reviews = Number(c.reviews) || 0;
  const rating = reviews > 0 ? Number(c.rating) || null : null;
  const photo = c.photo_url || '';
  const ref = c.referral_code ? ('&ref=' + encodeURIComponent(c.referral_code)) : '';
  // own=1&coach= čte appka (localStorage mtl_owncoach_<id>, 60 dní): kdo přijde přes tuhle
  // stránku, je kouči vlastní -- akviziční provize se neúčtuje.
  const linkOwn = origin + '/?own=1&coach=' + encodeURIComponent(c.id) + ref;
  const discTxt = discs.map(discLabel).join(' · ');
  const title = (c.name || 'Kouč') + (discTxt ? (' · ' + discTxt) : '') + (c.city ? (' · ' + c.city) : '');
  const desc = (c.bio ? String(c.bio).slice(0, 160) : ((discTxt || 'Trenér') + (c.city ? (' v ' + c.city) : '')));
  const stats = [
    Number(c.years) > 0 ? [c.years, 'let praxe'] : null,
    Number(c.fights) > 0 ? [c.fights, 'zápasů'] : null,
    Number(c.lessons_done) > 0 ? [c.lessons_done, 'odučených lekcí'] : null,
  ].filter(Boolean);

  const html = `<!doctype html><html lang="cs"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="profile"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin + (c.slug ? ('/coach/' + c.slug) : ('/api/coach-public?coach=' + c.id)))}">
${photo ? `<meta property="og:image" content="${esc(photo)}">` : ''}
<meta name="twitter:card" content="${photo ? 'summary_large_image' : 'summary'}"><meta name="theme-color" content="#0c0c0c">
${FONTS}
<style>
:root{--gold:#F4D87A;--goldDim:rgba(244,216,122,.42);--ink:#141414;--mid:#575757;--light:#8f8f8f;--border:#ececec;--surf:#fafafa}
*{box-sizing:border-box}
body{margin:0;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--ink);background:#fff;line-height:1.55;-webkit-font-smoothing:antialiased;font-size:16px}
.hero{position:relative;background:radial-gradient(120% 80% at 50% 0%,#2a2200 0%,#0c0c0c 62%);padding:34px 20px 30px;text-align:center}
.heroIn{position:relative;max-width:620px;margin:0 auto}
.wordmark{font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:.18em;color:var(--gold);margin-bottom:20px}
.ava{width:132px;height:132px;border-radius:50%;object-fit:cover;border:3px solid var(--gold);display:block;margin:0 auto 14px;background:#222}
h1{font-family:'Bebas Neue',sans-serif;font-size:44px;line-height:1.02;letter-spacing:.015em;color:#fff;margin:0 0 8px}
.city{color:rgba(255,255,255,.62);font-size:14.5px}
.stars{margin-top:12px;color:var(--gold);font-weight:700;font-size:14.5px}.stars span{color:rgba(255,255,255,.45);font-weight:400}
.chips{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:16px}
.chip{background:rgba(244,216,122,.10);border:1px solid var(--goldDim);color:var(--gold);border-radius:20px;padding:5px 12px;font-size:12px;font-weight:700}
.stats{display:flex;justify-content:center;gap:22px;margin-top:18px}.st b{display:block;font-family:'Bebas Neue',sans-serif;font-size:28px;color:#fff;letter-spacing:.02em}.st span{font-size:11.5px;color:rgba(255,255,255,.55)}
.wrap{max-width:620px;margin:0 auto;padding:28px 20px 110px}
section{margin-bottom:30px}
h2{font-family:'Bebas Neue',sans-serif;font-size:23px;letter-spacing:.05em;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid var(--ink)}
.desc{color:var(--mid);white-space:pre-wrap;margin:0}
.prices .pr{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:11px 0;border-bottom:1px solid var(--border)}
.prices .pr small{display:block;color:var(--light);font-size:12.5px}
.prices .pr strong{white-space:nowrap;font-size:16px}
.clubs a{display:flex;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px solid var(--border);color:var(--ink);text-decoration:none;font-weight:600}
.clubs a span{color:var(--light);font-weight:400}
.cta{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.94);backdrop-filter:blur(12px);border-top:1px solid var(--border);padding:12px 20px calc(env(safe-area-inset-bottom,0px) + 12px)}
.cta a{display:block;max-width:580px;margin:0 auto;text-align:center;background:linear-gradient(135deg,#C9A227,#F4D87A);color:#241c00;text-decoration:none;padding:16px;border-radius:14px;font-weight:700;font-size:16.5px;box-shadow:0 4px 18px rgba(201,162,39,.28)}
@media(min-width:560px){h1{font-size:52px}.hero{padding:44px 20px 38px}}
</style></head><body>
<div class="hero"><div class="heroIn">
  <div class="wordmark">MARTIAL TRAINING LAB</div>
  ${photo ? `<img class="ava" src="${esc(photo)}" alt="">` : ''}
  <h1>${esc(c.name || 'Kouč')}</h1>
  ${c.city ? `<div class="city">${esc(c.city)}</div>` : ''}
  ${rating ? `<div class="stars">★ ${rating.toFixed(1)} <span>(${reviews})</span></div>` : ''}
  ${discs.length ? `<div class="chips">${discs.map((d) => `<span class="chip">${esc(discLabel(d))}</span>`).join('')}</div>` : ''}
  ${stats.length ? `<div class="stats">${stats.map((s) => `<div class="st"><b>${esc(s[0])}</b><span>${esc(s[1])}</span></div>`).join('')}</div>` : ''}
</div></div>
<div class="wrap">
  ${c.bio ? `<section><p class="desc">${esc(c.bio)}</p></section>` : ''}
  ${priceList('Osobní lekce', inRows)}
  ${c.inperson_desc ? `<section><p class="desc">${esc(c.inperson_desc)}</p></section>` : ''}
  ${priceList('Online koučink', onRows)}
  ${c.online_desc ? `<section><p class="desc">${esc(c.online_desc)}</p></section>` : ''}
  ${clubs.length ? `<section><h2>Kde trénuje</h2><div class="clubs">${clubs.map((g) => `<a href="${esc(origin + (g.slug ? ('/club/' + g.slug) : ('/api/club-public?club=' + g.id)))}">${esc(g.name)}<span>${esc(g.city || '')} ›</span></a>`).join('')}</div></section>` : ''}
  ${(!c.bio && !inRows.length && !onRows.length && !clubs.length) ? '<section><p class="desc">Tenhle kouč zatím nemá v MTL vyplněnou nabídku. Otevři si ho v aplikaci.</p></section>' : ''}
</div>
<div class="cta"><a href="${esc(linkOwn)}">Rezervovat v aplikaci MTL →</a></div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
  return res.status(200).send(html);
}
