// /api/member-address — EVIDENCE ČLENŮ: ADRESY BYDLIŠTĚ PRO KLUB.
//
// Adresa je nepovinná a člověk ji má v member_addresses (jen pro sebe, pod RLS). Klub ji uvidí
// jen když (a) má u něj člověk aktivní členství (sám nebo jeho dítě) a (b) člověk zapnul
// „Zobrazovat klubu" (address_shares). Jinak klub vidí jen to, že adresa chybí / není sdílená.
// Ostatní poskytovatelé (kouči, jiné kluby) ji nevidí nikdy.
//
//   POST { action:'list',    gym_id }   majitel / spolumajitel: členové + stav adresy (+ adresa, je-li sdílená)
//                                       + kontakt (e-mail, telefon jen se souhlasem) -- podklad pro export členů
//   POST { action:'person',  gym_id, student_id, child_name }   adresa jednoho člena do jeho detailu
//   POST { action:'request', gym_id }   pošle žádost o doplnění těm, komu adresa chybí nebo ji klubu nesdílí
//                                       (nejvýš jednou za 30 dní)

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
const REQUEST_EVERY_DAYS = 30;

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
  if (!r.ok) return null;
  const u = await r.json();
  return (u && u.id) ? u.id : null;
}
function kidsOf(p) { try { const c = p && p.children; return (typeof c === 'string' ? JSON.parse(c) : c) || []; } catch (e) { return []; } }
const kidKey = (k) => (k && k.id) ? String(k.id) : ('name:' + String((k && k.name) || ''));
const inList = (ids) => `(${ids.map(q).join(',')})`;

// Adresy jsou citlivé: jen majitel a spolumajitel, ne každý trenér se správou rozvrhu.
async function canSee(gym, me) {
  if (String(gym.owner_id) === String(me)) return true;
  const gc = (await sb(`gym_coaches?gym_id=eq.${q(gym.id)}&coach_id=eq.${q(me)}&status=eq.active&select=co_owner`)) || [];
  return gc.some((x) => x.co_owner);
}

async function members(gym) {
  const ms = (await sb(`gym_memberships?gym_id=eq.${q(gym.id)}&status=in.(active,cancelling)&select=student_id,child_name,student_name`)) || [];
  const owners = [...new Set(ms.map((m) => m.student_id).filter(Boolean))];
  if (!owners.length) return { rows: [], owners: [] };
  const [profs, addrs, shares] = await Promise.all([
    sb(`profiles?id=in.${inList(owners)}&select=id,name,birthdate,children,email,phone,phone_show`),
    sb(`member_addresses?owner_id=in.${inList(owners)}&select=*`),
    sb(`address_shares?gym_id=eq.${q(gym.id)}&owner_id=in.${inList(owners)}&select=owner_id`),
  ]);
  const P = {}; (profs || []).forEach((p) => { P[p.id] = p; });
  const A = {}; (addrs || []).forEach((a) => { A[`${a.owner_id}|${a.person_key}`] = a; });
  const S = new Set((shares || []).map((s) => String(s.owner_id)));
  const seen = new Set(); const rows = [];
  for (const m of ms) {
    if (!m.student_id) continue;
    const k = `${m.student_id}|${m.child_name || ''}`; if (seen.has(k)) continue; seen.add(k);
    const p = P[m.student_id] || {};
    let personKey = 'self', name = p.name || m.student_name || '', dob = p.birthdate || null, isKid = false;
    if (m.child_name) {
      const kid = kidsOf(p).find((x) => String(x.name || '') === String(m.child_name));
      personKey = kid ? kidKey(kid) : ('name:' + m.child_name);
      name = m.child_name; dob = (kid && kid.dob) || null; isKid = true;
    }
    const a = A[`${m.student_id}|${personKey}`] || null;
    const shared = S.has(String(m.student_id));
    const hasAddr = !!(a && a.street && a.city);
    rows.push({ owner_id: m.student_id, name, is_kid: isKid, guardian: isKid ? (p.name || '') : null, dob,
      email: p.email || '', phone: (p.phone_show && p.phone) ? p.phone : '', child_name: m.child_name || null,
      has_address: hasAddr, shared,
      address: (shared && a) ? { street: a.street || '', postal: a.postal || '', city: a.city || '', country: a.country || '', citizenship: a.citizenship || '' } : null });
  }
  rows.sort((x, y) => String(x.name).localeCompare(String(y.name), 'cs'));
  return { rows, owners };
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const me = await whoami(req);
    if (!me) return res.status(401).json({ error: 'no token' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const gym = ((await sb(`gyms?id=eq.${q(String(b.gym_id || ''))}&select=id,name,owner_id`)) || [])[0];
    if (!gym) return res.status(404).json({ error: 'gym not found' });
    if (!(await canSee(gym, me))) return res.status(403).json({ error: 'forbidden' });

    // RYCHLÁ CESTA PRO DETAIL ČLENA. Dřív se kvůli jednomu člověku sestavoval celý seznam
    // členů klubu (všechna členství, profily, adresy) -- detail čekal ~2,5 s. Teď jen dotazy na
    // toho jednoho člověka, souběžně.
    if (b.action === 'person') {
      const sid = String(b.student_id || ''); const cn = String(b.child_name || '');
      if (!sid) return res.status(400).json({ ok: false, error: 'student_id required' });
      const memQ = `gym_memberships?gym_id=eq.${q(gym.id)}&student_id=eq.${q(sid)}&status=in.(active,cancelling)` + (cn ? `&child_name=eq.${q(cn)}` : '&child_name=is.null') + '&select=id&limit=1';
      const [mem, prof, shares] = await Promise.all([
        sb(memQ),
        cn ? sb(`profiles?id=eq.${q(sid)}&select=children`) : Promise.resolve(null),
        sb(`address_shares?gym_id=eq.${q(gym.id)}&owner_id=eq.${q(sid)}&select=owner_id`),
      ]);
      if (!(mem || []).length) return res.status(200).json({ ok: true, member: false });
      let key = 'self';
      if (cn) { const kid = kidsOf((prof || [])[0]).find((x) => String(x.name || '') === cn); key = kid ? kidKey(kid) : ('name:' + cn); }
      const a = ((await sb(`member_addresses?owner_id=eq.${q(sid)}&person_key=eq.${q(key)}&select=street,postal,city,country,citizenship`)) || [])[0] || null;
      const shared = (shares || []).length > 0;
      const has = !!(a && a.street && a.city);
      return res.status(200).json({ ok: true, member: true, has_address: has, shared,
        address: (shared && a) ? { street: a.street || '', postal: a.postal || '', city: a.city || '', country: a.country || '', citizenship: a.citizenship || '' } : null });
    }

    const { rows } = await members(gym);
    const last = ((await sb(`address_requests?gym_id=eq.${q(gym.id)}&select=last_sent_at`)) || [])[0] || null;
    const nextAt = last && last.last_sent_at ? new Date(new Date(last.last_sent_at).getTime() + REQUEST_EVERY_DAYS * 86400000) : null;

    if (b.action === 'list') {
      return res.status(200).json({ ok: true, rows, last_request_at: last ? last.last_sent_at : null,
        next_request_at: (nextAt && nextAt > new Date()) ? nextAt.toISOString() : null });
    }

    if (b.action === 'request') {
      if (nextAt && nextAt > new Date()) return res.status(429).json({ error: 'too_soon', next_request_at: nextAt.toISOString() });
      // Jedna notifikace na účet (rodič s dětmi dostane jednu), jen kde něco chybí.
      const need = {};
      rows.forEach((r) => { if (!r.has_address || !r.shared) { (need[r.owner_id] = need[r.owner_id] || []).push(r); } });
      const ids = Object.keys(need);
      for (const uid of ids) {
        const list = need[uid];
        const kids = list.filter((r) => r.is_kid).map((r) => r.name);
        const forWhom = kids.length ? (list.some((r) => !r.is_kid) ? ` (pro tebe i ${kids.join(', ')})` : ` (pro ${kids.join(', ')})`) : '';
        const forWhomEn = kids.length ? (list.some((r) => !r.is_kid) ? ` (for you and ${kids.join(', ')})` : ` (for ${kids.join(', ')})`) : '';
        const cs = `🏠 ${gym.name} tě prosí o doplnění adresy bydliště${forWhom} a o její zobrazení klubu. Potřebuje ji do evidence členů a pro sportovní dotace. Zabere to minutu.`;
        const en = `🏠 ${gym.name} asks you to add your home address${forWhomEn} and share it with the club. It needs it for the member register and sports grants. Takes a minute.`;
        try {
          const lang = (((await sb(`profiles?id=eq.${q(uid)}&select=lang`)) || [])[0] || {}).lang;
          await sb('notifications', { method: 'POST', prefer: 'return=minimal',
            body: JSON.stringify({ user_id: uid, type: 'system', read: false,
              data: JSON.stringify({ kind: 'address_request', gym_id: gym.id, gym_name: gym.name, msg_cs: cs, msg_en: en }),
              message: lang === 'en' ? en : cs }) });
        } catch (e) { console.error('[member-address] notify', e.message); }
      }
      await sb('address_requests?on_conflict=gym_id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal',
        body: JSON.stringify({ gym_id: gym.id, last_sent_at: new Date().toISOString(), sent_by: me }) });
      return res.status(200).json({ ok: true, sent: ids.length });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}
