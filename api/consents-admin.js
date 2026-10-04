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
      const rows = (await sbGet(`${f}&select=id,gym_id,student_id,student_name,guest_email,guardian_id,guardian_name,version,body_title,body_text,body_hash,terms_file_url,terms_file_hash,accepted_at&order=accepted_at.desc&limit=${per}&offset=${from}`)) || [];
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
      const gids = scope === 'mtl' ? [...new Set(rows.map((w) => w.gym_id).filter(Boolean))] : [];
      const gn = {};
      if (gids.length) ((await sbGet(`gyms?id=in.(${gids.map(encodeURIComponent).join(',')})&select=id,name`)) || []).forEach((g) => { gn[g.id] = g.name; });
      // PŘIHLÁŠKY ZA ČLENA (spolek) patří mezi doklady souhlasů klubu: žadatel podepsal znění
      // přihlášky. Řádek nese i vyplněné údaje, aby šel zobrazit a stáhnout jako hotový formulář.
      let apps = [];
      if (scope === 'gym') {
        let fa = `gym_member_applications?gym_id=eq.${encodeURIComponent(gymId)}`;
        if (ids) fa += `&student_id=in.(${ids.map(encodeURIComponent).join(',')})`;
        apps = (await sbGet(`${fa}&select=id,student_id,applicant_name,applicant_email,applicant_phone,applicant_birth,is_minor,guardian_name,guardian_contact,app_type,app_text,consent_at,consent_version,source,status,created_at&order=created_at.desc&limit=${per}`)) || [];
      }
      const appRows = apps.map((a) => ({
        id: 'app:' + a.id, kind: 'member_application', title: null, body_text: a.app_text || null,
        who: a.applicant_name || a.applicant_email || '—', accepted_at: a.consent_at || a.created_at,
        version: a.consent_version || null, guardian_name: a.guardian_name || null, guardian_outside: false,
        app: { name: a.applicant_name || null, email: a.applicant_email || null, phone: a.applicant_phone || null, birth: a.applicant_birth || null,
               minor: !!a.is_minor, guardian: a.guardian_name || null, guardian_contact: a.guardian_contact || null,
               type: a.app_type || null, source: a.source || null, status: a.status || null },
      }));
      const merged = rows.map((w) => {
        const e = ev[`${w.gym_id}|${w.student_id}|${w.body_hash}`] || null;
        return {
          id: w.id, kind: 'gym_terms', title: w.body_title || null, body_text: w.body_text || null,
          who: w.student_name || w.guest_email || '—', accepted_at: w.accepted_at,
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
          gym_name: gn[w.gym_id] || null,
          body_hash: w.body_hash || null,
          file_url: w.terms_file_url || null, file_hash: w.terms_file_hash || null,
        };
      }).concat(appRows).sort((x, y) => String(y.accepted_at || '').localeCompare(String(x.accepted_at || '')));
      return res.status(200).json({ ok: true, rows: merged, total: total + appRows.length, page, per });
    }

    // ── ostatní souhlasy (consent_acceptances) ────────────────────────────────────────────
    let f = 'consent_acceptances?select=id,user_id,user_name,user_email,kind,scope,version,lang,version_id,body_hash,accepted_at';
    if (scope === 'coach') f += `&scope=eq.${encodeURIComponent(uid)}`;
    if (scope === 'mtl') {
      const branch = String(q.branch || 'all');
      const list = PROVIDER_KINDS.map(encodeURIComponent).join(',');
      if (branch === 'providers') f += `&kind=in.(${list})`;
      else if (branch === 'students') f += `&kind=not.in.(${list})`;
    }
    if (ids) f += `&user_id=in.(${ids.map(encodeURIComponent).join(',')})`;

    const total = await sbCount(f.replace('select=id,user_id,user_name,user_email,kind,scope,version,lang,version_id,body_hash,accepted_at', 'select=id'));
    const acc = await sbGet(`${f}&order=accepted_at.desc&limit=${per}&offset=${from}`);

    // Jména a znění se dotahují jen pro tuhle stránku, ne pro celou historii.
    const uids = [...new Set((acc || []).map(a => a.user_id).filter(Boolean))];
    const names = {};
    if (uids.length) {
      const ps = await sbGet(`profiles?id=in.(${uids.map(encodeURIComponent).join(',')})&select=id,name,email`);
      (ps || []).forEach(p => { names[p.id] = p.name || p.email || ''; });
    }
    const vids = [...new Set((acc || []).map(a => a.version_id).filter(Boolean))];
    const vmap = {};
    if (vids.length) {
      const vs = await sbGet(`consent_versions?id=in.(${vids.map(encodeURIComponent).join(',')})&select=id,body_text,body_hash`);
      (vs || []).forEach(v => { vmap[v.id] = v; });
    }

    const rows = (acc || []).map(a => {
      const v = a.version_id ? vmap[a.version_id] : null;
      return {
        id: a.id, kind: a.kind, version: a.version, lang: a.lang,
        // Jméno ZE SNÍMKU souhlasu; živý profil jen u starších řádků, které snímek nemají.
        who: a.user_name || a.user_email || names[a.user_id] || '—', accepted_at: a.accepted_at,
        body_text: (v && v.body_text) || null,
        hash_mismatch: !!(v && v.body_hash && a.body_hash && v.body_hash !== a.body_hash),
      };
    });
    return res.status(200).json({ ok: true, rows, total, page, per });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
