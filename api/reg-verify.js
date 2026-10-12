// MTL — /api/reg-verify?kind=gym|coach&id=<uuid>
// Ověří poskytovatele v rejstříku a VÝSLEDEK ULOŽÍ (gyms / profiles: reg_verified,
// reg_verified_at, reg_checked_at -- sql/reg-verified.sql). Podle uloženého výsledku profil
// ukazuje „Ověřené IČO“ / „Ověřené DIČ“; kdo ověřený není, tu dlaždici nedostane.
//   'ares' = české IČO existuje v ARES a právní název sedí
//   'vies' = DIČ je platné ve VIES, kód země sedí a název sedí (nebo ho daný stát nevydává)
//   null   = nic z toho
// Výpadek ARES / VIES nic nepřepisuje: dřívější výsledek zůstane a vrátí se { ok:false }.
// Spouští jen ten, komu entita patří (majitel / spolumajitel klubu, kouč sám za sebe).
import { viesCheck } from './tax-verify.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

async function sb(path, init) {
  const r = await fetch(`${SB}/rest/v1/${path}`, Object.assign({ headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } }, init || {}));
  if (!r.ok) throw new Error(await r.text());
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  try { const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null; const u = await r.json(); return (u && u.id) || null; } catch (e) { return null; }
}
// Stejné porovnání názvu jako formuláře v appce (_taxNorm): bez diakritiky, teček a čárek.
function norm(s) {
  try { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim(); }
  catch (e) { return String(s || '').toLowerCase().trim(); }
}
const EU = ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','EL','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const kind = String((req.query && req.query.kind) || '');
    const id = String((req.query && req.query.id) || '').trim();
    if (!/^(gym|coach)$/.test(kind) || !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ ok: false, error: 'bad request' });
    const me = await whoami(req);
    if (!me) return res.status(401).json({ ok: false, error: 'not signed in' });

    let row = null, table = kind === 'gym' ? 'gyms' : 'profiles';
    if (kind === 'gym') {
      row = ((await sb(`gyms?id=eq.${q(id)}&select=id,owner_id,tax_id,vat_id,legal_name,billing_country,country_code`)) || [])[0];
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
      let allowed = String(row.owner_id) === String(me);
      if (!allowed) {
        const co = (await sb(`gym_coaches?gym_id=eq.${q(id)}&coach_id=eq.${q(me)}&co_owner=eq.true&status=eq.active&select=coach_id`)) || [];
        allowed = co.length > 0;
      }
      if (!allowed) return res.status(403).json({ ok: false, error: 'forbidden' });
    } else {
      if (String(id) !== String(me)) return res.status(403).json({ ok: false, error: 'forbidden' });
      row = ((await sb(`profiles?id=eq.${q(id)}&select=id,tax_id,vat_id,legal_name,billing_country,country_code`)) || [])[0];
      if (!row) return res.status(404).json({ ok: false, error: 'not found' });
    }

    const cc = String(row.billing_country || row.country_code || '').trim().toUpperCase();
    const legal = norm(row.legal_name);
    const ico = String(row.tax_id || '').replace(/\s+/g, '');
    const vat = String(row.vat_id || '').replace(/\s+/g, '').toUpperCase();
    let src = null, outage = false;

    // České IČO v ARES (osm číslic, česká nebo nevyplněná země).
    if ((!cc || cc === 'CZ') && /^\d{8}$/.test(ico) && legal) {
      try {
        const r = await fetch('https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/' + ico, { headers: { accept: 'application/json' } });
        if (r.ok) { const j = await r.json(); if (j && j.obchodniJmeno && norm(j.obchodniJmeno) === legal) src = 'ares'; }
        else if (r.status !== 404) outage = true;
      } catch (e) { outage = true; }
    }
    // DIČ ve VIES (EU). Kód země v DIČ musí sedět se zemí poskytovatele.
    if (!src && vat && legal) {
      const vcc = vat.slice(0, 2) === 'EL' ? 'GR' : vat.slice(0, 2);
      if (EU.indexOf(vcc) >= 0 && (!cc || cc === vcc)) {
        const v = await viesCheck(vat, null);
        if (!v.ok) outage = true;
        else if (v.valid && (!v.name || norm(v.name) === legal)) src = 'vies';
      }
    }
    if (!src && outage) return res.status(200).json({ ok: false, error: 'registry unavailable' });

    const now = new Date().toISOString();
    await sb(`${table}?id=eq.${q(id)}`, { method: 'PATCH', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ reg_verified: src, reg_verified_at: src ? now : null, reg_checked_at: now }) });
    return res.status(200).json({ ok: true, verified: src });
  } catch (e) {
    return res.status(200).json({ ok: false, error: (e && e.message) || 'error' });
  }
}
