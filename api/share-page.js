// /api/share-page — HEZKÉ ODKAZY NA KURZ A AKCI. V adrese je vždy pořadatel (vercel.json):
//   /club/<klub>/course/<kurz>, /club/<klub>/event/<akce>, /coach/<kouč>/event/<akce>,
//   /organization/<organizace>/event/<akce>
//
// Vrací malou HTML stránku s náhledem (OG tagy: název, termín, místo, cena, plakát) a člověka
// hned pošle na stávající přihlášku kurzu (/?cohort=<id>) nebo nákup lístků (/?event=<id>).
// Proč ne rovnou appka: robot Facebooku / Instagramu / WhatsAppu nespouští JavaScript, takže
// u odkazu na jednostránkovou appku ukáže jen obecné MTL. Přihláška ani nákup se tu nestaví
// podruhé.
//
// Adresy se tvoří automaticky z názvů a nemění se (sql/share-links.sql). Sledovací parametry
// z odkazu (src, utm_*, fbclid, gclid) jdou dál do appky, ať se zdroj přihlášky nepoztrácí.
const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const PASS = /^(src|fbclid|gclid|utm_[a-z]+)$/;

async function sbGet(path) {
  try { const r = await fetch(_SUPA + '/rest/v1/' + path, { headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY } }); return r.ok ? await r.json() : []; }
  catch (e) { return []; }
}
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const httpUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u)) ? u : '';
function photoOf(photos) {
  let p = photos; if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = []; } }
  const f = Array.isArray(p) ? p[0] : null;
  return httpUrl(typeof f === 'string' ? f : (f && f.url));
}
function money(v, cur, cs) {
  const n = Number(v); if (!(n > 0)) return '';
  try { return n.toLocaleString(cs ? 'cs-CZ' : 'en-GB', { maximumFractionDigits: 2 }) + ' ' + (String(cur || 'CZK').toUpperCase() === 'CZK' ? 'Kč' : String(cur).toUpperCase()); }
  catch (e) { return n + ' ' + cur; }
}
// Nejnižší cena: základní, nebo nejlevnější varianta.
function fromPrice(base, tiers) {
  let t = tiers; if (typeof t === 'string') { try { t = JSON.parse(t); } catch (e) { t = null; } }
  const all = [Number(base) || 0].concat(Array.isArray(t) ? t.map((x) => Number(x && x.price) || 0) : []).filter((x) => x > 0);
  return all.length ? Math.min.apply(null, all) : 0;
}
function day(d, cs) { try { return new Date(d).toLocaleDateString(cs ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Europe/Prague' }); } catch (e) { return ''; } }

function page(o) {
  return `<!doctype html><html lang="${o.cs ? 'cs' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Martial Training Lab">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.desc)}">
<meta property="og:url" content="${esc(o.canonical)}">
${o.image ? `<meta property="og:image" content="${esc(o.image)}">` : ''}
<meta name="twitter:card" content="${o.image ? 'summary_large_image' : 'summary'}">
<link rel="canonical" href="${esc(o.canonical)}">
<meta http-equiv="refresh" content="0;url=${esc(o.target)}">
<style>body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#0b0b0b;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}a{color:#F4D87A;font-weight:700}</style>
</head><body><div><div style="font-size:20px;font-weight:800;margin-bottom:8px;">${esc(o.title)}</div>
<a href="${esc(o.target)}">${o.cs ? 'Pokračovat' : 'Continue'} ›</a></div>
<script>location.replace(${JSON.stringify(o.target)});</script></body></html>`;
}

const OWNER = { club: { tbl: 'gyms', sel: 'id,slug,name,city,country,photos,owner_id' }, coach: { tbl: 'profiles', sel: 'id,slug,name,city,country,coach_status,referral_code' },
  organization: { tbl: 'organizations', sel: 'id,slug,name,owner_id' } };

// VLASTNÍ ODKAZ POŘADATELE -- stejně jako tlačítko na stránce klubu / kouče (club-public.js,
// coach-public.js): own=1&club= / own=1&coach= odpouští akviziční provizi (kdo přišel přes
// odkaz klubu, je jeho, ne akvizice MTL; appka -> localStorage mtl_owngym_ / mtl_owncoach_, 60 dní)
// a ref= je doporučovací kód majitele (Shikai / Bankai: mtl_ref_pending -> profiles.referred_by).
// Organizace own nemá (akviziční provize se jí netýká), jen ref majitele.
async function ownerParams(ok, own) {
  let ref = '';
  try {
    if (ok === 'coach') ref = own.referral_code || '';
    else if (own.owner_id) ref = ((await sbGet(`profiles?id=eq.${encodeURIComponent(own.owner_id)}&select=referral_code&limit=1`))[0] || {}).referral_code || '';
  } catch (e) {}
  const p = [];
  if (ok === 'club') p.push('own=1', 'club=' + encodeURIComponent(own.id));
  if (ok === 'coach') p.push('own=1', 'coach=' + encodeURIComponent(own.id));
  if (ref) p.push('ref=' + encodeURIComponent(ref));
  return p.join('&');
}

export default async function handler(req, res) {
  const q = req.query || {};
  const ok = String(q.ok || ''), owner = String(q.owner || '').toLowerCase(), kind = String(q.kind || ''), slug = String(q.slug || '').toLowerCase();
  const origin = 'https://' + (req.headers['x-forwarded-host'] || req.headers.host || 'app.martialtraininglab.com');
  const home = () => { res.setHeader('Cache-Control', 'public, max-age=60'); res.setHeader('Location', origin + '/'); return res.status(302).end(); };
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const valid = OWNER[ok] && SLUG_RE.test(owner) && SLUG_RE.test(slug) && (kind === 'event' || (kind === 'course' && ok === 'club'));
  if (!valid) return home();
  // Sledovací parametry dál do appky.
  const pass = Object.keys(q).filter((k) => PASS.test(k)).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(q[k]).slice(0, 200))).join('&');
  try {
    // Pořadatel podle adresy.
    const own = (await sbGet(`${OWNER[ok].tbl}?slug=eq.${encodeURIComponent(owner)}&select=${OWNER[ok].sel}&limit=1`))[0];
    if (!own) return home();
    let o = null;
    const ownQ = await ownerParams(ok, own);
    const tail = [ownQ, pass].filter(Boolean).join('&');
    const csOf = (country) => !country || ['CZ', 'SK'].includes(String(country).toUpperCase());
    if (kind === 'course') {
      const c = (await sbGet(`gym_cohorts?gym_id=eq.${encodeURIComponent(own.id)}&slug=eq.${encodeURIComponent(slug)}&select=id,name,start_date,price_regular,price_tiers,currency,description,poster&limit=1`))[0];
      if (c) {
        const cs = csOf(own.country);
        const price = money(fromPrice(c.price_regular, c.price_tiers), c.currency, cs);
        const bits = [own.name, own.city, c.start_date ? ((cs ? 'od ' : 'from ') + day(c.start_date, cs)) : '', price ? ((cs ? 'od ' : 'from ') + price + (cs ? ' / měs.' : ' / month')) : ''].filter(Boolean);
        o = { cs, title: c.name || (cs ? 'Kurz' : 'Course'),
          desc: bits.join(' · ') + (c.description ? (' — ' + String(c.description).replace(/\s+/g, ' ').slice(0, 160)) : ''),
          image: httpUrl(c.poster) || photoOf(own.photos),
          target: origin + '/?cohort=' + encodeURIComponent(c.id) + (tail ? '&' + tail : '') };
      }
    } else {
      // Akce pořadatele: organizace > klub > kouč (stejně jako jedinečnost adresy v databázi).
      const scope = ok === 'organization' ? `organization_id=eq.${own.id}`
        : ok === 'club' ? `gym_id=eq.${own.id}&organization_id=is.null`
        : `created_by=eq.${own.id}&gym_id=is.null&organization_id=is.null`;
      const e = (await sbGet(`events?${scope}&slug=eq.${encodeURIComponent(slug)}&select=id,title,description,poster,city,country,venue,starts_at,ticket_price,ticket_tiers,currency&limit=1`))[0];
      if (e) {
        const cs = csOf(e.country);
        const price = money(fromPrice(e.ticket_price, e.ticket_tiers), e.currency, cs);
        const bits = [own.name, e.starts_at ? day(e.starts_at, cs) : '', [e.venue, e.city].filter(Boolean).join(', '), price ? ((cs ? 'vstupenky od ' : 'tickets from ') + price) : ''].filter(Boolean);
        o = { cs, title: e.title || (cs ? 'Akce' : 'Event'),
          desc: bits.join(' · ') + (e.description ? (' — ' + String(e.description).replace(/\s+/g, ' ').slice(0, 160)) : ''),
          image: httpUrl(e.poster) || photoOf(own.photos),
          target: origin + '/?event=' + encodeURIComponent(e.id) + (tail ? '&' + tail : '') };
      }
    }
    // Kurz / akce nenalezena: na stránku pořadatele (klub / kouč), jinak do appky.
    if (!o) {
      if (ok === 'club' || ok === 'coach') { res.setHeader('Cache-Control', 'public, max-age=60'); res.setHeader('Location', origin + '/' + ok + '/' + own.slug); return res.status(302).end(); }
      return home();
    }
    o.canonical = origin + '/' + ok + '/' + own.slug + '/' + kind + '/' + slug;
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    return res.status(200).send(page(o));
  } catch (err) {
    console.error('[share-page]', err && err.message);
    return home();
  }
}
