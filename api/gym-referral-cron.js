// /api/gym-referral-cron.js
// Daily job: when a REFERRED gym reaches 20 ACTIVE memberships (same bar as Shikai/Bankai),
// flag gyms.referral_rewarded = true and
// notify the inviter with a VAGUE message (never reveals the count / threshold).
// XP (+50) se pocita v appce v computeMyXP z tohoto priznaku.
//
// vercel.json: { "crons": [ { "path": "/api/gym-referral-cron", "schedule": "0 4 * * *" } ] }
// Needs env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ; optional CRON_SECRET.

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// AKTIVNI KLUB = 20 AKTIVNICH CLENSTVI. Stejna hranice jako referral-cron (ACT_MEMBERS) a
// bankai-cron -- driv tu platilo "10 ruznych platicich clenu za celou historii", takze klub
// mohl byt "rozjety" pro odmenu za pozvani a zaroven "neaktivni" pro Shikai/Bankai.
const THRESHOLD = 20;

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
      // Aktivni clenstvi prave ted, ne soucet za celou historii.
      const mems = await sb(`gym_memberships?gym_id=eq.${g.id}&status=in.(active,cancelling)&select=id&limit=${THRESHOLD}`);
      if ((mems || []).length < THRESHOLD) continue;

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
          // `message` was missing entirely, so the card rendered blank. Wording stays VAGUE
          // on purpose: it must never reveal the member count or the threshold.
          message: '\u{1F3C6} Gym, kter\u00FD jsi p\u0159ivedl (' + (g.name || 'Gym') + '), se rozjel na MTL \u2014 odm\u011Bna je tvoje. \u{1F94A}',
        }]),
      });
      rewarded++;
    }

    return res.status(200).json({ ok: true, checked, rewarded });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
