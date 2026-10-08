// /api/consents-admin — souhlasy VŮČI JEDNÉ ENTITĚ, s ověřením, kdo se ptá.
//
// scope=gym&id=<gymId>    -> souhlasy studentů vůči tomu klubu (volá majitel klubu)
// scope=coach             -> souhlasy vůči volajícímu kouči
// scope=mtl&branch=...    -> souhlasy vůči MTL (jen zakladatel), větve students|providers|all
//
// Proč přes server: consent_acceptances, consent_versions i waiver_acceptances jsou pod RLS
// a být mají -- je to důkazní materiál. Přímé klientské čtení po zapnutí RLS vrátí TICHE nulu.
//
// Stránkování a hledání se dělá TADY, ne v prohlížeči. Klub s tisíci členy by jinak stahoval
// celou historii souhlasů jen proto, aby z ní ukázal dvacet řádků.
import { resolveParties, partyFor } from './_consent-party.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDER_UUID = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

// Druhy souhlasů podle toho, KDO je dává. Podle toho se dělí větve u MTL.
const PROVIDER_KINDS = ['provider_terms', 'partner', 'receiver_declaration', 'provider_marketing'];

async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc }); return r.ok ? await r.json() : []; }
  catch (e) { return []; }
}
async function sbCount(path) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { ...svc, Prefer: 'count=exact', Range: '0-0' } });
    const cr = r.headers.get('content-range') || '';
    const n = parseInt((cr.split('/')[1] || '0'), 10);
    return isNaN(n) ? 0 : n;
  } catch (e) { return 0; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const token = req.headers['x-access-token'] || ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!token) return res.status(401).json({ error: 'no token' });
    if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });

    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const uid = ((await ures.json()) || {}).id;
    if (!uid) return res.status(401).json({ error: 'no user' });

    const q = req.query || {};
    const scope = String(q.scope || 'gym');
    const per = Math.min(50, Math.max(20, parseInt(q.per, 10) || 20));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const from = (page - 1) * per, to = from + per - 1;
    const search = String(q.q || '').trim();

    // ── kdo smí co ────────────────────────────────────────────────────────────────────────
    if (scope === 'mtl' && uid !== FOUNDER_UUID) return res.status(403).json({ error: 'forbidden' });
    let gymId = null;
    if (scope === 'gym') {
      gymId = String(q.id || '');
      if (!gymId) return res.status(400).json({ error: 'no id' });
      const g = (await sbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id`))[0];
      if (!g || g.owner_id !== uid) return res.status(403).json({ error: 'not owner' });
    }

    // Hledání podle jména: nejdřív najdeme lidi, pak jejich souhlasy. Obráceně to nejde --
    // jméno na řádku souhlasu není (kromě podmínek klubu, kde se ukládá).
    let ids = null;
    if (search) {
      const like = encodeURIComponent('%' + search + '%');
      const ps = await sbGet(`profiles?or=(name.ilike.${like},email.ilike.${like})&select=id&limit=500`);
      ids = (ps || []).map(p => p.id);
      if (!ids.length) return res.status(200).json({ ok: true, rows: [], total: 0, page, per });
    }

    // ── podmínky klubu (waiver_acceptances) ───────────────────────────────────────────────
    // Klub vidí svoje; zakladatel ve větvi 'clubs' všechny kluby (dřív je neviděl vůbec).
    if (scope === 'gym' || (scope === 'mtl' && String(q.branch || '') === 'clubs')) {
      let f = scope === 'gym' ? `waiver_acceptances?gym_id=eq.${encodeURIComponent(gymId)}` : 'waiver_acceptances?id=not.is.null';
      if (ids) f += `&student_id=in.(${ids.map(encodeURIComponent).join(',')})`;
      const total = await sbCount(`${f}&select=id`);
      let rows = (await sbGet(`${f}&select=*&order=accepted_at.desc&limit=${per}&offset=${from}`)) || [];
      // ZÁKONNÝ ZÁSTUPCE MIMO APPKU: jméno sám napsal, doklad o tom, kdo to byl, je jinde --
      // odkaz šel na konkrétní e-mail a máme čas, IP a jestli klikl ze stejného zařízení
      // jako mladistvý (nejsilnější známka, že si souhlas dal sám). Přidá se k řádku.
      const ext = rows.filter((w) => w.guardian_name && !w.guardian_id && w.student_id);
      const ev = {};
      if (ext.length) {
        const mids = [...new Set(ext.map((w) => w.student_id))];
        const reqs = (await sbGet(`guardian_consent_requests?status=eq.approved&minor_id=in.(${mids.map(encodeURIComponent).join(',')})&select=gym_id,minor_id,body_hash,guardian_email,same_device,approved_at,approved_ip,approved_ua,requested_ip,requested_ua,created_at`)) || [];
        reqs.forEach((r) => { ev[`${r.gym_id}|${r.minor_id}|${r.body_hash}`] = r; });
      }
      // IDENTIFIKACE ČLOVĚKA k souhlasu: klub vidí jméno a e-mail; telefon, datum narození, IP a
      // zařízení jen MTL (zakladatel). Telefon si uživatel může klubu kdykoli skrýt, takže ho klub
      // u souhlasů nevidí nikdy.
      const sids = [...new Set(rows.map((w) => w.student_id).filter(Boolean))];
      const prof = {};
      if (sids.length) ((await sbGet(`profiles?id=in.(${sids.map(encodeURIComponent).join(',')})&select=id,name,email,phone,birthdate`)) || []).forEach((p) => { prof[p.id] = p; });
      const gids = scope === 'mtl' ? [...new Set(rows.map((w) => w.gym_id).filter(Boolean))] : [];
      const gn = {};
      if (gids.length) ((await sbGet(`gyms?id=in.(${gids.map(encodeURIComponent).join(',')})&select=id,name`)) || []).forEach((g) => { gn[g.id] = g.name; });
      // PŘIHLÁŠKY ZA ČLENA (spolek) patří mezi doklady souhlasů klubu: žadatel podepsal znění
      // přihlášky. Řádek nese i vyplněné údaje, aby šel zobrazit a stáhnout jako hotový formulář.
      let apps = [];
      if (scope === 'gym') {
        let fa = `gym_member_applications?gym_id=eq.${encodeURIComponent(gymId)}`;
        if (ids) fa += `&student_id=in.(${ids.map(encodeURIComponent).join(',')})`;
        apps = (await sbGet(`${fa}&select=*&order=created_at.desc&limit=${per}`)) || [];
      }
      const appRows = apps.map((a) => ({
        id: 'app:' + a.id, kind: 'member_application', title: null, body_text: a.app_text || null,
        who: a.applicant_name || a.applicant_email || '—', accepted_at: a.consent_at || a.created_at,
        version: a.consent_version || null, guardian_name: a.guardian_name || null, guardian_outside: false,
        ident: { name: a.applicant_name || null, email: a.applicant_email || null, phone: a.applicant_phone || null, account: a.student_id || null, birth: a.applicant_birth || null, ip: null, ua: null },
        app: { name: a.applicant_name || null, email: a.applicant_email || null, phone: a.applicant_phone || null, birth: a.applicant_birth || null,
               minor: !!a.is_minor, guardian: a.guardian_name || null, guardian_contact: a.guardian_contact || null,
               type: a.app_type || null, source: a.source || null, status: a.status || null,
               doc_url: a.doc_url || null, doc_name: a.doc_name || null, doc_hash: a.doc_hash || null },
      }));
      // SOUHLASY Z PŘIHLÁŠKY DO KURZU: podmínky kurzu, souhlas zástupce, provozní řád, marketing.
      // Ukládají se k přihlášce (cohort_members.consents) -- tady se ukážou jako jeden doklad.
      let cohRows = [];
      if (scope === 'gym') {
        let fc = `cohort_members?gym_id=eq.${encodeURIComponent(gymId)}&consents=not.is.null`;
        if (ids) fc += `&student_id=in.(${ids.map(encodeURIComponent).join(',')})`;
        const cms = (await sbGet(`${fc}&select=id,cohort_id,student_id,name,email,for_child,guardian_name,paid_by,consents,consent_at,created_at,status&order=created_at.desc&limit=${per}`)) || [];
        const cids = [...new Set(cms.map((m) => m.cohort_id).filter(Boolean))];
        const cn = {};
        if (cids.length) ((await sbGet(`gym_cohorts?id=in.(${cids.map(encodeURIComponent).join(',')})&select=id,name`)) || []).forEach((c) => { cn[c.id] = c.name; });
        cohRows = cms.filter((m) => m.consents && typeof m.consents === 'object').map((m) => {
          const c = m.consents || {};
          const lines = [];
          if (c.terms && c.terms.text) lines.push(c.terms.text);
          if (c.terms && c.terms.checkbox) lines.push('\u2611 ' + c.terms.checkbox);
          if (c.guardian && c.guardian.text) lines.push('\u2611 ' + c.guardian.text);
          if (c.rules && c.rules.checkbox) lines.push('\u2611 ' + c.rules.checkbox);
          if (c.marketing && c.marketing_text) lines.push('\u2611 ' + c.marketing_text);
          return {
            id: 'coh:' + m.id, kind: 'course_signup', title: (cn[m.cohort_id] ? ('Kurz \u201e' + cn[m.cohort_id] + '\u201c') : null),
            body_text: lines.join('\n\n') || null, plain: true,
            who: m.name || m.email || '\u2014', accepted_at: c.at || m.consent_at || m.created_at,
            version: null, guardian_name: (m.for_child ? (m.guardian_name || null) : null), guardian_outside: false,
            ident: { name: m.name || null, email: m.email || null, phone: null, account: m.student_id || null, birth: null,
                     ip: scope === 'mtl' ? (c.ip || null) : null, ua: scope === 'mtl' ? (c.user_agent || null) : null },
            body_hash: (c.terms && c.terms.hash) || null,
          };
        });
      }
      const merged = rows.map((w) => {
        const e = ev[`${w.gym_id}|${w.student_id}|${w.body_hash}`] || null;
        return {
          id: w.id, kind: 'gym_terms', title: w.body_title || null, body_text: w.body_text || null,
          who: w.student_name || w.guest_email || '—', accepted_at: w.accepted_at,
          ident: { name: w.student_name || (prof[w.student_id] || {}).name || null, email: w.guest_email || (prof[w.student_id] || {}).email || null,
                   phone: scope === 'mtl' ? ((prof[w.student_id] || {}).phone || null) : null, account: w.student_id || null,
                   birth: scope === 'mtl' ? ((prof[w.student_id] || {}).birthdate || null) : null,
                   ip: scope === 'mtl' ? (w.ip || null) : null, ua: scope === 'mtl' ? (w.user_agent || null) : null },
          version: w.version, guardian_name: w.guardian_name || null,
          guardian_outside: !!(w.guardian_name && !w.guardian_id),
          guardian_email: e ? e.guardian_email : null, same_device: e ? !!e.same_device : null,
          // Důkazy k souhlasu mimo appku: kdy a odkud o souhlas požádal mladistvý, kdy a odkud
          // ho zákonný zástupce potvrdil.
          // IP a zařízení vidí jen zakladatel (případný spor řeší MTL); klub vidí, komu šel odkaz
          // a jestli se potvrzovalo ze zařízení mladistvého.
          requested_at: e ? e.created_at : null,
          requested_ip: (e && scope === 'mtl') ? e.requested_ip : null, requested_ua: (e && scope === 'mtl') ? e.requested_ua : null,
          approved_ip: (e && scope === 'mtl') ? e.approved_ip : null, approved_ua: (e && scope === 'mtl') ? e.approved_ua : null,
          gym_name: gn[w.gym_id] || null, gym_id: w.gym_id || null,
          body_hash: w.body_hash || null,
          file_url: w.terms_file_url || null, file_hash: w.terms_file_hash || null,
        };
      }).concat(appRows).concat(cohRows).sort((x, y) => String(y.accepted_at || '').localeCompare(String(x.accepted_at || '')));
      // Vůči komu: klub (poskytovatel). U přihlášek a kurzů je to ten klub, za který se volá.
      try { const _gp = await resolveParties(sbGet, merged.map((r) => r.gym_id || (scope === 'gym' ? gymId : null))); merged.forEach((r) => { const k = r.gym_id || (scope === 'gym' ? gymId : null); r.party = (k && _gp[k]) || null; }); } catch (e) {}
      return res.status(200).json({ ok: true, rows: merged, total: total + appRows.length + cohRows.length, page, per });
    }

    // ── ostatní souhlasy (consent_acceptances) ────────────────────────────────────────────
    let f = 'consent_acceptances?select=id,user_id,user_name,user_email,kind,scope,version,lang,version_id,body_hash,accepted_at,ip,user_agent,meta';
    if (scope === 'coach') f += `&scope=eq.${encodeURIComponent(uid)}`;
    if (scope === 'mtl') {
      const branch = String(q.branch || 'all');
      const list = PROVIDER_KINDS.map(encodeURIComponent).join(',');
      if (branch === 'providers') f += `&kind=in.(${list})`;
      else if (branch === 'students') f += `&kind=not.in.(${list})`;
    }
    if (ids) f += `&user_id=in.(${ids.map(encodeURIComponent).join(',')})`;

    const total = await sbCount(f.replace('select=id,user_id,user_name,user_email,kind,scope,version,lang,version_id,body_hash,accepted_at,ip,user_agent,meta', 'select=id'));
    const acc = await sbGet(`${f}&order=accepted_at.desc&limit=${per}&offset=${from}`);

    // Jména a znění se dotahují jen pro tuhle stránku, ne pro celou historii.
    const uids = [...new Set((acc || []).map(a => a.user_id).filter(Boolean))];
    const names = {};
    if (uids.length) {
      const ps = await sbGet(`profiles?id=in.(${uids.map(encodeURIComponent).join(',')})&select=id,name,email,phone,birthdate`);
      (ps || []).forEach(p => { names[p.id] = p.name || p.email || ''; names['_p_' + p.id] = p; });
    }
    const vids = [...new Set((acc || []).map(a => a.version_id).filter(Boolean))];
    const vmap = {};
    if (vids.length) {
      const vs = await sbGet(`consent_versions?id=in.(${vids.map(encodeURIComponent).join(',')})&select=id,body_text,body_hash`);
      (vs || []).forEach(v => { vmap[v.id] = v; });
    }

    let _parties = {}; try { _parties = await resolveParties(sbGet, (acc || []).map((a) => a.scope)); } catch (e) {}
    const rows = (acc || []).map(a => {
      const v = a.version_id ? vmap[a.version_id] : null;
      return {
        id: a.id, kind: a.kind, version: a.version, lang: a.lang, party: partyFor(a, _parties),
        // Jméno ZE SNÍMKU souhlasu; živý profil jen u starších řádků, které snímek nemají.
        who: a.user_name || a.user_email || names[a.user_id] || '—', accepted_at: a.accepted_at,
        body_text: (v && v.body_text) || null,
        hash_mismatch: !!(v && v.body_hash && a.body_hash && v.body_hash !== a.body_hash),
        ident: (function(){ const p = names['_p_' + a.user_id] || {}; const mtl = scope === 'mtl';
          return { name: a.user_name || p.name || null, email: a.user_email || p.email || null, phone: mtl ? (p.phone || null) : null, account: a.user_id || null,
                   birth: mtl ? (p.birthdate || null) : null, ip: mtl ? (a.ip || null) : null, ua: mtl ? (a.user_agent || null) : null }; })(),
      };
    });
    return res.status(200).json({ ok: true, rows, total, page, per });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
