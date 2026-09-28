// /api/media-prune-cron.js — ÚKLID ÚLOŽIŠTĚ (jednou týdně)
//
// Tři druhy souborů, které nikdo nikdy nesmaže a které rostou navždy:
//   1) videa po SMAZANÝCH účtech — profil je pryč, soubor zůstal
//   2) OSIŘELÁ videa — na soubor se neodkazuje žádný profil ani žádost o ověření
//   3) fotky klubů po smazaných klubech
//
// Certifikační videa už appka nesbírá (uznávání disciplín bylo zrušeno), takže všechno, na
// co se neodkazuje profil, je po 90 dnech k mazání.
//
// Soubory v coach-videos se jmenují "<uuid vlastníka>-<timestamp>.<přípona>", takže vlastník
// se pozná z názvu i u souboru, na který se už nic neodkazuje.

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KEEP_CERT_DAYS = 90;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}

async function listBucket(bucket) {
  const r = await fetch(`${SB}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 1000, offset: 0, sortBy: { column: 'created_at', order: 'asc' } }),
  });
  if (!r.ok) throw new Error(`list ${bucket}: ${r.status}`);
  return r.json();
}

async function removeFiles(bucket, names) {
  if (!names.length) return 0;
  const r = await fetch(`${SB}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: names }),
  });
  return r.ok ? names.length : 0;
}

export default async function handler(req, res) {
  // Bez tajemstvi endpoint nespoustet: mazani souboru neni nic, co ma jit zavolat kdokoli.
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  const given = req.headers.authorization === `Bearer ${secret}` || req.query.secret === secret;
  if (!given) return res.status(401).json({ error: 'unauthorized' });

  const out = { videos_deleted: 0, photos_deleted: 0, checked: 0, errors: [] };
  const cutoff = Date.now() - KEEP_CERT_DAYS * 86400000;

  try {
    // Kdo v appce existuje a na co se odkazuje.
    const profiles = await sb('profiles?select=id,profile_video_url&limit=10000');
    const alive = new Set(profiles.map((p) => String(p.id)));
    const referenced = new Set();
    profiles.forEach((p) => {
      const u = p.profile_video_url || '';
      const n = String(u).split('/coach-videos/')[1];
      if (n) referenced.add(decodeURIComponent(n.split('?')[0]));
    });

    // Certifikacni videa uz neexistuji: discipliny se pridavaji rovnou, bez schvalovani.
    // V bucketu po nich zustaly soubory z jara 2026 a tenhle cron je uklidi jako osirela.

    const files = await listBucket('coach-videos');
    out.checked += files.length;
    const doomed = files.filter((f) => {
      if (referenced.has(f.name)) return false;
      const owner = String(f.name).split('-').slice(0, 5).join('-');   // uuid je prvnich pet casti
      if (alive.has(owner)) {
        // Vlastnik zije, ale na soubor se nic neodkazuje: necháme 90 dní a pak pryč.
        return new Date(f.created_at || 0).getTime() < cutoff;
      }
      return true;                                                      // ucet uz neexistuje
    }).map((f) => f.name);
    out.videos_deleted = await removeFiles('coach-videos', doomed);

    // Fotky klubu po smazanych klubech.
    try {
      const gyms = await sb('gyms?select=id,photos&limit=5000');
      const usedPhotos = new Set();
      gyms.forEach((g) => {
        (Array.isArray(g.photos) ? g.photos : []).forEach((u) => {
          const n = String(u || '').split('/gym-photos/')[1];
          if (n) usedPhotos.add(decodeURIComponent(n.split('?')[0]));
        });
      });
      const gp = await listBucket('gym-photos');
      out.checked += gp.length;
      const oldPhotos = gp
        .filter((f) => !usedPhotos.has(f.name) && new Date(f.created_at || 0).getTime() < cutoff)
        .map((f) => f.name);
      out.photos_deleted = await removeFiles('gym-photos', oldPhotos);
    } catch (e) { out.errors.push('gym-photos: ' + e.message); }

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e), ...out });
  }
}
