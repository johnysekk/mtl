// /api/ref-card.js — KDO TĚ ZVE.
//
// Podle zvacího kódu vrátí to nejnutnější pro kartu „Zve tě Petr Haiser" na úvodní obrazovce
// a při registraci: jméno, fotku a jeden řádek o tom, kdo to je. Nic víc -- žádný e-mail,
// telefon, město u soukromé osoby ani ID. Kód je veřejný (je v odkazu), takže i odpověď musí
// být jen to, co by stejně bylo vidět.
//
// Kouč a klub mají veřejný profil, u nich celé jméno. Student je soukromá osoba a odkaz může
// skončit ve skupině cizích lidí, proto jen křestní jméno a iniciála příjmení.
//
// GET /api/ref-card?code=ABC123

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) return null;
  return r.json();
}

function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });
  const code = String((req.query && req.query.code) || '').trim().slice(0, 40);
  if (!/^[A-Za-z0-9_-]{3,40}$/.test(code)) return res.status(400).json({ error: 'bad code' });

  try {
    const p = (await sbGet(`profiles?referral_code=eq.${encodeURIComponent(code)}&deleted_at=is.null&select=id,name,photo_url,photo_thumb,coach_status,main_discipline&limit=1`) || [])[0];
    if (!p) return res.status(404).json({ error: 'not found' });

    // Vlastní schválený klub má přednost: pozvánka od majitele klubu je pozvánka do klubu.
    const g = (await sbGet(`gyms?owner_id=eq.${encodeURIComponent(p.id)}&status=eq.approved&deleted_at=is.null&select=id,name,brand_logo,city&order=created_at.asc&limit=1`) || [])[0];

    const isCoach = p.coach_status === 'approved';
    const kind = g ? 'club' : (isCoach ? 'coach' : 'student');
    return res.status(200).json({
      ok: true,
      kind,
      name: (kind === 'student') ? shortName(p.name) : (p.name || ''),
      photo: p.photo_thumb || p.photo_url || null,
      club: g ? { name: g.name || '', city: g.city || '', logo: g.brand_logo || null } : null,
      discipline: isCoach ? (p.main_discipline || null) : null,
      // ID PRO PŮVOD NÁKUPU. Kdo přišel přes pozvánku kouče nebo majitele klubu a pak u něj
      // koupí, je jeho klient, ne akvizice MTL. Obě ID jsou veřejná (kouč je v decku, klub
      // na veřejné stránce), soukromé osobě se nevrací nic.
      coachId: isCoach ? p.id : null,
      gymId: g ? g.id : null,
    });
  } catch (e) {
    return res.status(500).json({ error: 'failed' });
  }
}
