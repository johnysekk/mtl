// /api/kid-transfer — PŘEDÁNÍ DÍTĚTE JINÉMU ZÁKONNÉMU ZÁSTUPCI, celé na serveru.
//
// KDO SOUHLASÍ: odesílatel při odeslání (prohlášení „předávám"), příjemce při přijetí.
// Zápis proběhne až po souhlasu obou, tedy při přijetí.
// KOMU: jen dospělému propojenému v Rodině (partner, nebo rodič odesílatele) -- stejné
// pravidlo jako nabídka v appce, tady ale vynucené. Odkaz „pro kohokoli" je zrušený.
//
// Proč tady: předání sahá do účtů DVOU lidí (odebrat dítě jednomu, přidat druhému, přepsat
// jeho záznamy). Z prohlížeče to šlo jen proto, že profiles a gym_attendance neměly RLS.
// Po zapnutí RLS by příjemce dítě dostal, ale odesílateli by zůstalo (zápis do cizího
// profilu by se tiše neprovedl) -- dítě by bylo dvakrát.
//
// A dřív se přesouvala jen docházka. Členství, rezervace, omluvenky a zkušební lekce
// dítěte zůstaly u původního rodiče, takže nový zástupce neviděl aktivní členství a
// nemohl ho platit. Teď se přesouvá všechno, co je vedené na rodiče se jménem dítěte.
// Platby a doklady (transactions, doklady) se NEPŘESOUVAJÍ: jsou to účetní záznamy
// toho, kdo platil, a doklad zní na něj.
//
//   POST { action:'accept',  id }           příjemce potvrdil -> dítě a záznamy k němu
//   POST { action:'reverse', id, reason }   původní rodič do 24 h, nebo zakladatel kdykoli

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOUNDER = process.env.FOUNDER_UUID || '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
// Stejná verze jako KID_CONSENT_VERSION v index.html -- při změně souhlasu změnit obě.
const KID_CONSENT_VERSION = process.env.KID_CONSENT_VERSION || '2026-06-v1';

// Všechno, co je vedené na rodiče (student_id) se jménem dítěte (child_name).
const CHILD_TABLES = ['gym_memberships', 'gym_bookings', 'gym_attendance', 'gym_excuses', 'gym_trials'];

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}
const q = encodeURIComponent;

async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return (u && u.id) ? u.id : null;
}

// Propojení v Rodině: partner (oběma směry), nebo příjemce je rodičem odesílatele.
async function familyLinked(from, to) {
  const rows = (await sb(`family_links?status=eq.active&or=${q(`(and(guardian_id.eq.${from},member_id.eq.${to}),and(guardian_id.eq.${to},member_id.eq.${from}))`)}&select=relation,guardian_id,member_id`)) || [];
  return rows.some((r) => r.relation === 'partner' || (r.relation === 'guardian' && r.guardian_id === to && r.member_id === from));
}

async function profile(id, cols) {
  return ((await sb(`profiles?id=eq.${q(id)}&select=${cols}`)) || [])[0] || null;
}
function kids(p) {
  try { const c = p && p.children; return (typeof c === 'string' ? JSON.parse(c) : c) || []; } catch (e) { return []; }
}
function isMinor(p) {
  if (!p) return true;
  if (p.birthdate) {
    const b = new Date(p.birthdate); const n = new Date();
    let a = n.getFullYear() - b.getFullYear();
    if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
    return a < 18;
  }
  return !!p.is_minor;
}
async function notify(userId, kind, cs, en, lang) {
  try {
    await sb('notifications', {
      method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({ user_id: userId, type: 'system', read: false,
        data: JSON.stringify({ kind, msg_cs: cs, msg_en: en }), message: lang === 'en' ? en : cs }),
    });
  } catch (e) { console.error('[kid-transfer] notify', e.message); }
}

// Přesune dítě z účtu `from` na účet `to` -- profil i všechny jeho záznamy.
async function moveKid(from, to, toName, kidName) {
  const pf = await profile(from, 'children');
  const pt = await profile(to, 'children,name');
  const fk = kids(pf), tk = kids(pt);
  const idx = fk.findIndex((c) => c && c.name === kidName);
  if (idx < 0) return { error: 'kid_not_on_sender' };
  if (tk.some((c) => c && c.name === kidName)) return { error: 'kid_name_taken' };
  const kid = fk[idx];
  kid.consent = { at: new Date().toISOString(), version: KID_CONSENT_VERSION, guardian_id: to, guardian_name: toName || (pt && pt.name) || '' };
  delete kid._archived;
  tk.push(kid); fk.splice(idx, 1);
  // Nejdřív přidat příjemci, pak odebrat odesílateli: kdyby druhý zápis selhal, dítě je
  // dvakrát (dohledatelné a opravitelné), ne nikde.
  await sb(`profiles?id=eq.${q(to)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ children: JSON.stringify(tk) }) });
  await sb(`profiles?id=eq.${q(from)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ children: JSON.stringify(fk) }) });
  const moved = {};
  for (const t of CHILD_TABLES) {
    try {
      const rows = await sb(`${t}?student_id=eq.${q(from)}&child_name=eq.${q(kidName)}`, {
        method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ student_id: to }),
      });
      moved[t] = (rows || []).length;
    } catch (e) { moved[t] = 'error'; console.error('[kid-transfer] move', t, e.message); }
  }
  try {
    await sb('guardian_consents', { method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({ guardian_id: to, guardian_name: toName || (pt && pt.name) || '', kid_id: kid.id || null,
        kid_name: kidName, kid_dob: kid.dob || null, version: KID_CONSENT_VERSION }) });
  } catch (e) { console.error('[kid-transfer] consent', e.message); }
  return { kid, kids: tk, moved };
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const me = await whoami(req);
    if (!me) return res.status(401).json({ error: 'no token' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const mp = await profile(me, 'name,lang,is_minor,birthdate');
    const myName = (mp && mp.name) || '';

    if (b.action === 'accept') {
      if (isMinor(mp)) return res.status(403).json({ error: 'minor' });
      const row = ((await sb(`kid_transfers?id=eq.${q(String(b.id || ''))}&to_guardian=eq.${q(me)}&status=eq.pending&select=*`)) || [])[0];
      if (!row) return res.status(404).json({ error: 'not_available' });
      if (!(await familyLinked(row.from_guardian, me))) return res.status(403).json({ error: 'not_family' });
      const r = await moveKid(row.from_guardian, me, myName, row.kid_name);
      if (r.error === 'kid_not_on_sender') {
        await sb(`kid_transfers?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled' }) });
        return res.status(409).json({ error: r.error });
      }
      if (r.error) return res.status(409).json({ error: r.error });
      const undo = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      await sb(`kid_transfers?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ status: 'accepted', accepted_at: new Date().toISOString(), undo_until: undo, consent_version: KID_CONSENT_VERSION }) });
      const fp = await profile(row.from_guardian, 'lang');
      const first = (r.kid && r.kid.firstName) || row.kid_name;
      await notify(row.from_guardian, 'kidxfer_done',
        `\u2705 ${first} byl/a předán/a uživateli ${myName || 'nový zákonný zástupce'}. Předání můžeš do 24 hodin vrátit v sekci Děti.`,
        `\u2705 ${first} was transferred to ${myName || 'the new guardian'}. You can undo it within 24 hours in the Kids section.`,
        fp && fp.lang);
      return res.status(200).json({ ok: true, children: r.kids, moved: r.moved });
    }

    if (b.action === 'reverse') {
      const row = ((await sb(`kid_transfers?id=eq.${q(String(b.id || ''))}&status=eq.accepted&select=*`)) || [])[0];
      if (!row) return res.status(404).json({ error: 'not_reversible' });
      const isFounder = me === FOUNDER;
      if (!isFounder) {
        if (row.from_guardian !== me) return res.status(403).json({ error: 'only_original' });
        if (!row.undo_until || new Date(row.undo_until).getTime() < Date.now()) return res.status(403).json({ error: 'window_passed' });
      }
      if (!row.to_guardian) return res.status(400).json({ error: 'nothing' });
      const op = await profile(row.from_guardian, 'name,lang');
      const r = await moveKid(row.to_guardian, row.from_guardian, row.from_guardian_name || (op && op.name) || '', row.kid_name);
      if (r.error) return res.status(409).json({ error: r.error });
      await sb(`kid_transfers?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ status: 'reversed', reversed_at: new Date().toISOString(), reversed_by: me,
          reverse_reason: String(b.reason || (isFounder && me !== row.from_guardian ? 'MTL review' : 'guardian undo')).slice(0, 500) }) });
      const hp = await profile(row.to_guardian, 'lang');
      const first = (r.kid && r.kid.firstName) || row.kid_name;
      const byMtl = isFounder && me !== row.from_guardian;
      await notify(row.to_guardian, 'kidxfer_reversed',
        `\u21a9\ufe0f Předání dítěte ${first} bylo vráceno${byMtl ? ' (MTL)' : ''}.`,
        `\u21a9\ufe0f The transfer of ${first} was reversed${byMtl ? ' by MTL' : ''}.`, hp && hp.lang);
      return res.status(200).json({ ok: true, children: me === row.from_guardian ? r.kids : null, moved: r.moved });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}
