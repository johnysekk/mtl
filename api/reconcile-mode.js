// /api/reconcile-mode.js — nightly reconcile for the uniform-per-person payment model.
// Every gym's payment_mode must equal its OWNER's profiles.payment_mode. The client already
// propagates the mode atomically on switch (Platby & provize save), so this only corrects rare
// drift (e.g. a partial write, a manual DB edit, or a gym created before the owner set a mode).
// It NEVER touches per-entity accounts (stripe_account / receiver IBAN) — only the mode flag.
// vercel.json: { "path": "/api/reconcile-mode", "schedule": "0 4 * * *" }

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body,
  });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });
  const auth = req.headers.authorization || '';
  if (!(auth === `Bearer ${process.env.CRON_SECRET}` || req.headers['x-vercel-cron'])) return res.status(401).json({ error: 'unauthorized' });
  try {
    let fixed = 0, checked = 0;
    const gyms = await sb('gyms?owner_id=not.is.null&select=id,owner_id,payment_mode&limit=10000');
    // resolve each owner's canonical mode (profiles.payment_mode), chunked to keep URLs sane
    const owners = [...new Set((gyms || []).map(g => g.owner_id).filter(Boolean))];
    const ownerMode = {};
    for (let i = 0; i < owners.length; i += 150) {
      const chunk = owners.slice(i, i + 150);
      const profs = await sb(`profiles?id=in.(${chunk.join(',')})&select=id,payment_mode`);
      (profs || []).forEach(p => { ownerMode[p.id] = p.payment_mode || null; });
    }
    for (const g of gyms || []) {
      checked++;
      const om = ownerMode[g.owner_id];
      // only correct when the owner has a definite mode and the gym drifted away from it
      if (om && g.payment_mode !== om) {
        await sb(`gyms?id=eq.${g.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ payment_mode: om }) });
        fixed++;
      }
    }
    return res.status(200).json({ ok: true, checked, fixed });
  } catch (err) {
    console.error('reconcile-mode', err);
    return res.status(500).json({ error: err.message });
  }
}
