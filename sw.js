// MTL — SERVICE WORKER: appka se otevře i bez internetu nebo při výpadku MTL.
//
// Co dělá:
//   • appka (jen hlavní stránka „/“): vždy nejdřív ze sítě (nová verze po nasazení se načte hned);
//     když síť vůbec neodpoví, otevře se poslední uložená verze. Jiné stránky (veřejný profil
//     klubu, sdílené odkazy, /api/…) se neukládají a neotvírají z paměti,
//   • vlastní skripty appky: ze sítě, offline z paměti (žádná stará verze vedle nové appky),
//   • knihovny z CDN, písma, obrázky: z paměti, na pozadí se obnoví,
//   • data z databáze (jen čtení): ze sítě; offline (nebo když MTL neodpovídá) poslední načtená
//     odpověď -- appka tak ukáže rezervace, rozvrh, permanentku, vstupenky a Kartu MTL s QR,
//   • zápisy (rezervace, platby, check-in…) se nikdy neukládají ani neodkládají -- offline selžou
//     a appka to řekne (proužek „Jsi offline").
// Uložená data patří přihlášenému: při odhlášení / jiném účtu je appka smaže ('mtl-clear-data').
// Platby (Stripe, Finbricks), API MTL (/api/*) a přihlašování se neukládají nikdy.
const VERSION = 'mtl-sw-2026-10-17b';
const SHELL = 'mtl-shell-' + VERSION;
const ASSETS = 'mtl-assets-' + VERSION;
const DATA = 'mtl-data-v1';
const IMG_MAX = 300, DATA_MAX = 600;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    try { await c.addAll(['/', '/manifest.json', '/doklad-layout.js', '/favicon-192.png']); } catch (err) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = [SHELL, ASSETS, DATA];
    for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'mtl-clear-data') e.waitUntil(caches.delete(DATA));
});

// Appce říct, že jede z uložených dat (proužek) / že je síť zpátky.
let offlineSaid = false;
async function tell(type) {
  if ((type === 'mtl-offline') === offlineSaid) return;
  offlineSaid = type === 'mtl-offline';
  for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type });
}
async function prune(c, max) {
  try { const ks = await c.keys(); if (ks.length > max) for (const k of ks.slice(0, ks.length - max)) await c.delete(k); } catch (err) {}
}
const fromCache = async (hit) => {
  const h = new Headers(hit.headers); h.set('x-mtl-offline', '1');
  return new Response(await hit.blob(), { status: hit.status, statusText: hit.statusText, headers: h });
};

// Síť má přednost. Uložená kopie jen když síť selže, nebo když neodpoví do `ms` a kopie existuje
// (pak se na síť dál čeká na pozadí a kopie se obnoví). Bez kopie se na síť čeká, ať trvá jak chce.
async function networkFirst(req, cacheName, ms, key, max) {
  const c = await caches.open(cacheName);
  const k = key || req;
  const net = fetch(req).then((res) => {
    if (res && res.ok) c.put(k, res.clone()).then(() => (max ? prune(c, max) : null)).catch(() => {});
    if (res && res.status < 500) tell('mtl-online');
    return res;
  });
  net.catch(() => {});
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve('slow'), ms); });
  try {
    const first = await Promise.race([net, slow]);
    clearTimeout(timer);
    if (first !== 'slow') return first;
    const hit = await c.match(k);
    if (hit) { tell('mtl-offline'); return fromCache(hit); }
    return await net;
  } catch (err) {
    clearTimeout(timer);
    const hit = await c.match(k);
    tell('mtl-offline');
    if (hit) return fromCache(hit);
    throw err;
  }
}
async function staleWhileRevalidate(req) {
  const c = await caches.open(ASSETS);
  const hit = await c.match(req);
  const net = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).then(() => prune(c, IMG_MAX)).catch(() => {});
    return res;
  }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // zápisy nikdy
  let url; try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') return;
  const same = url.origin === self.location.origin;

  // Nikdy z paměti: API MTL, platby, přihlášení, realtime.
  if (same && url.pathname.startsWith('/api/')) return;
  if (/stripe\.com|finbricks|google-analytics|googletagmanager|facebook/.test(url.hostname)) return;
  if (/\/auth\/v1\/|\/realtime\/v1\//.test(url.pathname)) return;

  // Appka: jen hlavní stránka. Ostatní navigace (veřejné stránky klubů, sdílené odkazy) běží
  // normálně ze sítě -- do paměti se nedostanou a appku nenahradí.
  if (req.mode === 'navigate') {
    if (same && (url.pathname === '/' || url.pathname === '/index.html')) {
      e.respondWith(networkFirst(req, SHELL, 15000, '/').catch(async () => (await caches.match('/')) || Response.error()));
    }
    return;
  }
  // Data z databáze (Supabase REST, jen čtení).
  if (/\.supabase\.co$/.test(url.hostname) && url.pathname.startsWith('/rest/v1/')) {
    e.respondWith(networkFirst(req, DATA, 10000, null, DATA_MAX));
    return;
  }
  // Vlastní skripty a styly appky: síť, offline z paměti.
  if (same && /\.(js|css|json)$/.test(url.pathname)) {
    e.respondWith(networkFirst(req, SHELL, 15000));
    return;
  }
  // Veřejné obrázky (fotky klubů a koučů), knihovny z CDN, písma, ikony.
  if ((/\.supabase\.co$/.test(url.hostname) && url.pathname.startsWith('/storage/v1/object/public/'))
      || /cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url.hostname)
      || (same && /\.(png|jpg|jpeg|webp|svg|ico|woff2?)$/.test(url.pathname))) {
    e.respondWith(staleWhileRevalidate(req));
  }
});
