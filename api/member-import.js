// /api/member-import — VLASTNÍ ČLENOVÉ KLUBU: IMPORT (CSV) I RUČNÍ ZADÁNÍ.
//
// Klub přenáší lidi, kteří už jsou jeho členy (přihlášku má u sebe mimo MTL). Proto:
//   • povinné potvrzení klubu, že jsou to platní členové a má jejich souhlas se zpracováním
//     údajů z přihlášky (ukládá se kdo a kdy potvrdil);
//   • u spolku se každému hned vytvoří SCHVÁLENÁ přihláška s datem „Členem od" -- při nákupu
//     členství v appce se pak na přihlášku neptá znovu a datum vzniku členství sedí;
//   • kdo už v MTL účet má (stejný e-mail), propojí se hned; ostatním se vše připíše po
//     registraci se stejným e-mailem;
//   • adresa bydliště z přihlášky: existujícímu účtu bez adresy se zapíše hned (a zobrazí se
//     tomuto klubu; člověk dostane notifikaci a může ji změnit nebo skrýt), ostatním po registraci.
//
// POST { gym_id, attest:true, rows:[{ name, email, phone, plan, birthdate, member_since, street, postal, city }] }

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
const ATTEST_CS = 'Potvrzuji, že tyto osoby jsou skutečně platnými členy tohoto klubu a já mám jejich souhlas zpracovávat osobní údaje z jejich členské přihlášky, kterou uchovávám mimo MTL.';

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}) },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}
async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null; const u = await r.json(); return (u && u.id) ? u.id : null;
}
const isoDate = (v) => { const s = String(v || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z')) ? s : null; };
const clean = (v, n) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, n || 200) : null; };

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ ok: false, error: 'not configured' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const me = await whoami(req);
    if (!me) return res.status(401).json({ ok: false, error: 'no token' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const gym = ((await sb(`gyms?id=eq.${q(String(b.gym_id || ''))}&select=id,name,owner_id,org_form`)) || [])[0];
    if (!gym) return res.status(404).json({ ok: false, error: 'gym not found' });
    let ok = String(gym.owner_id) === String(me);
    if (!ok) { const gc = (await sb(`gym_coaches?gym_id=eq.${q(gym.id)}&coach_id=eq.${q(me)}&status=eq.active&select=co_owner`)) || []; ok = gc.some((x) => x.co_owner); }
    if (!ok) return res.status(403).json({ ok: false, error: 'Členy může přenášet jen majitel nebo spolumajitel klubu.' });
    if (!b.attest) return res.status(400).json({ ok: false, error: 'Potvrď, že jde o platné členy a máš jejich souhlas.' });
    const spolek = gym.org_form === 'nonprofit';

    // Řádky: e-mail povinný, u spolku i „Členem od".
    const seen = new Set(); const rows = []; const skipped = [];
    for (const r of (Array.isArray(b.rows) ? b.rows : []).slice(0, 2000)) {
      const email = String((r && r.email) || '').trim().toLowerCase();
      if (!email || email.indexOf('@') < 1 || seen.has(email)) { skipped.push({ email, why: 'email' }); continue; }
      const since = isoDate(r.member_since);
      if (spolek && !since) { skipped.push({ email, why: 'member_since' }); continue; }
      seen.add(email);
      rows.push({ email, name: clean(r.name, 120), phone: clean(r.phone, 40), plan: clean(r.plan, 120),
        birthdate: isoDate(r.birthdate), member_since: since,
        street: clean(r.street, 160), postal: clean(r.postal, 20), city: clean(r.city, 120) });
    }
    if (!rows.length) return res.status(400).json({ ok: false, error: spolek ? 'Žádný řádek s e-mailem a datem „Členem od".' : 'Žádný řádek s e-mailem.', skipped });

    const now = new Date().toISOString();
    const emails = rows.map((r) => r.email);
    const inList = (arr) => `(${arr.map((e) => `"${String(e).replace(/"/g, '')}"`).join(',')})`;

    // 1) imported_members: nové vložit, existující doplnit (stav pozvánky se nemění).
    const have = (await sb(`imported_members?gym_id=eq.${q(gym.id)}&email=in.${q(inList(emails))}&select=id,email`)) || [];
    const haveMap = {}; have.forEach((h) => { haveMap[h.email] = h.id; });
    const base = (r) => ({ name: r.name, phone: r.phone, plan: r.plan, birthdate: r.birthdate, member_since: r.member_since,
      street: r.street, postal: r.postal, city: r.city, existing_member: true, attested_by: me, attested_at: now });
    const fresh = rows.filter((r) => !haveMap[r.email]).map((r) => Object.assign({ gym_id: gym.id, email: r.email, source: b.source === 'manual' ? 'manual' : 'csv', status: 'pending' }, base(r)));
    if (fresh.length) await sb('imported_members', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(fresh) });
    for (const r of rows.filter((x) => haveMap[x.email])) {
      await sb(`imported_members?id=eq.${q(haveMap[r.email])}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(base(r)) });
    }

    // 2) Kdo už má účet (stejný e-mail).
    const profs = (await sb(`profiles?email=in.${q(inList(emails))}&select=id,email,name,lang`)) || [];
    const acct = {}; profs.forEach((p) => { if (p.email) acct[String(p.email).toLowerCase()] = p; });

    // 3) Spolek: schválená přihláška s původním datem (bez nového souhlasu v MTL).
    let apps = 0;
    if (spolek) {
      for (const r of rows) {
        const p = acct[r.email];
        const ex = ((await sb(`gym_member_applications?gym_id=eq.${q(gym.id)}&status=in.(pending,approved)&or=${q(`(applicant_email.ilike."${r.email}"${p ? `,student_id.eq.${p.id}` : ''})`)}&select=id,status,is_minor&limit=20`)) || []).filter((x) => !x.is_minor);
        const decided = (r.member_since ? (r.member_since + 'T12:00:00Z') : now);
        const note = 'P\u0159ijat(a) p\u0159ed p\u0159echodem na MTL \u2014 p\u0159ihl\u00e1\u0161ka v archivu klubu (potvrzeno ' + now.slice(0, 10) + ')';
        if (ex[0]) {
          await sb(`gym_member_applications?id=eq.${q(ex[0].id)}`, { method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ status: 'approved', decided_at: decided, decided_note: note, student_id: p ? p.id : undefined }) });
        } else {
          await sb('gym_member_applications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({
            gym_id: gym.id, student_id: p ? p.id : null, applicant_name: r.name, applicant_email: r.email, applicant_phone: r.phone,
            applicant_birth: r.birthdate, status: 'approved', decided_at: decided, decided_note: note, source: 'import' }) });
        }
        apps++;
      }
    }

    // 4) Adresa z přihlášky: existujícímu účtu bez adresy hned (a zobrazená tomuto klubu).
    let addrs = 0;
    for (const r of rows) {
      const p = acct[r.email];
      if (!p || !r.street || !r.city) continue;
      const cur = ((await sb(`member_addresses?owner_id=eq.${q(p.id)}&person_key=eq.self&select=owner_id`)) || [])[0];
      if (cur) continue;   // vlastní adresu nikdy nepřepisujeme
      await sb('member_addresses', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({
        owner_id: p.id, person_key: 'self', street: r.street, postal: r.postal, city: r.city, updated_at: now }) });
      await sb('address_shares?on_conflict=owner_id,gym_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify({ owner_id: p.id, gym_id: gym.id }) });
      const cs = `🏠 ${gym.name} doplnil tvou adresu bydliště z členské přihlášky a vidí ji. Zkontroluj ji -- můžeš ji změnit nebo klubu skrýt.`;
      const en = `🏠 ${gym.name} added your home address from your membership application and can see it. Check it -- you can change it or hide it from the club.`;
      try { await sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id: p.id, type: 'system', read: false,
        data: JSON.stringify({ kind: 'address_from_club', gym_id: gym.id, gym_name: gym.name, msg_cs: cs, msg_en: en }), message: p.lang === 'en' ? en : cs }) }); } catch (e) {}
      addrs++;
    }

    return res.status(200).json({ ok: true, imported: rows.length, linked: Object.keys(acct).length, applications: apps, addresses: addrs, skipped, attest_text: ATTEST_CS });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
}
