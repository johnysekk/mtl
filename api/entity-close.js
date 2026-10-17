// /api/entity-close — POZASTAVENÍ A VÝMAZ ÚČTU NEBO PROFILU (sql/entity-close.sql, _entity-close.js)
// POST + Authorization: Bearer <token>
//   { action:'state' }                                  -> stav mých profilů (proužky v appce)
//   { action:'preview', kind, id }                       -> co platí až po datu výmazu, předplatná, překážky
//   { action:'close',   kind, id, mode, reason_key, reason, consent_text }
//   { action:'restore', kind, id }                       -> zrušit žádost o výmaz (do data výmazu)
//   { action:'pause' | 'unpause', kind, id }             -> pozastavit / zrušit pozastavení
// kind: 'account' | 'coach' | 'gym' | 'org'   mode: 'refund' | 'fulfil'
//
// Žádost o výmaz: profil se hned skryje a nic nového se neprodá; zaplacené věci v příštích 30
// dnech dojedou; členství se přestanou obnovovat; dotčení zákazníci dostanou notifikaci, zakladatel
// notifikaci s důvodem, poskytovatel e-mail s datem výmazu. Za 30 dní entity-close-cron.js
// vypořádá to, co platí až po datu výmazu (vrátí / nechá plnit mimo aplikaci), a profil vymaže.
// Historie (doklady, transakce, souhlasy, docházka a XP, achievementy, výsledky) zůstává.
import { CLOSE_DAYS, sb, get, one, patch, whoami, loadEntity, ownedEntities, coOwnersOf, obligations, summarize,
  subscriptionsOf, setRenew, notify, log, founderId, fmt } from './_entity-close.js';
import { sendMail, shell, para, button, esc, APP_URL } from './_mail.js';

const q = encodeURIComponent;
const DAY = 86400000;
const KINDS = ['account', 'coach', 'gym', 'org'];
const REASONS = { expensive: 'Je to drahé', no_students: 'Málo zákazníků přes MTL', complicated: 'Je to složité', other_tool: 'Používám jiný systém',
  stopping: 'Končím s činností', temporary: 'Jen dočasně (sezóna, zranění…)', other: 'Jiný důvod' };
const dCz = (d) => { const x = new Date(d); return `${x.getUTCDate()}. ${x.getUTCMonth() + 1}. ${x.getUTCFullYear()}`; };
const KIND_CS = { account: 'účet', coach: 'profil kouče', gym: 'profil klubu', org: 'profil organizace' };

async function own(kind, id, me) {
  const ent = await loadEntity(kind, kind === 'account' || kind === 'coach' ? me : id);
  if (!ent) return [null, [404, { error: 'Nenalezeno.' }]];
  if (kind === 'coach' && ent.row.coach_status !== 'approved' && !ent.closingAt && !ent.pausedAt) return [null, [400, { error: 'Nemáš profil kouče.' }]];
  if (String(ent.owner) !== String(me)) return [null, [403, { error: kind === 'gym' ? 'Klub smí pozastavit nebo smazat jen jeho majitel.' : 'Tohle ti nepatří.' }]];
  return [ent, null];
}
const hidden = (ent) => !!(ent.closingAt || ent.pausedAt);

// Akce pořadatele: skryté a bez prodeje, dokud je pořadatel pozastavený nebo se ruší.
async function refreshEvents(ent) {
  const f = ent.kind === 'gym' ? `gym_id=eq.${q(ent.id)}` : ent.kind === 'org' ? `organization_id=eq.${q(ent.id)}`
    : ent.kind === 'coach' ? `created_by=eq.${q(ent.id)}&gym_id=is.null&organization_id=is.null` : null;
  if (!f) return;
  const fresh = await loadEntity(ent.kind, ent.id);
  try {
    if (fresh && hidden(fresh)) await patch(`events?${f}&host_closed_at=is.null`, { host_closed_at: new Date().toISOString() });
    else await patch(`events?${f}&host_closed_at=not.is.null`, { host_closed_at: null });
  } catch (e) { console.error('[entity-close] events', e.message); }
}

async function setState(ent, fields) {
  if (ent.kind === 'gym') return patch(`gyms?id=eq.${q(ent.id)}`, fields);
  if (ent.kind === 'org') return patch(`organizations?id=eq.${q(ent.id)}`, fields);
  return patch(`profiles?id=eq.${q(ent.id)}`, fields);
}
const F = {
  close: (k, at, mode, reason) => k === 'coach' ? { coach_closing_at: at, coach_close_mode: mode }
    : k === 'account' ? { deleted_at: at, close_mode: mode, delete_reason: reason } : { deleted_at: at, close_mode: mode, delete_reason: reason },
  open: (k) => k === 'coach' ? { coach_closing_at: null, coach_close_mode: null } : { deleted_at: null, close_mode: null, ...(k === 'account' ? { delete_reason: null } : { delete_reason: null }) },
  pause: (k, at, by) => k === 'coach' ? { coach_paused_at: at, coach_paused_by: by } : k === 'account' ? { deactivated_at: at } : { paused_at: at, paused_by: by },
  unpause: (k) => k === 'coach' ? { coach_paused_at: null, coach_paused_by: null } : k === 'account' ? { deactivated_at: null } : { paused_at: null, paused_by: null },
};

async function preview(ent, me) {
  const deleteAt = Date.now() + CLOSE_DAYS * DAY;
  const list = ent.kind === 'account' ? await ownedEntities(me) : [];
  const blockers = [];
  // Spolumajitel brání jen výmazu CELÉHO ÚČTU (klub by zůstal bez majitele). Samotný klub smazat jde.
  const gyms = ent.kind === 'account' ? (await Promise.all(list.filter((x) => x.kind === 'gym').map((x) => loadEntity('gym', x.id)))).filter(Boolean) : [];
  for (const g of gyms) { const co = await coOwnersOf(g.id); if (co.length) blockers.push({ kind: 'gym', id: g.id, name: g.name, reason: 'co_owner' }); }
  const ents = ent.kind === 'account' ? (await Promise.all(list.map((x) => loadEntity(x.kind, x.id)))).filter(Boolean) : [ent];
  let items = [];
  for (const e of ents) items = items.concat((await obligations(e, deleteAt)).map((i) => Object.assign({ entity: e.name, entityKind: e.kind }, i)));
  let subs = [];
  for (const e of ents.concat(ent.kind === 'account' ? [ent] : [])) subs = subs.concat((await subscriptionsOf(e)).filter((s) => !s.platform || e.kind !== 'account' || true));
  return { deleteOn: new Date(deleteAt).toISOString(), entities: list, blockers, summary: summarize(items),
    items: items.slice(0, 300).map((i) => ({ entity: i.entity, type: i.type, who: i.who, label: i.label, refund: i.refund, currency: i.currency, method: i.method })),
    subscriptions: subs.filter((s) => !s.own && !s.platform).length, ownSubscriptions: subs.filter((s) => s.own).length };
}

async function closeOne(ent, me, mode, deleteAt, reasonKey, reason, consent, cascade, keepRenew) {
  if (ent.closingAt) return { skipped: true };
  const at = new Date().toISOString();
  const subs = await subscriptionsOf(ent);
  // Nechat běžet automatické obnovy zákazníků (poskytovatel je řeší ve svém Stripe účtu):
  // nevypínají se a členství s předplatným se nevrací. Platformní / vlastní předplatná končí vždy.
  const keep = !!keepRenew && ent.kind !== 'account';
  const items = (await obligations(ent, deleteAt)).filter((it) => !(keep && it.table === 'gym_memberships' && it.sub));
  await setState(ent, F.close(ent.kind, at, mode, reason || reasonKey || null));
  const stopped = await setRenew(keep ? subs.filter((x) => !x.studentId) : subs, true);
  await refreshEvents(ent);
  // Zákazníci: kdo má něco zaplaceného po datu výmazu, nebo běžící předplatné.
  const by = {};
  items.forEach((i) => { if (i.studentId) (by[i.studentId] = by[i.studentId] || { items: [], sub: false }).items.push(i); });
  subs.filter((s) => s.studentId).forEach((s) => { (by[s.studentId] = by[s.studentId] || { items: [], sub: false }).sub = true; });
  const dOn = dCz(deleteAt);
  if (ent.kind !== 'account') {
    for (const sid of Object.keys(by)) {
      const x = by[sid];
      const what = x.items.slice(0, 4).map((i) => i.label).join(', ') + (x.items.length > 4 ? ` a další (${x.items.length - 4})` : '');
      const tailCs = x.items.length ? (mode === 'refund'
        ? ` Co máš zaplacené na dobu po tomto datu (${what}), ti ${ent.name} vrátí ${dOn} — kartou automaticky, převodem ti peníze pošle sám.`
        : ` Co máš zaplacené na dobu po tomto datu (${what}), ${ent.name} splní mimo aplikaci — domluv se s ním.`) : '';
      const tailEn = x.items.length ? (mode === 'refund'
        ? ` What you paid for after that date (${what}) will be refunded on ${dOn} — card automatically, transfers are sent by the provider.`
        : ` What you paid for after that date (${what}) will be provided outside the app — arrange it with the provider.`) : '';
      await notify(sid,
        `🚫 ${ent.name} ukončuje činnost v MTL — profil bude vymazán ${dOn}. Do té doby vše zaplacené platí.${tailCs}${x.sub ? (keep ? ` Členství / předplatné se dál obnovuje — od ${dOn} ho ${ent.name} vede mimo MTL (Stripe poskytovatele).` : ' Členství / předplatné se už automaticky neobnoví.') : ''}`,
        `🚫 ${ent.name} is leaving MTL — the profile will be deleted on ${dOn}. Until then everything you paid for stays valid.${tailEn}${x.sub ? (keep ? ` Your membership / subscription keeps renewing — from ${dOn} the provider runs it outside MTL (their own Stripe).` : ' Your membership / subscription will not renew.') : ''}`,
        { kind: 'provider_closing', go: 'bookings', entity_kind: ent.kind, entity_id: ent.id, delete_on: dOn, mode });
    }
  }
  await log({ kind: ent.kind, entity_id: String(ent.id), user_id: me, action: 'close', mode, reason_key: reasonKey || null, reason: reason || null,
    consent_text: consent || null, delete_on: new Date(deleteAt).toISOString().slice(0, 10),
    meta: { subs: stopped.map((s) => ({ sub: s.sub, acct: s.acct || null, membership: s.membership || null })), students: Object.keys(by), cascade: !!cascade, at, keep_renew: keep,
      summary: summarize(items) } });
  return { items, stopped: stopped.length, notified: Object.keys(by).length };
}

async function restoreOne(ent, me, cascadeOnly) {
  if (!ent.closingAt) return { skipped: true };
  const last = await one(`entity_close_log?kind=eq.${ent.kind}&entity_id=eq.${q(ent.id)}&action=eq.close&order=created_at.desc&limit=1&select=meta`);
  if (cascadeOnly && !(last && last.meta && last.meta.cascade)) return { skipped: true };
  await setState(ent, F.open(ent.kind));
  // Obnovit jen předplatná, která vypnul výmaz. Kdo mezitím členství sám ukončil, zůstává ukončený.
  const closedAt = new Date((last && last.meta && last.meta.at) || ent.closingAt).getTime();
  const subs = [];
  for (const s0 of ((last && last.meta && Array.isArray(last.meta.subs)) ? last.meta.subs : [])) {
    if (s0.membership) {
      const mrow = await one(`gym_memberships?id=eq.${q(s0.membership)}&select=status,cancelled_at`);
      if (!mrow || mrow.status !== 'active' || (mrow.cancelled_at && new Date(mrow.cancelled_at).getTime() >= closedAt - 60000)) continue;
    }
    subs.push(s0);
  }
  await setRenew(subs, false);
  await refreshEvents(ent);
  if (ent.kind !== 'account') {
    for (const sid of ((last && last.meta && last.meta.students) || [])) {
      await notify(sid, `✅ ${ent.name} v MTL zůstává — výmaz profilu je zrušený. Vše běží dál${subs.length ? ', členství se zase obnovuje' : ''}.`,
        `✅ ${ent.name} is staying in MTL — the deletion was cancelled. Everything carries on${subs.length ? ' and memberships renew again' : ''}.`,
        { kind: 'provider_restored', go: 'bookings', entity_kind: ent.kind, entity_id: ent.id });
    }
  }
  await log({ kind: ent.kind, entity_id: String(ent.id), user_id: me, action: 'restore' });
  return { restored: true };
}

async function mailOwner(me, title, html) {
  const p = await one(`profiles?id=eq.${q(me)}&select=email,lang`);
  if (!p || !p.email) return;
  const en = p.lang === 'en';
  await sendMail(p.email, title, shell(title, html, en));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const me = await whoami(req);
    if (!me) return res.status(401).json({ error: 'Přihlas se znovu.' });
    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const action = String(b.action || ''), kind = String(b.kind || '');

    if (action === 'state') {
      const acc = await loadEntity('account', me);
      const ents = (await Promise.all((await ownedEntities(me)).map((x) => loadEntity(x.kind, x.id)))).filter(Boolean);
      // Profil kouče, který se ruší, už nemá coach_status 'approved' jen po výmazu -- do té doby ano.
      const del = (e) => e.closingAt ? new Date(new Date(e.closingAt).getTime() + CLOSE_DAYS * DAY).toISOString() : null;
      return res.status(200).json({ ok: true,
        account: acc && { closingAt: acc.closingAt, deleteOn: del(acc), pausedAt: acc.pausedAt },
        entities: ents.map((e) => ({ kind: e.kind, id: e.id, name: e.name, closingAt: e.closingAt || null, deleteOn: del(e), pausedAt: e.pausedAt || null, pausedBy: e.pausedBy || null, mode: e.mode || null })) });
    }
    if (KINDS.indexOf(kind) < 0) return res.status(400).json({ error: 'bad kind' });
    const [ent, err] = await own(kind, String(b.id || ''), me);
    if (err) return res.status(err[0]).json(err[1]);

    if (action === 'preview') return res.status(200).json(Object.assign({ ok: true }, await preview(ent, me)));

    if (action === 'close') {
      const mode = b.mode === 'fulfil' ? 'fulfil' : b.mode === 'refund' ? 'refund' : null;
      const consent = String(b.consent_text || '').trim().slice(0, 4000);
      const reasonKey = REASONS[b.reason_key] ? b.reason_key : null;
      const reason = String(b.reason || '').trim().slice(0, 1000) || null;
      if (!consent) return res.status(400).json({ error: 'Chybí souhlas s výmazem.' });
      if (ent.closingAt) return res.status(409).json({ error: 'O výmaz už je požádáno.' });
      const pv = await preview(ent, me);
      if (pv.blockers.length) return res.status(409).json({ error: 'Klub se spolumajitelem nejde smazat spolu s účtem — nejdřív převeď vlastnictví, nebo spolumajitele odeber.', blockers: pv.blockers });
      if (!mode && pv.summary.count) return res.status(400).json({ error: 'Vyber, jak naložit s tím, co je zaplacené po datu výmazu.' });
      const deleteAt = Date.now() + CLOSE_DAYS * DAY;
      const m = mode || 'fulfil';
      const keepRenew = b.keep_renew === true;
      const out = { entities: [] };
      if (kind === 'account') {
        for (const x of await ownedEntities(me)) {
          const e = await loadEntity(x.kind, x.id); if (!e) continue;
          out.entities.push(Object.assign({ kind: e.kind, name: e.name }, await closeOne(e, me, m, deleteAt, reasonKey, reason, consent, true, keepRenew)));
        }
        await closeOne(ent, me, m, deleteAt, reasonKey, reason, consent, false, false);
      } else {
        out.entities.push(Object.assign({ kind, name: ent.name }, await closeOne(ent, me, m, deleteAt, reasonKey, reason, consent, false, keepRenew)));
      }
      const dOn = dCz(deleteAt);
      // Zakladatel: důvod a proklik na uživatele -- ať stihne zavolat dřív, než se profil smaže.
      try {
        const fid = await founderId();
        const who = await one(`profiles?id=eq.${q(me)}&select=name,email`);
        if (fid && String(fid) !== String(me)) await notify(fid,
          `🗑️ ${who && who.name || 'Uživatel'} požádal o výmaz: ${KIND_CS[kind]}${kind !== 'account' ? ' „' + ent.name + '"' : ''}. Smaže se ${dOn}. Důvod: ${reasonKey ? REASONS[reasonKey] : '—'}${reason ? ' — „' + reason + '"' : ''}. Vypořádání: ${m === 'refund' ? 'vrátí peníze' : 'plní mimo aplikaci'}. Ozvi se mu, dokud je čas.`,
          `🗑️ ${who && who.name || 'A user'} asked to delete: ${kind}${kind !== 'account' ? ' "' + ent.name + '"' : ''}. Deleted on ${dOn}. Reason: ${reasonKey || '—'}${reason ? ' — "' + reason + '"' : ''}. Settlement: ${m}. Reach out while there is time.`,
          { kind: 'entity_closing_admin', user_id: me, entity_kind: kind, entity_id: ent.id });
      } catch (e) {}
      // E-mail poskytovateli: datum, co se stane a jak to zrušit.
      try {
        const bankL = (pv.items || []).filter((i) => i.method === 'bank');
        const html = para(`Požádal(a) jsi o výmaz: <b>${esc(KIND_CS[kind])}${kind !== 'account' ? ' „' + esc(ent.name) + '"' : ''}</b>. Už teď je ${kind === 'account' ? 'skrytý všem' : 'profil skrytý ve vyhledávání'} a nic nového se na něm neprodá. <b>Vymaže se ${esc(dOn)}</b>.`)
          + para('Do té doby to jde kdykoli zrušit jedním klikem v appce (proužek nahoře). Zaplacené rezervace v těchto 30 dnech normálně dojedou — odučit, odbavit, případně zrušit s vrácením peněz.')
          + para(m === 'refund'
            ? `Co platí až po datu výmazu, se ${esc(dOn)} vrátí zákazníkům (100 % nevyčerpané části): kartou automaticky z tvého Stripe účtu${bankL.length ? ', převody a hotovost vrátíš sám — seznam ti přijde v den výmazu' : ''}.`
            : 'Co platí až po datu výmazu, splníš zákazníkům mimo aplikaci — peníze se nevrací. Zákazníci o tom dostali zprávu.')
          + (keepRenew && pv.subscriptions ? para(`Automatické obnovy zákazníků jsi nechal(a) běžet: ${esc(dOn)} se předplatná odpojí od MTL (bez provize MTL a bez dokladů z MTL) a dál je spravuješ sám ve svém Stripe účtu.`) : (pv.subscriptions ? para('Automatické obnovy členství zákazníků jsou vypnuté — zaplacené období normálně doběhne.') : ''))
          + para('Doklady, transakce, souhlasy a historie docházky zůstávají uložené, jak ukládá zákon.')
          + button(APP_URL + '/?go=closing', 'Otevřít appku');
        await mailOwner(me, `Žádost o výmaz — ${dOn}`, html);
      } catch (e) {}
      return res.status(200).json({ ok: true, deleteOn: new Date(deleteAt).toISOString(), result: out });
    }

    if (action === 'restore') {
      if (!ent.closingAt) return res.status(409).json({ error: 'O výmaz nebylo požádáno.' });
      if (kind !== 'account') {
        const accRow = await one(`profiles?id=eq.${q(me)}&select=deleted_at`);
        if (accRow && accRow.deleted_at) return res.status(409).json({ error: 'Maže se celý účet — nejdřív obnov účet (obnoví se s ním i jeho profily).' });
      }
      if (Date.now() > new Date(ent.closingAt).getTime() + CLOSE_DAYS * DAY) return res.status(410).json({ error: 'Lhůta na obnovení uplynula.' });
      await restoreOne(ent, me, false);
      if (kind === 'account') {
        for (const x of await ownedEntities(me)) { const e = await loadEntity(x.kind, x.id); if (e) await restoreOne(e, me, true); }
      }
      try {
        const fid = await founderId(); const who = await one(`profiles?id=eq.${q(me)}&select=name`);
        if (fid && String(fid) !== String(me)) await notify(fid, `✅ ${who && who.name || 'Uživatel'} zrušil výmaz: ${KIND_CS[kind]}${kind !== 'account' ? ' „' + ent.name + '"' : ''}.`,
          `✅ ${who && who.name || 'A user'} cancelled the deletion: ${kind}${kind !== 'account' ? ' "' + ent.name + '"' : ''}.`, { kind: 'entity_closing_admin', user_id: me, entity_kind: kind, entity_id: ent.id });
      } catch (e) {}
      return res.status(200).json({ ok: true });
    }

    if (action === 'pause' || action === 'unpause') {
      const on = action === 'pause', at = new Date().toISOString();
      if (on && ent.pausedAt) return res.status(200).json({ ok: true, already: true });
      await setState(ent, on ? F.pause(kind, at, 'self') : F.unpause(kind));
      await refreshEvents(ent);
      // Celý účet: pozastaví i profily, které nejsou pozastavené samy (a zase jen ty vrátí).
      if (kind === 'account') {
        for (const x of await ownedEntities(me)) {
          const e = await loadEntity(x.kind, x.id); if (!e) continue;
          if (on && !e.pausedAt) { await setState(e, F.pause(e.kind, at, 'account')); await refreshEvents(e); }
          if (!on && e.pausedAt && e.pausedBy === 'account') { await setState(e, F.unpause(e.kind)); await refreshEvents(e); }
        }
      }
      await log({ kind, entity_id: String(ent.id), user_id: me, action });
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'bad action' });
  } catch (e) {
    console.error('[entity-close]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
