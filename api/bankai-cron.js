import { rerateOwner } from './gym-rerate.js';
// /api/bankai-cron.js — maintains profiles.bankai_eligible for the Bankai perf-gate.
// Given coach_ref_score>=5 (the referral threshold, checked at rate-compute time), a provider
// is Bankai-eligible if EITHER: >=10 taught privates (transactions type=coach_1to1 for this
// coach) OR they own a gym with >=25 active/cancelling memberships. Daily cron.
// vercel.json: { "path": "/api/bankai-cron", "schedule": "0 3 * * *" }
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: SKEY, Authorization: `Bearer ${SKEY}` };
async function sbGet(path) { try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; } catch (e) { return []; } }
async function sbPatch(path, body) { try { await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) }); } catch (e) {} }

export default async function handler(req, res) {
  try {
    // Only providers who can even reach Bankai (score>=5) matter; others gate out on score first.
    const cands = await sbGet(`profiles?coach_ref_score=gte.5&select=id,bankai_eligible&limit=5000`);
    let changed = 0;
    for (const p of cands || []) {
      // >=10 taught privates (paid coach 1:1)?
      const priv = await sbGet(`transactions?coach_id=eq.${encodeURIComponent(p.id)}&type=eq.coach_1to1&select=id&limit=10`);
      let elig = (priv || []).length >= 10;
      if (!elig) {
        // else >=25 active memberships across gyms this profile owns?
        const gyms = await sbGet(`gyms?owner_id=eq.${encodeURIComponent(p.id)}&select=id`);
        const ids = (gyms || []).map(g => g.id).filter(Boolean);
        if (ids.length) {
          const inList = ids.map(encodeURIComponent).join(',');
          const mems = await sbGet(`gym_memberships?gym_id=in.(${inList})&status=in.(active,cancelling)&select=id&limit=25`);
          elig = (mems || []).length >= 25;
        }
      }
      if (!!p.bankai_eligible !== elig) {
        await sbPatch(`profiles?id=eq.${encodeURIComponent(p.id)}`, { bankai_eligible: elig });
        changed++;
        // Called directly rather than over HTTP: a self-fetch needs a base URL from the
        // environment, and if that variable is missing the call fails silently -- the worst way
        // for a money fix to not work. A Stripe subscription locks its application_fee_percent at
        // creation, so without this the reward reaches nobody who is already a member.
        try { await rerateOwner(p.id); } catch (e) { console.error('rerate', e && e.message); }
      }
    }
    res.status(200).json({ ok: true, checked: (cands || []).length, changed });
  } catch (err) {
    console.error('bankai-cron', err);
    res.status(500).json({ error: err.message });
  }
}
