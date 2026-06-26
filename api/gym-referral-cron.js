// /api/gym-referral-cron.js
// Daily job: when a REFERRED gym reaches 10 DISTINCT paying members
// (transactions.type = 'membership'), flag gyms.referral_rewarded = true and
// notify the inviter with a VAGUE message (never reveals the count / threshold).
// The +125 XP itself is computed client-side in computeMyXP from this flag.
//
// vercel.json: { "crons": [ { "path": "/api/gym-referral-cron", "schedule": "0 4 * * *" } ] }
// Needs env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ; optional CRON_SECRET.

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const THRESHOLD = 10; // distinct paying members required to release the reward

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
    body: opts.body,
  });
  const txt = await r.text();
  let j; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = txt; }
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set' });

  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    const okHdr = auth === `Bearer ${process.env.CRON_SECRET}` || req.headers['x-vercel-cron'];
    if (!okHdr) return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // Gyms that were invited and have not yet released the reward
    const pending = await sb(`gyms?referred_by=not.is.null&referral_rewarded=is.false&select=id,name,referred_by&limit=2000`);
    let rewarded = 0, checked = 0;

    for (const g of (pending || [])) {
      checked++;
      // Count DISTINCT paying members (membership transactions) for this gym
      const rows = await sb(`transactions?gym_id=eq.${g.id}&type=eq.membership&select=member_id&limit=10000`);
      const members = new Set((rows || []).map(r => r.member_id).filter(Boolean));
      if (members.size < THRESHOLD) continue;

      // Release: flag the gym (idempotent — only flips false -> true)
      await sb(`gyms?id=eq.${g.id}&referral_rewarded=is.false`, {
        method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ referral_rewarded: true }),
      });

      // VAGUE notification to the inviter — never states the member count/threshold
      await sb(`notifications`, {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify([{
          user_id: g.referred_by,
          type: 'system',
          read: false,
          data: JSON.stringify({ kind: 'gym_invite_reward', gym_name: g.name || 'Gym' }),
        }]),
      });
      rewarded++;
    }

    return res.status(200).json({ ok: true, checked, rewarded });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
