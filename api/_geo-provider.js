// GEOKÓDOVÁNÍ — JEDNO MÍSTO PRO VŠECHNY POSKYTOVATELE MAP.
//
// Appka i servery se ptají jen tady (search = text → místa, reverse = bod → místo). Kdo
// odpovídá, určuje proměnná prostředí GEO_PROVIDER:
//   nominatim  (výchozí, zdarma)  -- OpenStreetMap. Limit 1 dotaz/s, jen pro malý provoz.
//   locationiq (LOCATIONIQ_KEY)   -- placený OSM, stejná data a formát, bez limitu 1/s.
//   mapbox     (MAPBOX_TOKEN)     -- placený. Ukládat souřadnice smí jen s „permanent"
//                                    geokódováním: MAPBOX_PERMANENT=1 (jinak podmínky Mapboxu
//                                    ukládání nedovolují).
//   google     (GOOGLE_GEO_KEY)   -- placený (Geocoding API). Podmínky Googlu ukládání
//                                    výsledků omezují -- před přepnutím ověřit smlouvu.
// Odpověď je VŽDY ve stejném tvaru (tvar Nominatimu, na který je appka stavěná), plus:
//   precision: 'address' | 'street' | 'district' | 'postcode' | 'city' | 'region' | 'country'
//   provider:  kdo odpověděl
// Země je vždy TVRDÁ PODMÍNKA (cc), ne nápověda: co v ní není, se nevrátí. Kdyby poskytovatel
// přesto vrátil něco jinde, vyhodí se to tady (_ccOk).

const UA = process.env.GEO_USER_AGENT
  || 'MartialTrainingLab/1.0 (+https://app.martialtraininglab.com; info@martialtraininglab.com)';
const PROVIDER = String(process.env.GEO_PROVIDER || 'nominatim').trim().toLowerCase();

export function providerName() {
  if (PROVIDER === 'locationiq' && process.env.LOCATIONIQ_KEY) return 'locationiq';
  if (PROVIDER === 'mapbox' && process.env.MAPBOX_TOKEN) return 'mapbox';
  if (PROVIDER === 'google' && process.env.GOOGLE_GEO_KEY) return 'google';
  return 'nominatim';
}

// Nominatim: nejvýš 1 dotaz za sekundu z jedné instance (podmínky OSM).
let _lastNom = 0;
async function nomThrottle() {
  const wait = _lastNom + 1050 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastNom = Date.now();
}

const DISTRICT = ['suburb', 'city_district', 'district', 'borough', 'quarter', 'neighbourhood', 'neighborhood'];
const CITY = ['city', 'town', 'village', 'hamlet', 'municipality'];

// Přesnost z odpovědi ve tvaru Nominatimu.
function nomPrecision(x) {
  const a = (x && x.address) || {};
  const t = String((x && (x.addresstype || x.type)) || '').toLowerCase();
  if (a.house_number) return 'address';
  if (t === 'country') return 'country';
  if (['state', 'region', 'county', 'province'].includes(t)) return 'region';
  if (t === 'postcode') return 'postcode';
  if (DISTRICT.includes(t)) return 'district';
  if (CITY.includes(t) || (t === 'administrative' && CITY.some((k) => a[k]) && !a.road)) return 'city';
  if (a.road || a.pedestrian || a.footway || t === 'road' || t === 'street') return 'street';
  if (CITY.some((k) => a[k])) return 'city';
  return 'region';
}

const _ccOk = (row, cc) => {
  if (!cc) return true;
  const want = String(cc).toLowerCase().split(',').filter(Boolean);
  const got = String((row.address && row.address.country_code) || '').toLowerCase();
  return !got || want.includes(got);
};

// ── Nominatim / LocationIQ (stejný formát) ────────────────────────────────────────────
async function osmSearch(q, o, base, key) {
  const p = new URLSearchParams({ format: 'json', addressdetails: '1', limit: String(o.limit), 'accept-language': o.lang, q });
  if (o.cc) p.set('countrycodes', o.cc);
  if (o.kind === 'place') p.set('featureType', 'settlement');
  if (key) p.set('key', key);
  if (!key) await nomThrottle();
  const r = await fetch(`${base}/search?${p}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) { const e = new Error('geocoder_unavailable'); e.status = r.status; throw e; }
  const d = await r.json();
  return (Array.isArray(d) ? d : []).map((x) => ({
    display_name: x.display_name, lat: x.lat, lon: x.lon, boundingbox: x.boundingbox || null,
    address: x.address || {}, type: x.addresstype || x.type, class: x.class, precision: nomPrecision(x),
  }));
}
async function osmReverse(lat, lon, o, base, key) {
  const p = new URLSearchParams({ format: 'json', addressdetails: '1', zoom: String(o.zoom), 'accept-language': o.lang, lat: String(lat), lon: String(lon) });
  if (key) p.set('key', key);
  if (!key) await nomThrottle();
  const r = await fetch(`${base}/reverse?${p}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) { const e = new Error('geocoder_unavailable'); e.status = r.status; throw e; }
  const d = await r.json();
  return { display_name: d && d.display_name, address: (d && d.address) || {}, lat, lon, precision: nomPrecision(d || {}) };
}

// ── Našeptávání míst (obce, části obcí) při psaní ────────────────────────────────────
// Nominatim prefix neumí: „Brno-stř" nenajde nic, „Brno-střed" ano. Pro našeptávač míst se
// proto bere služba, která píšícímu rozumí:
//   * nominatim (zdarma)  -> Photon (photon.komoot.io, OpenStreetMap, zdarma, férové užití),
//   * locationiq          -> LocationIQ Autocomplete,
//   * mapbox              -> Mapbox umí sám (autocomplete=true),
//   * google              -> Geocoding (bez prefixu; pro našeptávač by chtělo Places API).
const PH_PREC = { city: 'city', district: 'district', locality: 'district', county: 'region', state: 'region', country: 'country', street: 'street', house: 'address' };
async function photonPlaces(q, o) {
  const p = new URLSearchParams({ q, limit: String(Math.min(20, o.limit * 3)) });
  ['city', 'district', 'locality'].forEach((l) => p.append('layer', l));
  if (['en', 'de', 'fr', 'it'].includes(o.lang)) p.set('lang', o.lang);
  // Bez filtru země u Photonu: přednost dostanou místa blízko člověka, cizí země se vyřadí níž.
  if (o.near) { p.set('lat', String(o.near.lat)); p.set('lon', String(o.near.lng)); }
  const r = await fetch(`https://photon.komoot.io/api/?${p}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) { const e = new Error('geocoder_unavailable'); e.status = r.status; throw e; }
  const d = await r.json();
  return ((d && d.features) || []).map((f) => {
    const pr = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [];
    const t = String(pr.type || '').toLowerCase();
    const isCity = t === 'city';
    const address = { suburb: isCity ? (pr.district || undefined) : pr.name, city: isCity ? pr.name : (pr.city || pr.county || undefined),
      state: pr.state || undefined, county: pr.county || undefined, country: pr.country || undefined,
      country_code: String(pr.countrycode || '').toLowerCase() || undefined };
    const ex = pr.extent;
    return { display_name: [pr.name, isCity ? null : pr.city, pr.state, pr.country].filter(Boolean).join(', '), lat: String(c[1]), lon: String(c[0]),
      boundingbox: ex ? [String(ex[3]), String(ex[1]), String(ex[0]), String(ex[2])] : null, address, type: t, class: 'photon', precision: PH_PREC[t] || 'city' };
  });
}
async function liqAutocomplete(q, o) {
  const p = new URLSearchParams({ key: process.env.LOCATIONIQ_KEY, q, limit: String(Math.min(20, o.limit)), 'accept-language': o.lang, dedupe: '1',
    tag: 'place:city,place:town,place:village,place:hamlet,place:suburb,place:quarter,place:neighbourhood,place:borough' });
  if (o.cc) p.set('countrycodes', o.cc);
  const r = await fetch(`https://api.locationiq.com/v1/autocomplete?${p}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) { const e = new Error('geocoder_unavailable'); e.status = r.status; throw e; }
  const d = await r.json();
  return (Array.isArray(d) ? d : []).map((x) => {
    const a = Object.assign({}, x.address || {});
    if (DISTRICT.includes(String(x.type || '')) && a.name && !a.suburb) a.suburb = a.name;
    if (CITY.includes(String(x.type || '')) && a.name && !a.city) a.city = a.name;
    return { display_name: x.display_name, lat: x.lat, lon: x.lon, boundingbox: x.boundingbox || null, address: a, type: x.type, class: x.class, precision: nomPrecision({ address: a, type: x.type }) };
  });
}

// ── Mapbox Geocoding v6 ───────────────────────────────────────────────────────────────
const MB_PREC = { address: 'address', street: 'street', neighborhood: 'district', locality: 'district', district: 'region',
  postcode: 'postcode', place: 'city', region: 'region', country: 'country' };
function mbToNom(f) {
  const pr = f.properties || {}, c = pr.context || {};
  const coords = (f.geometry && f.geometry.coordinates) || [pr.coordinates && pr.coordinates.longitude, pr.coordinates && pr.coordinates.latitude];
  const address = {
    house_number: (c.address && c.address.address_number) || undefined,
    road: (c.street && c.street.name) || (c.address && c.address.street_name) || undefined,
    suburb: (c.neighborhood && c.neighborhood.name) || (c.locality && c.locality.name) || undefined,
    city: (c.place && c.place.name) || undefined,
    postcode: (c.postcode && c.postcode.name) || undefined,
    state: (c.region && c.region.name) || undefined,
    country: (c.country && c.country.name) || undefined,
    country_code: String((c.country && (c.country.country_code || c.country.country_code_alpha_3)) || '').slice(0, 2).toLowerCase() || undefined,
  };
  if (pr.feature_type === 'place' && !address.city) address.city = pr.name;
  const bb = pr.bbox || f.bbox;
  return { display_name: pr.full_address || [pr.name, pr.place_formatted].filter(Boolean).join(', '),
    lat: String(coords[1]), lon: String(coords[0]), boundingbox: bb ? [String(bb[1]), String(bb[3]), String(bb[0]), String(bb[2])] : null,
    address, type: pr.feature_type, class: 'mapbox', precision: MB_PREC[pr.feature_type] || 'region' };
}
async function mbSearch(q, o) {
  const p = new URLSearchParams({ q, access_token: process.env.MAPBOX_TOKEN, limit: String(Math.min(10, o.limit)), language: o.lang, autocomplete: 'true' });
  if (o.cc) p.set('country', o.cc);
  if (o.kind === 'place') p.set('types', 'place,locality,neighborhood,postcode');
  if (process.env.MAPBOX_PERMANENT === '1') p.set('permanent', 'true');
  const r = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${p}`);
  if (!r.ok) { const e = new Error('geocoder_unavailable'); e.status = r.status; throw e; }
  const d = await r.json();
  return ((d && d.features) || []).map(mbToNom);
}
async function mbReverse(lat, lon, o) {
  const p = new URLSearchParams({ longitude: String(lon), latitude: String(lat), access_token: process.env.MAPBOX_TOKEN, language: o.lang, limit: '1' });
  if (o.zoom <= 6) p.set('types', 'country,region'); else if (o.zoom <= 12) p.set('types', 'place,locality,neighborhood');
  if (process.env.MAPBOX_PERMANENT === '1') p.set('permanent', 'true');
  const r = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?${p}`);
  if (!r.ok) { const e = new Error('geocoder_unavailable'); e.status = r.status; throw e; }
  const d = await r.json();
  const f = ((d && d.features) || [])[0];
  if (!f) return { display_name: null, address: {}, lat, lon, precision: null };
  const x = mbToNom(f);
  return { display_name: x.display_name, address: x.address, lat, lon, precision: x.precision };
}

// ── Google Geocoding API ──────────────────────────────────────────────────────────────
function gToNom(g) {
  const pick = (t, short) => { const c = (g.address_components || []).find((x) => (x.types || []).includes(t)); return c ? (short ? c.short_name : c.long_name) : undefined; };
  const types = g.types || [];
  const address = {
    house_number: pick('street_number'), road: pick('route'),
    suburb: pick('sublocality') || pick('sublocality_level_1') || pick('neighborhood'),
    city: pick('locality') || pick('postal_town') || pick('administrative_area_level_2'),
    postcode: pick('postal_code'), state: pick('administrative_area_level_1'),
    country: pick('country'), country_code: String(pick('country', true) || '').toLowerCase() || undefined,
  };
  const prec = types.includes('street_address') || types.includes('premise') || address.house_number ? 'address'
    : types.includes('route') ? 'street'
      : (types.includes('sublocality') || types.includes('neighborhood')) ? 'district'
        : types.includes('postal_code') ? 'postcode'
          : types.includes('locality') ? 'city'
            : types.includes('country') ? 'country' : 'region';
  const v = (g.geometry && (g.geometry.bounds || g.geometry.viewport)) || null;
  return { display_name: g.formatted_address, lat: String(g.geometry.location.lat), lon: String(g.geometry.location.lng),
    boundingbox: v ? [String(v.southwest.lat), String(v.northeast.lat), String(v.southwest.lng), String(v.northeast.lng)] : null,
    address, type: types[0], class: 'google', precision: prec };
}
async function gSearch(q, o) {
  const p = new URLSearchParams({ address: q, key: process.env.GOOGLE_GEO_KEY, language: o.lang });
  if (o.cc) p.set('components', o.cc.split(',').map((c) => 'country:' + c.toUpperCase()).join('|'));
  const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${p}`);
  if (!r.ok) { const e = new Error('geocoder_unavailable'); e.status = r.status; throw e; }
  const d = await r.json();
  if (d.status && !['OK', 'ZERO_RESULTS'].includes(d.status)) { const e = new Error('geocoder_unavailable'); e.status = 502; throw e; }
  return ((d && d.results) || []).slice(0, o.limit).map(gToNom);
}
async function gReverse(lat, lon, o) {
  const p = new URLSearchParams({ latlng: `${lat},${lon}`, key: process.env.GOOGLE_GEO_KEY, language: o.lang });
  if (o.zoom <= 6) p.set('result_type', 'country'); else if (o.zoom <= 12) p.set('result_type', 'locality|sublocality');
  const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${p}`);
  if (!r.ok) { const e = new Error('geocoder_unavailable'); e.status = r.status; throw e; }
  const d = await r.json();
  const g = ((d && d.results) || [])[0];
  if (!g) return { display_name: null, address: {}, lat, lon, precision: null };
  const x = gToNom(g);
  return { display_name: x.display_name, address: x.address, lat, lon, precision: x.precision };
}

// ── Veřejné funkce ────────────────────────────────────────────────────────────────────
// o: { cc:'cz' | 'cz,sk', lang:'cs', limit:1..12, kind:'address'|'place'|null }
export async function geoSearch(q, o = {}) {
  const opt = { cc: String(o.cc || '').toLowerCase().replace(/[^a-z,]/g, '').slice(0, 64), lang: String(o.lang || 'cs').slice(0, 5),
    limit: Math.max(1, Math.min(12, parseInt(o.limit, 10) || 8)), kind: o.kind || null,
    near: (o.near && isFinite(+o.near.lat) && isFinite(+o.near.lng)) ? { lat: Math.round(+o.near.lat * 100) / 100, lng: Math.round(+o.near.lng * 100) / 100 } : null };
  const p = providerName();
  let rows;
  // Našeptávač míst: služba s vyhledáváním podle začátku slova; když selže, běžné hledání.
  if (opt.kind === 'place' && (p === 'nominatim' || p === 'locationiq') && process.env.GEO_PLACE_AUTOCOMPLETE !== 'off') {
    try {
      const ac = p === 'locationiq' ? await liqAutocomplete(q, opt) : await photonPlaces(q, opt);
      const ok = ac.filter((x) => _ccOk(x, opt.cc) && isFinite(parseFloat(x.lat)) && isFinite(parseFloat(x.lon))).slice(0, opt.limit);
      if (ok.length) return ok.map((x) => Object.assign(x, { provider: p === 'locationiq' ? 'locationiq' : 'photon' }));
    } catch (e) { console.error('[geo] autocomplete', e.status || '', e.message); }
  }
  if (p === 'mapbox') rows = await mbSearch(q, opt);
  else if (p === 'google') rows = await gSearch(q, opt);
  else if (p === 'locationiq') rows = await osmSearch(q, opt, 'https://us1.locationiq.com/v1', process.env.LOCATIONIQ_KEY);
  else rows = await osmSearch(q, opt, 'https://nominatim.openstreetmap.org', null);
  return rows.filter((x) => _ccOk(x, opt.cc) && isFinite(parseFloat(x.lat)) && isFinite(parseFloat(x.lon))).map((x) => Object.assign(x, { provider: p }));
}
export async function geoReverse(lat, lon, o = {}) {
  const opt = { lang: String(o.lang || 'cs').slice(0, 5), zoom: Math.max(3, Math.min(18, parseInt(o.zoom, 10) || 10)) };
  const p = providerName();
  let out;
  if (p === 'mapbox') out = await mbReverse(lat, lon, opt);
  else if (p === 'google') out = await gReverse(lat, lon, opt);
  else if (p === 'locationiq') out = await osmReverse(lat, lon, opt, 'https://us1.locationiq.com/v1', process.env.LOCATIONIQ_KEY);
  else out = await osmReverse(lat, lon, opt, 'https://nominatim.openstreetmap.org', null);
  return Object.assign(out, { provider: p });
}
// Bod pro adresu / město v dané zemi: nejdřív přesná adresa, pak město. NIKDY střed státu --
// klub uprostřed země by rozbil všechny vzdálenosti. Vrací null, když nic nesedí.
export async function geoLocate({ street, city, postal, cc, lang }) {
  const tries = [];
  if (street && city) tries.push([[street, postal, city].filter(Boolean).join(', '), 'address']);
  if (city) tries.push([[postal, city].filter(Boolean).join(' '), 'place']);
  for (const [q, kind] of tries) {
    const rows = await geoSearch(q, { cc, lang, limit: 1, kind: kind === 'place' ? 'place' : null });
    const x = rows[0];
    if (x && x.precision !== 'country' && x.precision !== 'region') {
      return { lat: parseFloat(x.lat), lng: parseFloat(x.lon), precision: x.precision, cc: String((x.address && x.address.country_code) || cc || '').toUpperCase() || null, provider: x.provider };
    }
  }
  return null;
}
export function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371, toR = (x) => x * Math.PI / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
