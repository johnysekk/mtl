// /api/demand-match-cron — UPOZORNĚNÍ „V OKOLÍ PŘIBYL KLUB / KOUČ" (Vercel Cron, denně).
//
// Kdo vyplnil „Chybí ti tu kluby?" (nebo mu v okolí deck nic neukázal), dostane notifikaci,
// jakmile se do 20 km od místa z jeho poptávky objeví klub nebo kouč (osobní lekce) se
// sportem, který hledal:
//   * klub / kouč se počítá, až když je opravdu vidět v decku: schválený, není skrytý
//     (výmaz, pozastavení, MTL), umí přijmout platbu, má fakturační údaje, u klubu i rozvrh
//     nebo otevřený kurz a pravidla -- stejná pravidla jako v appce (_sellMissing, _mtlPayReady).
//     Dokud to nesplní, čeká a zkouší se každou noc znovu,
//   * poptávka: posledních 120 dní (DEMAND_FRESH_DAYS), kdo už klub našel (resolved), ne,
//   * vzdálenost: vzdušnou čarou mezi bodem klubu (adresa) a bodem poptávky (poloha telefonu,
//     nebo vybrané místo -- obec, čtvrť). V notifikaci se píše „asi X km od <místo z poptávky>",
//   * každý jen jednou za klub / kouče (demand_matches); majitel a tým klubu ne,
//   * kdo zaškrtl „Mám vážný zájem" (platí 90 dní), dostane i e-mail,
//   * proklik vede rovnou na profil klubu / kouče.
// Po rozeslání se klub / kouč označí (demand_notified_at) a už se znovu nerozesílá.
import { LOCAL_KM, DEMAND_FRESH_DAYS, discList, commitLive } from './_geo.js';
import { haversineKm } from './_geo-provider.js';
import { sendMail, shell, para, button, esc, APP_URL } from './_mail.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const q = encodeURIComponent;
const DAY = 86400000;

const sbGet = async (path) => { try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc }); return r.ok ? r.json() : []; } catch (e) { return []; } };
const sbPost = async (path, body, prefer) => { try { const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'POST', headers: { ...svc, Prefer: prefer || 'return=minimal' }, body: JSON.stringify(body) }); return r.ok; } catch (e) { return false; } };
const sbPatch = async (path, body) => { try { const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(body) }); return r.ok; } catch (e) { return false; } };

// Text notifikace appka překreslí sama (NOTIF_T: demand_new_gym / demand_new_coach) se svými
// názvy sportů; tyhle jsou pro e-mail a pro záložní text zprávy.
const DISC_CS = { muay_thai: 'Muay Thai', bjj: 'Brazilské jiu-jitsu', mma: 'MMA', boxing: 'Box', kickboxing: 'Kickbox', judo: 'Judo', karate: 'Karate',
  wrestling: 'Zápas', taekwondo: 'Taekwondo', aikido: 'Aikido', kung_fu: 'Kung-fu', krav_maga: 'Krav Maga', sambo: 'Sambo', capoeira: 'Capoeira',
  grappling: 'Grappling', bare_knuckle: 'Bare-knuckle' };
const discCs = (d) => DISC_CS[d] || String(d || '').replace(/_/g, ' ');
const discEn = (d) => String(d || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ── Je vidět v decku? (serverová kopie _sellMissing / _mtlPayReady z appky) ───────────
const BILLING = ['legal_name', 'tax_id', 'billing_line1', 'billing_city', 'billing_postal', 'billing_country'];
function payReady(e) {
  const mode = e.payment_mode || (e.stripe_account ? 'stripe' : ((e.receiver_id_value || e.receiver_name) ? 'qr_bank' : null));
  if (!mode) return false;
  if (mode === 'stripe') { if (!e.stripe_account || e.charges_enabled === false) return false; }
  else { if (!e.receiver_id_value || !e.receiver_name) return false; if (e.commission_card_status !== 'active') return false; }
  return BILLING.every((f) => !(f in e) || String(e[f] || '').trim());
}
function hasOffer(g, openCohort) {
  if (openCohort) return true;
  let sc = g.schedule; if (typeof sc === 'string') { try { sc = JSON.parse(sc); } catch (e) { sc = []; } }
  const t = new Date().toISOString().slice(0, 10);
  return (sc || []).some((c) => {
    if (!c) return false; if (c.until && c.until < t) return false;
    if (c.once) return !!(c.date && c.date >= t);
    if (Array.isArray(c.slots)) return c.slots.some((s) => s && s.day != null && s.time);
    return c.day != null && !!c.time;
  });
}
function termsReady(g) {
  const has = typeof g.terms_text === 'string' && g.terms_text.trim();
  if (!has) return false;
  return g.org_form !== 'nonprofit' || !!(g.member_app_file_url || g.terms_file_url);
}

// Poptávka do 20 km od bodu: obdélník (rychlý dotaz), pak přesná vzdálenost. Na člověka jeden
// řádek s nejbližším bodem a shodnými sporty.
async function demandNear(lat, lng, discs) {
  const dLat = LOCAL_KM / 110.574 + 0.01, dLng = LOCAL_KM / (111.32 * Math.max(0.05, Math.cos(lat * Math.PI / 180))) + 0.01;
  const fresh = new Date(Date.now() - DEMAND_FRESH_DAYS * DAY).toISOString();
  const rows = await sbGet(`demand_signals?select=user_id,city,disciplines,lat,lng,source,committed,committed_at&source=neq.resolved&last_seen_at=gte.${q(fresh)}`
    + `&lat=gte.${lat - dLat}&lat=lte.${lat + dLat}&lng=gte.${lng - dLng}&lng=lte.${lng + dLng}&limit=20000`);
  const want = new Set(discs);
  const by = {};
  for (const r of rows || []) {
    if (!r.user_id || r.lat == null || r.lng == null) continue;
    const km = haversineKm(lat, lng, +r.lat, +r.lng);
    if (km > LOCAL_KM) continue;
    const hit = discList(r.disciplines).filter((d) => !want.size || want.has(d));
    if (!hit.length) continue;
    const u = by[r.user_id] || (by[r.user_id] = { user_id: r.user_id, km, city: r.city || '', discs: new Set(), committed: false });
    if (km < u.km) { u.km = km; u.city = r.city || u.city; }
    hit.forEach((d) => u.discs.add(d));
    if (commitLive(r.committed, r.committed_at)) u.committed = true;
  }
  return Object.values(by);
}

async function notifyPeople(kind, target, people, skip) {
  if (!people.length) return { notified: 0, emailed: 0 };
  const ids = people.map((p) => p.user_id).filter((u) => !skip.has(String(u)));
  if (!ids.length) return { notified: 0, emailed: 0 };
  // Už upozornění dřív -- znovu ne.
  const done = new Set();
  for (let i = 0; i < ids.length; i += 150) {
    ((await sbGet(`demand_matches?target_kind=eq.${kind}&target_id=eq.${q(target.id)}&user_id=in.(${ids.slice(i, i + 150).map(q).join(',')})&select=user_id`)) || [])
      .forEach((r) => done.add(String(r.user_id)));
  }
  const todo = people.filter((p) => ids.includes(p.user_id) && !done.has(String(p.user_id)));
  const langs = {};
  for (let i = 0; i < todo.length; i += 150) {
    ((await sbGet(`profiles?id=in.(${todo.slice(i, i + 150).map((p) => q(p.user_id)).join(',')})&select=id,lang,email,deleted_at`)) || [])
      .forEach((p) => { langs[p.id] = p; });
  }
  let notified = 0, emailed = 0;
  for (const p of todo) {
    const pr = langs[p.user_id] || {};
    if (pr.deleted_at) continue;
    const km = Math.max(1, Math.round(p.km));
    const disc = [...p.discs][0] || '';
    const from = p.city || '';
    const isGym = kind === 'gym';
    const cs = (isGym ? `🏛️ V okolí přibyl klub: ${target.name}` : `🥊 V okolí přibyl kouč: ${target.name} (osobní lekce)`)
      + ` · ${discCs(disc)}${target.city ? ' · ' + target.city : ''}. Asi ${km} km vzdušnou čarou od ${from ? 'místa z tvé poptávky (' + from + ')' : 'místa z tvé poptávky'}.`;
    const en = (isGym ? `🏛️ A club joined near you: ${target.name}` : `🥊 A coach joined near you: ${target.name} (in-person lessons)`)
      + ` · ${discEn(disc)}${target.city ? ' · ' + target.city : ''}. About ${km} km in a straight line from ${from ? 'the place in your request (' + from + ')' : 'the place in your request'}.`;
    const ok = await sbPost('demand_matches', { user_id: p.user_id, target_kind: kind, target_id: String(target.id), distance_km: Math.round(p.km * 10) / 10, emailed: false }, 'return=minimal,resolution=ignore-duplicates');
    if (!ok) continue;
    await sbPost('notifications', { user_id: p.user_id, type: 'system', read: false, message: pr.lang === 'en' ? en : cs,
      data: JSON.stringify({ kind: isGym ? 'demand_new_gym' : 'demand_new_coach', gym_id: isGym ? target.id : null, coach_id: isGym ? null : target.id,
        name: target.name, city: target.city || null, km, from: from || null, disc, msg_cs: cs, msg_en: en }) });
    notified++;
    if (p.committed && pr.email) {
      const e0 = pr.lang === 'en';
      const link = APP_URL + (isGym ? `/?go=gym&id=${q(target.id)}` : `/?go=coach&id=${q(target.id)}`);
      const html = para(esc(e0 ? en : cs))
        + para(e0 ? 'You ticked that you are seriously interested, so we are letting you know by e-mail as well.' : 'Zaškrtl(a) jsi, že máš vážný zájem, proto ti píšeme i e-mailem.')
        + button(link, e0 ? (isGym ? 'Open the club' : 'Open the coach') : (isGym ? 'Otevřít klub' : 'Otevřít kouče'));
      const r = await sendMail(pr.email, e0 ? `Near you: ${target.name}` : `V okolí: ${target.name}`, shell(e0 ? 'New near you' : 'Nově v okolí', html, e0, false));
      if (r && r.ok) { emailed++; await sbPatch(`demand_matches?user_id=eq.${q(p.user_id)}&target_kind=eq.${kind}&target_id=eq.${q(target.id)}`, { emailed: true }); }
    }
  }
  return { notified, emailed };
}

export default async function handler(req, res) {
  const sec = (process.env.CRON_SECRET || '').trim();
  if (!sec) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  if (String(req.headers.authorization || '') !== `Bearer ${sec}`) return res.status(401).json({ error: 'unauthorized' });
  const out = { gyms: 0, coaches: 0, notified: 0, emailed: 0, waiting: 0, errors: [] };
  const now = new Date().toISOString();
  try {
    // ── KLUBY ──
    const gyms = await sbGet('gyms?select=id,name,city,owner_id,city_lat,city_lng,disciplines,payment_mode,stripe_account,charges_enabled,receiver_id_value,receiver_name,'
      + 'commission_card_status,legal_name,tax_id,billing_line1,billing_city,billing_postal,billing_country,schedule,terms_text,terms_file_url,member_app_file_url,org_form'
      + '&status=eq.approved&demand_notified_at=is.null&deleted_at=is.null&paused_at=is.null&city_lat=not.is.null&limit=200');
    for (const g of gyms || []) {
      try {
        const susp = await sbGet(`gyms?id=eq.${q(g.id)}&select=suspended,account_suspended`);
        if (susp[0] && (susp[0].suspended || susp[0].account_suspended)) { out.waiting++; continue; }
        const coh = await sbGet(`gym_cohorts?gym_id=eq.${q(g.id)}&status=eq.open&select=id&limit=1`);
        if (!payReady(g) || !hasOffer(g, !!(coh && coh.length)) || !termsReady(g)) { out.waiting++; continue; }
        const team = await sbGet(`gym_coaches?gym_id=eq.${q(g.id)}&status=eq.active&select=coach_id`);
        const skip = new Set([String(g.owner_id)].concat((team || []).map((t) => String(t.coach_id))));
        const people = await demandNear(+g.city_lat, +g.city_lng, discList(g.disciplines));
        const r = await notifyPeople('gym', g, people, skip);
        out.notified += r.notified; out.emailed += r.emailed; out.gyms++;
        await sbPatch(`gyms?id=eq.${q(g.id)}`, { demand_notified_at: now });
      } catch (e) { out.errors.push(`gym ${g.id}: ${e.message}`); }
    }
    // ── KOUČI S OSOBNÍMI LEKCEMI ──
    const coaches = await sbGet('profiles?select=id,name,city,city_lat,city_lng,disciplines,rate_inperson,payment_mode,stripe_account,charges_enabled,receiver_id_value,receiver_name,'
      + 'commission_card_status,legal_name,tax_id,billing_line1,billing_city,billing_postal,billing_country,account_suspended'
      + '&coach_status=eq.approved&demand_notified_at=is.null&deleted_at=is.null&deactivated_at=is.null&coach_closing_at=is.null&coach_paused_at=is.null'
      + '&rate_inperson=gt.0&city_lat=not.is.null&limit=200');
    for (const c of coaches || []) {
      try {
        if (c.account_suspended || !payReady(c)) { out.waiting++; continue; }
        const people = await demandNear(+c.city_lat, +c.city_lng, discList(c.disciplines));
        const r = await notifyPeople('coach', c, people, new Set([String(c.id)]));
        out.notified += r.notified; out.emailed += r.emailed; out.coaches++;
        await sbPatch(`profiles?id=eq.${q(c.id)}`, { demand_notified_at: now });
      } catch (e) { out.errors.push(`coach ${c.id}: ${e.message}`); }
    }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message, ...out });
  }
}
