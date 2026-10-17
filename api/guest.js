// /api/guest — ZÁPISY LIDÍ BEZ ÚČTU (a bez přihlášení) přes server. RLS krok 3.7.
// POST { action, ... }
//   dropin_book      -- host z QR na recepci: založí čekající rezervaci jednorázového vstupu
//                       { gymId, coachId?, amount, currency, cls, date, time, level?, disc?, tok, email?, attr? }
//   dropin_email     -- host po zaplacení opraví e-mail pro přihlašovací odkaz
//                       { sessionId, acct, bookingId, email }
//   cohort_waitlist  -- čekačka na kurz { cohortId, name, email, phone?, attr? }
//   member_application -- přihláška za člena spolku podaná s kurzem bez účtu { gymId, cohortId, ... }
//
// Dřív to appka zapisovala do databáze sama s veřejným klíčem: kdokoli tak mohl zakládat řádky
// s libovolným obsahem a číst všechny rezervace hostů (jména, e-maily). Teď databáze nepřihlášeným
// zápis nedovolí a server zapíše jen to, co dává smysl: klub existuje a prodává, cena sedí s ceníkem,
// kouč je v týmu klubu, kurz patří klubu, e-mail je e-mail, a stejná věc se nezaloží dvakrát.
import Stripe from 'stripe';
import { checkPrice } from './_price-check.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const str = (v, n) => (v == null ? null : (String(v).trim().slice(0, n) || null));

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return r.ok ? await r.json() : [];
}
async function sbWrite(method, path, body) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`SB ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

async function dropinBook(b) {
  const gymId = str(b.gymId, 64), tok = str(b.tok, 80);
  if (!gymId || !tok || !/^[A-Za-z0-9_-]{6,80}$/.test(tok)) return [400, { error: 'Neplatný odkaz.' }];
  const g = ((await sbGet(`gyms?id=eq.${q(gymId)}&select=id,name,status,account_suspended,deleted_at`)) || [])[0];
  if (!g || g.status !== 'approved' || g.account_suspended || g.deleted_at) return [404, { error: 'Klub nenalezen.' }];
  // Stejný QR (token) = stejná rezervace. Druhé načtení stránky nezaloží druhou.
  const ex = ((await sbGet(`gym_bookings?gym_id=eq.${q(gymId)}&guest_token=eq.${q(tok)}&select=id,status&limit=1`)) || [])[0];
  if (ex) return ex.status === 'pending' ? [200, { id: ex.id }] : [409, { error: 'Tenhle QR kód už byl použitý. Požádej na recepci o nový.' }];
  let coachId = str(b.coachId, 64);
  if (coachId && String(coachId) !== 'null') {
    const c = await sbGet(`gym_coaches?gym_id=eq.${q(gymId)}&coach_id=eq.${q(coachId)}&status=eq.active&select=id&limit=1`);
    if (!(c && c.length)) coachId = null;
  } else coachId = null;
  const amount = Number(b.amount), currency = String(b.currency || 'CZK').toUpperCase();
  const pc = await checkPrice({ SB, KEY, kind: 'gymDropin', amount, currency, gymId, coachId });
  if (!pc.ok) return [400, { error: 'Cena neodpovídá ceníku klubu. Požádej na recepci o nový QR kód.' }];
  const email = str(b.email, 200);
  const date = str(b.date, 10), time = str(b.time, 8);
  const row = {
    gym_id: gymId, paid_to: coachId ? 'coach' : 'gym', amount, currency, status: 'pending', reception_checkin: true,
    guest_token: tok, guest_email: (email && EMAIL.test(email)) ? email : null,
    date, time, class_name: str(b.cls, 120) || 'Drop-in', class_date: date, class_time: time,
    level: str(b.level, 40) || 'all', coach_id: coachId, discipline: str(b.disc, 40), gym_name: g.name || 'Klub',
    attr_src: str(b.attr, 60),
  };
  const ins = await sbWrite('POST', 'gym_bookings', row);
  return [200, { id: ins && ins[0] && ins[0].id }];
}

async function dropinEmail(b) {
  const email = str(b.email, 200), bookingId = str(b.bookingId, 64), sessionId = str(b.sessionId, 200), acct = str(b.acct, 64);
  if (!email || !EMAIL.test(email) || !bookingId || !sessionId) return [400, { error: 'bad request' }];
  // E-mail smí opravit jen ten, kdo tu rezervaci zaplatil -- pozná se podle zaplacené platby Stripe.
  const s = await stripe.checkout.sessions.retrieve(sessionId, acct ? { stripeAccount: acct } : undefined);
  const md = (s && s.metadata) || {};
  if (String(md.mtl_booking_id || '') !== bookingId || s.payment_status !== 'paid') return [403, { error: 'forbidden' }];
  await sbWrite('PATCH', `gym_bookings?id=eq.${q(bookingId)}&student_id=is.null`, { guest_email: email });
  return [200, { ok: true }];
}

async function cohortWaitlist(b) {
  const cohortId = str(b.cohortId, 64), name = str(b.name, 120), email = str(b.email, 200);
  if (!cohortId || !name || !email || !EMAIL.test(email)) return [400, { error: 'Vyplň jméno a platný e-mail.' }];
  const c = ((await sbGet(`gym_cohorts?id=eq.${q(cohortId)}&select=id,gym_id,status`)) || [])[0];
  if (!c || ['cancelled', 'ended', 'draft'].includes(String(c.status || ''))) return [404, { error: 'Kurz nenalezen.' }];
  const ex = await sbGet(`cohort_members?cohort_id=eq.${q(cohortId)}&email=ilike.${q(email)}&status=neq.cancelled&select=status&limit=1`);
  if (ex && ex.length) return [200, { ok: true, already: ex[0].status }];
  await sbWrite('POST', 'cohort_members', { cohort_id: cohortId, gym_id: c.gym_id || null, name, email, phone: str(b.phone, 40), status: 'waitlist', attr_src: str(b.attr, 60) });
  return [200, { ok: true }];
}

async function memberApplication(b) {
  const gymId = str(b.gymId, 64), cohortId = str(b.cohortId, 64), email = str(b.applicant_email, 200);
  if (!gymId || !email || !EMAIL.test(email) || !str(b.applicant_name, 160)) return [400, { error: 'bad request' }];
  const g = ((await sbGet(`gyms?id=eq.${q(gymId)}&select=id,org_form,status`)) || [])[0];
  if (!g || g.org_form !== 'nonprofit' || g.status !== 'approved') return [404, { error: 'Klub nenalezen.' }];
  if (cohortId) {
    const c = ((await sbGet(`gym_cohorts?id=eq.${q(cohortId)}&select=gym_id`)) || [])[0];
    if (!c || String(c.gym_id) !== gymId) return [400, { error: 'Kurz nepatří tomuhle klubu.' }];
  }
  const ex = await sbGet(`gym_member_applications?gym_id=eq.${q(gymId)}&applicant_email=ilike.${q(email)}&applicant_name=eq.${q(String(b.applicant_name).trim())}&select=id&limit=1`);
  if (ex && ex.length) return [200, { ok: true, already: true }];
  await sbWrite('POST', 'gym_member_applications', {
    gym_id: gymId, student_id: null,
    applicant_name: str(b.applicant_name, 160), applicant_email: email, applicant_phone: str(b.applicant_phone, 40),
    applicant_birth: str(b.applicant_birth, 10), is_minor: !!b.is_minor,
    guardian_name: str(b.guardian_name, 160), guardian_contact: str(b.guardian_contact, 240),
    consent_at: new Date().toISOString(), consent_version: str(b.consent_version, 40),
    app_type: str(b.app_type, 40), app_text: str(b.app_text, 20000),
    source: 'cohort', cohort_id: cohortId,
    doc_url: str(b.doc_url, 600), doc_name: str(b.doc_name, 200), doc_hash: str(b.doc_hash, 128),
  });
  return [200, { ok: true }];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const a = String(b.action || '');
    const fn = { dropin_book: dropinBook, dropin_email: dropinEmail, cohort_waitlist: cohortWaitlist, member_application: memberApplication }[a];
    if (!fn) return res.status(400).json({ error: 'bad action' });
    const [code, body] = await fn(b);
    return res.status(code).json(body);
  } catch (e) {
    console.error('[guest]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
