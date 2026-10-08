// /api/consent-prune-cron — ÚKLID SOUHLASŮ K NÁKUPŮM, KTERÉ NIKDY NEPROBĚHLY.
//
// Některé souhlasy se dávají těsně před konkrétním nákupem (zahájení online služby / předplatného,
// přítomnost zástupce na soukromce s dítětem). Když si to člověk rozmyslí a nezaplatí, souhlas
// nemá k čemu sloužit -- a držet u něj IP adresu a zařízení je proti minimalizaci údajů (GDPR).
//
// PÁROVÁNÍ JE KONZERVATIVNÍ: smaže se jen souhlas, ke kterému od stejného člověka k témuž
// poskytovateli v okně 7 dnů po souhlasu neexistuje ŽÁDNÁ platba ani rezervace. Když existuje
// cokoli, souhlas zůstává. Chyba tak může vést jen k tomu, že zbytečný souhlas zůstane -- nikdy
// k tomu, že zmizí souhlas k zaplacené službě. Běží jen nad souhlasy staršími 30 dnů.
//
// NEMAŽE SE: VOP, ochrana údajů, pravidla klubu, souhlasy zástupce za dítě, a podmínky Finbricks
// (ty se zapisují až na serveru, když Finbricks platbu opravdu založil -- každý takový záznam
// patří ke skutečné platbě, viz pis-create.js).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
const DAY = 86400000;
const KINDS = ['online_service_start', 'online_plan_start', 'guardian_presence'];
const MIN_AGE_DAYS = 30, WINDOW_DAYS = 7, MAX_DELETE = 500;

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}) } });
  if (!r.ok) throw new Error(`SB ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
const any = async (path) => { try { const r = await sb(path + '&limit=1'); return !!(r && r.length); } catch (e) { return true; } };   // při chybě radši nechat

export default async function handler(req, res) {
  const sec = process.env.CRON_SECRET;
  if (!sec) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  if ((req.headers.authorization || '') !== `Bearer ${sec}`) return res.status(401).json({ error: 'unauthorized' });

  const before = new Date(Date.now() - MIN_AGE_DAYS * DAY).toISOString();
  let rows = [];
  try { rows = await sb(`consent_acceptances?kind=in.(${KINDS.join(',')})&accepted_at=lt.${q(before)}&select=id,user_id,kind,scope,meta,accepted_at&order=accepted_at.asc&limit=2000`); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const del = []; let kept = 0;
  for (const c of rows || []) {
    if (del.length >= MAX_DELETE) break;
    const m = c.meta || {};
    const coach = String(c.scope || m.coach_id || '');
    const uid = String(c.user_id || '');
    if (!uid || !coach) { kept++; continue; }
    const from = new Date(new Date(c.accepted_at).getTime() - DAY).toISOString();
    const to = new Date(new Date(c.accepted_at).getTime() + WINDOW_DAYS * DAY).toISOString();
    const win = `created_at=gte.${q(from)}&created_at=lte.${q(to)}`;
    // Platba od tohoto člověka (za sebe nebo za někoho) tomuto kouči.
    let used = await any(`transactions?coach_id=eq.${q(coach)}&or=(member_id.eq.${q(uid)},paid_by.eq.${q(uid)})&${win}&select=id`);
    if (!used && c.kind === 'online_plan_start') used = await any(`gym_memberships?coach_id=eq.${q(coach)}&or=(student_id.eq.${q(uid)},paid_by.eq.${q(uid)})&status=not.in.(cancelled,pending,pending_offline)&${win}&select=id`);
    if (!used && c.kind !== 'online_plan_start') used = await any(`bookings?coach_id=eq.${q(coach)}&or=(student_id.eq.${q(uid)},paid_by.eq.${q(uid)})&${win}&select=id`);
    if (used) { kept++; continue; }
    del.push(c.id);
  }
  let deleted = 0;
  for (let i = 0; i < del.length; i += 100) {
    const chunk = del.slice(i, i + 100);
    // Souhlasy jsou chráněné triggerem proti změně i smazání. Mazat smí jen funkce
    // prune_consent_acceptances (sql/consent-prune.sql), a jen tyto tři druhy.
    try { const n = await sb('rpc/prune_consent_acceptances', { method: 'POST', body: JSON.stringify({ p_ids: chunk.map(String) }) }); deleted += Number(n) || 0; }
    catch (e) { console.error('[consent-prune]', e.message); }
  }
  return res.status(200).json({ ok: true, checked: (rows || []).length, kept, deleted });
}
