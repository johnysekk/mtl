// /api/circle-cron.js
// MTL CIRCLE — detect when a CITY can finally carry student ads,
// stamp it, and tell the CO-CREATORS who built it.
//
// THE RULE: advertising into thin supply burns money. A student who searches "Muay Thai
// Brno" and finds one gym leaves; one who finds six picks one. So ads unlock on a
// BUSINESS CONDITION, never as a prize:
//
//   DENSITY  — DENSITY_GATE live clubs in that CITY (any discipline)
//   LIVE     — each gym approved, not suspended, able to take payments, AND actually
//              trading (>= MIN_TX completed transactions in the last 30 days).
//              A dead listing converts nobody, so it must not count toward the bar.
//
// Nobody clears that alone. That is the entire point: a gym that wants ads in its city
// has to go and recruit OTHER gyms — competitors included. Rivals become co-creators.
//
// CO-CREATORS, NOT A LINEAGE. We never publish "gym X was brought by gym Y": between
// rival gyms that reads as ownership, even humiliation, and it isn't true — someone sent
// you a link, you are not their student. Only the CONTRIBUTION is public, and only as a
// group of equals: "Brno — Muay Thai: unlocked by Iron Gym, Warriors, Fight Club."
//
// The cron only DETECTS and NOTIFIES. Turning the campaign on is a human decision
// (circle_markets.ads_on), because money leaves MTL's pocket when it does.
//
// vercel.json: { "path": "/api/circle-cron", "schedule": "0 9 * * *" }
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY; optional CRON_SECRET.

const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const DENSITY_GATE = 6;   // live gyms needed before a market can carry ads
const MIN_TX       = 5;   // completed transactions in 30 days = "really trading"
const TX_WINDOW_D  = 30;

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

async function notify(userId, kind, message, data = {}) {
  if (!userId) return;
  try {
    await sb('notifications', { method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({ user_id: userId, type: 'system', read: false, message, data: JSON.stringify({ kind, ...data }) }) });
  } catch (e) { console.error('notify', e); }
}

const norm  = (s) => String(s || '').trim().toLowerCase();
const discs = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  }

  const out = { unlocked: 0, notified: 0, markets: [], errors: [] };

  try {
    const gyms = await sb('gyms?status=eq.approved&select=id,name,city,country,disciplines,owner_id,referred_by,payment_mode,stripe_account,receiver_id_value,account_suspended');

    // Which gyms are actually trading? A listing with no money moving through it is not
    // supply, and counting it would send us advertising into a market that cannot convert.
    const since = new Date(Date.now() - TX_WINDOW_D * 86400000).toISOString();
    const tx = await sb(`transactions?status=in.(paid,completed)&created_at=gte.${encodeURIComponent(since)}&select=gym_id`);
    const txBy = {};
    for (const t of tx || []) if (t.gym_id) txBy[t.gym_id] = (txBy[t.gym_id] || 0) + 1;

    const canPay = (g) => (g.payment_mode === 'qr_bank' ? !!g.receiver_id_value : !!g.stripe_account);
    const isLive = (g) => !g.account_suspended && canPay(g) && (txBy[g.id] || 0) >= MIN_TX;

    // A market is a CITY, not a city x discipline. Counting per discipline sounds more
    // precise but would have killed the mechanic: Zlín has ~6 combat clubs in TOTAL and
    // 1-2 per discipline, so a 6-club gate per discipline only ever opens in Praha. It
    // also isn't what we advertise - a campaign lands on "find your club in <city>" and
    // the student filters the discipline themselves. Six clubs of ANY disciplines is a
    // real choice; one club in the whole city loses them whatever it teaches. Discipline
    // is still collected, but only as a signal for the ad copy.
    const mk = {};
    for (const g of gyms || []) {
      if (!isLive(g)) continue;
      const city = String(g.city || '').trim();
      if (!city) continue;
      const k = norm(city) + '|' + norm(g.country);
      if (!mk[k]) mk[k] = { city, country: g.country || null, live: 0, creators: new Set(), disc: new Set() };
      mk[k].live++;
      discs(g.disciplines).forEach((d) => mk[k].disc.add(d));
      // A co-creator brought a club into this city and is NOT that club's own owner
      // (a self-referral would be attribution, not contribution).
      if (g.referred_by && String(g.referred_by) !== String(g.owner_id)) mk[k].creators.add(g.referred_by);
    }

    const ready = Object.values(mk).filter((m) => m.live >= DENSITY_GATE);
    if (!ready.length) return res.status(200).json({ ok: true, ...out });

    const known = await sb('circle_markets?select=city,country');
    const seen = new Set((known || []).map((m) => norm(m.city) + '|' + norm(m.country)));

    for (const m of ready) {
      try {
        if (seen.has(norm(m.city) + '|' + norm(m.country))) continue;   // already unlocked

        await sb('circle_markets', {
          method: 'POST', prefer: 'return=minimal',
          body: JSON.stringify({
            city: m.city, country: m.country, live_gyms: m.live,
            disciplines: [...m.disc].join(','),   // what the scene teaches -> ad-copy signal
          }),
        });
        out.unlocked++;
        out.markets.push(`${m.city} (${m.live})`);

        // Tell the co-creators, together. The message names the market, never who brought whom.
        const creators = [...m.creators];
        for (const uid of creators) {
          await notify(uid, 'circle_market',
            `\u{1F534} MTL Circle: ${m.city} je ODEMČENO. ${m.live} živých klubů — dost na to, aby si student vybral. Jsi jeden ze spolutvůrců téhle scény.`,
            { city: m.city });
          out.notified++;
        }

        // And tell every gym owner in the market - they all benefit from the ads.
        const owners = new Set();
        for (const g of gyms || []) {
          if (!isLive(g)) continue;
          if (norm(g.city) !== norm(m.city)) continue;
          if (g.owner_id && !creators.includes(g.owner_id)) owners.add(g.owner_id);
        }
        for (const uid of owners) {
          await notify(uid, 'circle_market',
            `\u{1F534} MTL Circle: ${m.city} je ODEMČENO. Scéna je dost silná na to, aby sem MTL přivádělo studenty.`,
            { city: m.city });
          out.notified++;
        }
      } catch (e) { out.errors.push(`${m.city}: ${e.message}`); }
    }

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('circle-cron', e);
    return res.status(500).json({ error: e.message, ...out });
  }
}
