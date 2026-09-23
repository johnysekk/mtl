// /api/bug-reports.js — SEZNAM A SPRÁVA HLÁŠENÍ (jen zakladatel).
//
// Uživatel hlášení zakládá přímo z appky (RLS: smí insert svého řádku), ale číst cizí nesmí
// -- screenshot i text můžou obsahovat osobní údaje jiných lidí. Seznam proto chodí odtud,
// přes service key, a jen pro zakladatele. Obrázek se posílá jako dočasný podepsaný odkaz
// s platností 10 minut; veřejná URL na bucket neexistuje.
//
// GET  /api/bug-reports?status=new            → seznam
// POST /api/bug-reports { id, status, note }  → změna stavu

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDER = process.env.FOUNDER_UUID || '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}

async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u.id : null;
}

// Podepsaný odkaz platí 10 minut a nikam se neukládá -- po zavření Adminu je neplatný.
async function signedUrl(path) {
  try {
    const r = await fetch(`${SB}/storage/v1/object/sign/bug-shots/${encodeURI(path)}`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 600 }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.signedURL ? `${SB}/storage/v1${j.signedURL}` : null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });
  const uid = await whoami(req);
  if (!uid) return res.status(401).json({ error: 'no token' });
  if (String(uid) !== String(FOUNDER)) return res.status(403).json({ error: 'forbidden' });

  try {
    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      if (!b.id) return res.status(400).json({ error: 'missing id' });
      const patch = {};
      if (b.status) patch.status = String(b.status).slice(0, 20);
      if ('note' in b) patch.admin_note = b.note ? String(b.note).slice(0, 2000) : null;
      if (b.status === 'done' || b.status === 'wont') patch.resolved_at = new Date().toISOString();
      await sb(`bug_reports?id=eq.${encodeURIComponent(b.id)}`, {
        method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch),
      });
      return res.status(200).json({ ok: true });
    }

    const status = String((req.query && req.query.status) || 'new');
    const filter = (status === 'all') ? '' : `&status=eq.${encodeURIComponent(status)}`;
    const rows = await sb(`bug_reports?select=*${filter}&order=created_at.desc&limit=100`);
    for (const r of (rows || [])) {
      r.shot_url = r.shot_path ? await signedUrl(r.shot_path) : null;
      delete r.shot_path;
    }
    return res.status(200).json({ ok: true, rows: rows || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
