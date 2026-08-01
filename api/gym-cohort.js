// /api/gym-cohort — the demand cohort that was WAITING for this gym's sport nearby.
// GET  ?gymId  -> { ok, count, committed, disciplines }  (owner/founder only; aggregate, no PII)
// POST ?gymId  { discount_pct, expires_days } -> sends the waiting cohort a WELCOME-OFFER
//      notification (optional discount is the gym's choice) and logs hotspot_offers. -> { ok, notified }
// Server-side + service-role: the gym never reads others' signals or writes others' notifications client-side.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
import { LOCAL_KM, DEMAND_THRESHOLD, DEMAND_FRESH_DAYS, DEMAND_BANDS_KM, commitLive, discList as _discList, OPPORTUNITY_MIN_PEOPLE, OPPORTUNITY_MAX } from './_geo.js';
const RADIUS_KM = LOCAL_KM;   // was 25 -- a club must not be handed people the app never showed it
const FRESH_DAYS = DEMAND_FRESH_DAYS;
const THRESHOLD = DEMAND_THRESHOLD; // the cohort surfaces to the gym only at 15+ unique people (small-number privacy)

async function pagedGet(path) {
  let out = [], PAGE = 1000;
  for (let off = 0; off <= 1000000; off += PAGE) {
    const r = await fetch(`${SB}/rest/v1/${path}&limit=${PAGE}&offset=${off}`, { headers: svc });
    if (!r.ok) break;
    const page = await r.json();
    if (!Array.isArray(page) || page.length === 0) break;
    out = out.concat(page);
    if (page.length < PAGE) break;
  }
  return out;
}
function hav(la1, lo1, la2, lo2) {
  const R = 6371, toR = x => x * Math.PI / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const _RL_SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _RL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
function _rlIp(req) { const xr = req.headers['x-real-ip']; if (xr) return String(xr).trim(); const p = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return p.length ? p[p.length - 1] : ((req.socket && req.socket.remoteAddress) || 'unknown'); }
async function _rlAllow(endpoint, ip, limit, banMult) {
  try {
    const win = Math.floor(Date.now() / 600000);
    const r = await fetch(_RL_SUPA + '/rest/v1/rpc/rl_hit', { method: 'POST', headers: { apikey: _RL_KEY, Authorization: 'Bearer ' + _RL_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: ip + ':' + endpoint + ':' + win, p_ip: ip, p_endpoint: endpoint, p_window: win, p_limit: limit, p_ban_mult: banMult || 0 }) });
    if (!r.ok) return true;
    let _j = await r.json();
    if (Array.isArray(_j)) _j = _j[0];
    else if (_j && typeof _j === 'object') _j = Object.values(_j)[0];
    return _j !== false && _j !== 'false';
  } catch (e) { return true; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let b = {};
    if (req.method === 'POST') { try { b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (e) { b = {}; } }
    const gymId = req.query.gymId || b.gymId;
    const token = req.headers['x-access-token'] || b.token ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!gymId) return res.status(400).json({ error: 'no gymId' });
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    // verify caller
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });
    if (!(await _rlAllow('gym-cohort', 'u:' + uid, 60))) return res.status(429).json({ ok: false, error: 'Too many requests' });

    // load gym + ownership (founder may also act)
    const gres = await fetch(`${SB}/rest/v1/gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id,city_lat,city_lng,disciplines,name,city,country`, { headers: svc });
    const grows = gres.ok ? await gres.json() : [];
    if (!grows.length) return res.status(404).json({ error: 'no gym' });
    const gym = grows[0];
    let isFounder = false;
    if (gym.owner_id !== uid) {
      const pr = await fetch(`${SB}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: svc });
      const prows = pr.ok ? await pr.json() : [];
      isFounder = prows.length && prows[0].role === 'founder';
      if (!isFounder) return res.status(403).json({ error: 'not owner' });
    }

    const glat = gym.city_lat != null ? +gym.city_lat : null;
    const glng = gym.city_lng != null ? +gym.city_lng : null;
    if (glat == null || glng == null || !isFinite(glat) || !isFinite(glng)) return res.status(200).json({ ok: true, count: 0, committed: 0, disciplines: [], note: 'gym has no coords' });
    const gymDisc = new Set(_discList(gym.disciplines));

    // pull recent demand in a bounding box, exact-filter by haversine + discipline intersection + strong signal
    const dLat = 0.32, dLng = 0.32 / Math.max(0.2, Math.cos(glat * Math.PI / 180));
    const fresh = new Date(Date.now() - FRESH_DAYS * 86400000).toISOString();
    // freshness now runs on last_seen_at, not created_at: created_at is when they FIRST said it
    // and must never move, last_seen_at is "are they still looking". And anyone who has since
    // found a club (source='resolved') is out of the queue -- a queue full of people already
    // training somewhere is worthless and quietly inflates the number we show clubs.
    const rows = await pagedGet(`demand_signals?select=user_id,disciplines,lat,lng,committed,committed_at,source,opens,form_at,windows,levels,wanted_gyms&source=neq.resolved&last_seen_at=gte.${fresh}&lat=gte.${glat - dLat}&lat=lte.${glat + dLat}&lng=gte.${glng - dLng}&lng=lte.${glng + dLng}`);

    // A single total hides the distribution, and the distribution is the whole story: 3 people
    // 2 km away will almost certainly come, 6 people 19 km away almost certainly will not -- they
    // will go somewhere nearer. A club that opens a 06:30 class expecting 14 and gets 4 never
    // trusts this data again, so the panel must lead with the NEAREST band, not the total.
    // The distance was already being computed here and thrown away as a filter; now it is kept.
    const matchUsers = new Set(), committedUsers = new Set(), discCount = {};
    const bandUsers = DEMAND_BANDS_KM.map(() => new Set());
    // The threshold is measured on people who FILLED THE FORM, not on every signal: a passive one is
    // somebody who opened an empty deck and said nothing, and gating on those is weak.
    const formUsers = new Set();
    const winCount = {}, lvlCount = {};
    // window|level -> Set of people, plus their distances, so each opportunity can carry its own
    // bands rather than inheriting the totals.
    const pairUsers = {}, pairDist = {};
    for (const r of rows) {
      if (r.lat == null || r.lng == null) continue;
      const dKm = hav(glat, glng, +r.lat, +r.lng);
      if (dKm > RADIUS_KM) continue;
      // ATTRIBUTION IS NAMED, NOT COMPUTED. The person picked which clubs they would go to, having
      // just swiped past them; distance decides nothing here. A radius could never tell apart
      // 21 km / 70 minutes from 3 km / 8 minutes inside one city, and no amount of location
      // precision fixes that -- even exact GPS says where somebody stood, not where they would
      // travel from.
      //
      // Rows written before the form existed carry no list, so they fall back to the radius they
      // were collected under. Dropping them would erase real demand to enforce a rule that did not
      // exist when they were made.
      const _want = String(r.wanted_gyms || '').split(',').map(x => x.trim()).filter(Boolean);
      if (r.form_at && _want.indexOf(String(gymId)) < 0) continue;
      const ds = (r.disciplines || '').split(',').map(x => x.trim()).filter(Boolean);
      const hit = gymDisc.size ? ds.some(d => gymDisc.has(d)) : ds.length > 0;
      if (!hit) continue;
      const strong = (r.source !== 'passive') || ((r.opens || 1) >= 3);
      if (!strong) continue;
      if (r.user_id) {
        matchUsers.add(r.user_id);
        if (commitLive(r.committed, r.committed_at)) committedUsers.add(r.user_id);
        // cumulative: someone 3 km away counts in the 5, 10 and 20 km bands
        for (let bi = 0; bi < DEMAND_BANDS_KM.length; bi++) {
          if (dKm <= DEMAND_BANDS_KM[bi]) bandUsers[bi].add(r.user_id);
        }
        if (r.form_at) {
          formUsers.add(r.user_id);
          const _ws = (r.windows || '').split(',').map(x => x.trim()).filter(Boolean);
          const _ls = (r.levels || '').split(',').map(x => x.trim()).filter(Boolean);
          _ws.forEach(w => { winCount[w] = (winCount[w] || 0) + 1; });
          _ls.forEach(l => { lvlCount[l] = (lvlCount[l] || 0) + 1; });
          // The audience is the WHOLE combination, not each label separately. Crossing them one by
          // one turned "advanced + women" and "beginner + women" into a single "women: 4", and the
          // club could not tell whether to open a beginners' or an advanced women's class -- the
          // one thing it needed to know. Sorted so the same combination always keys the same way
          // regardless of the order somebody tapped the chips.
          const _key = _ls.slice().sort().join('+');
          _ws.forEach(w => {
            const k = w + '|' + _key;
            (pairUsers[k] = pairUsers[k] || new Set()).add(r.user_id);
            (pairDist[k] = pairDist[k] || []).push(dKm);
          });
        }
      }
      ds.forEach(d => { if (!gymDisc.size || gymDisc.has(d)) discCount[d] = (discCount[d] || 0) + 1; });
    }
    const disciplines = Object.entries(discCount).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n }));

    // Build the opportunity list: window x level pairs, each with its own distance bands. A club
    // decides on a concrete class, not on two abstract rankings.
    const _pairs = Object.keys(pairUsers).map(k => {
      const [w, l] = k.split('|');
      const ds = pairDist[k] || [];
      return {
        window: w, levels: (l ? l.split('+') : []), count: pairUsers[k].size,
        bands: DEMAND_BANDS_KM.map(km => ({ km, count: ds.filter(d => d <= km).length })),
      };
    }).sort((a, b) => b.count - a.count);
    const _strong = _pairs.filter(p => p.count >= OPPORTUNITY_MIN_PEOPLE);
    const _opps = _strong.slice(0, OPPORTUNITY_MAX);
    // Everything below the bar is summarised, never silently dropped -- a club that sees "3 further
    // smaller requests" knows something is forming; one that sees nothing assumes there is nothing.
    const _weak = _pairs.filter(p => _opps.indexOf(p) < 0);
    const _restU = new Set();
    _weak.forEach(p => { const k = p.window + '|' + (p.levels || []).join('+'); (pairUsers[k] || new Set()).forEach(u => _restU.add(u)); });
    const _oppRest = { groups: _weak.length, people: _restU.size };

    if (req.method !== 'POST') {
      const enough = formUsers.size >= THRESHOLD;
      return res.status(200).json(enough
        ? { ok: true, enough: true, threshold: THRESHOLD, count: matchUsers.size, forms: formUsers.size,
            committed: committedUsers.size, disciplines,
            bands: DEMAND_BANDS_KM.map((km, i) => ({ km, count: bandUsers[i].size })),
            windows: Object.entries(winCount).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n })),
            levels: Object.entries(lvlCount).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ v, n })),
            opportunities: _opps, opportunities_rest: _oppRest }
        : { ok: true, enough: false, threshold: THRESHOLD, forms: formUsers.size });   // below threshold: hide the numbers, show only progress
    }
    if (formUsers.size < THRESHOLD) return res.status(400).json({ error: 'not enough demand', threshold: THRESHOLD });

    // POST action=sounding: ask the waiting cohort whether they would come, WITHOUT opening
    // anything. A club that lists a class and then finds nobody comes never trusts this data
    // again, and once the room and the coach are booked the days are expensive to move. Asking
    // is free, so even a cautious owner will try it -- and a concrete answer beats an estimate.
    //
    // It lives here rather than in the client because the recipient ids must never leave the
    // server: the club is told HOW MANY, never WHO.
    if (b.action === 'sounding') {
      const ids = Array.from(matchUsers);
      if (!ids.length) return res.status(400).json({ ok: false, error: 'nobody to ask' });

      const disc = String(b.discipline || (disciplines.length ? disciplines[0].v : '') || '').trim();
      const dys = String(b.days || '').split(',').map(x => x.trim()).filter(Boolean).join(',');
      if (!disc || !dys) return res.status(400).json({ ok: false, error: 'discipline + days required' });

      // send_sounding enforces ownership and the one-per-30-days cap, so a failure here is a
      // real refusal and must surface rather than be swallowed.
      const sr = await fetch(`${SB}/rest/v1/rpc/send_sounding`, {
        method: 'POST', headers: { ...svc },
        body: JSON.stringify({ p_gym_id: gymId, p_disc: disc, p_window: b.window || null,
          p_level: b.level || null, p_days: dys, p_time: b.time || null, p_user_ids: ids }),
      });
      if (!sr.ok) {
        const t = await sr.text().catch(() => '');
        return res.status(400).json({ ok: false, error: 'sounding refused', detail: t.slice(0, 200) });
      }
      const soundingId = await sr.json().catch(() => null);

      const nm2 = gym.name || 'Klub';
      const dayCs = { po: 'Po', ut: '\u00dat', st: 'St', ct: '\u010ct', pa: 'P\u00e1', so: 'So', ne: 'Ne' };
      const dTxt = dys.split(',').map(d => dayCs[d] || d).join(' a ');
      const tTxt = b.time ? (' v ' + b.time) : '';
      const payload2 = ids.map(u => ({
        user_id: u, type: 'system', read: false,
        data: JSON.stringify({ kind: 'sounding_ask', sounding_id: soundingId, gym_id: gymId, gym_name: nm2, days: dys, time: b.time || null, disc }),
        // Deliberately conditional wording. If people answer and nothing ever happens, we have
        // burned their willingness to answer the next one.
        message: '\uD83E\uDD14 ' + nm2 + ' zva\u017euje otev\u0159\u00edt lekci ' + dTxt + tTxt + '. P\u0159i\u0161el bys? Nen\u00ed to z\u00e1vazn\u00e9 \u2014 pom\u016f\u017ee to klubu rozhodnout.',
      }));
      let sent = 0;
      for (let i = 0; i < payload2.length; i += 500) {
        const chunk = payload2.slice(i, i + 500);
        const rr = await fetch(`${SB}/rest/v1/notifications`, { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
        if (rr.ok) sent += chunk.length;
      }
      return res.status(200).json({ ok: true, sounding_id: soundingId, asked: sent });
    }

    // POST: send the waiting cohort a welcome-offer notification (discount optional)
    const pct = Math.max(0, Math.min(100, parseInt(b.discount_pct, 10) || 0));
    const days = Math.max(0, Math.min(365, parseInt(b.expires_days, 10) || 0));
    const expires = days ? new Date(Date.now() + days * 86400000).toISOString() : null;
    const topDisc = disciplines.length ? disciplines[0].v : null;

    await fetch(`${SB}/rest/v1/hotspot_offers`, { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' },
      body: JSON.stringify({ gym_id: gymId, disc: topDisc, discount_pct: pct || null, expires_at: expires }) });

    const ids = Array.from(matchUsers);
    const nm = gym.name || 'A gym';
    const where = gym.city ? (' v ' + gym.city) : '';
    const offerCz = pct ? (' a dává ti uvítací slevu ' + pct + '%' + (days ? (' (platí ' + days + ' dní)') : '')) : '';
    const offerEn = pct ? (' and is giving you a welcome discount of ' + pct + '%' + (days ? (' (valid ' + days + ' days)') : '')) : '';
    const msgCz = '\uD83C\uDF89 ' + nm + ' u\u010D\u00ED sport, kter\u00FD jsi hledal' + where + offerCz + '. Najde\u0161 ho v MTL appce.';
    const msgEn = '\uD83C\uDF89 ' + nm + ' teaches the sport you were looking for' + offerEn + '. Find it in the MTL app.';

    const payload = ids.map(u => ({
      user_id: u, type: 'system', read: false,
      data: JSON.stringify({ kind: 'welcome_offer', gym_id: gymId, disc: topDisc, discount_pct: pct || null, expires_at: expires }),
      message: msgCz + ' / ' + msgEn,
    }));
    let notified = 0;
    for (let i = 0; i < payload.length; i += 500) {
      const chunk = payload.slice(i, i + 500);
      const r = await fetch(`${SB}/rest/v1/notifications`, { method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(chunk) });
      if (r.ok) notified += chunk.length;
    }
    return res.status(200).json({ ok: true, notified, count: matchUsers.size, committed: committedUsers.size, discount_pct: pct, expires_days: days });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
