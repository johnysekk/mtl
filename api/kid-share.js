// /api/kid-share — SDÍLENÍ PÉČE O DÍTĚ S BLÍZKOU OSOBOU.
//
// Dítě žije na účtu jednoho zákonného zástupce (držitel, profiles.children). Držitel může
// u každého dítěte zvlášť a u každé blízké osoby zvlášť (propojené v Rodině) zapnout sdílení.
// Blízká osoba ho musí přijmout. Držitel může kdykoli vypnout; blízká osoba může odejít.
//
// Co sdílení dává (fáze 1): kartu dítěte -- věk, pásky, docházku -- a zdravotní poznámku jen
// když ji držitel povolí (see_health). Jednat za dítě (rezervace, platby, souhlasy) přijde
// ve fázi 2 přes can_act / is_guardian; sloupce jsou připravené, appka je zatím nenastavuje.
//
// Dítě je v profilu držitele a do cizího profilu blízká osoba po zapnutí RLS nesmí, proto
// všechno čte a zapisuje server. Tabulka kid_shares je za RLS bez politik.
//
//   POST { action:'mine' }                                   držitel: blízké osoby + sdílení
//   POST { action:'set', kid_key, person_id, enabled, see_health }   držitel
//   POST { action:'with_me' }                                blízká osoba: pozvánky + děti
//   POST { action:'respond', id, accept }                    blízká osoba
//   POST { action:'leave', id }                              blízká osoba ukončí sdílení

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}) },
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
async function profile(id, cols) { return ((await sb(`profiles?id=eq.${q(id)}&select=${cols}`)) || [])[0] || null; }
function kidsOf(p) { try { const c = p && p.children; return (typeof c === 'string' ? JSON.parse(c) : c) || []; } catch (e) { return []; } }
// Starší děti nemají id -- klíčem je pak jméno.
const kidKey = (k) => (k && k.id) ? String(k.id) : ('name:' + String((k && k.name) || ''));
function age(dob) {
  if (!dob) return null; const b = new Date(dob); if (isNaN(b)) return null; const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}
// Blízké osoby: propojení dvou dospělých v Rodině (relation='partner'), aktivní.
async function closePersons(me) {
  const rows = (await sb(`family_links?status=eq.active&relation=eq.partner&or=${q(`(guardian_id.eq.${me},member_id.eq.${me})`)}&select=guardian_id,member_id`)) || [];
  return [...new Set(rows.map((r) => (r.guardian_id === me ? r.member_id : r.guardian_id)).filter(Boolean))];
}
async function notify(userId, kind, cs, en, lang) {
  try {
    await sb('notifications', { method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({ user_id: userId, type: 'system', read: false,
        data: JSON.stringify({ kind, msg_cs: cs, msg_en: en }), message: lang === 'en' ? en : cs }) });
  } catch (e) { console.error('[kid-share] notify', e.message); }
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const me = await whoami(req);
    if (!me) return res.status(401).json({ error: 'no token' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // ── DRŽITEL ──────────────────────────────────────────────────────────────────────
    if (b.action === 'mine') {
      const ids = await closePersons(me);
      const people = ids.length ? ((await sb(`profiles?id=in.(${ids.map(q).join(',')})&select=id,name`)) || []) : [];
      const shares = (await sb(`kid_shares?holder_id=eq.${q(me)}&status=in.(pending,active)&select=id,kid_id,person_id,status,see_health`)) || [];
      return res.status(200).json({ ok: true, people, shares });
    }

    if (b.action === 'set') {
      const kKey = String(b.kid_key || ''); const pid = String(b.person_id || '');
      const mp = await profile(me, 'name,children');
      const kid = kidsOf(mp).find((k) => kidKey(k) === kKey && !k._archived);
      if (!kid) return res.status(404).json({ error: 'kid_not_found' });
      if (!(await closePersons(me)).includes(pid)) return res.status(403).json({ error: 'not_close_person' });
      const open = ((await sb(`kid_shares?holder_id=eq.${q(me)}&kid_id=eq.${q(kKey)}&person_id=eq.${q(pid)}&status=in.(pending,active)&select=id,status`)) || [])[0];
      const pp = await profile(pid, 'lang');
      const first = kid.firstName || kid.name;
      if (b.enabled) {
        const seeHealth = !!b.see_health;
        if (open) {
          await sb(`kid_shares?id=eq.${q(open.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ see_health: seeHealth }) });
          return res.status(200).json({ ok: true, id: open.id, status: open.status });
        }
        const ins = await sb('kid_shares', { method: 'POST', prefer: 'return=representation',
          body: JSON.stringify({ holder_id: me, kid_id: kKey, kid_name: kid.name, person_id: pid, status: 'pending', see_health: seeHealth }) });
        await notify(pid, 'kid_share_invite',
          `\ud83d\udc6a ${(mp && mp.name) || 'Blízká osoba'} s tebou chce sdílet péči o dítě ${first}. Přijmi to v Rodině.`,
          `\ud83d\udc6a ${(mp && mp.name) || 'Someone close'} wants to share ${first}'s care with you. Accept it in Family.`, pp && pp.lang);
        return res.status(200).json({ ok: true, id: ins && ins[0] && ins[0].id, status: 'pending' });
      }
      if (open) {
        await sb(`kid_shares?id=eq.${q(open.id)}`, { method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: 'revoked', revoked_at: new Date().toISOString() }) });
        if (open.status === 'active') {
          await notify(pid, 'kid_share_revoked', `Sdílení péče o dítě ${first} bylo ukončeno.`, `Sharing ${first}'s care has ended.`, pp && pp.lang);
        }
      }
      return res.status(200).json({ ok: true, status: 'off' });
    }

    // ── BLÍZKÁ OSOBA ─────────────────────────────────────────────────────────────────
    if (b.action === 'with_me') {
      const rows = (await sb(`kid_shares?person_id=eq.${q(me)}&status=in.(pending,active)&select=*&order=created_at.asc`)) || [];
      const holders = [...new Set(rows.map((r) => r.holder_id))];
      const hp = holders.length ? ((await sb(`profiles?id=in.(${holders.map(q).join(',')})&select=id,name,children`)) || []) : [];
      const byId = {}; hp.forEach((p) => { byId[p.id] = p; });
      const out = [];
      for (const r of rows) {
        const h = byId[r.holder_id];
        const kid = kidsOf(h).find((k) => kidKey(k) === r.kid_id && !k._archived);
        if (!kid) {
          // Dítě už u držitele není (smazané, archivované, předané) -- sdílení končí samo.
          await sb(`kid_shares?id=eq.${q(r.id)}`, { method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ status: 'revoked', revoked_at: new Date().toISOString() }) });
          continue;
        }
        const item = { id: r.id, status: r.status, holder_name: (h && h.name) || '',
          kid: { name: kid.name, first: kid.firstName || kid.name, age: age(kid.dob), belts: kid.belts || {},
            trophy_img: kid.trophy_img || null, health: (r.see_health && kid.health) ? kid.health : null } };
        if (r.status === 'active') {
          try {
            const att = (await sb(`gym_attendance?student_id=eq.${q(r.holder_id)}&child_name=eq.${q(kid.name)}&select=class_date,class_name,gym_id&order=class_date.desc&limit=5`)) || [];
            const gids = [...new Set(att.map((a) => a.gym_id).filter(Boolean))];
            const gs = gids.length ? ((await sb(`gyms?id=in.(${gids.map(q).join(',')})&select=id,name`)) || []) : [];
            const gn = {}; gs.forEach((g) => { gn[g.id] = g.name; });
            item.recent = att.map((a) => ({ date: a.class_date, cls: a.class_name || '', gym: gn[a.gym_id] || '' }));
          } catch (e) { item.recent = []; }
        }
        out.push(item);
      }
      return res.status(200).json({ ok: true, items: out });
    }

    if (b.action === 'respond' || b.action === 'leave') {
      const row = ((await sb(`kid_shares?id=eq.${q(String(b.id || ''))}&person_id=eq.${q(me)}&select=*`)) || [])[0];
      if (!row) return res.status(404).json({ error: 'not_found' });
      const mp = await profile(me, 'name');
      const hp = await profile(row.holder_id, 'lang');
      if (b.action === 'respond') {
        if (row.status !== 'pending') return res.status(409).json({ error: 'not_pending' });
        const ok = !!b.accept;
        await sb(`kid_shares?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: ok ? 'active' : 'declined', responded_at: new Date().toISOString() }) });
        await notify(row.holder_id, ok ? 'kid_share_accepted' : 'kid_share_declined',
          ok ? `\u2705 ${(mp && mp.name) || 'Blízká osoba'} přijal/a sdílení péče o dítě ${row.kid_name}.` : `${(mp && mp.name) || 'Blízká osoba'} sdílení péče o dítě ${row.kid_name} odmítl/a.`,
          ok ? `\u2705 ${(mp && mp.name) || 'Your close person'} accepted sharing ${row.kid_name}'s care.` : `${(mp && mp.name) || 'Your close person'} declined sharing ${row.kid_name}'s care.`,
          hp && hp.lang);
        return res.status(200).json({ ok: true });
      }
      if (!['pending', 'active'].includes(row.status)) return res.status(409).json({ error: 'not_open' });
      await sb(`kid_shares?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ status: 'revoked', revoked_at: new Date().toISOString() }) });
      await notify(row.holder_id, 'kid_share_left',
        `${(mp && mp.name) || 'Blízká osoba'} ukončil/a sdílení péče o dítě ${row.kid_name}.`,
        `${(mp && mp.name) || 'Your close person'} stopped sharing ${row.kid_name}'s care.`, hp && hp.lang);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}
