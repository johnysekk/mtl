// /api/my-referrals.js — PŘEHLED POZVÁNEK PRO TRACKER.
//
// Vrátí lidi a kluby, které přihlášený uživatel pozval, a u každého, kam došel:
// registrace -> první trénink -> aktivní (10 odučených soukromek nebo 20 aktivních členství,
// stejná hranice jako Shikai/Bankai). Běží na serveru, protože „první trénink" se musí
// dohledat v cizích rezervacích a docházce -- to do prohlížeče nepatří. Ven jdou jen odvozené
// kroky, ne data o tom, kdy a kde ten člověk trénoval.
//
// Soukromá osoba se vrací jen křestním jménem a iniciálou; kouč a klub celým názvem.
//
// GET /api/my-referrals   (Authorization: Bearer <access token>)

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) return [];
  return r.json();
}
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return res.status(401).json({ error: 'no token' });
  const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!ur.ok) return res.status(401).json({ error: 'bad token' });
  const me = await ur.json();
  const uid = me && me.id;
  if (!uid) return res.status(401).json({ error: 'bad token' });

  try {
    const [meRow] = await sbGet(`profiles?id=eq.${uid}&select=coach_ref_score,bankai_eligible,referral_code`);
    const people = await sbGet(`profiles?referred_by=eq.${uid}&deleted_at=is.null&select=id,name,photo_thumb,photo_url,coach_status,ref_coach_qualified,referral_rewarded,created_at&order=created_at.desc&limit=200`);
    const clubs = await sbGet(`gyms?referred_by=eq.${uid}&deleted_at=is.null&select=id,name,brand_logo,status,referral_rewarded,owner_id,created_at&order=created_at.desc&limit=200`);

    // „První platba" = přesně ta událost, za kterou referral-cron dává body i XP
    // (referral_rewarded). Dřív se tu počítalo po svém z docházky a rezervací a tracker pak
    // mohl ukazovat splněný krok, za který odměna nepřišla -- třeba po zkušebním tréninku zdarma.
    const trained = new Set((people || []).filter((p) => p.referral_rewarded).map((p) => p.id));
    // Klub pozvaný odkazem na klub a jeho majitel pozvaný osobně jsou tentýž člověk --
    // v přehledu se nesmí objevit dvakrát ani počítat XP dvakrát.
    const ownersOfInvitedClubs = new Set((clubs || []).map((c) => c.owner_id).filter(Boolean));

    const outPeople = (people || []).filter((p) => !ownersOfInvitedClubs.has(p.id)).map((p) => {
      const isCoach = p.coach_status === 'approved';
      const active = !!p.ref_coach_qualified;
      return {
        kind: isCoach ? 'coach' : 'student',
        name: isCoach ? (p.name || '') : shortName(p.name),
        photo: p.photo_thumb || p.photo_url || null,
        since: p.created_at,
        steps: { registered: true, trained: trained.has(p.id), coach: isCoach, active },
        xp: (active ? 50 : 0) + (trained.has(p.id) ? 10 : 0),
      };
    });
    const outClubs = (clubs || []).map((c) => ({
      kind: 'club',
      name: c.name || '',
      photo: c.brand_logo || null,
      since: c.created_at,
      steps: { registered: true, approved: c.status === 'approved', active: !!c.referral_rewarded },
      xp: c.referral_rewarded ? 50 : 0,
    }));

    return res.status(200).json({
      ok: true,
      code: (meRow && meRow.referral_code) || null,
      score: (meRow && meRow.coach_ref_score) || 0,
      bankaiEligible: !!(meRow && meRow.bankai_eligible),
      people: outPeople,
      clubs: outClubs,
    });
  } catch (e) {
    return res.status(500).json({ error: 'failed' });
  }
}
