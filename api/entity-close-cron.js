// /api/entity-close-cron — Vercel Cron, denně. DEN VÝMAZU (30 dní po žádosti, sql/entity-close.sql).
// Pro klub, profil kouče, organizaci i celý účet:
//   1) vypořádá, co platí až po datu výmazu (_entity-close.js settle): při 'refund' vrátí kartou
//      automaticky, převody a hotovost dá poskytovateli na seznam (e-mail + notifikace), kurzy
//      vypořádá sám; při 'fulfil' nic nevrací,
//   2) zruší zbývající předplatná,
//   3) vymaže obsah profilu (klub a celý účet maže cron-attendance.js -- stejná lhůta), u kouče
//      a organizace tady. Historie zůstává: doklady, transakce, souhlasy, docházka, výsledky.
// Opakovaný běh nic nevrátí dvakrát: každé vrácení je zapsané v entity_close_log (_entity-close.js).
import { CLOSE_DAYS, get, one, patch, loadEntity, settle, subscriptionsOf, cancelNow, notify, fmt } from './_entity-close.js';
import { sendMail, shell, para, esc } from './_mail.js';

const q = encodeURIComponent;
const DAY = 86400000;

async function reportOwner(ent, ownerId, res, deleteOn) {
  if (!ownerId) return;
  const bank = res.bank || [], manual = res.manual || [], errs = res.errors || [];
  if (!bank.length && !manual.length && !errs.length && !(res.card || []).length) return;
  const line = (i) => `${i.who} — ${i.label}${i.refund ? ' — ' + fmt(i.refund, i.currency) : ''}`;
  const cs = `🗑️ ${ent.name} je vymazán z MTL. ` + ((res.card || []).length ? `Kartou se automaticky vrátilo ${res.card.length}× (${res.card.map((i) => fmt(i.refund, i.currency)).join(', ')}). ` : '')
    + (bank.length ? `VRAŤ PŘEVODEM: ${bank.map(line).join('; ')}. ` : '') + (manual.length ? `Kurzy vypořádej s účastníky sám: ${manual.map(line).join('; ')}. ` : '')
    + (errs.length ? `Nepodařilo se vrátit kartou (vrať sám): ${errs.map(line).join('; ')}.` : '');
  const en = `🗑️ ${ent.name} has been deleted from MTL. ` + ((res.card || []).length ? `${res.card.length} card refund(s) were sent automatically. ` : '')
    + (bank.length ? `TRANSFER BACK: ${bank.map(line).join('; ')}. ` : '') + (manual.length ? `Settle the courses yourself: ${manual.map(line).join('; ')}. ` : '')
    + (errs.length ? `Card refund failed (refund yourself): ${errs.map(line).join('; ')}.` : '');
  await notify(ownerId, cs, en, { kind: 'entity_deleted', entity_kind: ent.kind });
  try {
    const p = await one(`profiles?id=eq.${q(ownerId)}&select=email,lang`);
    if (p && p.email) {
      const li = (arr) => '<ul style="font-size:13px;line-height:1.6;padding-left:18px;margin:0 0 12px;">' + arr.map((i) => `<li>${esc(line(i))}</li>`).join('') + '</ul>';
      const html = para(`<b>${esc(ent.name)}</b> je od ${esc(deleteOn)} vymazán z MTL. Doklady, transakce a souhlasy zůstávají uložené.`)
        + ((res.card || []).length ? para('Kartou se automaticky vrátilo:') + li(res.card) : '')
        + (bank.length ? para('<b>Vrať převodem</b> (zákazníci o tom vědí):') + li(bank) : '')
        + (manual.length ? para('<b>Kurzy</b> — vypořádej s účastníky sám:') + li(manual) : '')
        + (errs.length ? para('<b>Kartou se nepodařilo vrátit</b> — vrať sám:') + li(errs) : '');
      await sendMail(p.email, `Výmaz dokončen — ${ent.name}`, shell(`Výmaz dokončen — ${ent.name}`, html, p.lang === 'en'));
    }
  } catch (e) {}
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET not configured' });
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'unauthorized' });
  const cutoff = new Date(Date.now() - CLOSE_DAYS * DAY).toISOString();
  const out = { gyms: 0, coaches: 0, orgs: 0, accounts: 0, errors: [] };
  const run = async (kind, rows, after) => {
    for (const r of rows || []) {
      try {
        const ent = await loadEntity(kind, r.id); if (!ent || !ent.closingAt) continue;
        const deleteAt = new Date(ent.closingAt).getTime() + CLOSE_DAYS * DAY;
        const res1 = await settle(ent, deleteAt);
        await after(ent);
        const d = new Date(deleteAt); const dOn = `${d.getUTCDate()}. ${d.getUTCMonth() + 1}. ${d.getUTCFullYear()}`;
        await reportOwner(ent, ent.owner, res1, dOn);
        out[kind === 'gym' ? 'gyms' : kind === 'coach' ? 'coaches' : 'orgs']++;
      } catch (e) { out.errors.push(`${kind} ${r.id}: ${e.message}`); }
    }
  };
  try {
    const now = new Date().toISOString();
    await run('gym', await get(`gyms?deleted_at=lt.${q(cutoff)}&close_settled_at=is.null&close_mode=not.is.null&select=id`),
      (e) => patch(`gyms?id=eq.${q(e.id)}`, { close_settled_at: now }));
    await run('coach', await get(`profiles?coach_closing_at=lt.${q(cutoff)}&coach_close_settled_at=is.null&select=id`), async (e) => {
      await patch(`profiles?id=eq.${q(e.id)}`, { coach_status: 'deleted', coach_close_settled_at: now, coach_purged_at: now });
      // Volné budoucí termíny soukromých lekcí pryč; tým klubů: kouč už v nich není.
      try { await fetch(`${(process.env.SUPABASE_URL || '').replace(/\/+$/, '')}/rest/v1/slots?coach_profile_id=eq.${q(e.id)}&booked=eq.false&date=gte.${now.slice(0, 10)}`, { method: 'DELETE', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }); } catch (x) {}
      try { await patch(`gym_coaches?coach_id=eq.${q(e.id)}&status=eq.active`, { status: 'removed' }); } catch (x) {}
    });
    await run('org', await get(`organizations?deleted_at=lt.${q(cutoff)}&close_settled_at=is.null&select=id`), async (e) => {
      await patch(`organizations?id=eq.${q(e.id)}`, { close_settled_at: now, purged_at: now });
      try { await patch(`organizations?id=eq.${q(e.id)}`, { logo_url: null }); } catch (x) {}
    });
    // Celý účet: vlastní předplatná (EP, členství jako zákazník) končí. Profil a přihlášení maže
    // cron-attendance.js ve stejný den.
    for (const r of ((await get(`profiles?deleted_at=lt.${q(cutoff)}&close_mode=in.(refund,fulfil)&select=id`)) || [])) {
      try { const ent = await loadEntity('account', r.id); if (ent) await cancelNow((await subscriptionsOf(ent)).filter((s) => s.own || s.platform)); await patch(`profiles?id=eq.${q(r.id)}`, { close_mode: 'done' }); out.accounts++; }
      catch (e) { out.errors.push(`account ${r.id}: ${e.message}`); }
    }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message, ...out });
  }
}
