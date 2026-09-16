// /api/geo-backfill-cron.js — doplní chybějící souřadnice klubům a akcím.
//
// PROČ: klub bez zeměpisného bodu (city_lat/city_lng) nemá vzdálenost. Deck řadí podle
// vzdálenosti, takže takový klub propadá na konec a v „3 km od tebe" se vůbec neobjeví.
// Body se plní při zakládání z adresy, ale geokódování může selhat (OSM limity, výpadek).
// Dřív to zůstalo prázdné navždy; tenhle cron to dorovná bez zásahu člověka.
//
// Běží denně. Zpracuje nejvýš 20 záznamů za jeden běh, mezi dotazy sekunda pauzy --
// OSM to po nás chce a rychlost tady není potřeba.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const UA = process.env.GEO_USER_AGENT
  || 'MartialTrainingLab/1.0 (+https://app.martialtraininglab.com; info@martialtraininglab.com)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sbGet = async (path) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
  return r.ok ? r.json() : [];
};
const sbPatch = async (path, body) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(body),
  });
  return r.ok;
};

async function geocode(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) { console.error('[geo-backfill] nominatim', r.status, q.slice(0, 60)); return null; }
  const d = await r.json();
  if (!Array.isArray(d) || !d.length) return null;
  const lat = parseFloat(d[0].lat), lng = parseFloat(d[0].lon);
  return (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null;
}

export default async function handler(req, res) {
  let done = 0, failed = 0;
  try {
    // Nejdřív adresa, pak město, pak jen země: čím přesnější, tím lepší, ale i hrubý bod
    // je lepší než žádný -- s ním klub aspoň existuje na mapě a v řazení.
    const gyms = await sbGet('gyms?select=id,name,address,city,country,country_code'
      + '&deleted_at=is.null&city_lat=is.null&limit=20');

    for (const g of (gyms || [])) {
      const tries = [
        [g.address, g.city, g.country].filter(Boolean).join(', '),
        [g.city, g.country].filter(Boolean).join(', '),
        g.country || '',
      ].filter((x) => x && x.length > 2);

      let hit = null;
      for (const q of tries) {
        hit = await geocode(q);
        await sleep(1000);
        if (hit) break;
      }
      if (!hit) { failed++; console.log('[geo-backfill] nenalezeno:', g.id, g.name); continue; }

      const ok = await sbPatch(`gyms?id=eq.${encodeURIComponent(g.id)}`, { city_lat: hit.lat, city_lng: hit.lng });
      if (ok) { done++; console.log('[geo-backfill] doplněno:', g.id, g.name, hit.lat, hit.lng); }
      else failed++;
    }

    return res.status(200).json({ ok: true, checked: (gyms || []).length, done, failed });
  } catch (e) {
    console.error('[geo-backfill]', (e && e.message) || e);
    return res.status(500).json({ error: (e && e.message) || 'error', done, failed });
  }
}
