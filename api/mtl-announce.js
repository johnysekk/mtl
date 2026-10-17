import { shell, esc, button, APP_URL } from './_mail.js';
// /api/mtl-announce.js — oficiální oznámení od MTL, jednosměrně.
//
// PROČ SERVER: rozesílá se tisícům lidí. Z prohlížeče by to znamenalo tisíce zápisů, RLS
// by část z nich odmítla a půlka by se ztratila při zavření záložky. Tady to proběhne
// jedním během se servisní rolí.
//
// JEDNOSMĚRNĚ: zapisuje se jen notifikace typu 'system' s kind 'mtl_announce'. Nevzniká
// žádné vlákno v chatu, takže není kam odpovědět -- stejně jako klubové oznámení členům.
//
// POST { audience, subject, body, test } + Authorization: Bearer <access token foundera>
//   audience: 'all' | 'providers' | 'coaches' | 'gyms' | 'orgs' | 'students'
//   test: true -> jen spočítá příjemce a NIC neodešle (náhled)
//   as_message: true -> navíc ZPRÁVA ve vlákně od MTL (sender 'support' = „MTL Support",
//                'founder' = „MTL Founder"). Vlákno je jen ke čtení (conversations.no_reply):
//                appka místo pole na psaní ukáže „Nelze odpovědět — v případě nutnosti napiš na
//                Podporu" a databáze odpověď nepustí (sql/mtl-messages.sql).
//   as_email: true -> navíc e-mail (Resend, po dávkách 100).
//
// Jen founder; ověřuje se token proti databázi, ne id z těla.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const RESEND_KEY = process.env.RESEND_API_KEY || process.env.RESEND_KEY;
const MAIL_FROM = process.env.MAIL_FROM || process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';

async function sbGet(path) {
  const out = [];
  const PAGE = 1000;
  for (let off = 0; off <= 200000; off += PAGE) {
    const r = await fetch(`${SB}/rest/v1/${path}&limit=${PAGE}&offset=${off}`, { headers: svc });
    if (!r.ok) break;
    const page = await r.json();
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

async function sbPost(table, rows) {
  const r = await fetch(`${SB}/rest/v1/${table}`, {
    method: 'POST', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`${table}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const token = req.headers['x-access-token'] ||
                  ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!token) return res.status(401).json({ error: 'no token' });
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const uid = (await ures.json()).id;
    if (!uid) return res.status(401).json({ error: 'no user' });
    const pr = await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=role`);
    if (!pr.length || pr[0].role !== 'founder') return res.status(403).json({ error: 'founder only' });

    const { audience, subject, body, test, as_message, sender, as_email } = req.body || {};
    const AUD = ['all', 'providers', 'coaches', 'gyms', 'orgs', 'students'];
    if (AUD.indexOf(audience) < 0) return res.status(400).json({ error: 'audience' });
    const txt = String(body || '').trim();
    if (!test && txt.length < 5) return res.status(400).json({ error: 'body too short' });
    if (txt.length > 2000) return res.status(400).json({ error: 'body too long' });

    // ── KDO TO DOSTANE ────────────────────────────────────────────────────────────────
    // Mrtvé účty se přeskakují vždy: smazané, deaktivované i zablokované.
    const alive = 'deleted_at=is.null&deactivated_at=is.null';
    const ids = new Set();

    const addCoaches = async () => {
      (await sbGet(`profiles?coach_status=eq.approved&${alive}&select=id`)).forEach(p => ids.add(p.id));
    };
    const addGymOwners = async () => {
      const gy = await sbGet('gyms?status=eq.approved&deleted_at=is.null&select=owner_id');
      gy.forEach(g => { if (g.owner_id) ids.add(g.owner_id); });
      // Spolumajitelé taky: klub mají na starost stejně jako vlastník.
      const co = await sbGet('gym_coaches?co_owner=eq.true&status=eq.active&select=coach_id');
      co.forEach(c => { if (c.coach_id) ids.add(c.coach_id); });
    };
    const addOrgOwners = async () => {
      // Dodavatelé (kind 'supplier') nejsou poskytovatelé -- zprávy o provizích a platbách se jich netýkají.
      (await sbGet('organizations?kind=neq.supplier&select=owner_id')).forEach(o => { if (o.owner_id) ids.add(o.owner_id); });
    };

    if (audience === 'coaches') await addCoaches();
    else if (audience === 'gyms') await addGymOwners();
    else if (audience === 'orgs') await addOrgOwners();
    else if (audience === 'providers') { await addCoaches(); await addGymOwners(); await addOrgOwners(); }
    else if (audience === 'students' || audience === 'all') {
      (await sbGet(`profiles?${alive}&select=id`)).forEach(p => ids.add(p.id));
      if (audience === 'students') {
        // Studenti = všichni MÍNUS poskytovatelé.
        const prov = new Set();
        (await sbGet(`profiles?coach_status=eq.approved&${alive}&select=id`)).forEach(p => prov.add(p.id));
        (await sbGet('gyms?status=eq.approved&deleted_at=is.null&select=owner_id')).forEach(g => { if (g.owner_id) prov.add(g.owner_id); });
        (await sbGet('organizations?select=owner_id')).forEach(o => { if (o.owner_id) prov.add(o.owner_id); });
        prov.forEach(x => ids.delete(x));
      }
    }

    const list = [...ids].filter(Boolean);
    if (test) return res.status(200).json({ ok: true, would_send: list.length, audience });
    if (!list.length) return res.status(200).json({ ok: true, sent: 0, audience });

    // ── ODESLÁNÍ ──────────────────────────────────────────────────────────────────────
    // Po dávkách, ať jeden velký zápis nespadne na časový limit. Když dávka selže,
    // pokračuje se dál a spadlé se spočítají -- lepší doručit většinu než nic.
    const head = String(subject || '').trim();
    const msg = '📣 MTL' + (head ? (' · ' + head) : '') + ': ' + txt;
    let sent = 0, failed = 0;
    for (let i = 0; i < list.length; i += 500) {
      const rows = list.slice(i, i + 500).map(id => ({
        user_id: id, type: 'system', read: false, message: msg,
        data: JSON.stringify({ kind: 'mtl_announce', subject: head || null, body: txt, at: new Date().toISOString() }),
      }));
      try { await sbPost('notifications', rows); sent += rows.length; }
      catch (e) { failed += rows.length; console.error('[mtl-announce]', e.message); }
    }
    // ── ZPRÁVA VE VLÁKNĚ OD MTL ─────────────────────────────────────────────────────
    let messages = null, emails = null;
    if (as_message) {
      const who = sender === 'founder' ? 'founder' : 'support';
      const label = who === 'founder' ? 'MTL Founder' : 'MTL Support';
      messages = 0;
      try {
        const have = new Map();
        (await sbGet(`conversations?coach_id=eq.${encodeURIComponent(uid)}&system_sender=eq.${who}&select=id,student_id`)).forEach((c) => have.set(String(c.student_id), c.id));
        const need = list.filter((id) => !have.has(String(id)) && String(id) !== String(uid));
        for (let i = 0; i < need.length; i += 500) {
          const rows = need.slice(i, i + 500).map((id) => ({ student_id: id, coach_id: uid, coach_name: label, student_name: null, system_sender: who, no_reply: true }));
          const r = await fetch(`${SB}/rest/v1/conversations`, { method: 'POST', headers: { ...svc, Prefer: 'return=representation' }, body: JSON.stringify(rows) });
          if (r.ok) ((await r.json()) || []).forEach((c) => have.set(String(c.student_id), c.id));
          else console.error('[mtl-announce] conv', (await r.text()).slice(0, 200));
        }
        const text = (head ? (head + '\n\n') : '') + txt;
        const convIds = list.map((id) => have.get(String(id))).filter(Boolean);
        for (let i = 0; i < convIds.length; i += 500) {
          const rows = convIds.slice(i, i + 500).map((cid) => ({ conversation_id: cid, sender_id: uid, text }));
          try { await sbPost('messages', rows); messages += rows.length; } catch (e) { console.error('[mtl-announce] msg', e.message); }
        }
      } catch (e) { console.error('[mtl-announce] messages', e.message); }
    }
    // ── E-MAIL ──────────────────────────────────────────────────────────────────────
    if (as_email && RESEND_KEY) {
      emails = 0;
      const people = [];
      for (let i = 0; i < list.length; i += 200) {
        (await sbGet(`profiles?id=in.(${list.slice(i, i + 200).map(encodeURIComponent).join(',')})&select=email,lang`)).forEach((p) => { if (p.email) people.push(p); });
      }
      const subj = 'MTL' + (head ? (' · ' + head) : ' · Oznámení');
      for (let i = 0; i < people.length; i += 100) {
        const batch = people.slice(i, i + 100).map((p) => ({ from: MAIL_FROM, to: [p.email], subject: subj,
          html: shell(head || (p.lang === 'en' ? 'Announcement from MTL' : 'Oznámení od MTL'), `<p style="font-size:14px;line-height:1.6;margin:0 0 12px;white-space:pre-line;">${esc(txt)}</p>` + button(APP_URL, p.lang === 'en' ? 'Open the app' : 'Otevřít appku'), p.lang === 'en', false) }));
        try {
          const r = await fetch('https://api.resend.com/emails/batch', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
          if (r.ok) emails += batch.length; else console.error('[mtl-announce] mail', r.status, (await r.text()).slice(0, 200));
        } catch (e) { console.error('[mtl-announce] mail', e.message); }
      }
    }
    return res.status(200).json({ ok: true, audience, sent, failed, messages, emails });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
