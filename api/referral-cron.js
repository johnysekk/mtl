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

      // ...or did they simply BUY A MEMBERSHIP?  (Petr, 2026-07-20)
      // This used to be a real hole: the most valuable conversion of all - the invitee walks in,
      // signs up for a membership and never books a single drop-in or private - awarded nobody
      // anything, because both tests above only look at per-lesson rows. A membership that is
      // active (or cancelling, i.e. paid to the end of the period) is at least as strong a proof
      // of "this person actually started training" as one attended lesson.
      // Deliberately NOT gated on a past date: a membership is paid up front and the money has
      // already moved, unlike a booking that can still be a no-show. pending_offline is excluded
      // on purpose - an unconfirmed QR/bank membership is not paid yet.
      if (!qualifies) {
        const b3 = await sb(
          `gym_memberships?student_id=eq.${inv.id}&status=in.(active,cancelling)&select=id&limit=1`
        );
        qualifies = b3 && b3.length;
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


    // ── RECRUIT ACTIVATION (universal) ──
    // ONE rule for EVERYBODY, coach or club: a referred provider counts as ACTIVE once they
    // have >= 10 taught 1:1 privates OR >= 25 active memberships. This is Petr's rule and it
    // replaces the two stale, inconsistent tests that used to live here:
    //   - coach: 5 lessons logged as held (a client-side counter, ref_coach_lessons)
    //   - gym:   revenue in 2 distinct calendar months
    // Those were far too weak - a club could "activate" off two tiny months and never become
    // a real business. The bar is now the same real-traction bar that gates Bankai
    // (bankai-cron.js), so "active" means the same thing everywhere in the product.
    // ref_coach_qualified stays the single idempotency flag → each referred person counts once.
    const ACT_PRIVATES = 10;   // taught 1:1 privates
    const ACT_MEMBERS  = 25;   // active memberships across the clubs they own

    async function isActiveProvider(uid) {
      // >= 10 taught 1:1 privates?
      const priv = await sb(`transactions?coach_id=eq.${uid}&type=eq.coach_1to1&select=id&limit=${ACT_PRIVATES}`);
      if ((priv || []).length >= ACT_PRIVATES) return true;
      // …or >= 25 active memberships across the clubs they own?
      const gy = await sb(`gyms?owner_id=eq.${uid}&status=eq.approved&select=id&limit=20`);
      const ids = (gy || []).map((g) => g.id);
      if (!ids.length) return false;
      const mems = await sb(`gym_memberships?gym_id=in.(${ids.join(',')})&status=in.(active,cancelling)&select=id&limit=${ACT_MEMBERS}`);
      return (mems || []).length >= ACT_MEMBERS;
    }

    let gymActivated = 0;
    try {
      const cand = await sb(`profiles?referred_by=not.is.null&ref_coach_qualified=not.is.true&select=id,referred_by,name&limit=500`);
      for (const c of (cand || [])) {
        if (!(await isActiveProvider(c.id))) continue;   // not yet a real business
        // qualify (set flag FIRST for idempotency), then bump referrer
        await sb(`profiles?id=eq.${c.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ ref_coach_qualified: true }) });
        const ref = await sb(`profiles?id=eq.${c.referred_by}&select=coach_ref_score,name&limit=1`);
        const newScore = ((ref && ref[0] && ref[0].coach_ref_score) || 0) + 1;
        await sb(`profiles?id=eq.${c.referred_by}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ coach_ref_score: newScore }) });
        try { await sb(`coach_ref_log`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ referrer_id: c.referred_by, referred_id: c.id, weight: 2 }]) }); } catch (e) {}
        let msg = `\uD83C\uDF89 Tv\u016Fj pozvan\u00FD gym ${c.name || ''} je te\u010F aktivn\u00ED! +1 bod do MTL Ligy \uD83C\uDFC6 \u2014 m\u00E1\u0161 ${newScore} aktivn\u00EDch p\u0159iveden\u00FDch. \uD83E\uDD4A`;
        // Milestones must match the REAL ladder in _ladderRate: Shikai at 2, Bankai at 5
        // (+ the performance gate, Stripe only). They used to fire at 3 and 10 - the old
        // ladder - so a referrer was congratulated a referral late. Fee-only wording: we
        // never show a "you keep X%" figure.
        if (newScore === 2) msg = `\uD83D\uDDE1\uFE0F 2 aktivn\u00ED p\u0159iveden\u00ED! Odemkl jsi SHIKAI \u2014 provize MTL ti klesla. \uD83E\uDD4A`;
        else if (newScore === 5) msg = `\uD83D\uDD25 5 aktivn\u00EDch p\u0159iveden\u00FDch! M\u00E1\u0161 na BANKAI (provize 2 %) \u2014 ve Stripe re\u017Eimu a po spln\u011Bn\u00ED v\u00FDkonu (10 soukromek nebo 25 \u010Dlenstv\u00ED). \uD83C\uDFC6`;
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
          const rows = await sb(`coach_ref_log?qualified_at=gte.${prevStart}&qualified_at=lt.${curStart.toISOString()}&select=referrer_id,weight&limit=5000`);
          const cc = {}; (rows || []).forEach(r => { if (r.referrer_id) cc[r.referrer_id] = (cc[r.referrer_id] || 0) + (r.weight || 1); });
          const top = Object.entries(cc).map(([id, n]) => ({ id, n: Number(n) })).sort((a, b) => b.n - a.n).slice(0, 3);
          for (let i = 0; i < top.length; i++) {
            const medal = i === 0 ? '\uD83E\uDD47' : i === 1 ? '\uD83E\uDD48' : '\uD83E\uDD49';
            await sb(`league_titles`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: top[i].id, season: prevSeason, rank: i + 1, points: top[i].n }]) });
            await sb(`notifications`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: top[i].id, type: 'referral', read: false, data: JSON.stringify({ kind: 'league_champion', season: prevSeason, rank: i + 1 }), message: `${medal} MTL Liga ${prevSeason}: skon\u010Dil jsi #${i + 1}! Z\u00EDskal jsi \u0161ampionsk\u00FD odznak. \uD83C\uDFC6` }]) });
            champions++;
          }
          // STREAKS removed: MTL Liga is retired and profiles.league_streak / league_streak_best
          // never existed in the DB - every query here 400'd inside its own try/catch, so the
          // block was dead weight that could never have worked.
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
          await sb(`notifications`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: id, type: 'referral', read: false, data: JSON.stringify({ kind: 'league_climb', rank: newRank }), message: `\uD83D\uDCC8 Posunul ses na #${newRank} v MTL Lize! Dr\u017E tempo. \uD83E\uDD4A` }]) });
          momentum++;
        } else if (newRank > last && last <= 10) {
          await sb(`notifications`, { method: 'POST', prefer: 'return=minimal', body: JSON.stringify([{ user_id: id, type: 'referral', read: false, data: JSON.stringify({ kind: 'league_drop', rank: newRank }), message: `\uD83D\uDCC9 Spadl jsi na #${newRank} v MTL Lize \u2014 n\u011Bkdo t\u011B p\u0159edb\u011Bhl. P\u0159ive\u010F kou\u010De a vra\u0165 se nahoru!` }]) });
          momentum++;
        }
      }
    } catch (e) { /* don't block */ }

    return res.status(200).json({ ok: true, checked, awarded, expiredPts, gymActivated, champions, momentum });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
