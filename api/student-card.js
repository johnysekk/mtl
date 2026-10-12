// /api/student-card.js — KARTA MTL (dříve „Karta studenta“). Slouží i jako QR účtu na recepci.
//
// Student ukáže u dodavatele (fyzio, výživa, foto…) QR ze své karty a dostane slevu, kterou si
// dodavatel zadal v profilu.
//
// QR SE MĚNÍ KAŽDÝCH 30 S A FUNGUJE BEZ DAT. Jako u ověřovacích aplikací (TOTP): telefon
// studenta si jednou stáhne klíč své karty a kód z něj počítá sám, z času -- internet k tomu
// nepotřebuje. Odkaz je ?karta=<id>.<krok>.<kód>; server klíč odvodí z tajemství a ID, kód
// přepočítá a přijme jen krok ±STEP_SLACK (2 minuty na rozjeté hodiny). Snímek obrazovky
// tak za pár minut neplatí a bez klíče se karta vyrobit nedá.
//
//   GET ?mine=1  (Bearer)          -> { ok, key, step, active, basis }   klíč vlastní karty
//   GET ?t=<kód z QR>[&org=<id>]   -> { ok, valid, expired, name, photo, active, basis, since, canRedeem, recorded }
//        canRedeem: ověřuje majitel (jednoho) zveřejněného dodavatele -- appka se ho zeptá,
//        jestli slevu opravdu uplatnil.
//   GET ?t=…&redeem=1 (Bearer)     -> totéž + zápis uplatněné slevy do org_views (source 'card',
//        engaged) -- dodavatel to vidí ve svém přehledu. Jen po potvrzení, ne při každém skenu.
//
// Aktivní = platné členství v klubu, nebo trénink (docházka / lekce s koučem) za posledních
// ACTIVE_DAYS dní. Dodavatel vidí jen jméno, fotku a jestli je karta aktivní -- nic dalšího.
import crypto from 'crypto';
import { pragueDate } from './_tz.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.CRON_SECRET || KEY || 'mtl';
const q = encodeURIComponent;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACTIVE_DAYS = 15;
const STEP_MS = 30000, STEP_SLACK = 4;
// Klíč karty: odvozený, nikde se neukládá. Stejný výpočet kódu dělá appka (_scardCode v index.html).
const cardKey = (uid) => crypto.createHmac('sha256', SECRET).update('cardkey:' + String(uid).toLowerCase()).digest();
const codeFor = (key, step) => crypto.createHmac('sha256', key).update(String(step)).digest('base64url').slice(0, 12);
// Vrací { uid } (platný), { expired:true } nebo null.
function readCode(t) {
  const m = /^([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{12})$/i.exec(String(t || '').trim());
  if (!m || !UUID.test(m[1])) return null;
  const uid = m[1].toLowerCase(), step = Number(m[2]);
  const a = Buffer.from(codeFor(cardKey(uid), step)), b = Buffer.from(m[3]);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) return null;
  return (Math.abs(step - Math.floor(Date.now() / STEP_MS)) <= STEP_SLACK) ? { uid } : { expired: true };
}

async function sb(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
  return r.ok ? r.json() : [];
}
async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  try { const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null; const u = await r.json(); return (u && u.id) || null; } catch (e) { return null; }
}

// Proč je karta aktivní: 'member' (platné členství), 'trained' (trénink za ACTIVE_DAYS dní), jinak null.
async function activity(uid) {
  const m = await sb(`gym_memberships?student_id=eq.${q(uid)}&status=in.(active,cancelling)&select=id&limit=1`);
  if (m && m.length) return 'member';
  const since = pragueDate(new Date(Date.now() - ACTIVE_DAYS * 86400000));
  const a = await sb(`gym_attendance?student_id=eq.${q(uid)}&class_date=gte.${since}&select=id&limit=1`);
  if (a && a.length) return 'trained';
  const b = await sb(`bookings?student_id=eq.${q(uid)}&status=eq.active&training_date=gte.${since}&training_date=lte.${pragueDate()}&select=id&limit=1`);
  if (b && b.length) return 'trained';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  const Q = req.query || {};
  try {
    if (Q.mine) {
      const me = await whoami(req);
      if (!me) return res.status(401).json({ ok: false, error: 'login' });
      const basis = await activity(me);
      return res.status(200).json({ ok: true, key: cardKey(me).toString('base64url'), step: Math.floor(Date.now() / STEP_MS), active: !!basis, basis });
    }

    const rc = readCode(Q.t);
    if (!rc) return res.status(200).json({ ok: true, valid: false });
    if (rc.expired) return res.status(200).json({ ok: true, valid: false, expired: true });
    const uid = rc.uid;
    const p = ((await sb(`profiles?id=eq.${q(uid)}&select=name,photo_url,photo_thumb,created_at,account_suspended`)) || [])[0];
    if (!p || p.account_suspended) return res.status(200).json({ ok: true, valid: false });
    const basis = await activity(uid);

    // Uplatnění slevy: ověřuje majitel zveřejněného dodavatele (ne student sám sebe). Zapisuje
    // se až po potvrzení dodavatelem (redeem=1) -- sken sám o sobě slevu neznamená.
    let recorded = false, canRedeem = false;
    const me = await whoami(req);
    if (me && String(me) !== uid) {
      let orgs = (await sb(`organizations?owner_id=eq.${q(me)}&kind=eq.supplier&status=eq.approved&supplier_sub=not.is.null&select=id`)) || [];
      if (Q.org) orgs = orgs.filter((o) => String(o.id) === String(Q.org));
      canRedeem = orgs.length === 1;
      if (canRedeem && String(Q.redeem || '') === '1') {
        const r = await fetch(`${SB}/rest/v1/org_views?on_conflict=organization_id,viewer_id,view_date`, {
          method: 'POST',
          headers: { ...svc, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ organization_id: orgs[0].id, viewer_id: uid, view_date: pragueDate(), source: 'card', engaged: true }),
        });
        recorded = r.ok;
      }
    }
    return res.status(200).json({
      ok: true, valid: true, name: p.name || '', photo: p.photo_url || p.photo_thumb || null,
      active: !!basis, basis, since: p.created_at ? String(p.created_at).slice(0, 4) : null, canRedeem, recorded,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
