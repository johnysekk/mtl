// /api/my-consents — vrátí souhlasy PŘIHLÁŠENÉHO uživatele i s přesným zněním, které viděl.
//
// Proč přes server a ne z prohlížeče: consent_acceptances a consent_versions jsou pod RLS
// (a být mají — je to důkazní materiál). Přímý klientský dotaz po jejím zapnutí vrátí TICHE
// nula řádků, takže by uživateli souhlasy zmizely a nikdo by si toho nevšiml. Service role
// za ověřeným tokenem je jediné čtení, které to přežije.
//
// Vrací dvě skupiny, protože se ukládají na dvou místech a obě jsou pro člověka „jeho souhlas":
//   consents — VOP, GDPR, beta NDA, souhlas se soukromkou mladistvého… (consent_acceptances)
//   waivers  — podmínky konkrétního klubu (waiver_acceptances)
//
// Znění se NEskládá znovu jako doklad: vrací se přesně to, co bylo uloženo v okamžiku přijetí.
// U dokladu je správně opak (data rozhodují), tady rozhoduje text, který člověk četl.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc }); return r.ok ? await r.json() : []; }
  catch (e) { return []; }
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
    const user = await ures.json();
    const uid = user && user.id;
    if (!uid) return res.status(401).json({ error: 'no user' });

    const acc = await sbGet(`consent_acceptances?user_id=eq.${encodeURIComponent(uid)}&select=id,kind,scope,version,lang,version_id,body_hash,accepted_at,ip,user_agent&order=accepted_at.desc&limit=500`);

    // Znění po dávkách -- jedna verze pokrývá klidně stovky přijetí, takže se text nestahuje
    // dokola pro každý řádek zvlášť.
    const vids = [...new Set((acc || []).map(a => a.version_id).filter(Boolean))];
    const vmap = {};
    for (let i = 0; i < vids.length; i += 50) {
      const chunk = vids.slice(i, i + 50).map(encodeURIComponent).join(',');
      const vs = await sbGet(`consent_versions?id=in.(${chunk})&select=id,kind,version,lang,body_text,body_hash`);
      (vs || []).forEach(v => { vmap[v.id] = v; });
    }

    const consents = (acc || []).map(a => {
      const v = a.version_id ? vmap[a.version_id] : null;
      return {
        id: a.id, kind: a.kind, scope: a.scope || null, version: a.version, lang: a.lang,
        accepted_at: a.accepted_at, ip: a.ip || null, user_agent: a.user_agent || null,
        body_text: (v && v.body_text) || null,
        // Když se hash přijetí liší od hashe uložené verze, text pod tou verzí se změnil bez
        // navýšení čísla. Nezamlčovat -- ať je na dokladu vidět, že znění není jisté.
        hash_mismatch: !!(v && v.body_hash && a.body_hash && v.body_hash !== a.body_hash),
      };
    });

    // Podmínky klubů. body_text se ukládá přímo k přijetí, takže žádné dohledávání verze.
    const wav = await sbGet(`waiver_acceptances?student_id=eq.${encodeURIComponent(uid)}&select=id,gym_id,version,body_title,body_text,body_hash,accepted_at,guardian_name,student_name&order=accepted_at.desc&limit=500`);
    const gids = [...new Set((wav || []).map(w => w.gym_id).filter(Boolean))];
    const gmap = {};
    if (gids.length) {
      const gs = await sbGet(`gyms?id=in.(${gids.map(encodeURIComponent).join(',')})&select=id,name,legal_name`);
      (gs || []).forEach(g => { gmap[g.id] = g.legal_name || g.name || ''; });
    }
    const waivers = (wav || []).map(w => ({
      id: w.id, gym_id: w.gym_id, gym_name: gmap[w.gym_id] || '',
      version: w.version, title: w.body_title || null, body_text: w.body_text || null,
      accepted_at: w.accepted_at, guardian_name: w.guardian_name || null, student_name: w.student_name || null,
    }));

    return res.status(200).json({ ok: true, consents, waivers });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
