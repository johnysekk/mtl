// /api/referral-cron.js
// Daily job: award +2 referral points to BOTH the invitee and the referrer,
// but only AFTER the invitee's first 1:1 or drop-in lesson has PASSED and was
// NOT cancelled/refunded (award-on-completion, not on payment).
//
// Configure in vercel.json:
//   { "crons": [ { "path": "/api/referral-cron", "schedule": "0 3 * * *" } ] }
//
// Needs env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// (optional) CRON_SECRET — if set, the request must send Authorization: Bearer <CRON_SECRET>.

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  // optional lock
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    const okHdr = auth === `Bearer ${process.env.CRON_SECRET}` || req.headers['x-vercel-cron'];
    if (!okHdr) return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const nowIso = new Date().toISOString();

    // ── EXPIRE referral credits older than 12 months (unconsumed) ──
    let expiredPts = 0;
    try {
      const exp = await sb(`referral_credits?consumed=is.false&expires_at=lt.${nowIso}&select=user_id&limit=5000`);
      const byUser = {};
      for (const r of (exp || [])) byUser[r.user_id] = (byUser[r.user_id] || 0) + 1;
      for (const uid of Object.keys(byUser)) {
        const n = byUser[uid];
        await sb(`referral_credits?user_id=eq.${uid}&consumed=is.false&expires_at=lt.${nowIso}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ consumed: true }) });
        const pr = await sb(`profiles?id=eq.${uid}&select=student_credits&limit=1`);
        const cur = (pr && pr[0] && pr[0].student_credits) || 0;
        await sb(`profiles?id=eq.${uid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ student_credits: Math.max(0, cur - n) }) });
        await sb(`notifications`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: uid, type: 'referral', read: false, data: JSON.stringify({ kind: 'referral_expired', n }), message: `\u231B ${n} referral ${n === 1 ? 'bod vypr\u0161el' : 'bod\u016F vypr\u0161elo'} (star\u0161\u00ED ne\u017E 12 m\u011Bs\u00EDc\u016F).` }]) });
        expiredPts += n;
      }
    } catch (e) { /* don't block awards */ }

    // invitees who were referred and not yet rewarded
    const invitees = await sb(
      `profiles?referred_by=not.is.null&referral_rewarded=not.is.true&select=id,referred_by,student_credits,name&limit=500`
    );

    let awarded = 0, checked = invitees.length;
    for (const inv of invitees) {
      // a PAST, non-cancelled 1:1 lesson?  (bookings.training_date, status='active')
      const b1 = await sb(
        `bookings?student_id=eq.${inv.id}&status=eq.active&training_date=lt.${today}&select=id&limit=1`
      );
      let qualifies = b1 && b1.length;

      // ...or a PAST, non-cancelled drop-in?  (gym_bookings.date, status='active')
      if (!qualifies) {
        const b2 = await sb(
          `gym_bookings?student_id=eq.${inv.id}&status=eq.active&date=lt.${today}&select=id&limit=1`
        );
        qualifies = b2 && b2.length;
      }
      if (!qualifies) continue;

      // set rewarded FIRST (idempotency) + grant invitee +2 in one PATCH
      await sb(`profiles?id=eq.${inv.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ referral_rewarded: true, student_credits: (inv.student_credits || 0) + 2 }),
      });

      // grant referrer +2 (read current, add)
      const ref = await sb(`profiles?id=eq.${inv.referred_by}&select=student_credits&limit=1`);
      const rc = (ref && ref[0] && ref[0].student_credits) || 0;
      await sb(`profiles?id=eq.${inv.referred_by}`, {
        method: 'PATCH',
        body: JSON.stringify({ student_credits: rc + 2 }),
      });

      // log the 4 new credit points for 12-month expiry (earned_at defaults to now())
      const _exp = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
      await sb(`referral_credits`, {
        method: 'POST', prefer: 'return=minimal',
        body: JSON.stringify([
          { user_id: inv.id, expires_at: _exp }, { user_id: inv.id, expires_at: _exp },
          { user_id: inv.referred_by, expires_at: _exp }, { user_id: inv.referred_by, expires_at: _exp },
        ]),
      });

      // notify both
      await sb(`notifications`, {
        method: 'POST',
        prefer: 'return=minimal',
        body: JSON.stringify([
          {
            user_id: inv.referred_by, type: 'referral', read: false,
            data: JSON.stringify({ kind: 'referral_reward_student', who: inv.name || '' }),
            message: `🎁 Tvůj pozvaný ${inv.name || 'kamarád'} absolvoval první lekci! Máš +2 referral body (sleva 10–20 % na další lekci).`,
          },
          {
            user_id: inv.id, type: 'referral', read: false,
            data: JSON.stringify({ kind: 'referral_reward_student' }),
            message: `🎁 Máš +2 referral body — sleva 10–20 % na další lekci!`,
          },
        ]),
      });

      awarded++;
    }


    // ── GYM-OWNER recruit activation ──
    // A referred gym owner becomes "active" after 2 distinct months of real gym revenue.
    // (Coaches activate in-app after 5 paid lessons/classes; this pass covers gym owners.)
    // ref_coach_qualified is the single idempotency flag → counts once per user even if
    // they are both a coach and a gym owner (whichever path qualifies first wins).
    let gymActivated = 0;
    try {
      const cand = await sb(`profiles?referred_by=not.is.null&ref_coach_qualified=not.is.true&select=id,referred_by,name&limit=500`);
      for (const c of (cand || [])) {
        const gy = await sb(`gyms?owner_id=eq.${c.id}&status=eq.approved&select=id&limit=1`);
        const gymId = gy && gy[0] && gy[0].id;
        if (!gymId) continue; // no gym → coach path handles activation in-app
        const tx = await sb(`transactions?gym_id=eq.${gymId}&select=created_at&limit=1000`);
        const months = new Set((tx || []).map(t => (t.created_at || '').slice(0, 7)).filter(Boolean));
        if (months.size < 2) continue; // needs 2 distinct months of real revenue
        // qualify (set flag FIRST for idempotency), then bump referrer
        await sb(`profiles?id=eq.${c.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ ref_coach_qualified: true }) });
        const ref = await sb(`profiles?id=eq.${c.referred_by}&select=coach_ref_score,name&limit=1`);
        const newScore = ((ref && ref[0] && ref[0].coach_ref_score) || 0) + 1;
        await sb(`profiles?id=eq.${c.referred_by}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ coach_ref_score: newScore }) });
        try { await sb(`coach_ref_log`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ referrer_id: c.referred_by, referred_id: c.id }]) }); } catch (e) {}
        let msg = `\uD83C\uDF89 Tv\u016Fj pozvan\u00FD gym ${c.name || ''} je te\u010F aktivn\u00ED! M\u00E1\u0161 ${newScore} aktivn\u00EDch p\u0159iveden\u00FDch. \uD83E\uDD4A`;
        if (newScore === 3) msg = `\uD83D\uDDE1\uFE0F 3 aktivn\u00ED p\u0159iveden\u00ED! Odemkl jsi SHIKAI rate \u2014 nech\u00E1v\u00E1\u0161 si 97 % (provize jen 3 %). \uD83E\uDD4A`;
        else if (newScore === 10) msg = `\uD83D\uDD25 10 aktivn\u00EDch p\u0159iveden\u00FDch! Odemkl jsi BANKAI rate \u2014 nech\u00E1v\u00E1\u0161 si 98 % (provize jen 2 %). \uD83C\uDFC6`;
        await sb(`notifications`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: c.referred_by, type: 'referral', read: false, data: JSON.stringify({ kind: 'coach_ref_qualified', who: c.name || '', score: newScore }), message: msg }]) });
        gymActivated++;
      }
    } catch (e) { /* don't block the response */ }


    // ── MTL LEAGUE: champions (season rollover) + momentum ──
    let champions = 0, momentum = 0;
    try {
      const now = new Date();
      const curQ = Math.floor(now.getUTCMonth() / 3) + 1, curY = now.getUTCFullYear();
      const curStart = new Date(Date.UTC(curY, (curQ - 1) * 3, 1));
      const prevEnd = new Date(curStart.getTime() - 1);
      const prevQ = Math.floor(prevEnd.getUTCMonth() / 3) + 1, prevY = prevEnd.getUTCFullYear();
      const prevStart = new Date(Date.UTC(prevY, (prevQ - 1) * 3, 1)).toISOString();
      const prevSeason = `Q${prevQ} ${prevY}`;
      const dayOfQ = Math.floor((now - curStart) / 86400000);

      // CHAMPIONS — once, in the first days of a new quarter, award prev-quarter top 3.
      if (dayOfQ <= 5) {
        const done = await sb(`league_titles?season=eq.${encodeURIComponent(prevSeason)}&select=id&limit=1`);
        if (!done || !done.length) {
          const rows = await sb(`coach_ref_log?qualified_at=gte.${prevStart}&qualified_at=lt.${curStart.toISOString()}&select=referrer_id&limit=5000`);
          const cc = {}; (rows || []).forEach(r => { if (r.referrer_id) cc[r.referrer_id] = (cc[r.referrer_id] || 0) + 1; });
          const top = Object.entries(cc).map(([id, n]) => ({ id, n: Number(n) })).sort((a, b) => b.n - a.n).slice(0, 3);
          for (let i = 0; i < top.length; i++) {
            const medal = i === 0 ? '\uD83E\uDD47' : i === 1 ? '\uD83E\uDD48' : '\uD83E\uDD49';
            await sb(`league_titles`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: top[i].id, season: prevSeason, rank: i + 1, points: top[i].n }]) });
            await sb(`notifications`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: top[i].id, type: 'referral', read: false, data: JSON.stringify({ kind: 'league_champion', season: prevSeason, rank: i + 1 }), message: `${medal} MTL League ${prevSeason}: skon\u010Dil jsi #${i + 1}! Z\u00EDskal jsi \u0161ampionsk\u00FD odznak. \uD83C\uDFC6` }]) });
            champions++;
          }
        }
      }

      // MOMENTUM — snapshot current-quarter ranks, notify climbers / overtaken (opt-in).
      const curRows = await sb(`coach_ref_log?qualified_at=gte.${curStart.toISOString()}&select=referrer_id&limit=5000`);
      const ccur = {}; (curRows || []).forEach(r => { if (r.referrer_id) ccur[r.referrer_id] = (ccur[r.referrer_id] || 0) + 1; });
      const ranked = Object.entries(ccur).map(([id, n]) => ({ id, n: Number(n) })).sort((a, b) => b.n - a.n);
      for (let i = 0; i < ranked.length; i++) {
        const id = ranked[i].id, newRank = i + 1;
        const pr = await sb(`profiles?id=eq.${id}&select=league_last_rank,league_notif_optin&limit=1`);
        const last = pr && pr[0] ? pr[0].league_last_rank : null;
        const optin = !(pr && pr[0] && pr[0].league_notif_optin === false);
        await sb(`profiles?id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ league_last_rank: newRank }) });
        if (!optin || last == null) continue;
        if (newRank < last && newRank <= 10) {
          await sb(`notifications`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: id, type: 'referral', read: false, data: JSON.stringify({ kind: 'league_climb', rank: newRank }), message: `\uD83D\uDCC8 Posunul ses na #${newRank} v MTL League! Dr\u017E tempo. \uD83E\uDD4A` }]) });
          momentum++;
        } else if (newRank > last && last <= 10) {
          await sb(`notifications`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: id, type: 'referral', read: false, data: JSON.stringify({ kind: 'league_drop', rank: newRank }), message: `\uD83D\uDCC9 Spadl jsi na #${newRank} v MTL League \u2014 n\u011Bkdo t\u011B p\u0159edb\u011Bhl. P\u0159ive\u010F kou\u010De a vra\u0165 se nahoru!` }]) });
          momentum++;
        }
      }
    } catch (e) { /* don't block */ }

    return res.status(200).json({ ok: true, checked, awarded, expiredPts, gymActivated, champions, momentum });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
