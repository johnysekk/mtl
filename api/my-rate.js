// /api/my-rate  — the DISPLAY side of the single source of truth. The UI must never compute the
// rate itself (a client copy of the ladder would drift from what the server charges). Instead it
// asks here: we read the caller's CONDITIONS from profiles (partner=EP, founding=FP,
// coach_ref_score -> Shikai/Bankai, bankai_eligible) and run the SAME _rate.js ladder the charge
// paths use, so the displayed % is exactly the charged %.
import { ladderRate } from './_rate.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const token = req.headers['x-access-token'] ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const mode = (req.query && req.query.mode) === 'qr_bank' ? 'qr_bank' : 'stripe';
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });

    const p = (await (await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=partner,founding,coach_ref_score,bankai_eligible`, { headers: svc })).json())[0] || {};
    const cond = { partner: !!p.partner, founding: !!p.founding, score: p.coach_ref_score || 0, bankai: !!p.bankai_eligible };
    const rate = ladderRate(mode, cond);

    let tier;
    if (cond.partner) tier = 'EP';
    else if (cond.founding) tier = 'FP';
    else if (mode === 'stripe' && cond.score >= 5 && cond.bankai) tier = 'Bankai';
    else if (cond.score >= 2) tier = 'Shikai';
    else tier = 'base';

    // conditions surfaced so the UI can show WHY (and what unlocks the next tier) from one source
    return res.status(200).json({ ok: true, mode, rate, pct: Math.round(rate * 1000) / 10, tier, conditions: cond });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
