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
//
// VZHLED: hero přebírá jazyk sdíleného profilu (tmavý radiální přechod, zlatá #F4D87A,
// Bebas Neue + DM Sans). Obsah pod ním je ZÁMĚRNĚ světlý — sdílený profil je trofejní karta
// s pár řádky, tohle musí unést rozvrh na sedm dní a ceník, a ty se na tmavé čtou hůř.
// Kluby se odlišují fotkou a obsahem, ne nastavením barev: stránka je i výkladní skříň MTL
// a padesát různě barevných stránek by značku rozpustilo.

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

function addrLine(g) {
  const street = String((g && g.address) || '').trim();
  const zip = String((g && g.postal_code) || '').trim();
  const city = String((g && g.city) || '').trim();
  const has = (v) => v && street.toLowerCase().indexOf(v.toLowerCase()) >= 0;
  const tail = [has(zip) ? '' : zip, has(city) ? '' : city].filter(Boolean).join(' ');
  return [street, tail].filter(Boolean).join(', ');
}

const DOW = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];
const DOW3 = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];

const DISC = {
  muay_thai: 'Muay Thai', bjj: 'Brazilské jiu-jitsu', mma: 'MMA', boxing: 'Box',
  kickboxing: 'Kickbox', judo: 'Judo', karate: 'Karate', wrestling: 'Zápas',
  taekwondo: 'Taekwondo', aikido: 'Aikido', kung_fu: 'Kung-fu', krav_maga: 'Krav Maga',
  sambo: 'Sambo', capoeira: 'Capoeira', grappling: 'Grappling'
};
function discLabel(d) { return DISC[d] || String(d || '').replace(/_/g, ' '); }

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com">'
  + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">';

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
  // account_suspended patří do stejné podmínky: pozastavený klub je pro veřejnost stejně
  // neaktivní jako neschválený a odkaz v biu na něj nemá vést.
  if (!g || (g.status && g.status !== 'approved') || g.account_suspended) {
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(404).send(
      '<!doctype html><html lang="cs"><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">' + FONTS
      + '<title>Klub nenalezen \u00b7 MTL</title>'
      + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
      + 'background:radial-gradient(120% 80% at 50% 0%,#2a2200 0%,#0c0c0c 62%);font-family:\'DM Sans\',system-ui,sans-serif;">'
      + '<div style="text-align:center;padding:0 22px;max-width:420px;">'
      + '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:16px;letter-spacing:.18em;color:#F4D87A;margin-bottom:22px;">MARTIAL TRAINING LAB</div>'
      + '<h1 style="font-family:\'Bebas Neue\',sans-serif;font-size:36px;color:#fff;margin:0 0 10px;letter-spacing:.02em;">Klub nenalezen</h1>'
      + '<p style="color:rgba(255,255,255,.55);line-height:1.6;font-size:14.5px;margin:0 0 24px;">Odkaz m\u016f\u017ee b\u00fdt star\u00fd, nebo klub v MTL moment\u00e1ln\u011b nen\u00ed aktivn\u00ed.</p>'
      + '<a href="' + esc(origin) + '" style="display:inline-block;padding:14px 26px;background:linear-gradient(135deg,#C9A227,#F4D87A);color:#241c00;border-radius:12px;text-decoration:none;font-weight:700;font-size:15px;">Otev\u0159\u00edt MTL</a>'
      + '</div></body></html>'
    );
  }

  const photos = parseJson(g.photos, []) || [];
  const discs = parseJson(g.disciplines, []) || [];
  const schedule = parseJson(g.schedule, []) || [];
  const plans = parseJson(g.membership_plans, []) || [];
  const cur = g.currency || 'CZK';

  // Trenéři: jen ti, kteří u klubu opravdu jsou. Jméno a nic víc -- kontakty patří do appky,
  // ne na veřejnou stránku.
  let coaches = [], ownerRef = '';
  try {
    const links = await sbGet(`gym_coaches?gym_id=eq.${encodeURIComponent(id)}&status=eq.active&select=coach_id&limit=40`);
    const ids = [...new Set((links || []).map(l => l.coach_id).filter(Boolean))];
    if (g.owner_id) ids.push(g.owner_id);
    if (ids.length) {
      const profs = await sbGet(`profiles?id=in.(${ids.join(',')})&select=id,name,photo_url,disciplines,referral_code&limit=40`);
      coaches = (profs || []).filter(p => p.name);
      // Doporučovací kód MAJITELE. Nese ho tlačítko vedle own=1 (viz linkOwn níž).
      const _ow = (profs || []).find(p => p.id === g.owner_id);
      ownerRef = (_ow && _ow.referral_code) || '';
    }
  } catch (e) { /* stránka se ukáže i bez nich */ }

  // gyms žádný sloupec s průměrem nenese -- appka si ho počítá z gym_ratings a my taky.
  let nRat = 0, avg = null;
  try {
    const rr = await sbGet(`gym_ratings?gym_id=eq.${encodeURIComponent(id)}&select=rating&limit=500`);
    const vals = (rr || []).map(r => Number(r.rating)).filter(v => v > 0);
    nRat = vals.length;
    if (nRat) avg = vals.reduce((a, b) => a + b, 0) / nRat;
  } catch (e) { /* hvězdičky nejsou povinné */ }

  const hero = photoUrl(photos[0]);
  const gallery = photos.slice(1, 10).map(photoUrl).filter(Boolean);
  // KARUSEL místo jedné fotky v pozadí: na stránku vodíme reklamu a fotky z tréninku jsou
  // to jediné, co o klubu řekne víc než text. Bere se všechno, co klub nahrál.
  const slides = photos.slice(0, 10).map(photoUrl).filter(Boolean);

  // Napsané recenze. Hvězdičky samy o sobě nikoho nepřesvědčí, věta od člena ano.
  let reviews = [];
  try {
    const rv = await sbGet(`gym_ratings?gym_id=eq.${encodeURIComponent(id)}&select=rating,comment,student_name,created_at&order=created_at.desc&limit=30`);
    reviews = (rv || [])
      .filter(r => r && r.comment && String(r.comment).trim().length > 2)
      .slice(0, 6)
      .map(r => ({ rating: Number(r.rating) || 0, text: String(r.comment).trim().slice(0, 400), who: String(r.student_name || '').trim() }));
  } catch (e) { /* recenze nejsou povinné */ }

  console.log('[club-public]', g.id, 'fotky:', photos.length, 'rozvrh:', schedule.length,
              'plány:', plans.length, 'trenéři:', coaches.length, 'popis:', !!g.description);

  // DVA PARAMETRY, DVĚ NEZÁVISLÉ VĚTVE -- ověřeno proti index.html, nekolidují:
  //   own=1&club= čte showPaidPopup() na svém začátku -> localStorage mtl_owngym_<id>.
  //     Odpouští akviziční provizi (acq_source vyjde 'direct'), platí 60 dnů.
  //   ref=       čte samostatný blok dřív v souboru -> mtl_ref_pending + mtl_gym_ref.
  //     Při registraci nastaví profiles.referred_by; referral-cron pak přičte majiteli
  //     +1 do coach_ref_score, ale AŽ když z toho člověka vyroste aktivní poskytovatel
  //     (10 odučených soukromek nebo 25 aktivních členství).
  // Ani jeden blok query nemaže a _acqSrc() testuje own_link dřív než referral, takže
  // ref nemůže klubu sebrat odpuštění poplatku. Bez kódu se parametr prostě nepřidá.
  const linkOwn = origin + '/?own=1&club=' + encodeURIComponent(g.id)
                + (ownerRef ? ('&ref=' + encodeURIComponent(ownerRef)) : '');
  const title = (g.name || 'Klub') + (g.city ? (' \u00b7 ' + g.city) : '');
  const discTxt = discs.map(discLabel).join(' \u00b7 ');
  const desc = (g.description ? String(g.description).slice(0, 160)
              : (discTxt ? (discTxt + (g.city ? (' v ' + g.city) : '')) : 'Tréninky a rozvrh'));

  // ── rozvrh ────────────────────────────────────────────────────────────────────────────
  // Jedna položka rozvrhu může nést další termíny v extraSlots (stejná třída, jiný den).
  // Appka je rozbaluje; bez toho tu klub se dvěma skupinovkami ukáže jen tu první.
  const byDay = {};
  (schedule || []).forEach(c => {
    // Termíny lekce: pole `slots`, všechny si rovné. Starý tvar se už nečte.
    const slots = Array.isArray(c.slots)
      ? c.slots.filter(x => x && x.day != null && x.time).map(x => ({ day: x.day, time: x.time }))
      : [];
    slots.forEach(sl => {
      const d = Number(sl.day);
      if (isNaN(d)) return;
      (byDay[d] = byDay[d] || []).push({ time: sl.time, name: c.name, disc: c.disc });
    });
  });
  let schedHtml = '';
  [1, 2, 3, 4, 5, 6, 0].forEach(d => {
    const list = (byDay[d] || []).slice().sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    if (!list.length) return;
    schedHtml += '<div class="day"><div class="dh"><span class="dh3">' + esc(DOW3[d]) + '</span>' + esc(DOW[d]) + '</div>'
      + list.map(c =>
        '<div class="cls"><span class="t">' + esc(c.time || '') + '</span>'
        + '<span class="n">' + esc(c.name || 'Trénink') + '</span>'
        + (c.disc ? '<span class="d">' + esc(discLabel(c.disc)) + '</span>' : '') + '</div>'
      ).join('') + '</div>';
  });

  // ── ceník ─────────────────────────────────────────────────────────────────────────────
  const priceRows = [];
  if (g.dropin_price) priceRows.push(['Jednorázový vstup', g.dropin_price]);
  (plans || []).forEach(p => {
    if (!p || !p.name || !p.price) return;
    const m = Number(p.months) || 1;
    const per = m === 1 ? ' / měsíc' : (' / ' + m + (m < 5 ? ' měsíce' : ' měsíců'));
    priceRows.push([p.name + per, p.price]);
  });
  const priceHtml = priceRows.length
    ? '<section><h2>Ceník</h2><div class="prices">'
      + priceRows.map(r => '<div class="pr"><span>' + esc(r[0]) + '</span><strong>' + esc(r[1]) + ' ' + esc(cur) + '</strong></div>').join('')
      + '</div></section>'
    : '';

  const stars = (avg && nRat > 0)
    ? '<div class="stars">\u2605 ' + avg.toFixed(1) + ' <span>(' + nRat + ')</span></div>'
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
<meta name="theme-color" content="#0c0c0c">
${FONTS}
<style>
:root{--gold:#F4D87A;--goldDim:rgba(244,216,122,.42);--ink:#141414;--mid:#575757;--light:#8f8f8f;--border:#ececec;--surf:#fafafa}
*{box-sizing:border-box}
body{margin:0;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--ink);background:#fff;line-height:1.55;-webkit-font-smoothing:antialiased}
.hero{position:relative;background:radial-gradient(120% 80% at 50% 0%,#2a2200 0%,#0c0c0c 62%);padding:34px 20px 30px;text-align:center;overflow:hidden}
.heroBg{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.32}
.heroBg:after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(12,12,12,.42) 0%,rgba(12,12,12,.80) 68%,#0c0c0c 100%)}
.heroIn{position:relative;max-width:620px;margin:0 auto}
.wordmark{font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:.18em;color:var(--gold);margin-bottom:20px}
h1{font-family:'Bebas Neue',sans-serif;font-size:44px;line-height:1.02;letter-spacing:.015em;color:#fff;margin:0 0 8px;text-shadow:0 2px 18px rgba(0,0,0,.55)}
.city{color:rgba(255,255,255,.62);font-size:14.5px}
.stars{margin-top:12px;color:var(--gold);font-weight:700;font-size:14.5px}
.stars span{color:rgba(255,255,255,.45);font-weight:400}
.chips{display:flex;flex-wrap:wrap;gap:7px;justify-content:center;margin-top:16px}
.chip{background:rgba(244,216,122,.10);border:1px solid var(--goldDim);color:var(--gold);border-radius:20px;padding:5px 12px;font-size:12px;font-weight:700}
.wrap{max-width:620px;margin:0 auto;padding:28px 20px 110px}
section{margin-bottom:30px}
h2{font-family:'Bebas Neue',sans-serif;font-size:23px;letter-spacing:.05em;margin:0 0 12px;padding-bottom:8px;border-bottom:2px solid var(--ink)}
.desc{color:var(--mid);white-space:pre-wrap;margin:0}
.day{margin-bottom:16px}
.dh{display:flex;align-items:center;gap:8px;font-size:11.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--light);font-weight:700;margin-bottom:5px}
.dh3{background:var(--ink);color:var(--gold);border-radius:6px;padding:2px 7px;font-size:11px;letter-spacing:.04em}
.cls{display:flex;gap:12px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--border)}
.cls .t{font-weight:700;min-width:50px;font-variant-numeric:tabular-nums}
.cls .n{flex:1;font-weight:500}
.cls .d{color:var(--light);font-size:12.5px}
.prices .pr{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:11px 0;border-bottom:1px solid var(--border)}
.prices .pr strong{white-space:nowrap;font-size:16px}
.people{display:flex;flex-wrap:wrap;gap:16px}
.p{width:92px;text-align:center}
.p img,.p .ph{width:76px;height:76px;border-radius:50%;object-fit:cover;background:var(--surf);display:block;margin:0 auto 7px;border:2px solid var(--gold)}
.p .ph{display:flex;align-items:center;justify-content:center;font-size:26px}
.p span{font-size:12.5px;font-weight:600;display:block;line-height:1.3}
.gal{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}
.gal img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:12px;background:var(--surf)}
.empty{color:var(--mid);background:var(--surf);border:1px solid var(--border);border-radius:14px;padding:16px;margin:0}
.cta{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.94);backdrop-filter:blur(12px);border-top:1px solid var(--border);padding:12px 20px calc(env(safe-area-inset-bottom,0px) + 12px)}
.cta a{display:block;max-width:580px;margin:0 auto;text-align:center;background:linear-gradient(135deg,#C9A227,#F4D87A);color:#241c00;text-decoration:none;padding:16px;border-radius:14px;font-weight:700;font-size:16.5px;box-shadow:0 4px 18px rgba(201,162,39,.28)}
.mOv{position:fixed;inset:0;z-index:60;background:rgba(8,8,8,.66);backdrop-filter:blur(3px);display:none;align-items:flex-end;justify-content:center;padding:16px}
.mOv.on{display:flex}
.mCard{position:relative;width:100%;max-width:420px;background:radial-gradient(120% 90% at 50% 0%,#2a2200 0%,#0c0c0c 62%);border:1px solid rgba(244,216,122,.22);border-radius:20px;padding:26px 22px 22px;text-align:center;box-shadow:0 -8px 50px rgba(0,0,0,.5);animation:mUp .22s ease-out}
@keyframes mUp{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}
.mX{position:absolute;top:10px;right:12px;width:32px;height:32px;border:none;background:transparent;color:rgba(255,255,255,.45);font-size:22px;line-height:1;cursor:pointer;font-family:inherit}
.mWm{font-family:'Bebas Neue',sans-serif;font-size:13px;letter-spacing:.18em;color:var(--gold);margin-bottom:12px}
.mCard h3{font-family:'Bebas Neue',sans-serif;font-size:27px;letter-spacing:.02em;color:#fff;margin:0 0 8px;line-height:1.1}
.mCard p{color:rgba(255,255,255,.60);font-size:14px;line-height:1.55;margin:0 0 18px}
.mGo{display:block;background:linear-gradient(135deg,#C9A227,#F4D87A);color:#241c00;text-decoration:none;padding:15px;border-radius:13px;font-weight:700;font-size:16px}
.mAlt{display:block;margin-top:10px;color:rgba(255,255,255,.55);text-decoration:none;font-size:13.5px;font-weight:600;padding:9px}
/* KARUSEL. Vodorovný scroll s přichytáváním -- na mobilu se posouvá prstem, na počítači
   jsou k tomu šipky. Žádná knihovna, stránka pro reklamu musí být rychlá. */
.car{position:relative;background:#0c0c0c}
.carTrack{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;-ms-overflow-style:none}
.carTrack::-webkit-scrollbar{display:none}
.carSlide{flex:0 0 100%;scroll-snap-align:center}
.carSlide img{display:block;width:100%;height:clamp(240px,46vw,420px);object-fit:cover}
.carNav{position:absolute;top:50%;transform:translateY(-50%);width:38px;height:38px;border-radius:50%;border:none;background:rgba(0,0,0,.45);color:#fff;font-size:22px;line-height:1;cursor:pointer;display:none}
.carPrev{left:10px}.carNext{right:10px}
.carDots{position:absolute;bottom:10px;left:0;right:0;display:flex;justify-content:center;gap:6px}
.carDot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.45);cursor:pointer}
.carDot.on{background:var(--gold);width:18px;border-radius:99px}
@media(min-width:760px){.carNav{display:block}}
/* RECENZE */
.rev{border:1px solid var(--border);border-radius:14px;padding:13px 15px;margin-bottom:10px;background:var(--surf)}
.rev p{margin:0;font-size:14.5px;color:var(--ink);line-height:1.6}
.revStars{color:#C9A227;font-size:13px;letter-spacing:.08em;margin-bottom:6px}
.revWho{margin-top:8px;font-size:12.5px;color:var(--light);font-weight:600}
@media(min-width:560px){.mOv{align-items:center}}
@media(min-width:560px){h1{font-size:52px}.hero{padding:44px 20px 38px}}
</style></head><body>
<div class="hero">
  ${hero ? `<div class="heroBg" style="background-image:url('${esc(hero)}')"></div>` : ''}
  <div class="heroIn">
    <div class="wordmark">MARTIAL TRAINING LAB</div>
    <h1>${esc(g.name || 'Klub')}</h1>
    ${addrLine(g) ? `<div class="city">${esc(addrLine(g))}</div>` : ''}
    ${stars}
    ${discs.length ? `<div class="chips">${discs.map(d => `<span class="chip">${esc(discLabel(d))}</span>`).join('')}</div>` : ''}
  </div>
</div>
<div class="wrap">
  ${(!schedHtml && !priceHtml && !coaches.length && !g.description) ? `<section><p class="empty">Tenhle klub zatím nemá v MTL vyplněný rozvrh, ceník ani trenéry. Otevři si ho v aplikaci.</p></section>` : ''}
  ${g.description ? `<section><p class="desc">${esc(g.description)}</p></section>` : ''}
  ${schedHtml ? `<section><h2>Rozvrh</h2>${schedHtml}</section>` : ''}
  ${priceHtml}
  ${coaches.length ? `<section><h2>Trenéři</h2><div class="people">${coaches.map(c =>
      `<div class="p">${c.photo_url ? `<img src="${esc(c.photo_url)}" alt="">` : '<div class="ph">\u{1F94A}</div>'}<span>${esc(c.name)}</span></div>`
    ).join('')}</div></section>` : ''}
  ${gallery.length ? `<section><h2>Fotky</h2><div class="gal">${gallery.map(u => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}</div></section>` : ''}
  ${reviews.length ? `<section><h2>Co \u0159\u00edkaj\u00ed \u010dlenov\u00e9</h2>${reviews.map(r => `<div class="rev">${r.rating ? `<div class="revStars">${'\u2605'.repeat(Math.max(1, Math.min(5, Math.round(r.rating))))}</div>` : ''}<p>${esc(r.text)}</p>${r.who ? `<div class="revWho">${esc(r.who)}</div>` : ''}</div>`).join('')}</section>` : ''}
</div>
<div class="cta"><a id="bookBtn" href="${esc(linkOwn)}">Rezervovat trénink \u2192</a></div>

<div class="mOv" id="mOv" role="dialog" aria-modal="true" aria-labelledby="mTit">
  <div class="mCard">
    <button class="mX" id="mX" aria-label="Zavřít">\u00d7</button>
    <div class="mWm">MARTIAL TRAINING LAB</div>
    <h3 id="mTit">Rezervace přes MTL</h3>
    <p>Rozvrh, členství i platby ${esc(g.name || 'klubu')} běží v aplikaci MTL. Účet si vytvoříš zdarma a klub se ti rovnou uloží mezi oblíbené.</p>
    <a class="mGo" href="${esc(linkOwn)}">Vytvořit účet zdarma</a>
    <a class="mAlt" href="${esc(linkOwn)}">Už mám účet — přihlásit se</a>
  </div>
</div>

<script>
// Karusel: tečky, šipky a posun prstem. Bez knihovny.
(function(){
  var tr=document.getElementById('carTrack'); if(!tr) return;
  var dots=[].slice.call(document.querySelectorAll('.carDot'));
  var go=function(i){ var w=tr.clientWidth; tr.scrollTo({ left:i*w, behavior:'smooth' }); };
  var cur=function(){ return Math.round(tr.scrollLeft/Math.max(1,tr.clientWidth)); };
  tr.addEventListener('scroll', function(){
    var i=cur(); dots.forEach(function(d,k){ d.classList.toggle('on', k===i); });
  }, { passive:true });
  dots.forEach(function(d){ d.onclick=function(){ go(+d.dataset.i||0); }; });
  var p=document.getElementById('carPrev'), n=document.getElementById('carNext');
  if(p) p.onclick=function(){ go(Math.max(0, cur()-1)); };
  if(n) n.onclick=function(){ go(Math.min(dots.length-1, cur()+1)); };
})();

// Klik na Rezervovat nenaviguje pryč: otevře se okno nad stránkou klubu, která zůstane vidět.
// Odkaz v tlačítku zůstává platný, takže bez JavaScriptu (nebo při chybě) funguje po staru.
(function(){
  var b=document.getElementById('bookBtn'), o=document.getElementById('mOv'), x=document.getElementById('mX');
  if(!b||!o) return;
  var sy=0;
  function open(e){ if(e) e.preventDefault(); sy=window.scrollY; o.classList.add('on');
    document.body.style.position='fixed'; document.body.style.top=(-sy)+'px'; document.body.style.width='100%'; }
  function close(){ o.classList.remove('on');
    document.body.style.position=''; document.body.style.top=''; document.body.style.width=''; window.scrollTo(0,sy); }
  b.addEventListener('click', open);
  if(x) x.addEventListener('click', close);
  o.addEventListener('click', function(e){ if(e.target===o) close(); });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape' && o.classList.contains('on')) close(); });
})();
</script>
</body></html>`;

  // Krátká cache: rozvrh se mění, ale ne po vteřinách. Robot sociální sítě si stránku stáhne
  // jednou a pak ji drží sám.
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
  return res.status(200).send(html);
}
