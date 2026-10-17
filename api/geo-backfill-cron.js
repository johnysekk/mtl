// /api/geo-backfill-cron.js — doplní chybějící souřadnice klubům a organizacím.
//
// PROČ: klub bez zeměpisného bodu (city_lat/city_lng) nemá vzdálenost. Deck řadí podle
// vzdálenosti, takže takový klub propadá na konec a v „3 km od tebe" se vůbec neobjeví.
// Body se plní při zakládání z adresy, ale geokódování může selhat (OSM limity, výpadek).
// Dřív to zůstalo prázdné navždy; tenhle cron to dorovná bez zásahu člověka.
//
// Běží denně. Zpracuje nejvýš 20 záznamů za jeden běh, mezi dotazy sekunda pauzy --
// OSM to po nás chce a rychlost tady není potřeba. Poskytovatele map určuje _geo-provider.js.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
import { geoLocate } from './_geo-provider.js';
import { ccOf } from './_country.js';

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

export default async function handler(req, res) {
  // JEN VERCEL CRON. Bez tajného klíče by úlohu spustil kdokoli, kdo zná adresu.
  const _cron = (process.env.CRON_SECRET || '').trim();
  if (!_cron) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  if (String(req.headers.authorization || '') !== `Bearer ${_cron}`) return res.status(401).json({ error: 'unauthorized' });
  let done = 0, failed = 0;
  try {
    // Nejdřív přesná adresa, pak obec -- VŽDY uvnitř země klubu (cc je podmínka, ne nápověda).
    // Střed státu se nikdy neuloží: klub uprostřed země by rozbil všechny vzdálenosti a
    // upozornění v okolí. Bez nalezeného bodu klub počká, až majitel adresu opraví.
    const gyms = await sbGet('gyms?select=id,name,address,postal_code,city,country,country_code,billing_country'
      + '&deleted_at=is.null&city_lat=is.null&limit=20');

    for (const g of (gyms || [])) {
      const cc = ccOf(g.country_code || g.country || g.billing_country || '');
      if (!cc) { failed++; console.log('[geo-backfill] klub bez země:', g.id, g.name); continue; }
      let hit = null;
      try { hit = await geoLocate({ street: g.address, city: g.city, postal: g.postal_code, cc }); } catch (e) { console.error('[geo-backfill]', e.message); }
      await sleep(1100);
      if (!hit) { failed++; console.log('[geo-backfill] nenalezeno:', g.id, g.name); continue; }

      const ok = await sbPatch(`gyms?id=eq.${encodeURIComponent(g.id)}`, { city_lat: hit.lat, city_lng: hit.lng, geo_precision: hit.precision })
        || await sbPatch(`gyms?id=eq.${encodeURIComponent(g.id)}`, { city_lat: hit.lat, city_lng: hit.lng });
      if (ok) { done++; console.log('[geo-backfill] doplněno:', g.id, g.name, hit.lat, hit.lng, hit.precision); }
      else failed++;
    }

    // ORGANIZACE (hlavně dodavatelé -- řadí se podle vzdálenosti): bod z provozovny, bez vlastní
    // provozovny ze sídla. Dělí se o stejný strop 20 dotazů za běh; sloupce přidává org-geo.sql.
    const left = Math.max(0, 20 - (gyms || []).length);
    const orgs = left ? await sbGet('organizations?select=id,name,address,billing_line1,billing_city,city,billing_country,country'
      + '&city_lat=is.null&city=not.is.null&limit=' + left) : [];
    for (const o of (orgs || [])) {
      const cc = ccOf(o.billing_country || o.country || '');
      const city = (o.address ? o.city : (o.billing_city || o.city)) || '';
      const street = o.address || o.billing_line1 || '';
      if (!cc) { failed++; continue; }
      let hit = null;
      try { hit = await geoLocate({ street, city, cc }); } catch (e) { console.error('[geo-backfill] org', e.message); }
      await sleep(1100);
      if (!hit) { failed++; console.log('[geo-backfill] org nenalezena:', o.id, o.name); continue; }
      const ok = await sbPatch(`organizations?id=eq.${encodeURIComponent(o.id)}`, { city_lat: hit.lat, city_lng: hit.lng, geo_precision: hit.precision })
        || await sbPatch(`organizations?id=eq.${encodeURIComponent(o.id)}`, { city_lat: hit.lat, city_lng: hit.lng });
      if (ok) { done++; console.log('[geo-backfill] org doplněna:', o.id, o.name, hit.lat, hit.lng); }
      else failed++;
    }

    return res.status(200).json({ ok: true, checked: (gyms || []).length + (orgs || []).length, done, failed });
  } catch (e) {
    console.error('[geo-backfill]', (e && e.message) || e);
    return res.status(500).json({ error: (e && e.message) || 'error', done, failed });
  }
}
