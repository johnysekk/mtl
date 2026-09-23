// /api/bug-shots-prune.js — ÚKLID SCREENSHOTŮ.
//
// Screenshot může nést jména členů i zdravotní poznámky. Text hlášení je k dohledání užitečný
// dlouho, obrázek ne -- u vyřešených se po 90 dnech maže, a s ním i cesta k němu.
// Běží týdně (vercel.json).

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON = process.env.CRON_SECRET;

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}) },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}

export default async function handler(req, res) {
  const auth = String(req.headers.authorization || '');
  if (CRON && auth !== `Bearer ${CRON}`) return res.status(401).json({ error: 'unauthorized' });
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });

  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  let removed = 0;
  try {
    const rows = await sb(`bug_reports?status=in.(done,wont)&shot_path=not.is.null&created_at=lt.${cutoff}&select=id,shot_path&limit=500`);
    for (const r of (rows || [])) {
      try {
        await fetch(`${SB}/storage/v1/object/bug-shots/${encodeURI(r.shot_path)}`, {
          method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
        });
        await sb(`bug_reports?id=eq.${r.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ shot_path: null }) });
        removed++;
      } catch (e) { /* jeden neúspěch nezastaví zbytek */ }
    }
    // OSIŘELÉ OBRÁZKY. Nahrání jde z prohlížeče přímo do bucketu, takže se dá nahrát soubor
    // a hlášení pak neodeslat -- ať omylem, nebo schválně. Co je starší než den a nepatří
    // k žádnému hlášení, jde pryč.
    let orphans = 0;
    try {
      const known = new Set(((await sb('bug_reports?select=shot_path&shot_path=not.is.null&limit=5000')) || []).map(r => r.shot_path));
      const lr = await fetch(`${SB}/storage/v1/object/list/bug-shots`, {
        method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit: 1000, sortBy: { column: 'created_at', order: 'asc' } }),
      });
      const folders = lr.ok ? await lr.json() : [];
      for (const f of (folders || [])) {
        const fr = await fetch(`${SB}/storage/v1/object/list/bug-shots`, {
          method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix: f.name, limit: 1000 }),
        });
        const files = fr.ok ? await fr.json() : [];
        for (const x of (files || [])) {
          const path = `${f.name}/${x.name}`;
          const age = Date.now() - new Date(x.created_at || 0).getTime();
          if (known.has(path) || age < 86400000) continue;
          await fetch(`${SB}/storage/v1/object/bug-shots/${encodeURI(path)}`, {
            method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
          });
          orphans++;
        }
      }
    } catch (e) { /* úklid osiřelých není důvod shodit zbytek */ }

    return res.status(200).json({ ok: true, removed, orphans });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
