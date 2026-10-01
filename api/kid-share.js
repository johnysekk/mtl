// /api/kid-share — SDÍLENÍ PÉČE O DÍTĚ S BLÍZKOU OSOBOU.
//
// Dítě žije na účtu jednoho zákonného zástupce (držitel, profiles.children). Držitel může
// u každého dítěte zvlášť a u každé blízké osoby zvlášť (propojené v Rodině) zapnout sdílení.
// Blízká osoba ho musí přijmout. Držitel může kdykoli vypnout; blízká osoba může odejít.
//
// Co sdílení dává: kartu dítěte (věk, pásky, docházka, nadcházející lekce), zdravotní poznámku
// jen se svolením (see_health). S can_act navíc jednat: přihlásit na lekci, koupit členství,
// zaplatit, omluvit. Záznam se pak vede na držitele a dítě, plátcem je blízká osoba (paid_by).
// Souhlasy za dítě (podmínky klubu, přihláška za člena) smí dát jen zákonný zástupce:
// is_guardian nastaví držitel a blízká osoba to musí sama potvrdit (guardian_confirmed_at).
// Kdo zákonný zástupce není, jedná jen tam, kde souhlas už je; jinak požádá držitele.
//
// Dítě je v profilu držitele a do cizího profilu blízká osoba po zapnutí RLS nesmí, proto
// všechno čte a zapisuje server. Tabulka kid_shares je za RLS bez politik.
//
//   POST { action:'mine' }                                   držitel: blízké osoby + sdílení
//   POST { action:'set', kid_key, person_id, enabled, see_health, can_act, is_guardian }  držitel
//   POST { action:'with_me' }                                blízká osoba: pozvánky + děti
//   POST { action:'respond', id, accept, guardian_confirm }  blízká osoba
//   POST { action:'confirm_guardian', id }                   blízká osoba potvrdí prohlášení
//   POST { action:'leave', id }                              blízká osoba ukončí sdílení
//   POST { action:'consent_check', id, gym_id }              je u klubu souhlas za dítě?
//   POST { action:'ask_holder', id, gym_id }                 požádat držitele o souhlas
//   POST { action:'excuse', id, booking_id, reason }         omluvit dítě z lekce (jednorázový vstup)
//   POST { action:'release', id, reservation_id, reason }    uvolnit rezervaci v rámci členství
//   POST { action:'trial_left', id, gym_id }                 kolik zkušebních zbývá dítěti

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
// extra: cíl prokliku (kid_key = které dítě, share_id). Appka podle kind otevře Rodinu
// a u kid_share_accepted rovnou nastavení sdílení toho dítěte.
async function notify(userId, kind, cs, en, lang, extra) {
  try {
    await sb('notifications', { method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({ user_id: userId, type: 'system', read: false,
        data: JSON.stringify(Object.assign({ kind, msg_cs: cs, msg_en: en }, extra || {})), message: lang === 'en' ? en : cs }) });
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
      const shares = (await sb(`kid_shares?holder_id=eq.${q(me)}&status=in.(pending,active)&select=id,kid_id,person_id,status,see_health,can_act,is_guardian,guardian_confirmed_at`)) || [];
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
        // Zákonný zástupce má plná práva: vidí zdravotní poznámku a smí jednat.
        const isGuard = !!b.is_guardian;
        const seeHealth = isGuard || !!b.see_health;
        const canAct = isGuard || !!b.can_act;
        if (open) {
          const cur = ((await sb(`kid_shares?id=eq.${q(open.id)}&select=is_guardian,guardian_confirmed_at`)) || [])[0] || {};
          const patch = { see_health: seeHealth, can_act: canAct, is_guardian: isGuard };
          // Nově označený zákonný zástupce musí prohlášení potvrdit sám; odebráním se ruší.
          if (!isGuard || !cur.is_guardian) patch.guardian_confirmed_at = null;
          await sb(`kid_shares?id=eq.${q(open.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
          if (isGuard && !cur.is_guardian && open.status === 'active') {
            await notify(pid, 'kid_share_guardian',
              `\ud83d\udc6a ${(mp && mp.name) || 'Blízká osoba'} tě u dítěte ${first} označil/a jako zákonného zástupce. Potvrď to v Rodině.`,
              `\ud83d\udc6a ${(mp && mp.name) || 'Someone close'} marked you as ${first}'s legal guardian. Confirm it in Family.`, pp && pp.lang, { share_id: open.id });
          }
          return res.status(200).json({ ok: true, id: open.id, status: open.status });
        }
        const ins = await sb('kid_shares', { method: 'POST', prefer: 'return=representation',
          body: JSON.stringify({ holder_id: me, kid_id: kKey, kid_name: kid.name, person_id: pid, status: 'pending',
            see_health: seeHealth, can_act: canAct, is_guardian: isGuard }) });
        await notify(pid, 'kid_share_invite',
          `\ud83d\udc6a ${(mp && mp.name) || 'Blízká osoba'} s tebou chce sdílet péči o dítě ${first}. Přijmi to v Rodině.`,
          `\ud83d\udc6a ${(mp && mp.name) || 'Someone close'} wants to share ${first}'s care with you. Accept it in Family.`, pp && pp.lang,
          { share_id: ins && ins[0] && ins[0].id });
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
      const today = new Date().toISOString().slice(0, 10);
      const one = async (r) => {
        const h = byId[r.holder_id];
        const kid = kidsOf(h).find((k) => kidKey(k) === r.kid_id && !k._archived);
        if (!kid) {
          // Dítě už u držitele není (smazané, archivované, předané) -- sdílení končí samo.
          await sb(`kid_shares?id=eq.${q(r.id)}`, { method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ status: 'revoked', revoked_at: new Date().toISOString() }) });
          return null;
        }
        const guardian = !!(r.is_guardian && r.guardian_confirmed_at);
        const item = { id: r.id, status: r.status, holder_id: r.holder_id, holder_name: (h && h.name) || '',
          can_act: !!r.can_act, is_guardian: !!r.is_guardian, guardian,
          needs_guardian_confirm: !!(r.is_guardian && !r.guardian_confirmed_at),
          kid: { key: r.kid_id, id: kid.id || null, name: kid.name, first: kid.firstName || kid.name, dob: kid.dob || null,
            age: age(kid.dob), belts: kid.belts || {},
            trophy_img: kid.trophy_img || null, health: (r.see_health && kid.health) ? kid.health : null } };
        if (r.status !== 'active') return item;
        const H = q(r.holder_id), K = q(kid.name);
        const safe = (pr) => pr.then((x) => x || []).catch(() => []);
        const [att, bk, ex, mm, rs] = await Promise.all([
          safe(sb(`gym_attendance?student_id=eq.${H}&child_name=eq.${K}&select=class_date,class_name,gym_id&order=class_date.desc&limit=5`)),
          safe(sb(`gym_bookings?student_id=eq.${H}&child_name=eq.${K}&class_date=gte.${today}&status=not.in.(cancelled,refunded)&select=id,gym_id,gym_name,class_name,class_date,class_time,status&order=class_date.asc&limit=10`)),
          safe(sb(`gym_excuses?student_id=eq.${H}&child_name=eq.${K}&class_date=gte.${today}&select=gym_id,class_date,class_time`)),
          safe(sb(`gym_memberships?student_id=eq.${H}&child_name=eq.${K}&status=in.(active,cancelling)&select=id,gym_name,plan_name,period_end,status`)),
          safe(sb(`gym_class_reservations?student_id=eq.${H}&child_name=eq.${K}&class_date=gte.${today}&select=id,gym_name,class_name,class_date,class_time&order=class_date.asc&limit=10`)),
        ]);
        const gids = [...new Set(att.map((a) => a.gym_id).filter(Boolean))];
        const gs = gids.length ? await safe(sb(`gyms?id=in.(${gids.map(q).join(',')})&select=id,name`)) : [];
        const gn = {}; gs.forEach((g) => { gn[g.id] = g.name; });
        item.recent = att.map((a) => ({ date: a.class_date, cls: a.class_name || '', gym: gn[a.gym_id] || '' }));
        const exk = new Set(ex.map((e) => `${e.gym_id}|${e.class_date}|${e.class_time}`));
        item.upcoming = bk.map((x) => ({ id: x.id, gym: x.gym_name || '', cls: x.class_name || '', date: x.class_date, time: x.class_time || '',
          status: x.status, excused: exk.has(`${x.gym_id}|${x.class_date}|${x.class_time}`) }));
        item.memberships = mm.map((m) => ({ gym: m.gym_name || '', plan: m.plan_name || '', until: m.period_end || null, status: m.status }));
        item.reservations = rs.map((x) => ({ id: x.id, gym: x.gym_name || '', cls: x.class_name || '', date: x.class_date, time: x.class_time || '' }));
        return item;
      };
      const out = (await Promise.all(rows.map(one))).filter(Boolean);
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
        const patch = { status: ok ? 'active' : 'declined', responded_at: new Date().toISOString() };
        if (ok && row.is_guardian && b.guardian_confirm) patch.guardian_confirmed_at = new Date().toISOString();
        await sb(`kid_shares?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
        await notify(row.holder_id, ok ? 'kid_share_accepted' : 'kid_share_declined',
          ok ? `\u2705 ${(mp && mp.name) || 'Blízká osoba'} přijal/a sdílení péče o dítě ${row.kid_name}. Teď můžeš nastavit, jestli smí za dítě jednat.` : `${(mp && mp.name) || 'Blízká osoba'} sdílení péče o dítě ${row.kid_name} odmítl/a.`,
          ok ? `\u2705 ${(mp && mp.name) || 'Your close person'} accepted sharing ${row.kid_name}'s care. You can now set whether they may act for the child.` : `${(mp && mp.name) || 'Your close person'} declined sharing ${row.kid_name}'s care.`,
          hp && hp.lang, { kid_key: row.kid_id, share_id: row.id });
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

    // ── JEDNAT ZA DÍTĚ ────────────────────────────────────────────────────────────────
    if (['confirm_guardian', 'consent_check', 'ask_holder', 'excuse', 'release', 'trial_left'].includes(b.action)) {
      const row = ((await sb(`kid_shares?id=eq.${q(String(b.id || ''))}&person_id=eq.${q(me)}&status=eq.active&select=*`)) || [])[0];
      if (!row) return res.status(404).json({ error: 'not_found' });
      const mp = await profile(me, 'name');
      const myName = (mp && mp.name) || '';

      if (b.action === 'confirm_guardian') {
        if (!row.is_guardian) return res.status(409).json({ error: 'not_marked' });
        await sb(`kid_shares?id=eq.${q(row.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ guardian_confirmed_at: new Date().toISOString() }) });
        return res.status(200).json({ ok: true });
      }
      if (!row.can_act) return res.status(403).json({ error: 'cannot_act' });

      if (b.action === 'consent_check') {
        // Souhlas za dítě u klubu už existuje, když: držitel přijal provozní řád klubu, nebo
        // dítě u klubu už něco má (zaplacený vstup / členství -- držitel to tehdy odsouhlasil).
        const gid = String(b.gym_id || '');
        const g = ((await sb(`gyms?id=eq.${q(gid)}&select=org_form`)) || [])[0] || {};
        const wa = (await sb(`waiver_acceptances?gym_id=eq.${q(gid)}&or=${q(`(student_id.eq.${row.holder_id},guardian_id.eq.${row.holder_id})`)}&select=id&limit=1`)) || [];
        const mb = (await sb(`gym_memberships?gym_id=eq.${q(gid)}&student_id=eq.${q(row.holder_id)}&child_name=eq.${q(row.kid_name)}&status=in.(active,cancelling,expired)&select=id&limit=1`)) || [];
        const bk = (await sb(`gym_bookings?gym_id=eq.${q(gid)}&student_id=eq.${q(row.holder_id)}&child_name=eq.${q(row.kid_name)}&status=not.in.(pending,cancelled,refunded)&select=id&limit=1`)) || [];
        const app = (await sb(`gym_member_applications?gym_id=eq.${q(gid)}&student_id=eq.${q(row.holder_id)}&applicant_name=eq.${q(row.kid_name)}&status=in.(pending,approved)&select=id&limit=1`)) || [];
        return res.status(200).json({ ok: true, terms_ok: !!(wa.length || mb.length || bk.length), app_ok: !!app.length,
          nonprofit: g.org_form === 'nonprofit', guardian: !!(row.is_guardian && row.guardian_confirmed_at) });
      }

      if (b.action === 'ask_holder') {
        const g = ((await sb(`gyms?id=eq.${q(String(b.gym_id || ''))}&select=name`)) || [])[0] || {};
        const hp = await profile(row.holder_id, 'lang');
        await notify(row.holder_id, 'kid_share_consent_ask',
          `\ud83d\udc6a ${myName || 'Blízká osoba'} chce přihlásit dítě ${row.kid_name} v klubu ${g.name || ''}. Podmínky klubu za dítě musíš odsouhlasit ty: otevři klub a přihlas dítě, nebo mu jako zákonnému zástupci povol souhlasy v nastavení sdílení.`,
          `\ud83d\udc6a ${myName || 'Someone close'} wants to sign ${row.kid_name} up at ${g.name || 'a club'}. The club terms have to be accepted by you: open the club and book for the child, or mark them as legal guardian in the sharing settings.`,
          hp && hp.lang, { kid_key: row.kid_id, share_id: row.id, gym_id: String(b.gym_id || '') });
        return res.status(200).json({ ok: true });
      }

      if (b.action === 'trial_left') {
        // Stejná pravidla jako u vlastního dítěte (trialLeft v appce): kdo u klubu platil,
        // zkušební nemá; jinak počet z nastavení klubu mínus už využité -- na účtu držitele.
        const gid = String(b.gym_id || '');
        const g = ((await sb(`gyms?id=eq.${q(gid)}&select=trial_classes`)) || [])[0] || {};
        const total = Math.max(0, Math.min(3, parseInt(g.trial_classes || 0, 10) || 0));
        if (!total) return res.status(200).json({ ok: true, left: 0, total });
        const paid = (await sb(`transactions?gym_id=eq.${q(gid)}&member_id=eq.${q(row.holder_id)}&select=id&limit=1`)) || [];
        if (paid.length) return res.status(200).json({ ok: true, left: 0, total });
        // Jako book_trial: zrušené se nepočítají, ale víc než jedno zrušení nárok bere.
        const tr = (await sb(`gym_trials?gym_id=eq.${q(gid)}&student_id=eq.${q(row.holder_id)}&child_name=eq.${q(row.kid_name)}&select=cancelled_at`)) || [];
        const canc = tr.filter((x) => x.cancelled_at).length;
        if (canc > 1) return res.status(200).json({ ok: true, left: 0, total });
        return res.status(200).json({ ok: true, left: Math.max(0, total - tr.filter((x) => !x.cancelled_at).length), total });
      }

      if (b.action === 'release') {
        const rv = ((await sb(`gym_class_reservations?id=eq.${q(String(b.reservation_id || ''))}&student_id=eq.${q(row.holder_id)}&child_name=eq.${q(row.kid_name)}&select=gym_id,class_name,class_date,class_time`)) || [])[0];
        if (!rv) return res.status(404).json({ error: 'reservation_not_found' });
        await sb(`gym_class_reservations?id=eq.${q(String(b.reservation_id))}`, { method: 'DELETE', prefer: 'return=minimal' });
        const dup = (await sb(`gym_excuses?gym_id=eq.${q(rv.gym_id)}&student_id=eq.${q(row.holder_id)}&child_name=eq.${q(row.kid_name)}&class_date=eq.${q(rv.class_date)}&class_time=eq.${q(rv.class_time)}&select=id&limit=1`)) || [];
        if (!dup.length) {
          const hp0 = await profile(row.holder_id, 'name');
          await sb('gym_excuses', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({
            gym_id: rv.gym_id, student_id: row.holder_id, student_name: (hp0 && hp0.name) || null,
            class_name: rv.class_name, class_date: rv.class_date, class_time: rv.class_time,
            reason_key: null, note: String(b.reason || '').slice(0, 300) || null, child_name: row.kid_name, source: 'membership' }) });
        }
        const hp = await profile(row.holder_id, 'lang');
        await notify(row.holder_id, 'kid_share_excused',
          `${myName || 'Blízká osoba'} uvolnil/a rezervaci dítěte ${row.kid_name} na lekci ${rv.class_name || ''} (${rv.class_date}).`,
          `${myName || 'Someone close'} released ${row.kid_name}'s spot in ${rv.class_name || 'a class'} (${rv.class_date}).`, hp && hp.lang);
        return res.status(200).json({ ok: true });
      }

      if (b.action === 'excuse') {
        const bk = ((await sb(`gym_bookings?id=eq.${q(String(b.booking_id || ''))}&student_id=eq.${q(row.holder_id)}&child_name=eq.${q(row.kid_name)}&select=gym_id,class_name,class_date,class_time`)) || [])[0];
        if (!bk) return res.status(404).json({ error: 'booking_not_found' });
        const dup = (await sb(`gym_excuses?gym_id=eq.${q(bk.gym_id)}&student_id=eq.${q(row.holder_id)}&child_name=eq.${q(row.kid_name)}&class_date=eq.${q(bk.class_date)}&class_time=eq.${q(bk.class_time)}&select=id&limit=1`)) || [];
        if (!dup.length) {
          const hp0 = await profile(row.holder_id, 'name');
          await sb('gym_excuses', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({
            gym_id: bk.gym_id, student_id: row.holder_id, student_name: (hp0 && hp0.name) || null,
            class_name: bk.class_name, class_date: bk.class_date, class_time: bk.class_time,
            reason_key: null, note: String(b.reason || '').slice(0, 300) || null, child_name: row.kid_name, source: 'dropin' }) });
          const hp = await profile(row.holder_id, 'lang');
          await notify(row.holder_id, 'kid_share_excused',
            `${myName || 'Blízká osoba'} omluvil/a dítě ${row.kid_name} z lekce ${bk.class_name || ''} (${bk.class_date}).`,
            `${myName || 'Someone close'} excused ${row.kid_name} from ${bk.class_name || 'a class'} (${bk.class_date}).`, hp && hp.lang);
        }
        return res.status(200).json({ ok: true });
      }
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}
