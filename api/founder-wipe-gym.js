// /api/founder-wipe-gym.js — smaže klub KOMPLET: data i soubory.
//
// PROČ ENDPOINT A NE JEN SQL: SQL smaže záznam o souboru, ale samotný soubor v úložišti nechá.
// Zůstane sirotek, na kterého se zapomene a platí se za něj. Tady se nejdřív smažou soubory
// přes Storage API a pak data databázovou funkcí wipe_gyms (sql-53).
//
// POST { user_id, gym_ids: [...], confirm: 'SMAZAT' }
// Jen founder. Bez confirm nic nedělá.
//
// CO MAŽE:
//   • soubory: fotky klubu a zázemí, logo, merch, plakáty akcí a kurzů, nahrané podmínky,
//     loga sponzorů (bucket gym-photos i coach-photos)
//   • data: všechny tabulky se sloupcem gym_id, doklady k transakcím klubu, pak klub sám
// CO NEMAŽE:
//   • účty lidí (majitel ani kouči o profil nepřijdou)
//   • připojený účet u Stripe — ten patří poskytovateli, ruší se v Stripe Dashboardu

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const FOUNDER = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';

const sbGet = async (path) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
  return r.ok ? r.json() : [];
};

// Z URL na Storage vytáhne bucket a jméno souboru. Cokoli, co na Storage nevede
// (externí odkaz, prázdno), se ignoruje.
function parseStorageUrl(u) {
  try {
    const s = String(u || '');
    const m = s.match(/\/storage\/v1\/object\/(?:public\/)?([^/]+)\/(.+)$/);
    if (!m) return null;
    return { bucket: m[1], name: decodeURIComponent(m[2].split('?')[0]) };
  } catch (e) { return null; }
}

function pushUrls(acc, val) {
  try {
    if (!val) return;
    if (typeof val === 'string') {
      // Sloupec může být pole v JSONu uložené jako text, nebo prostě jedna URL.
      const t = val.trim();
      if (t.startsWith('[')) { try { JSON.parse(t).forEach((x) => pushUrls(acc, x)); return; } catch (e) {} }
      acc.push(t);
      return;
    }
    if (Array.isArray(val)) { val.forEach((x) => pushUrls(acc, x)); return; }
    if (typeof val === 'object') {
      // fotky klubu se ukládají i jako { url: ... }, sponzoři jako { logo: ... }
      ['url', 'logo', 'image_url', 'poster', 'src'].forEach((k) => { if (val[k]) pushUrls(acc, val[k]); });
    }
  } catch (e) {}
}

async function removeFiles(urls) {
  const byBucket = {};
  urls.forEach((u) => {
    const p = parseStorageUrl(u);
    if (!p) return;
    (byBucket[p.bucket] = byBucket[p.bucket] || []).push(p.name);
  });
  const out = {};
  for (const bucket of Object.keys(byBucket)) {
    const names = [...new Set(byBucket[bucket])];
    try {
      // Storage API maže po dávkách; 100 na jedno volání je bezpečné.
      let done = 0;
      for (let i = 0; i < names.length; i += 100) {
        const part = names.slice(i, i + 100);
        const r = await fetch(`${SB}/storage/v1/object/${encodeURIComponent(bucket)}`, {
          method: 'DELETE', headers: svc, body: JSON.stringify({ prefixes: part }),
        });
        if (r.ok) done += part.length;
        else out['chyba_' + bucket] = (await r.text()).slice(0, 200);
      }
      out[bucket] = done;
    } catch (e) { out['chyba_' + bucket] = (e && e.message) || 'error'; }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { user_id, gym_ids, confirm } = req.body || {};
    if (user_id !== FOUNDER) return res.status(403).json({ error: 'founder only' });
    if (confirm !== 'SMAZAT') return res.status(400).json({ error: 'chybi confirm: "SMAZAT"' });
    const ids = (Array.isArray(gym_ids) ? gym_ids : []).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'zadny gym_id' });

    const inList = ids.map((x) => `"${x}"`).join(',');

    // ── 1) POSBÍRAT SOUBORY ────────────────────────────────────────────────────────────
    // Dřív než zmizí řádky, jinak se z čeho brát URL nebude.
    const urls = [];
    try {
      const gg = await sbGet(`gyms?id=in.(${inList})&select=photos,facility_photos,brand_logo,terms_file_url,sponsors`);
      (gg || []).forEach((g) => { ['photos', 'facility_photos', 'brand_logo', 'terms_file_url', 'sponsors'].forEach((k) => pushUrls(urls, g[k])); });
    } catch (e) {}
    try {
      const mm = await sbGet(`gym_merch?gym_id=in.(${inList})&select=image_url`);
      (mm || []).forEach((m) => pushUrls(urls, m.image_url));
    } catch (e) {}
    try {
      const ev = await sbGet(`events?gym_id=in.(${inList})&select=poster`);
      (ev || []).forEach((e2) => pushUrls(urls, e2.poster));
    } catch (e) {}
    try {
      const ch = await sbGet(`gym_cohorts?gym_id=in.(${inList})&select=poster`);
      (ch || []).forEach((c) => pushUrls(urls, c.poster));
    } catch (e) {}

    // ── 2) SMAZAT SOUBORY ──────────────────────────────────────────────────────────────
    // Napřed soubory: když by selhalo mazání dat, aspoň se nehromadí sirotci. Obráceně
    // bychom po chybě v datech neměli z čeho URL zjistit.
    const files = await removeFiles(urls);

    // ── 3) SMAZAT DATA ─────────────────────────────────────────────────────────────────
    const r = await fetch(`${SB}/rest/v1/rpc/wipe_gyms`, {
      method: 'POST', headers: svc,
      body: JSON.stringify({ p_gyms: ids, p_delete_doklady: true }),
    });
    if (!r.ok) {
      const t = await r.text();
      return res.status(500).json({ error: 'wipe_gyms: ' + t.slice(0, 300), files, urls_found: urls.length });
    }
    const db = await r.json();

    return res.status(200).json({ ok: !!(db && db.ok), gyms: ids.length, files, urls_found: urls.length, db });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
