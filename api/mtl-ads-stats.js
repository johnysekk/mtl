// /api/mtl-ads-stats.js — čísla reklamního programu pro Admin → MTL Ads.
//
// CO TO POČÍTÁ: kolik lidí reklama přivedla, co u poskytovatelů utratili, kolik z toho
// zůstalo MTL, a jak si vedou jednotlivé kluby. Bez toho se kampaň nedá řídit — Ads Manager
// ukáže náklady, ale ne to, co se z toho vrátilo přes provize.
//
// GET /api/mtl-ads-stats?months=6   (Authorization: Bearer <token foundera>)
// Jen founder; ověřuje se token proti databázi.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function sbGet(path) {
  const out = [];
  const PAGE = 1000;
  for (let off = 0; off <= 100000; off += PAGE) {
    const r = await fetch(`${SB}/rest/v1/${path}&limit=${PAGE}&offset=${off}`, { headers: svc });
    if (!r.ok) break;
    const page = await r.json();
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

const ym = (d) => String(d || '').slice(0, 7);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = req.headers['x-access-token'] ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!token) return res.status(401).json({ error: 'no token' });
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const uid = (await ures.json()).id;
    const pr = await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=role`);
    if (!pr.length || pr[0].role !== 'founder') return res.status(403).json({ error: 'founder only' });

    const months = Math.max(1, Math.min(24, parseInt(req.query.months, 10) || 6));
    const since = new Date(); since.setMonth(since.getMonth() - months);
    const sinceISO = since.toISOString();

    // ── STAV PROGRAMU ─────────────────────────────────────────────────────────────────
    const ps = await sbGet('platform_settings?id=eq.1&select=ads_program_on');
    const programOn = !!(ps && ps[0] && ps[0].ads_program_on);
    const gyms = await sbGet('gyms?status=eq.approved&deleted_at=is.null&select=id,name,city,ads_opt_in,account_suspended');
    const gymName = {}; gyms.forEach(g => { gymName[g.id] = g.name || '—'; });
    const optIn = gyms.filter(g => g.ads_opt_in && !g.account_suspended);

    // ── TRANSAKCE Z REKLAMY ───────────────────────────────────────────────────────────
    const tx = await sbGet(
      `transactions?acq_source=eq.mtl_ads&created_at=gte.${encodeURIComponent(sinceISO)}` +
      '&select=id,created_at,type,gross_amount,mtl_fee,mtl_fee_refunded,currency,gym_id,coach_id,member_id,test_mode'
    );
    const live = tx.filter(t => !t.test_mode);

    const byCur = {};                       // souhrn po měnách
    const byMonth = {};                     // vývoj v čase
    const byGym = {};                       // výkon klubů
    const members = new Set();              // unikátní přivedení lidé
    const membersByGym = {};
    let memberships = 0, dropins = 0;

    live.forEach(t => {
      const cur = String(t.currency || 'CZK').toUpperCase();
      const gross = Number(t.gross_amount) || 0;
      const fee = (Number(t.mtl_fee) || 0) - (Number(t.mtl_fee_refunded) || 0);
      const m = ym(t.created_at);
      const gid = t.gym_id || ('coach:' + (t.coach_id || '?'));

      (byCur[cur] = byCur[cur] || { gross: 0, fee: 0, n: 0 });
      byCur[cur].gross += gross; byCur[cur].fee += fee; byCur[cur].n++;

      (byMonth[m] = byMonth[m] || { gross: 0, fee: 0, n: 0, members: new Set() });
      byMonth[m].gross += gross; byMonth[m].fee += fee; byMonth[m].n++;
      if (t.member_id) byMonth[m].members.add(t.member_id);

      (byGym[gid] = byGym[gid] || { gross: 0, fee: 0, n: 0 });
      byGym[gid].gross += gross; byGym[gid].fee += fee; byGym[gid].n++;

      if (t.member_id) {
        members.add(t.member_id);
        (membersByGym[gid] = membersByGym[gid] || new Set()).add(t.member_id);
      }
      if (t.type === 'membership') memberships++; else dropins++;
    });

    // ── PRŮMĚRNÁ HODNOTA PŘIVEDENÉHO ČLOVĚKA ──────────────────────────────────────────
    // Tohle je číslo, proti kterému se v Ads Manageru poměřuje cena za konverzi.
    const mainCur = Object.keys(byCur).sort((a, b) => byCur[b].fee - byCur[a].fee)[0] || 'CZK';
    const feeMain = (byCur[mainCur] && byCur[mainCur].fee) || 0;
    const perMember = members.size ? Math.round(feeMain / members.size) : 0;

    const monthsOut = Object.keys(byMonth).sort().map(k => ({
      month: k, gross: byMonth[k].gross, fee: byMonth[k].fee,
      transactions: byMonth[k].n, members: byMonth[k].members.size,
    }));

    const gymsOut = Object.keys(byGym).map(k => ({
      gym_id: k, name: gymName[k] || k,
      members: (membersByGym[k] ? membersByGym[k].size : 0),
      gross: byGym[k].gross, fee: byGym[k].fee, transactions: byGym[k].n,
    })).sort((a, b) => b.fee - a.fee).slice(0, 50);

    return res.status(200).json({
      ok: true,
      program_on: programOn,
      months,
      feed: {
        clubs_total: gyms.length,
        clubs_opt_in: optIn.length,
        // Kolik jich reálně v katalogu je, řekne feed sám (má i podmínku plateb a fotky).
        feed_url: (process.env.APP_URL || 'https://app.martialtraininglab.com') + '/api/meta-feed',
      },
      totals: {
        currency: mainCur,
        members: members.size,
        transactions: live.length,
        memberships, dropins,
        gross: (byCur[mainCur] && byCur[mainCur].gross) || 0,
        fee: feeMain,
        fee_per_member: perMember,
        by_currency: byCur,
      },
      months_series: monthsOut,
      gyms: gymsOut,
    });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
