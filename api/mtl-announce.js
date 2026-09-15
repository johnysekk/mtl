// /api/mtl-announce.js — oficiální oznámení od MTL, jednosměrně.
//
// PROČ SERVER: rozesílá se tisícům lidí. Z prohlížeče by to znamenalo tisíce zápisů, RLS
// by část z nich odmítla a půlka by se ztratila při zavření záložky. Tady to proběhne
// jedním během se servisní rolí.
//
// JEDNOSMĚRNĚ: zapisuje se jen notifikace typu 'system' s kind 'mtl_announce'. Nevzniká
// žádné vlákno v chatu, takže není kam odpovědět -- stejně jako klubové oznámení členům.
//
// POST { audience, subject, body, test } + Authorization: Bearer <access token foundera>
//   audience: 'all' | 'providers' | 'coaches' | 'gyms' | 'orgs' | 'students'
//   test: true -> jen spočítá příjemce a NIC neodešle (náhled)
//
// Jen founder; ověřuje se token proti databázi, ne id z těla.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function sbGet(path) {
  const out = [];
  const PAGE = 1000;
  for (let off = 0; off <= 200000; off += PAGE) {
    const r = await fetch(`${SB}/rest/v1/${path}&limit=${PAGE}&offset=${off}`, { headers: svc });
    if (!r.ok) break;
    const page = await r.json();
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

async function sbPost(table, rows) {
  const r = await fetch(`${SB}/rest/v1/${table}`, {
    method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`${table}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const token = req.headers['x-access-token'] ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!token) return res.status(401).json({ error: 'no token' });
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const uid = (await ures.json()).id;
    if (!uid) return res.status(401).json({ error: 'no user' });
    const pr = await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=role`);
    if (!pr.length || pr[0].role !== 'founder') return res.status(403).json({ error: 'founder only' });

    const { audience, subject, body, test } = req.body || {};
    const AUD = ['all', 'providers', 'coaches', 'gyms', 'orgs', 'students'];
    if (AUD.indexOf(audience) < 0) return res.status(400).json({ error: 'audience' });
    const txt = String(body || '').trim();
    if (!test && txt.length < 5) return res.status(400).json({ error: 'body too short' });
    if (txt.length > 2000) return res.status(400).json({ error: 'body too long' });

    // ── KDO TO DOSTANE ────────────────────────────────────────────────────────────────
    // Mrtvé účty se přeskakují vždy: smazané, deaktivované i zablokované.
    const alive = 'deleted_at=is.null&deactivated_at=is.null';
    const ids = new Set();

    const addCoaches = async () => {
      (await sbGet(`profiles?coach_status=eq.approved&${alive}&select=id`)).forEach(p => ids.add(p.id));
    };
    const addGymOwners = async () => {
      const gy = await sbGet('gyms?status=eq.approved&deleted_at=is.null&select=owner_id');
      gy.forEach(g => { if (g.owner_id) ids.add(g.owner_id); });
      // Spolumajitelé taky: klub mají na starost stejně jako vlastník.
      const co = await sbGet('gym_coaches?co_owner=eq.true&status=eq.active&select=coach_id');
      co.forEach(c => { if (c.coach_id) ids.add(c.coach_id); });
    };
    const addOrgOwners = async () => {
      (await sbGet('organizations?select=owner_id')).forEach(o => { if (o.owner_id) ids.add(o.owner_id); });
    };

    if (audience === 'coaches') await addCoaches();
    else if (audience === 'gyms') await addGymOwners();
    else if (audience === 'orgs') await addOrgOwners();
    else if (audience === 'providers') { await addCoaches(); await addGymOwners(); await addOrgOwners(); }
    else if (audience === 'students' || audience === 'all') {
      (await sbGet(`profiles?${alive}&select=id`)).forEach(p => ids.add(p.id));
      if (audience === 'students') {
        // Studenti = všichni MÍNUS poskytovatelé.
        const prov = new Set();
        (await sbGet(`profiles?coach_status=eq.approved&${alive}&select=id`)).forEach(p => prov.add(p.id));
        (await sbGet('gyms?status=eq.approved&deleted_at=is.null&select=owner_id')).forEach(g => { if (g.owner_id) prov.add(g.owner_id); });
        (await sbGet('organizations?select=owner_id')).forEach(o => { if (o.owner_id) prov.add(o.owner_id); });
        prov.forEach(x => ids.delete(x));
      }
    }

    const list = [...ids].filter(Boolean);
    if (test) return res.status(200).json({ ok: true, would_send: list.length, audience });
    if (!list.length) return res.status(200).json({ ok: true, sent: 0, audience });

    // ── ODESLÁNÍ ──────────────────────────────────────────────────────────────────────
    // Po dávkách, ať jeden velký zápis nespadne na časový limit. Když dávka selže,
    // pokračuje se dál a spadlé se spočítají -- lepší doručit většinu než nic.
    const head = String(subject || '').trim();
    const msg = '📣 MTL' + (head ? (' · ' + head) : '') + ': ' + txt;
    let sent = 0, failed = 0;
    for (let i = 0; i < list.length; i += 500) {
      const rows = list.slice(i, i + 500).map(id => ({
        user_id: id, type: 'system', read: false, message: msg,
        data: JSON.stringify({ kind: 'mtl_announce', subject: head || null, body: txt, at: new Date().toISOString() }),
      }));
      try { await sbPost('notifications', rows); sent += rows.length; }
      catch (e) { failed += rows.length; console.error('[mtl-announce]', e.message); }
    }
    return res.status(200).json({ ok: true, audience, sent, failed });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
