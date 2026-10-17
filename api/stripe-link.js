// /api/stripe-link — PŘIPOJENÍ STRIPE ÚČTU K PROFILU NEBO KLUBU (jen přes server).
// POST { target:'coach'|'coach_payout'|'gym', action:'link'|'sync', acct?, gymId? }   + Bearer token
//
// Dřív si appka zapisovala stripe_account / gym_payout_account / charges_enabled sama. Kdo měl
// přístup k úpravám klubu, mohl tak platby klubu přesměrovat na jiný Stripe účet, a kdokoli si mohl
// nastavit „platby fungují", i když nefungovaly. Teď:
//   * link: účet se připojí, jen když patří volajícímu -- založil ho on (metadata mtl_user z
//     /api/create-coach a /api/create-gym), u klubu i účet založený pro ten klub (metadata gym_id)
//     -- a u klubu jen majitel nebo spolumajitel. Stav plateb (charges_enabled) se bere ze Stripe.
//   * sync: obnoví stav plateb u účtu, který už připojený je.
// Odpojení (nastavení na prázdno) appka dělá sama -- to nikomu peníze nepřesměruje.
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return r.ok ? await r.json() : [];
}
async function sbPatch(path, body) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`SB ${r.status} ${(await r.text().catch(() => '')).slice(0, 160)}`);
}
async function authUser(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return (u && u.id) ? u : null;
}
async function isGymBoss(gymId, uid) {
  const g = ((await sbGet(`gyms?id=eq.${q(gymId)}&select=id,owner_id,stripe_account`)) || [])[0];
  if (!g) return { ok: false, gym: null };
  if (String(g.owner_id) === String(uid)) return { ok: true, gym: g };
  const c = await sbGet(`gym_coaches?gym_id=eq.${q(gymId)}&coach_id=eq.${q(uid)}&status=eq.active&co_owner=eq.true&select=id&limit=1`);
  return { ok: !!(c && c.length), gym: g };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const u = await authUser(req);
    if (!u) return res.status(401).json({ error: 'Nejsi přihlášený.' });
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const target = String(b.target || ''), action = String(b.action || 'link');
    if (!['coach', 'coach_payout', 'gym'].includes(target) || !['link', 'sync'].includes(action)) return res.status(400).json({ error: 'bad request' });

    // Kam se zapisuje a co tam je teď.
    let table, rowId, col, stored, gymId = null;
    if (target === 'gym') {
      gymId = String(b.gymId || '');
      if (!gymId) return res.status(400).json({ error: 'Chybí klub.' });
      const gb = await isGymBoss(gymId, u.id);
      if (!gb.gym) return res.status(404).json({ error: 'Klub nenalezen.' });
      if (!gb.ok) return res.status(403).json({ error: 'Stripe účet klubu připojuje jen majitel nebo spolumajitel.' });
      table = 'gyms'; rowId = gymId; col = 'stripe_account'; stored = gb.gym.stripe_account || null;
    } else {
      const p = ((await sbGet(`profiles?id=eq.${q(u.id)}&select=id,stripe_account,gym_payout_account`)) || [])[0] || {};
      table = 'profiles'; rowId = u.id; col = (target === 'coach') ? 'stripe_account' : 'gym_payout_account'; stored = p[col] || null;
    }

    const acct = action === 'sync' ? stored : String(b.acct || '').trim();
    if (!acct) return res.status(200).json({ ok: true, linked: false, charges_enabled: false });
    if (!/^acct_[A-Za-z0-9]+$/.test(acct)) return res.status(400).json({ error: 'Neplatný Stripe účet.' });

    const a = await stripe.accounts.retrieve(acct);
    const md = (a && a.metadata) || {};
    if (acct !== stored) {
      const mine = String(md.mtl_user || '') === String(u.id)
        || (target === 'gym' && (String(md.gym_id || '') === gymId || String(md.gym_profile_id || '') === String(u.id)));
      if (!mine) return res.status(403).json({ error: 'Tenhle Stripe účet nepatří tobě — připoj účet, který jsi založil přes MTL.' });
    }
    const ready = !!(a && a.charges_enabled);
    const patch = { [col]: acct };
    // charges_enabled patří k vlastnímu účtu kouče a k účtu klubu; výplatní účet kouče v klubu ho nemění.
    if (target !== 'coach_payout') patch.charges_enabled = ready;
    await sbPatch(`${table}?id=eq.${q(rowId)}`, patch);
    return res.status(200).json({ ok: true, linked: true, acct, charges_enabled: ready });
  } catch (e) {
    console.error('[stripe-link]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
