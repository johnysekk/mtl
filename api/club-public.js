// /api/club-public — veřejná stránka klubu (?club=<id>), bez účtu a bez přihlášení.
//
// K čemu je: klub si ji dá do bia na Instagramu. Kdo na ni klikne, uvidí rozvrh, ceník a lidi
// kolem klubu, aniž by cokoli instaloval — a odkaz do appky, který nese ?own=1&club=<id>,
// takže se ten člověk připíše klubu, ne objevení přes MTL.
//
// Vrací HOTOVÉ HTML, ne JSON. Důvod je jediný: OG tagy. Odkaz vlepený do bia nebo do zprávy
// musí ukázat název, město a fotku — appka jako jednostránková aplikace to udělat neumí,
// protože robot Facebooku ani Instagramu nespustí JavaScript. Proto se stránka skládá tady.
//
// Veřejné je jen to, co klub sám vystavuje: název, město, disciplíny, popis, rozvrh, ceník,
// hodnocení a jména trenérů. Žádné kontakty na členy, žádné e-maily, žádná docházka.

const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbGet(path) {
  try {
    const r = await fetch(_SUPA + '/rest/v1/' + path, { headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY } });
    return r.ok ? await r.json() : [];
  } catch (e) { return []; }
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// gyms.photos je pole OBJEKTŮ {space,url} (viz showcasePhotos v index.html), ne pole stringů.
// Vložit objekt do src dá "[object Object]" -> rozbitý obrázek přes celou stránku.
// Starší řádky mohou nést holý string, takže bereme obojí a cokoli jiného zahodíme.
function photoUrl(p) {
  if (!p) return '';
  if (typeof p === 'string') return p;
  if (typeof p === 'object' && typeof p.url === 'string') return p.url;
  return '';
}

function parseJson(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

const DOW = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];

const DISC = {
  muay_thai: 'Muay Thai', bjj: 'Brazilské jiu-jitsu', mma: 'MMA', boxing: 'Box',
  kickboxing: 'Kickbox', judo: 'Judo', karate: 'Karate', wrestling: 'Zápas',
  taekwondo: 'Taekwondo', aikido: 'Aikido', kung_fu: 'Kung-fu', krav_maga: 'Krav Maga',
  sambo: 'Sambo', capoeira: 'Capoeira', grappling: 'Grappling'
};
function discLabel(d) { return DISC[d] || String(d || '').replace(/_/g, ' '); }

export default async function handler(req, res) {
  const id = (req.query && (req.query.club || req.query.id)) || '';
  const origin = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'app.martialtraininglab.com');

  if (!id) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send('<!doctype html><meta charset="utf-8"><p>Chybí klub.</p>');
  }

  // Vyjmenovat sloupce se nevyplatilo: stačí jeden, který se jinak jmenuje, a PostgREST
  // odmítne celý dotaz -- stránka pak vyjde prázdná a není vidět proč.
  const gr = await sbGet(`gyms?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  const g = gr && gr[0];
  if (!g) console.log('[club-public] klub nenalezen nebo dotaz selhal:', id);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  // Pozastavený nebo neexistující klub nedostane stránku. Ne kvůli utajení, ale proto, že
  // odkaz v biu, který ukazuje neaktivní klub, škodí klubu i MTL.
  if (!g || (g.status && g.status !== 'approved')) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(404).send(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Klub nenalezen · MTL</title>' +
      '<body style="font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;text-align:center;color:#333;">' +
      '<h1 style="font-size:20px;">Klub nenalezen</h1>' +
      '<p style="color:#777;line-height:1.6;">Odkaz může být starý, nebo klub v MTL momentálně není aktivní.</p>' +
      '<a href="' + esc(origin) + '" style="display:inline-block;margin-top:12px;padding:12px 20px;background:#141414;color:#fff;border-radius:12px;text-decoration:none;font-weight:700;">Otevřít MTL</a></body>'
    );
  }

  const photos = parseJson(g.photos, []) || [];
  const discs = parseJson(g.disciplines, []) || [];
  const schedule = parseJson(g.schedule, []) || [];
  const plans = parseJson(g.membership_plans, []) || [];
  const cur = g.currency || 'CZK';

  // Trenéři: jen ti, kteří u klubu opravdu jsou. Jméno a nic víc -- kontakty patří do appky,
  // ne na veřejnou stránku.
  let coaches = [];
  try {
    const links = await sbGet(`gym_coaches?gym_id=eq.${encodeURIComponent(id)}&status=eq.active&select=coach_id&limit=40`);
    const ids = [...new Set((links || []).map(l => l.coach_id).filter(Boolean))];
    if (g.owner_id) ids.push(g.owner_id);
    if (ids.length) {
      const profs = await sbGet(`profiles?id=in.(${ids.join(',')})&select=id,name,photo_url,disciplines&limit=40`);
      coaches = (profs || []).filter(p => p.name);
    }
  } catch (e) { /* stránka se ukáže i bez nich */ }

  console.log('[club-public]', g.id, 'fotky:', photos.length, 'rozvrh:', schedule.length,
              'plány:', plans.length, 'trenéři:', coaches.length, 'popis:', !!g.description);

  const linkOwn = origin + '/?own=1&club=' + encodeURIComponent(g.id);
  const title = (g.name || 'Klub') + (g.city ? (' · ' + g.city) : '');
  const discTxt = discs.map(discLabel).join(' · ');
  const desc = (g.description ? String(g.description).slice(0, 160)
              : (discTxt ? (discTxt + (g.city ? (' v ' + g.city) : '')) : 'Tréninky a rozvrh')) ;
  const hero = photoUrl(photos[0]);

  // ── rozvrh ────────────────────────────────────────────────────────────────────────────
  // Jedna položka rozvrhu může nést další termíny v extraSlots (stejná třída, jiný den).
  // Appka je rozbaluje; bez toho tu klub se dvěma skupinovkami ukáže jen tu první.
  const byDay = {};
  (schedule || []).forEach(c => {
    const slots = [{ day: c.day, time: c.time }];
    if (Array.isArray(c.extraSlots)) {
      c.extraSlots.forEach(x => { if (x && x.day != null && x.time) slots.push({ day: x.day, time: x.time }); });
    }
    slots.forEach(sl => {
      const d = Number(sl.day);
      if (isNaN(d)) return;
      (byDay[d] = byDay[d] || []).push({ time: sl.time, name: c.name, disc: c.disc, level: c.level });
    });
  });
  let schedHtml = '';
  [1, 2, 3, 4, 5, 6, 0].forEach(d => {
    const list = (byDay[d] || []).slice().sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    if (!list.length) return;
    schedHtml += '<div class="day"><h3>' + esc(DOW[d]) + '</h3>' +
      list.map(c =>
        '<div class="cls"><span class="t">' + esc(c.time || '') + '</span>' +
        '<span class="n">' + esc(c.name || 'Trénink') + '</span>' +
        (c.disc ? '<span class="d">' + esc(discLabel(c.disc)) + '</span>' : '') + '</div>'
      ).join('') + '</div>';
  });

  // ── ceník ─────────────────────────────────────────────────────────────────────────────
  let priceHtml = '';
  const priceRows = [];
  if (g.dropin_price) priceRows.push(['Jednorázový vstup', g.dropin_price]);
  (plans || []).forEach(p => {
    if (!p || !p.name || !p.price) return;
    const m = Number(p.months) || 1;
    const per = m === 1 ? ' / měsíc' : (' / ' + m + (m < 5 ? ' měsíce' : ' měsíců'));
    priceRows.push([p.name + per, p.price]);
  });
  if (priceRows.length) {
    priceHtml = '<section><h2>Ceník</h2><div class="prices">' +
      priceRows.map(r => '<div class="pr"><span>' + esc(r[0]) + '</span><strong>' + esc(r[1]) + ' ' + esc(cur) + '</strong></div>').join('') +
      '</div></section>';
  }

  // Počet hodnocení klub v řádku nenese -- spočítá se z gym_ratings.
  // gyms žádný sloupec s průměrem nenese -- appka si ho počítá z gym_ratings a my taky.
  let nRat = 0, _avg = null;
  try {
    const rr = await sbGet(`gym_ratings?gym_id=eq.${encodeURIComponent(id)}&select=rating&limit=500`);
    const vals = (rr || []).map(r => Number(r.rating)).filter(v => v > 0);
    nRat = vals.length;
    if (nRat) _avg = vals.reduce((a, b) => a + b, 0) / nRat;
  } catch (e) { /* hvězdičky nejsou povinné */ }
  const stars = (_avg && nRat > 0)
    ? ('<div class="stars">★ ' + Number(_avg).toFixed(1) + ' <span>(' + nRat + ' hodnocení)</span></div>')
    : '';

  const html =
`<!doctype html><html lang="cs"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin + '/api/club-public?club=' + g.id)}">
${hero ? `<meta property="og:image" content="${esc(hero)}">` : ''}
<meta name="twitter:card" content="${hero ? 'summary_large_image' : 'summary'}">
<style>
:root{--dark:#141414;--mid:#555;--light:#8a8a8a;--border:#e7e7e7;--surf:#fafafa;--red:#E23A3A}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;color:var(--dark);background:#fff;line-height:1.55}
.wrap{max-width:620px;margin:0 auto;padding:0 18px 100px}
.heroWrap{max-width:620px;margin:0 auto}
.hero{width:100%;aspect-ratio:16/9;max-height:44vh;object-fit:cover;display:block;background:var(--surf)}
h1{font-size:26px;margin:18px 0 4px;line-height:1.2}
.city{color:var(--light);font-size:15px;margin-bottom:10px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 4px}
.chip{background:var(--surf);border:1px solid var(--border);border-radius:999px;padding:5px 11px;font-size:12.5px;font-weight:600}
.stars{font-size:14px;font-weight:700;margin:8px 0 0}.stars span{color:var(--light);font-weight:400}
h2{font-size:17px;margin:28px 0 10px}
.desc{color:var(--mid);white-space:pre-wrap}
.day{margin-bottom:14px}
.day h3{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--light);margin:0 0 6px}
.cls{display:flex;gap:10px;align-items:baseline;padding:7px 0;border-bottom:1px solid var(--border)}
.cls .t{font-weight:700;min-width:52px}
.cls .n{flex:1}
.cls .d{color:var(--light);font-size:12.5px}
.prices .pr{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)}
.people{display:flex;flex-wrap:wrap;gap:14px;margin-top:6px}
.p{width:88px;text-align:center}
.p img,.p .ph{width:72px;height:72px;border-radius:50%;object-fit:cover;background:var(--surf);display:block;margin:0 auto 6px;border:1px solid var(--border)}
.p .ph{display:flex;align-items:center;justify-content:center;font-size:24px}
.p span{font-size:12.5px;font-weight:600;display:block;line-height:1.3}
.gal{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px}
.gal img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:var(--surf)}
.cta{position:fixed;left:0;right:0;bottom:0;background:#fff;border-top:1px solid var(--border);padding:12px 18px calc(env(safe-area-inset-bottom,0px) + 12px)}
.cta a{display:block;max-width:584px;margin:0 auto;text-align:center;background:var(--dark);color:#fff;text-decoration:none;padding:15px;border-radius:14px;font-weight:800;font-size:16px}
.empty{color:var(--mid);background:var(--surf);border:1px solid var(--border);border-radius:12px;padding:14px}
.foot{color:var(--light);font-size:12px;text-align:center;margin-top:30px}
.foot a{color:var(--light)}
</style></head><body>
${hero ? `<div class="heroWrap"><img class="hero" src="${esc(hero)}" alt="${esc(g.name || '')}"></div>` : ''}
<div class="wrap">
  <h1>${esc(g.name || 'Klub')}</h1>
  ${g.city ? `<div class="city">${esc(g.city)}${g.address ? (' · ' + esc(g.address)) : ''}</div>` : ''}
  ${stars}
  ${discs.length ? `<div class="chips">${discs.map(d => `<span class="chip">${esc(discLabel(d))}</span>`).join('')}</div>` : ''}
  ${g.description ? `<section><p class="desc">${esc(g.description)}</p></section>` : ''}
  ${(!schedHtml && !priceHtml && !coaches.length && !g.description) ? `<section><p class="empty">Tenhle klub zatím nemá v MTL vyplněný rozvrh, ceník ani trenéry. Otevři si ho v aplikaci.</p></section>` : ''}
  ${schedHtml ? `<section><h2>Rozvrh</h2>${schedHtml}</section>` : ''}
  ${priceHtml}
  ${coaches.length ? `<section><h2>Kdo tu trénuje</h2><div class="people">${coaches.map(c =>
      `<div class="p">${c.photo_url ? `<img src="${esc(c.photo_url)}" alt="">` : '<div class="ph">🥊</div>'}<span>${esc(c.name)}</span></div>`
    ).join('')}</div></section>` : ''}
  ${(function(){ const rest = photos.slice(1, 10).map(photoUrl).filter(Boolean); return rest.length ? `<section><h2>Fotky</h2><div class="gal">${rest.map(u => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}</div></section>` : ''; })()}
  <p class="foot">Rezervace, členství a docházku vede <a href="${esc(origin)}">Martial Training Lab</a>.</p>
</div>
<div class="cta"><a href="${esc(linkOwn)}">Rezervovat trénink →</a></div>
</body></html>`;

  // Krátká cache: rozvrh se mění, ale ne po vteřinách. Robot sociální sítě si stránku stáhne
  // jednou a pak ji drží sám.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
  return res.status(200).send(html);
}
