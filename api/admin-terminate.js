// /api/admin-terminate — UKONČENÍ SPOLUPRÁCE ZE STRANY MTL (jen zakladatel), s okamžitým účinkem.
// POST { kind:'gym'|'coach'|'org'|'account', id, reason, mode:'refund'|'fulfil',
//        dsa?: { illegal, redress } }
//
// Totéž jako výmaz na žádost poskytovatele (api/entity-close.js + entity-close-cron.js), jen bez
// 30denní lhůty a bez možnosti obnovení:
//   1) profil se hned skryje a nic se na něm neprodá, akce pořadatele zmizí,
//   2) vypořádá se, co je zaplacené na dobu od dneška (_entity-close.js settle): 'refund' = kartou
//      se vrací hned automaticky z účtu poskytovatele, převody a hotovost vrací poskytovatel
//      (seznam dostane e-mailem); 'fulfil' = poskytovatel splní mimo aplikaci. Předplatná končí,
//   3) obsah profilu se vymaže (jako po 30 dnech v cronu). Celý účet: všechny jeho profily,
//      pak účet sám včetně přihlášení. Historie zůstává (doklady, transakce, souhlasy, docházka).
// Důvod je povinný -- poskytovatel ho dostane v notifikaci i e-mailem (DSA čl. 17: odůvodnění).
// dsa: MTL zjistilo nezákonnou nabídku -> informuje kupující za posledních 6 měsíců (čl. 32).
import { one, patch, whoami, loadEntity, ownedEntities, obligations, subscriptionsOf, settle, cancelNow, notify, log, founderId, fmt } from './_entity-close.js';
import { sendMail, shell, para, esc, button, APP_URL } from './_mail.js';
import { dsaInformBuyers } from './_dsa-inform.js';

const q = encodeURIComponent;
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KIND_CS = { account: 'účet', coach: 'profil kouče', gym: 'klub', org: 'organizaci' };
const SUBJ = { account: 'Účet', coach: 'Profil kouče', gym: 'Klub', org: 'Organizace' };
const del = (path) => fetch(`${SB}/rest/v1/${path}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }).catch(() => null);

// Obsah profilu pryč -- stejná pravidla jako výmaz po 30 dnech (cron-attendance.js,
// entity-close-cron.js). Jméno klubu a fakturační identita zůstávají (jsou na dokladech).
async function purge(ent, now) {
  if (ent.kind === 'gym') {
    await patch(`gyms?id=eq.${q(ent.id)}`, { close_settled_at: now });
    await patch(`gyms?id=eq.${q(ent.id)}`, { photos: null, facility_photos: null, description: null, contact_phone: null, contact_email: null,
      contact_public: false, contact_phone_public: false, contact_email_public: false, status: 'deleted', suspended: true, purged_at: now });
  } else if (ent.kind === 'coach') {
    await patch(`profiles?id=eq.${q(ent.id)}`, { coach_status: 'deleted', coach_close_settled_at: now, coach_purged_at: now });
    await del(`slots?coach_profile_id=eq.${q(ent.id)}&booked=eq.false&date=gte.${now.slice(0, 10)}`);
    try { await patch(`gym_coaches?coach_id=eq.${q(ent.id)}&status=eq.active`, { status: 'removed' }); } catch (e) {}
  } else if (ent.kind === 'org') {
    await patch(`organizations?id=eq.${q(ent.id)}`, { close_settled_at: now, purged_at: now });
    try { await patch(`organizations?id=eq.${q(ent.id)}`, { logo_url: null }); } catch (e) {}
  } else if (ent.kind === 'account') {
    const p = await one(`profiles?id=eq.${q(ent.id)}&select=id,name,email,deleted_at`);
    try { await fetch(`${SB}/rest/v1/deleted_identities`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: ent.id, name: (p && p.name) || null, email: (p && p.email) || null, deleted_at: (p && p.deleted_at) || now, purged_at: now }) }); } catch (e) {}
    await patch(`profiles?id=eq.${q(ent.id)}`, { name: 'Smazaný uživatel', photo_url: null, bio: null, emoji: null,
      phone: null, contact_phone: null, contact_email: null, billing_phone: null, invoice_email: null,
      health_note: null, guardian_email: null, guardian_name: null, guardian_phone: null,
      children: null, coach_status: 'deleted', purged_at: now, close_mode: 'done' });
    for (const t of ['demand_signals', 'demand_sounding_replies', 'course_alerts', 'slot_alerts']) await del(`${t}?user_id=eq.${q(ent.id)}`);
    try { await fetch(`${SB}/auth/v1/admin/users/${ent.id}`, { method: 'DELETE', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }); } catch (e) {}
  }
}

async function terminateOne(ent, admin, mode, reason, now) {
  if (ent.kind !== 'account' && ent.settledAt) return { skipped: true };
  const nowMs = new Date(now).getTime();
  // Stav jako u výmazu: skryté hned, nic se neprodá (mtl_sale_blocked, sql/entity-close.sql).
  const fields = ent.kind === 'coach' ? { coach_closing_at: now, coach_close_mode: mode }
    : { deleted_at: now, close_mode: mode, delete_reason: 'MTL: ' + reason };
  if (ent.kind === 'gym') await patch(`gyms?id=eq.${q(ent.id)}`, fields);
  else if (ent.kind === 'org') await patch(`organizations?id=eq.${q(ent.id)}`, fields);
  else await patch(`profiles?id=eq.${q(ent.id)}`, fields);
  const evF = ent.kind === 'gym' ? `gym_id=eq.${q(ent.id)}` : ent.kind === 'org' ? `organization_id=eq.${q(ent.id)}`
    : ent.kind === 'coach' ? `created_by=eq.${q(ent.id)}&gym_id=is.null&organization_id=is.null` : null;
  if (evF) { try { await patch(`events?${evF}&host_closed_at=is.null`, { host_closed_at: now }); } catch (e) {} }

  let res = { card: [], bank: [], manual: [], errors: [] }, items = [], subs = [];
  if (ent.kind !== 'account') {
    items = await obligations(ent, nowMs);
    subs = await subscriptionsOf(ent);
    // Zákazníci se dozví, že poskytovatel v MTL končí a co bude s tím, co mají zaplacené.
    const by = {};
    items.forEach((i) => { if (i.studentId) (by[i.studentId] = by[i.studentId] || { items: [], sub: false }).items.push(i); });
    subs.filter((s) => s.studentId).forEach((s) => { (by[s.studentId] = by[s.studentId] || { items: [], sub: false }).sub = true; });
    for (const sid of Object.keys(by)) {
      const x = by[sid];
      const what = x.items.slice(0, 4).map((i) => i.label).join(', ') + (x.items.length > 4 ? ` a další (${x.items.length - 4})` : '');
      await notify(sid,
        `🚫 ${ent.name} v MTL skončil — spolupráce byla ukončena ze strany MTL a profil už v appce není.`
          + (x.items.length ? (mode === 'refund' ? ` Co máš zaplacené dopředu (${what}), se ti vrací — o každém vrácení ti přijde zpráva.` : ` Co máš zaplacené dopředu (${what}), ${ent.name} splní mimo aplikaci — domluv se s ním přímo.`) : '')
          + (x.sub ? ' Členství / předplatné se už nebude strhávat.' : ''),
        `🚫 ${ent.name} has left MTL — MTL ended the cooperation and the profile is no longer in the app.`
          + (x.items.length ? (mode === 'refund' ? ` What you prepaid (${what}) is being refunded — you get a message for each refund.` : ` What you prepaid (${what}) will be provided outside the app — arrange it with the provider.`) : '')
          + (x.sub ? ' Your membership / subscription will not be charged again.' : ''),
        { kind: 'provider_closed', go: 'bookings', entity_kind: ent.kind, entity_id: ent.id, by: 'mtl', mode });
    }
    // Vrácení / předplatná: stejné jako v den výmazu.
    ent.mode = mode;
    res = await settle(ent, nowMs, { keepRenew: false });
  } else {
    // Celý účet: vlastní předplatná (EP, členství jako zákazník) končí hned.
    await cancelNow((await subscriptionsOf(ent)).filter((s) => s.own || s.platform));
  }
  await purge(ent, now);
  await log({ kind: ent.kind, entity_id: String(ent.id), user_id: admin, action: 'terminate', mode, reason,
    delete_on: now.slice(0, 10), meta: { by: 'mtl', card: res.card.length, bank: res.bank.length, manual: res.manual.length, errors: res.errors.length, subs: subs.length } });
  return Object.assign({ kind: ent.kind, name: ent.name, owner: ent.owner }, res);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const me = await whoami(req);
    const fid = await founderId();
    if (!me || !fid || String(me) !== String(fid)) return res.status(403).json({ error: 'Jen zakladatel.' });
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const kind = String(b.kind || ''), id = String(b.id || '');
    const reason = String(b.reason || '').trim().slice(0, 1000);
    const mode = b.mode === 'fulfil' ? 'fulfil' : 'refund';
    if (!['gym', 'coach', 'org', 'account'].includes(kind) || !id) return res.status(400).json({ error: 'bad request' });
    if (!reason) return res.status(400).json({ error: 'Důvod je povinný — poskytovatel ho uvidí.' });
    if (String(id) === String(fid) && (kind === 'account' || kind === 'coach')) return res.status(400).json({ error: 'Sám sebe ne.' });
    const ent = await loadEntity(kind, id);
    if (!ent) return res.status(404).json({ error: 'Nenalezeno.' });
    const owner = kind === 'account' || kind === 'coach' ? ent.id : ent.owner;
    const ownerP = await one(`profiles?id=eq.${q(owner)}&select=id,name,email,lang`);
    const now = new Date().toISOString();

    // DSA čl. 32 (nepovinné): dřív než se profil vymaže -- potřebuje transakce a doklady.
    const dsaOut = [];
    const dsa = b.dsa && String(b.dsa.illegal || '').trim() ? { illegal: String(b.dsa.illegal).trim().slice(0, 1500), redress: String(b.dsa.redress || '').trim().slice(0, 1500) } : null;
    if (dsa && !dsa.redress) return res.status(400).json({ error: 'U upozornění kupujícím vyplň i to, co můžou dělat (prostředky nápravy).' });

    const targets = [];
    if (kind === 'account') {
      for (const x of await ownedEntities(id)) { const e = await loadEntity(x.kind, x.id); if (e) targets.push(e); }
      targets.push(ent);
    } else targets.push(ent);
    if (dsa) for (const e of targets.filter((t) => t.kind !== 'account')) dsaOut.push(Object.assign({ kind: e.kind, name: e.name }, await dsaInformBuyers({ kind: e.kind, id: e.id, name: e.name, illegal: dsa.illegal, redress: dsa.redress, by: me })));

    // E-mail a notifikace poskytovateli PŘED výmazem účtu (po něm už e-mail ani přihlášení nemá).
    const what = kind === 'account' ? 'tvůj účet MTL včetně všech profilů' : `${KIND_CS[kind]} ${ent.name}`;
    const whatEn = kind === 'account' ? 'your MTL account including all profiles' : `your ${kind === 'gym' ? 'club' : kind === 'coach' ? 'coach profile' : 'organization'} ${ent.name}`;
    const out = [];
    for (const e of targets) out.push(await terminateOne(e, me, mode, reason, now));
    const card = out.flatMap((r) => r.card || []), bank = out.flatMap((r) => r.bank || []), manual = out.flatMap((r) => r.manual || []), errs = out.flatMap((r) => r.errors || []);
    const line = (i) => `${i.who} — ${i.label}${i.refund ? ' — ' + fmt(i.refund, i.currency) : ''}`;
    if (ownerP && kind !== 'account') {
      await notify(ownerP.id,
        `⛔ MTL ukončilo spolupráci: ${what} je s okamžitou platností odstraněn z MTL. Důvod: ${reason}.`
          + (mode === 'refund' ? (card.length ? ` Kartou se zákazníkům vrátilo ${card.length}×.` : '') + (bank.length ? ` VRAŤ PŘEVODEM: ${bank.map(line).join('; ')}.` : '') : ' Co mají zákazníci zaplacené dopředu, jim splň mimo aplikaci.')
          + (manual.length ? ` Kurzy vypořádej s účastníky sám: ${manual.map(line).join('; ')}.` : '') + (errs.length ? ` Kartou se nepodařilo vrátit (vrať sám): ${errs.map(line).join('; ')}.` : '')
          + ' Pokud nesouhlasíš, napiš nám přes Podporu.',
        `⛔ MTL ended the cooperation: ${whatEn} has been removed from MTL with immediate effect. Reason: ${reason}.`
          + (mode === 'refund' ? (card.length ? ` ${card.length} card refund(s) were sent.` : '') + (bank.length ? ` TRANSFER BACK: ${bank.map(line).join('; ')}.` : '') : ' Provide what customers prepaid outside the app.')
          + ' If you disagree, contact Support.',
        { kind: 'mtl_terminated', entity_kind: kind, entity_id: ent.id, name: ent.name, reason, mode, at: now });
    }
    if (ownerP && ownerP.email) {
      const li = (arr) => '<ul style="font-size:13px;line-height:1.6;padding-left:18px;margin:0 0 12px;">' + arr.map((i) => `<li>${esc(line(i))}</li>`).join('') + '</ul>';
      const html = para(`MTL ukončilo spolupráci: <b>${esc(what)}</b> je od ${esc(new Date(now).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' }))} odstraněn z Martial Training Lab, s okamžitou platností.`)
        + para(`<b>Důvod:</b> ${esc(reason)}`)
        + (kind === 'account' ? para('Přihlášení k účtu je zrušené. Doklady, transakce a souhlasy zůstávají uložené, jak ukládá zákon.') : para('Doklady, transakce, souhlasy a historie zůstávají uložené, jak ukládá zákon.'))
        + (mode === 'refund'
          ? ((card.length ? para('Kartou se zákazníkům automaticky vrátilo:') + li(card) : '') + (bank.length ? para('<b>Vrať převodem</b> (zákazníci o tom vědí):') + li(bank) : ''))
          : para('Co mají zákazníci zaplacené dopředu, jim splň mimo aplikaci. Zákazníci o tom dostali zprávu.'))
        + (manual.length ? para('<b>Kurzy</b> — vypořádej s účastníky sám:') + li(manual) : '')
        + (errs.length ? para('<b>Kartou se nepodařilo vrátit</b> — vrať sám:') + li(errs) : '')
        + para('Pokud s rozhodnutím nesouhlasíš, odpověz na tento e-mail. Rozhodnutí přezkoumáme.')
        + (kind !== 'account' ? button(APP_URL + '/', 'Otevřít appku') : '');
      try { await sendMail(ownerP.email, `Ukončení spolupráce — ${kind === 'account' ? 'účet MTL' : ent.name}`, shell(`Ukončení spolupráce — ${kind === 'account' ? 'účet MTL' : ent.name}`, html, ownerP.lang === 'en')); } catch (e) {}
    }
    return res.status(200).json({ ok: true, results: out.map((r) => ({ kind: r.kind, name: r.name, card: (r.card || []).length, bank: (r.bank || []).length, manual: (r.manual || []).length, errors: (r.errors || []).length, skipped: !!r.skipped })), dsa: dsaOut });
  } catch (e) {
    console.error('[admin-terminate]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
