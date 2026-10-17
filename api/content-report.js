// /api/content-report — NAHLÁŠENÍ OBSAHU (DSA čl. 16) A ROZHODNUTÍ MTL (čl. 16 odst. 5, čl. 17).
//
// Nahlásit jde veřejný profil poskytovatele (klub, kouč, organizace / dodavatel, akce, kurz),
// jakoukoli recenzi a -- poskytovatel -- svého studenta. Oznámení má všechno, co chce čl. 16
// odst. 2: vysvětlení, proč je obsah nezákonný / porušuje podmínky, přesné umístění (odkaz),
// jméno a e-mail oznamovatele a prohlášení o dobré víře (uloží se přesně to znění, které viděl).
// Nahlášený obsah si server sám dohledá a uloží jeho snímek -- klient mu ho podstrčit nemůže.
//
//   POST { action:'report', kind, id, category, explanation, url, good_faith_text, lang }   (jméno a e-mail z účtu)
//        -> potvrzení o přijetí oznamovateli (notifikace + e-mail) a zakladateli úkol s proklikem
//   POST { action:'decide', report_id, status:'no_action'|'restricted', act, ground, text }   (jen zakladatel)
// kind: gym | coach | org (i dodavatel) | event | cohort | gym_review | coach_review | student
//        -> oznamovatel dostane rozhodnutí s možnostmi nápravy; při omezení dostane autor obsahu
//           odůvodnění (čl. 17). Recenzi jde rovnou odstranit (act:'remove_review').

import { providerMail, esc, APP, FOUNDER_UUID } from './_provider-mail.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
const DAY = 86400000;

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}) } });
  if (!r.ok) throw new Error(await r.text());
  if (r.status === 204) return null; const _t = await r.text(); return _t ? JSON.parse(_t) : null;   // POST s return=minimal vrací 201 s prázdným tělem
}
const sbGet = (p) => sb(p).catch(() => []);
const one = async (p) => ((await sbGet(p)) || [])[0] || null;
// Přihlášený uživatel z tokenu. Při neúspěchu vrátí důvod (bez tokenu / stav ověření), ať je
// v hlášce vidět, co selhalo.
async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim(); if (!tok || tok === 'null' || tok === 'undefined') return { why: 'no_token' };
  try { const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }); if (!r.ok) return { why: 'auth_' + r.status }; const u = await r.json(); return (u && u.id) ? u : { why: 'no_user' }; } catch (e) { return { why: 'auth_fetch' }; }
}
async function notify(userId, kind, cs, en, data) {
  if (!userId) return;
  try {
    const lang = ((await one(`profiles?id=eq.${q(userId)}&select=lang`)) || {}).lang;
    await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id: userId, type: 'system', read: false,
      data: JSON.stringify(Object.assign({ kind, msg_cs: cs, msg_en: en }, data)), message: lang === 'en' ? en : cs }) });
  } catch (e) { console.error('[content-report] notify', e.message); }
}

export const CATEGORIES = {
  illegal:   ['Nezákonný obsah nebo činnost', 'Illegal content or activity'],
  scam:      ['Podvod, klamání zákazníků', 'Scam or misleading customers'],
  fake:      ['Falešný profil nebo falešná recenze', 'Fake profile or fake review'],
  hate:      ['Nenávist, obtěžování, vyhrožování', 'Hate, harassment or threats'],
  violence:  ['Násilí nebo nebezpečné jednání', 'Violence or dangerous behaviour'],
  minors:    ['Ohrožení dětí a mladistvých', 'Endangering children or minors'],
  privacy:   ['Zveřejnění osobních údajů, soukromí', 'Personal data or privacy'],
  ip:        ['Porušení autorských práv nebo ochranné známky', 'Copyright or trademark infringement'],
  terms:     ['Porušení podmínek MTL', 'Breach of the MTL terms'],
  other:     ['Jiné', 'Other'],
};
const KINDS = ['gym', 'coach', 'org', 'event', 'cohort', 'gym_review', 'coach_review', 'student'];
const KIND_CS = { gym: 'profil klubu', coach: 'profil kouče', org: 'profil organizace', event: 'akce', cohort: 'kurz', gym_review: 'recenze', coach_review: 'recenze kouče', student: 'uživatel' };
const KIND_EN = { gym: 'club profile', coach: 'coach profile', org: 'organization profile', event: 'event', cohort: 'course', gym_review: 'review', coach_review: 'coach review', student: 'user' };

// Snímek: jen textová pole, která na obsahu člověk vidí (zkrácená).
const SNAP_KEYS = ['name', 'title', 'abbr', 'description', 'bio', 'about', 'motto', 'comment', 'review', 'rating', 'coach_id', 'gym_id', 'city', 'student_name', 'venue', 'date', 'start_date', 'kind', 'created_at'];
const snap = (row) => { const o = {}; SNAP_KEYS.forEach((k) => { if (row && row[k] != null && row[k] !== '') o[k] = typeof row[k] === 'string' ? row[k].slice(0, 2000) : row[k]; }); return o; };
const gymOwner = async (gymId) => ((await one(`gyms?id=eq.${q(gymId)}&select=owner_id`)) || {}).owner_id || null;

// Nahlášený obsah dohledaný serverem: { owner, label, snapshot, gymId } nebo null.
async function resolveTarget(kind, id) {
  if (kind === 'gym') { const g = await one(`gyms?id=eq.${q(id)}&select=*`); return g && { owner: g.owner_id, label: g.name, snapshot: snap(g) }; }
  if (kind === 'coach' || kind === 'student') { const p = await one(`profiles?id=eq.${q(id)}&select=id,name,bio,city,coach_status`); return p && { owner: p.id, label: p.name, snapshot: snap(p) }; }
  if (kind === 'org') { const o = await one(`organizations?id=eq.${q(id)}&select=*`); return o && { owner: o.owner_id, label: o.name, snapshot: snap(o) }; }
  if (kind === 'event') { const e = await one(`events?id=eq.${q(id)}&select=*`); return e && { owner: e.organizer_id || e.owner_id || e.created_by || e.coach_id || (e.gym_id ? await gymOwner(e.gym_id) : null), label: e.title || e.name, snapshot: snap(e) }; }
  if (kind === 'cohort') { const c = await one(`gym_cohorts?id=eq.${q(id)}&select=*`); return c && { owner: c.coach_id || (c.gym_id ? await gymOwner(c.gym_id) : null), label: c.title || c.name, snapshot: snap(c) }; }
  if (kind === 'gym_review') { const r = await one(`gym_ratings?id=eq.${q(id)}&select=*`); return r && { owner: r.student_id, label: (r.student_name || 'Recenze'), snapshot: snap(r), gymId: r.gym_id }; }
  if (kind === 'coach_review') { const r = await one(`bookings?id=eq.${q(id)}&select=id,student_id,student_name,coach_id,rating,review,created_at`); return r && (r.review || r.rating) && { owner: r.student_id, label: (r.student_name || 'Recenze'), snapshot: snap(r) }; }
  return null;
}

// Studenta nahlašuje poskytovatel, se kterým má co do činění: člen / rezervace / docházka v jeho
// klubu, nebo jeho rezervace u kouče.
async function providerOf(me, sid) {
  const own = ((await sbGet(`gyms?owner_id=eq.${q(me)}&select=id`)) || []).map((g) => g.id);
  const staff = ((await sbGet(`gym_coaches?coach_id=eq.${q(me)}&status=eq.active&select=gym_id`)) || []).map((g) => g.gym_id);
  const gids = [...new Set(own.concat(staff))];
  if (gids.length) {
    const inG = `gym_id=in.(${gids.map(q).join(',')})&student_id=eq.${q(sid)}&select=id&limit=1`;
    for (const t of ['gym_memberships', 'gym_bookings', 'gym_attendance', 'gym_class_reservations']) if (((await sbGet(`${t}?${inG}`)) || []).length) return true;
  }
  if (((await sbGet(`bookings?coach_id=eq.${q(me)}&student_id=eq.${q(sid)}&select=id&limit=1`)) || []).length) return true;
  if (((await sbGet(`gym_attendance?coach_id=eq.${q(me)}&student_id=eq.${q(sid)}&select=id&limit=1`)) || []).length) return true;
  return false;
}

const REDRESS_CS = 'S rozhodnutím nesouhlasíš? Odpověz nám na support@martialtraininglab.com (s číslem oznámení) a znovu ho posoudíme. Můžeš se také obrátit na orgán mimosoudního řešení sporů podle čl. 21 nařízení o digitálních službách nebo na soud.';
// Skrýt / vrátit recenzi. Vrací true, když se něco změnilo.
async function hideReview(r0, hide) {
  if (r0.target_kind === 'gym_review') {
    const cur = await one(`gym_ratings?id=eq.${q(r0.target_id)}&select=id,hidden_at`);
    if (!cur || (hide ? cur.hidden_at : !cur.hidden_at)) return false;
    await sb(`gym_ratings?id=eq.${q(r0.target_id)}`, { method: 'PATCH', prefer: 'return=minimal',
      body: JSON.stringify(hide ? { hidden_at: new Date().toISOString(), hidden_report_id: r0.id } : { hidden_at: null, hidden_report_id: null }) });
    return true;
  }
  if (r0.target_kind === 'coach_review') {
    const cur = await one(`bookings?id=eq.${q(r0.target_id)}&select=id,rating,review,review_hidden`);
    if (!cur) return false;
    if (hide) {
      if (cur.review_hidden || (cur.rating == null && !cur.review)) return false;
      await sb(`bookings?id=eq.${q(cur.id)}`, { method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ rating: null, review: null, review_hidden: { rating: cur.rating, review: cur.review, report_id: r0.id, at: new Date().toISOString() } }) });
    } else {
      const h = cur.review_hidden; if (!h) return false;
      await sb(`bookings?id=eq.${q(cur.id)}`, { method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ rating: h.rating == null ? null : h.rating, review: h.review || null, review_hidden: null }) });
    }
    return true;
  }
  return false;
}
const REDRESS_EN = 'Disagree with the decision? Reply to support@martialtraininglab.com (quote the notice number) and we will review it again. You can also turn to an out-of-court dispute settlement body under Art. 21 of the Digital Services Act, or to a court.';

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ ok: false, error: 'not configured' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const u = await whoami(req); if (!u || !u.id) return res.status(401).json({ ok: false, error: `Přihlášení se nepodařilo ověřit (${(u && u.why) || 'auth'}) — odhlas se a přihlas znovu.` });
    const me = u.id;
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    if (b.action === 'report') {
      const kind = String(b.kind || ''), id = String(b.id || '').slice(0, 80);
      const category = String(b.category || ''), explanation = String(b.explanation || '').trim().slice(0, 4000);
      // Oznamovatel = přihlášený účet: jméno z profilu, e-mail z přihlášení (v appce se needitují).
      const prof = await one(`profiles?id=eq.${q(me)}&select=name`);
      const name = String((prof && prof.name) || (u.user_metadata && u.user_metadata.name) || '').trim().slice(0, 120) || 'Uživatel MTL';
      const email = String(u.email || '').trim().slice(0, 160);
      const goodFaith = String(b.good_faith_text || '').trim().slice(0, 600);
      let url = String(b.url || '').trim().slice(0, 500);
      if (!KINDS.includes(kind) || !id) return res.status(400).json({ ok: false, error: 'Neznámý obsah.' });
      if (!CATEGORIES[category]) return res.status(400).json({ ok: false, error: 'Vyber důvod.' });
      if (explanation.length < 20) return res.status(400).json({ ok: false, error: 'Popiš, co je na obsahu špatně (aspoň 20 znaků).' });
      if (!email) return res.status(400).json({ ok: false, error: 'Účet nemá e-mail.' });
      if (!goodFaith) return res.status(400).json({ ok: false, error: 'Potvrď prohlášení o dobré víře.' });
      if (!/^https:\/\//i.test(url)) url = APP;
      // Proti zahlcení: nejvýš 5 oznámení za 24 h (a níž jedno otevřené na stejný obsah).
      const recent = (await sbGet(`content_reports?reporter_id=eq.${q(me)}&created_at=gte.${q(new Date(Date.now() - DAY).toISOString())}&select=id`)) || [];
      if (recent.length >= 5) return res.status(429).json({ ok: false, error: 'Za posledních 24 hodin jsi poslal/a 5 oznámení. Zkus to zítra.' });
      const t = await resolveTarget(kind, id);
      if (!t) return res.status(404).json({ ok: false, error: 'Obsah nenalezen.' });
      if (t.owner && String(t.owner) === String(me)) return res.status(400).json({ ok: false, error: 'Vlastní obsah nahlásit nejde.' });
      if (kind === 'student' && !(await providerOf(me, id))) return res.status(403).json({ ok: false, error: 'Nahlásit můžeš jen svého studenta.' });
      const dup = await one(`content_reports?reporter_id=eq.${q(me)}&target_kind=eq.${q(kind)}&target_id=eq.${q(id)}&status=eq.received&select=id,no`);
      if (dup) return res.status(409).json({ ok: false, error: `Tenhle obsah už máš nahlášený (oznámení DSA-${dup.no}), řešíme ho.` });

      const row = ((await sb('content_reports', { method: 'POST', prefer: 'return=representation', body: JSON.stringify({
        reporter_id: me, reporter_name: name, reporter_email: email, reporter_role: kind === 'student' ? 'provider' : 'visitor',
        target_kind: kind, target_id: id, target_owner_id: t.owner || null, target_label: t.label || null, target_url: url,
        target_snapshot: Object.assign({ gym_id: t.gymId || undefined }, t.snapshot), category, explanation, good_faith_text: goodFaith,
        lang: b.lang === 'en' ? 'en' : 'cs' }) })) || [])[0];
      if (!row) throw new Error('insert failed');
      const no = `DSA-${row.no}`, what = KIND_CS[kind], whatEn = KIND_EN[kind], lbl = t.label ? ` „${t.label}"` : '';
      // Potvrzení o přijetí (čl. 16 odst. 4): v appce i e-mailem.
      await notify(me, 'dsa_received',
        `📨 Oznámení ${no} jsme přijali: ${what}${lbl} (${CATEGORIES[category][0]}). Posoudíme ho a dáme ti vědět, jak jsme rozhodli.`,
        `📨 We received notice ${no}: ${whatEn}${lbl} (${CATEGORIES[category][1]}). We will review it and let you know our decision.`,
        { report_id: row.id, no });
      await providerMail(email, `Přijali jsme oznámení ${no}`, [
        `Dobrý den, ${esc(name)},`,
        `potvrzujeme přijetí vašeho oznámení <b>${esc(no)}</b> ze dne ${esc(new Date(row.created_at).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }))}.`,
        `Nahlášený obsah: ${esc(what)}${esc(lbl)} · <a href="${esc(url)}">${esc(url)}</a><br>Důvod: ${esc(CATEGORIES[category][0])}`,
        `Vaše vysvětlení:<br>${esc(explanation).replace(/\n/g, '<br>')}`,
        `Prohlášení: ${esc(goodFaith)}`,
        'Oznámení posoudíme a o rozhodnutí vás budeme informovat.' ], null);
      // Student nahlášený poskytovatelem: i do evidence rizikových (2+ různí poskytovatelé = příznak
      // u profilu, vidí ho zakladatel v Problémových studentech). Dřív to zapisovala appka sama.
      if (kind === 'student') {
        try {
          await sb('student_reports', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ student_id: id, reporter_id: me, reporter_name: name, reason: `${no} · ${CATEGORIES[category][0]}: ${explanation}`.slice(0, 1000) }) });
          const reps = new Set(((await sbGet(`student_reports?student_id=eq.${q(id)}&select=reporter_id`)) || []).map((x) => x.reporter_id));
          if (reps.size >= 2) await sb(`profiles?id=eq.${q(id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ risk_flag: true, risk_note: `Nahlášen ${reps.size} poskytovateli (naposledy ${name}, ${no}) ${new Date().toISOString().slice(0, 10)}` }) });
        } catch (e) { console.error('[content-report] student_reports', e.message); }
      }
      // Zakladateli s detailem: u recenze hvězdy, začátek textu a kde je (klub / kouč), proklik
      // vede rovnou na recenzi, kde ji jde skrýt.
      let det = '', detEn = '';
      if (kind === 'gym_review' || kind === 'coach_review') {
        const sn = t.snapshot || {}, txt = String(sn.comment || sn.review || '').replace(/\s+/g, ' ').trim();
        let where = '';
        try {
          if (kind === 'gym_review' && t.gymId) where = ((await one(`gyms?id=eq.${q(t.gymId)}&select=name`)) || {}).name || '';
          if (kind === 'coach_review' && sn.coach_id) where = ((await one(`profiles?id=eq.${q(sn.coach_id)}&select=name`)) || {}).name || '';
        } catch (e) {}
        const stars = sn.rating != null ? ` ${'★'.repeat(Math.max(0, Math.min(5, Math.round(Number(sn.rating) || 0))))}` : '';
        const quote = txt ? ` „${txt.slice(0, 140)}${txt.length > 140 ? '…' : ''}"` : '';
        det = `${where ? ' U: ' + where + '.' : ''}${stars}${quote}`;
        detEn = `${where ? ' At: ' + where + '.' : ''}${stars}${quote}`;
      }
      if (FOUNDER_UUID) await notify(FOUNDER_UUID, 'dsa_report_new',
        `🚩 Nové oznámení ${no}: ${what}${lbl} · ${CATEGORIES[category][0]}.${det} Od: ${name}. Důvod: ${explanation.slice(0, 200)}`,
        `🚩 New notice ${no}: ${whatEn}${lbl} · ${CATEGORIES[category][1]}.${detEn} From: ${name}. Reason: ${explanation.slice(0, 200)}`,
        { report_id: row.id, no, target_kind: kind });
      return res.status(200).json({ ok: true, id: row.id, no });
    }

    if (b.action === 'decide') {
      if (!FOUNDER_UUID || String(me) !== FOUNDER_UUID) return res.status(403).json({ ok: false, error: 'forbidden' });
      const status = b.status === 'restricted' ? 'restricted' : (b.status === 'no_action' ? 'no_action' : null);
      const act = String(b.act || '').slice(0, 300), ground = String(b.ground || '').trim().slice(0, 500), text = String(b.text || '').trim().slice(0, 4000);
      if (!status || !text) return res.status(400).json({ ok: false, error: 'Vyber rozhodnutí a napiš odůvodnění.' });
      if (status === 'restricted' && !ground) return res.status(400).json({ ok: false, error: 'U omezení uveď důvod (zákon nebo článek podmínek).' });
      const r0 = await one(`content_reports?id=eq.${q(String(b.report_id || ''))}&select=*`);
      if (!r0) return res.status(404).json({ ok: false, error: 'Oznámení nenalezeno.' });
      if (r0.status !== 'received') return res.status(409).json({ ok: false, error: 'Už je rozhodnuto.' });
      let action = act || (status === 'restricted' ? 'omezeno' : 'bez zásahu');
      // Recenzi jde rovnou SKRÝT (ne smazat -- jde vrátit, snímek zůstává u oznámení). Recenze
      // kouče je hodnocení u rezervace: přesune se do review_hidden, rezervace (platba, doklad)
      // zůstává a hodnocení přestane počítat do průměru kouče.
      if (status === 'restricted' && (b.act === 'hide_review' || b.act === 'remove_review')) {
        if (!(await hideReview(r0, true))) return res.status(409).json({ ok: false, error: 'Recenzi se nepodařilo skrýt (už neexistuje?).' });
        action = 'recenze skryta';
      }
      const actionEn = ({ 'recenze skryta': 'review hidden', 'bez zásahu': 'no action', 'omezeno': 'restricted' })[action] || action;
      const nowIso = new Date().toISOString();
      const upd = ((await sb(`content_reports?id=eq.${q(r0.id)}&status=eq.received`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({
        status, decided_at: nowIso, decided_by: me, decision_action: action, decision_ground: ground || null, decision_text: text }) })) || [])[0];
      if (!upd) return res.status(409).json({ ok: false, error: 'Už je rozhodnuto.' });
      const no = `DSA-${r0.no}`, what = KIND_CS[r0.target_kind], whatEn = KIND_EN[r0.target_kind], lbl = r0.target_label ? ` „${r0.target_label}"` : '';
      // Oznamovateli rozhodnutí (čl. 16 odst. 5).
      const decCs = status === 'restricted' ? `Obsah jsme omezili (${action}).` : 'Obsah jsme posoudili a nezasáhli jsme.';
      const decEn = status === 'restricted' ? `We restricted the content (${actionEn}).` : 'We reviewed the content and took no action.';
      if (r0.reporter_id) await notify(r0.reporter_id, 'dsa_decided', `⚖️ Oznámení ${no} (${what}${lbl}): ${decCs} ${text}`, `⚖️ Notice ${no} (${whatEn}${lbl}): ${decEn} ${text}`, { report_id: r0.id, no });
      await providerMail(r0.reporter_email, `Rozhodnutí k oznámení ${no}`, [
        `Dobrý den, ${esc(r0.reporter_name || '')},`, `k vašemu oznámení <b>${esc(no)}</b> (${esc(what)}${esc(lbl)}): ${esc(decCs)}`,
        `Odůvodnění: ${esc(text).replace(/\n/g, '<br>')}`, esc(REDRESS_CS) ], null);
      // Autorovi při omezení odůvodnění (čl. 17): co, proč, na základě čeho, jak se bránit.
      if (status === 'restricted' && r0.target_owner_id) {
        const cs = `⚖️ Omezili jsme tvůj obsah: ${what}${lbl}. Co jsme udělali: ${action}. Důvod: ${ground}. ${text} Rozhodnutí vychází z oznámení ${no}, posuzoval ho člověk, ne automat. ${REDRESS_CS}`;
        const en = `⚖️ We restricted your content: ${whatEn}${lbl}. Action: ${actionEn}. Ground: ${ground}. ${text} The decision is based on notice ${no} and was made by a person, not automatically. ${REDRESS_EN}`;
        await notify(r0.target_owner_id, 'dsa_restricted', cs, en, { report_id: r0.id, no });
        const ow = await one(`profiles?id=eq.${q(r0.target_owner_id)}&select=email,name`);
        if (ow && ow.email) await providerMail(ow.email, `Omezení obsahu (${no})`, [
          `Dobrý den${ow.name ? ', ' + esc(ow.name) : ''},`, `omezili jsme váš obsah: ${esc(what)}${esc(lbl)}.`,
          `Co jsme udělali: ${esc(action)}<br>Důvod (zákon / podmínky): ${esc(ground)}`, `Odůvodnění: ${esc(text).replace(/\n/g, '<br>')}`,
          `Rozhodnutí vychází z oznámení ${esc(no)} a posuzoval ho člověk, ne automatizovaný systém.`, esc(REDRESS_CS) ], null);
      }
      return res.status(200).json({ ok: true, status, action });
    }
    // Vrátit skrytou recenzi (např. po úspěšném rozporu autora). Jen zakladatel.
    if (b.action === 'unhide_review') {
      if (!FOUNDER_UUID || String(me) !== FOUNDER_UUID) return res.status(403).json({ ok: false, error: 'forbidden' });
      const r0 = await one(`content_reports?id=eq.${q(String(b.report_id || ''))}&select=*`);
      if (!r0 || !/_review$/.test(r0.target_kind)) return res.status(404).json({ ok: false, error: 'Oznámení nenalezeno.' });
      if (!(await hideReview(r0, false))) return res.status(409).json({ ok: false, error: 'Recenze není skrytá.' });
      await sb(`content_reports?id=eq.${q(r0.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({
        decision_action: `${r0.decision_action || ''} · znovu zobrazena ${new Date().toISOString().slice(0, 10)}`.slice(0, 300) }) });
      if (r0.target_owner_id) await notify(r0.target_owner_id, 'dsa_restored',
        `✅ Tvoje recenze (${r0.target_label || ''}) je znovu zobrazená. Rozhodnutí k oznámení DSA-${r0.no} jsme změnili.`,
        `✅ Your review (${r0.target_label || ''}) is visible again. We changed the decision on notice DSA-${r0.no}.`, { report_id: r0.id, no: `DSA-${r0.no}`, gym_id: (r0.target_snapshot || {}).gym_id || null, coach_id: (r0.target_snapshot || {}).coach_id || null });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
}
