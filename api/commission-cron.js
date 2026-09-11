// /api/commission-cron.js
// Runs daily. Collects the off-Stripe (cash/QR) MTL commission that accrued as
// commission_status='pending' during the closed previous month, by charging the
// provider's card-on-file (commission_card_*) once we are on/after the 6th.
//
//  BILLING (only when day-of-month >= 6):
//    sum pending+failed cash/qr commission per gym AND per coach (paid_to='coach') & currency, any closed month
//    (commission_month < current YYYY-MM) -> Stripe PaymentIntent off_session on
//    the card -> success: rows 'collected' + clear the failure clock + notify (doklad);
//    failure: rows 'failed', start/keep commission_failed_at, notify "fix card in 2 weeks".
//
//  SUSPENSION (every run):
//    commission_failed_at older than GRACE_DAYS (14) and still unpaid ->
//      qr_bank gym/coach   -> account_suspended = true  (whole gym/coach frozen)
//      stripe + takes_cash -> cash_blocked = true        (only cash recording frozen)
//
//  LIFT (every run): a gym with a failure clock but NO remaining unpaid commission
//    -> clear commission_failed_at + account_suspended + cash_blocked + notify.
//
// vercel.json: { "path": "/api/commission-cron", "schedule": "0 8 * * *" }
// Needs env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY ; optional CRON_SECRET.

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

import { isTestMode } from './_config.js';
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GRACE_DAYS = 14;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body,
  });
  const txt = await r.text(); let j; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = txt; }
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
}
// E-MAIL VEDLE NOTIFIKACE. notify() zapisuje jen zpravu v appce -- kdo ji neotevre, o selhane
// provizi se nedozvi a po dvou tydnech mu cron pozastavi ucet. Zprava, ktera clovek nevidi,
// nema smysl: penize a pozastaveni patri do mailu.
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'MTL <noreply@martialtraininglab.com>';
async function sendEmail(to, subject, html) {
  if (!RESEND || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html }),
    });
  } catch (e) { console.error('commission email', e.message); }
}
function mailHtml(title, body) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;padding:22px;">
    <div style="font-size:19px;font-weight:800;color:#111;margin-bottom:10px;">${title}</div>
    <div style="font-size:14px;color:#333;line-height:1.6;">${body}</div>
    <div style="font-size:12px;color:#888;margin-top:22px;">Martial Training Lab</div>
  </div>`;
}
// Notifikace v appce a k tomu mail u toho, co se tyka penez nebo pozastaveni uctu.
async function notifyMail(userId, subject, body) {
  try {
    if (!userId) return;
    const p = (await sb(`profiles?id=eq.${userId}&select=email`))[0];
    if (p && p.email) await sendEmail(p.email, subject, mailHtml(subject, body));
  } catch (e) {}
}

const notify = (user_id, kind, message, extra = {}) =>
  sb('notifications', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ user_id, type: 'system', read: false, data: JSON.stringify({ kind, ...extra }), message }) });
function prevMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); }

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'env not set' });
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (!(auth === `Bearer ${process.env.CRON_SECRET}` || req.headers['x-vercel-cron'])) return res.status(401).json({ error: 'unauthorized' });
  }

  const now = new Date();
  const billDay = now.getUTCDate() >= 6;

// STRIPE MA MINIMALNI CASTKU. Pod ni kartu odmitne a paymentIntents.create spadne -- coz cron
// dosud pocital jako SELHANI PLATBY: odlozil o tri dny, poslal "provizi se nepodarilo strhnout"
// a po dvou tydnech pozastavil ucet. Pritom klub nic neudelal, jen mu za den narostla provize
// mensi, nez co Stripe umi strhnout. U denniho rezimu to nastava skoro vzdycky.
// Spravne: pod minimem se NESTRHAVA a NIC se neoznaci -- castka zustane pending a pricte se
// k dalsimu dni. Jednou minimum pretece a strhne se najednou.
const STRIPE_MIN = { czk: 1500, eur: 50, usd: 50, gbp: 30, pln: 200, huf: 17500, chf: 50, sek: 300, dkk: 250, nok: 300 };
const belowMin = (amount, cur) => amount < (STRIPE_MIN[String(cur || 'czk').toLowerCase()] || 50);
let deferredMin = 0;
  const curMonth = now.toISOString().slice(0, 7);
  let marked = 0, markErr = null;
  let collected = 0, failed = 0, suspended = 0, lifted = 0;

  // Two independent ways to end up on daily: the global beta switch, or a per-entity flag the
  // founder sets on one club or coach. The second exists because the first turns the whole
  // platform into a test, which is no use while the only real data is your own.
  let TEST = false; try { TEST = await isTestMode(); } catch (e) {}
  let dailyGyms = new Set(), dailyCoaches = new Set();
  try { dailyGyms = new Set(((await sb('gyms?commission_daily=is.true&select=id')) || []).map(g => g.id)); } catch (e) {}
  try { dailyCoaches = new Set(((await sb('profiles?commission_daily=is.true&select=id')) || []).map(x => x.id)); } catch (e) {}
  let dailyOrgs = new Set();
  try { dailyOrgs = new Set(((await sb('organizations?commission_daily=is.true&select=id')) || []).map(o => o.id)); } catch (e) {}
  const orgDaily = (id) => TEST || dailyOrgs.has(id);
  const gymDaily = (id) => TEST || dailyGyms.has(id);
  const coachDaily = (id) => TEST || dailyCoaches.has(id);
  const today = new Date().toISOString().slice(0, 10);
  // The wide fetch takes the running month too; rows belonging to anybody NOT on daily are
  // dropped again during grouping, so nothing changes for them.
  const monthOp = (TEST || dailyGyms.size || dailyCoaches.size || dailyOrgs.size) ? 'lte' : 'lt';

  try {
    // ---- gather unpaid cash/qr commission, grouped by gym + currency ----
    const tx = await sb(`transactions?select=gym_id,paid_to,currency,mtl_fee,mtl_rate,gross_amount,mtl_fee_refunded,payment_method,commission_status,commission_month&payment_method=in.(cash,qr,pis)&commission_status=in.(pending,failed)&commission_month=${monthOp}.${curMonth}&limit=20000`);
    const byGym = {};
    for (const t of (tx || [])) {
      if (!t.gym_id) continue;
      // PROVIZI DLUZI TEN, KOMU PRISLY PENIZE. Skupinovka kouce v rezimu klub nese gym_id, ale penize
      // sly na kouce (paid_to='coach') -- driv se jeho provize strhla z karty KLUBU a jeho radek se
      // oznacil jako zaplaceny. Organizace stejne.
      if (t.paid_to && t.paid_to !== 'gym') continue;
      if (t.commission_month === curMonth && !gymDaily(t.gym_id)) continue;
      const cur = (t.currency || 'czk').toLowerCase();
      (byGym[t.gym_id] = byGym[t.gym_id] || {});
      byGym[t.gym_id][cur] = (byGym[t.gym_id][cur] || 0) + ((t.mtl_fee || 0) - (t.mtl_fee_refunded || 0));
    }
    const gymIds = Object.keys(byGym);
    const unpaidSet = new Set(gymIds);

    let gymMap = {};
    if (gymIds.length) {
      const gyms = await sb(`gyms?id=in.(${gymIds.join(',')})&select=id,name,owner_id,payment_mode,takes_cash,commission_card_customer,commission_card_pm,commission_failed_at,commission_next_retry,account_suspended,cash_blocked`);
      (gyms || []).forEach(g => { gymMap[g.id] = g; });
    }

    for (const gid of gymIds) {
      const g = gymMap[gid]; if (!g) continue;

      // ---- BILLING (on/after the 6th, needs a card, 3-day retry spacing) ----
      const retryReady = !g.commission_next_retry || new Date(g.commission_next_retry).getTime() <= Date.now();
      if (billDay && retryReady && g.commission_card_customer && g.commission_card_pm) {
        let anyFail = false, anyCharge = false;
        for (const cur of Object.keys(byGym[gid])) {
          const amount = Math.round(byGym[gid][cur]);
          // Pod minimem Stripe: nechame to na priste, at se z toho nestane "selhalo".
          if (amount > 0 && belowMin(amount, cur)) { deferredMin++; continue; }
          if (!amount || amount <= 0) continue;
          anyCharge = true;
          let pi = null;
          try {
            pi = await stripe.paymentIntents.create({
              amount, currency: cur,
              customer: g.commission_card_customer,
              payment_method: g.commission_card_pm,
              off_session: true, confirm: true,
              description: `MTL provize (hotovost/QR) ${g.name || ''}`,
              metadata: { gym_id: gid, kind: 'mtl_commission', month: curMonth },
            }, { idempotencyKey: `comm_${gid}_${gymDaily(gid) ? today : curMonth}_${cur}` });
          } catch (e) { pi = null; }

          if (pi && pi.status === 'succeeded') {
            // CHANGED: the mark-as-collected used to be skipped entirely on a daily entity, so the
            // rows stayed 'pending' and the SAME money was charged again the next day, and every day
            // after. Daily now marks too -- it just marks a wider set, because a daily charge also
            // covers the running month, which the monthly filter (commission_month < current) excludes.
            // commission_collected_at is what unified-doklad-cron reads to know what to put on the
            // receipt, instead of guessing from created_at.
            {
              const _scope = gymDaily(gid) ? '' : `&commission_month=lt.${curMonth}`;
              // ilike, ne eq: nahoře se měna převádí na malá písmena (`t.currency.toLowerCase()`),
              // ale v databázi je uložená velkými -- takže `currency=eq.czk` nenašlo NIC. Provize
              // se strhla z karty, PATCH proběhl bez chyby a označil nula řádků. Transakce zůstaly
              // pending, unified-doklad-cron neměl co vystavit a nikomu nic nedošlo.
              // return=representation, ne minimal: potřebujeme vědět, KOLIK řádků se opravdu
              // orazítkovalo. Když se karta strhne a označení tiše selže, transakce zůstanou
              // pending, unified-doklad-cron nemá co vystavit a nikdo se to nedozví -- přesně
              // ten stav, kdy notifikace chodí a doklad ne.
              try{
                const _upd = await sb(`transactions?gym_id=eq.${gid}&or=(paid_to.is.null,paid_to.eq.gym)&payment_method=in.(cash,qr,pis)&commission_status=in.(pending,failed)&currency=ilike.${encodeURIComponent(cur)}${_scope}`,
                  { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ commission_status: 'collected', commission_collected_at: new Date().toISOString() }) });
                marked += (Array.isArray(_upd) ? _upd.length : 0);
              }catch(e){ markErr = markErr || String(e.message || e).slice(0, 200); }
            }
            // BEZ NOTIFIKACE. O strzeni se clovek dozvi jednou zpravou spolu s dokladem
            // (unified-doklad-cron o pul hodiny pozdeji): castka, jak byla strzena, a proklik primo
            // na doklad. Driv prisly dve zpravy za tutez provizi a obe vedly na stejne misto.
            collected++;
          } else {
            anyFail = true;
            if (!gymDaily(gid)) await sb(`transactions?gym_id=eq.${gid}&or=(paid_to.is.null,paid_to.eq.gym)&payment_method=in.(cash,qr,pis)&commission_status=eq.pending&currency=ilike.${encodeURIComponent(cur)}&commission_month=lt.${curMonth}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ commission_status: 'failed' }) });
            failed++;
          }
        }
        if (anyCharge && anyFail) {
          const patch = { commission_next_retry: new Date(Date.now() + 3 * 86400000).toISOString() };
          if (!g.commission_failed_at) { patch.commission_failed_at = new Date().toISOString(); g.commission_failed_at = patch.commission_failed_at; }
          await sb(`gyms?id=eq.${gid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
          await notifyMail(g.owner_id, 'Provizi MTL se nepodařilo strhnout', 'Zkusíme to znovu za tři dny. Zkontroluj prosím platební kartu v Platby a provize — po dvou týdnech bez úhrady se účet pozastaví.'); await notify(g.owner_id, 'commission_failed', `⚠️ Stržení provize MTL z karty selhalo. Aktualizuj kartu — další pokus za 3 dny. Pokud neuhradíš do 2 týdnů, účet bude pozastaven.`, { gym_id: gid });
        } else if (anyCharge && !anyFail) {
          unpaidSet.delete(gid);
          await sb(`gyms?id=eq.${gid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ commission_next_retry: null, commission_last_billed: prevMonth(curMonth) }) });
        }
      }

      // ---- SUSPENSION (2-week clock) ----
      if (g.commission_failed_at && unpaidSet.has(gid)) {
        const overdue = Date.now() > new Date(g.commission_failed_at).getTime() + GRACE_DAYS * 86400000;
        if (overdue) {
          if (g.payment_mode === 'qr_bank' && !g.account_suspended) {
            await sb(`gyms?id=eq.${gid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ account_suspended: true }) });
            await notify(g.owner_id, 'account_suspended', `🚫 Účet byl pozastaven kvůli neuhrazené provizi MTL. Gym je skrytý a nelze ho používat (tebou ani studenty), dokud provizi neuhradíš (aktualizuj kartu).`, { gym_id: gid });
            suspended++;
          } else if (g.payment_mode !== 'qr_bank' && g.takes_cash && !g.cash_blocked) {
            await sb(`gyms?id=eq.${gid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ cash_blocked: true }) });
            await notify(g.owner_id, 'cash_blocked', `🚫 Zaznamenávání hotovosti bylo pozastaveno kvůli neuhrazené provizi z hotovostních plateb. Stripe platby běží dál; cash odblokuješ úhradou provize (aktualizuj kartu).`, { gym_id: gid });
            suspended++;
          }
        }
      }
    }

    // ---- LIFT: gyms with a failure clock but nothing unpaid anymore ----
    const susGyms = await sb(`gyms?commission_failed_at=not.is.null&select=id,owner_id,account_suspended,cash_blocked`);
    for (const g of (susGyms || [])) {
      if (unpaidSet.has(g.id)) continue; // still owes
      await sb(`gyms?id=eq.${g.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ commission_failed_at: null, account_suspended: false, cash_blocked: false }) });
      if (g.account_suspended || g.cash_blocked) await notify(g.owner_id, 'commission_cleared', `✅ Provize uhrazena — účet je opět plně aktivní.`, { gym_id: g.id });
      lifted++;
    }

    // ===== COACH PROVIDERS: coach-own cash/QR (paid_to='coach'), billed on profiles =====
    const ctx = await sb(`transactions?select=coach_id,currency,mtl_fee,mtl_rate,gross_amount,mtl_fee_refunded,payment_method,commission_status,commission_month&payment_method=in.(cash,qr,pis)&commission_status=in.(pending,failed)&paid_to=eq.coach&coach_id=not.is.null&commission_month=${monthOp}.${curMonth}&limit=20000`);
    const byCoach = {};
    for (const t of (ctx || [])) {
      if (!t.coach_id) continue;
      if (t.commission_month === curMonth && !coachDaily(t.coach_id)) continue;
      const cur = (t.currency || 'czk').toLowerCase();
      (byCoach[t.coach_id] = byCoach[t.coach_id] || {});
      byCoach[t.coach_id][cur] = (byCoach[t.coach_id][cur] || 0) + ((t.mtl_fee || 0) - (t.mtl_fee_refunded || 0));
    }
    const coachIds = Object.keys(byCoach);
    const unpaidCoach = new Set(coachIds);
    let coachMap = {};
    if (coachIds.length) {
      const profs = await sb(`profiles?id=in.(${coachIds.join(',')})&select=id,name,payment_mode,takes_cash,commission_card_customer,commission_card_pm,commission_failed_at,commission_next_retry,account_suspended,cash_blocked`);
      (profs || []).forEach(p => { coachMap[p.id] = p; });
    }
    for (const cid of coachIds) {
      const c = coachMap[cid]; if (!c) continue;

      // ---- BILLING (on/after the 6th, needs a card, 3-day retry spacing) ----
      const retryReady = !c.commission_next_retry || new Date(c.commission_next_retry).getTime() <= Date.now();
      if (billDay && retryReady && c.commission_card_customer && c.commission_card_pm) {
        let anyFail = false, anyCharge = false;
        for (const cur of Object.keys(byCoach[cid])) {
          const amount = Math.round(byCoach[cid][cur]);
          // Pod minimem Stripe: nechame to na priste, at se z toho nestane "selhalo".
          if (amount > 0 && belowMin(amount, cur)) { deferredMin++; continue; }
          if (!amount || amount <= 0) continue;
          anyCharge = true;
          let pi = null;
          try {
            pi = await stripe.paymentIntents.create({
              amount, currency: cur,
              customer: c.commission_card_customer,
              payment_method: c.commission_card_pm,
              off_session: true, confirm: true,
              description: `MTL provize (hotovost/QR) ${c.name || 'kouc'}`,
              metadata: { coach_id: cid, kind: 'mtl_commission', month: curMonth },
            }, { idempotencyKey: `comm_coach_${cid}_${coachDaily(cid) ? today : curMonth}_${cur}` });
          } catch (e) { pi = null; }

          if (pi && pi.status === 'succeeded') {
            // CHANGED: same as the gym branch above -- daily used to skip the mark and re-charge daily.
            {
              const _scope = coachDaily(cid) ? '' : `&commission_month=lt.${curMonth}`;
              await sb(`transactions?coach_id=eq.${cid}&paid_to=eq.coach&payment_method=in.(cash,qr,pis)&commission_status=in.(pending,failed)&currency=ilike.${encodeURIComponent(cur)}${_scope}`,
                { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ commission_status: 'collected', commission_collected_at: new Date().toISOString() }) });
            }
            // BEZ NOTIFIKACE. O strzeni se clovek dozvi jednou zpravou spolu s dokladem
            // (unified-doklad-cron o pul hodiny pozdeji): castka, jak byla strzena, a proklik primo
            // na doklad. Driv prisly dve zpravy za tutez provizi a obe vedly na stejne misto.
            collected++;
          } else {
            anyFail = true;
            if (!coachDaily(cid)) await sb(`transactions?coach_id=eq.${cid}&paid_to=eq.coach&payment_method=in.(cash,qr,pis)&commission_status=eq.pending&currency=ilike.${encodeURIComponent(cur)}&commission_month=lt.${curMonth}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ commission_status: 'failed' }) });
            failed++;
          }
        }
        if (anyCharge && anyFail) {
          const patch = { commission_next_retry: new Date(Date.now() + 3 * 86400000).toISOString() };
          if (!c.commission_failed_at) { patch.commission_failed_at = new Date().toISOString(); c.commission_failed_at = patch.commission_failed_at; }
          await sb(`profiles?id=eq.${cid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
          await notifyMail(cid, 'Provizi MTL se nepodařilo strhnout', 'Zkusíme to znovu za tři dny. Zkontroluj prosím platební kartu v Platby a provize — po dvou týdnech bez úhrady se účet pozastaví.'); await notify(cid, 'commission_failed', `⚠️ Stržení provize MTL z karty selhalo. Aktualizuj kartu — další pokus za 3 dny. Pokud neuhradíš do 2 týdnů, zaznamenávání hotovosti se pozastaví.`, { coach_id: cid });
        } else if (anyCharge && !anyFail) {
          unpaidCoach.delete(cid);
          await sb(`profiles?id=eq.${cid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ commission_next_retry: null, commission_last_billed: prevMonth(curMonth) }) });
        }
      }

      // ---- SUSPENSION (2-week clock) ----
      if (c.commission_failed_at && unpaidCoach.has(cid)) {
        const overdue = Date.now() > new Date(c.commission_failed_at).getTime() + GRACE_DAYS * 86400000;
        if (overdue) {
          if (c.payment_mode === 'qr_bank' && !c.account_suspended) {
            await sb(`profiles?id=eq.${cid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ account_suspended: true }) });
            await notify(cid, 'account_suspended', `🚫 Účet byl pozastaven kvůli neuhrazené provizi MTL. Tvůj profil je skrytý. Aktualizuj kartu a uhraď provizi.`, { coach_id: cid });
            suspended++;
          } else if (c.payment_mode !== 'qr_bank' && c.takes_cash && !c.cash_blocked) {
            await sb(`profiles?id=eq.${cid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ cash_blocked: true }) });
            await notify(cid, 'cash_blocked', `🚫 Zaznamenávání hotovosti bylo pozastaveno kvůli neuhrazené provizi. Stripe platby běží dál.`, { coach_id: cid });
            suspended++;
          }
        }
      }
    }

    // ---- LIFT: coaches with a failure clock but nothing unpaid anymore ----
    const susCoaches = await sb(`profiles?commission_failed_at=not.is.null&select=id,account_suspended,cash_blocked`);
    for (const c of (susCoaches || [])) {
      if (unpaidCoach.has(c.id)) continue;
      await sb(`profiles?id=eq.${c.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ commission_failed_at: null, account_suspended: false, cash_blocked: false, commission_next_retry: null }) });
      if (c.account_suspended || c.cash_blocked) await notify(c.id, 'commission_cleared', `✅ Provize uhrazena — účet je opět plně aktivní.`, { coach_id: c.id });
      lifted++;
    }


    // ===== ORGANIZACE: provize z akcí pořádaných organizací (paid_to='organization') =====
    // Postaveno stejně jako klubová a koučovská větev výše: sečti nezaplacené, po 6. dni
    // strhni z karty, při selhání odlož a nakonec pozastav. Nic vlastního, jen jiný vlastník.
    const otx = await sb(`transactions?select=organization_id,paid_to,currency,mtl_fee,mtl_rate,gross_amount,mtl_fee_refunded,payment_method,commission_status,commission_month&payment_method=in.(cash,qr,pis)&commission_status=in.(pending,failed)&organization_id=not.is.null&commission_month=${monthOp}.${curMonth}&limit=20000`);
    const byOrg = {};
    for (const t of (otx || [])) {
      if (!t.organization_id) continue;
      if (t.paid_to && t.paid_to !== 'organization') continue;
      // Běžný provoz účtuje po měsíci; denní režim je jen pro testovací účty.
      if (t.commission_month === curMonth && !orgDaily(t.organization_id)) continue;
      const cur = (t.currency || 'czk').toLowerCase();
      (byOrg[t.organization_id] = byOrg[t.organization_id] || {});
      byOrg[t.organization_id][cur] = (byOrg[t.organization_id][cur] || 0) + ((t.mtl_fee || 0) - (t.mtl_fee_refunded || 0));
    }
    const orgIds = Object.keys(byOrg);
    const unpaidOrg = new Set(orgIds);
    let orgMap = {};
    if (orgIds.length) {
      const orgs = await sb(`organizations?id=in.(${orgIds.join(',')})&select=id,name,owner_id,payment_mode,commission_card_customer,commission_card_pm,commission_failed_at,commission_next_retry,account_suspended,cash_blocked`);
      (orgs || []).forEach(o => { orgMap[o.id] = o; });
    }
    for (const oid of orgIds) {
      const o = orgMap[oid];
      if (!o) continue;
      const retryReady = !o.commission_next_retry || new Date(o.commission_next_retry).getTime() <= Date.now();
      if (billDay && retryReady && o.commission_card_customer && o.commission_card_pm) {
        let anyFail = false, anyCharge = false;
        for (const cur of Object.keys(byOrg[oid])) {
          const amount = Math.round(byOrg[oid][cur]);
          // Pod minimem Stripe: nechame to na priste, at se z toho nestane "selhalo".
          if (amount > 0 && belowMin(amount, cur)) { deferredMin++; continue; }
          if (!amount || amount <= 0) continue;
          anyCharge = true;
          let pi = null;
          try {
            pi = await stripe.paymentIntents.create({
              amount, currency: cur,
              customer: o.commission_card_customer, payment_method: o.commission_card_pm,
              off_session: true, confirm: true,
              description: `MTL provize (hotovost/QR) ${o.name || 'organizace'}`,
              metadata: { organization_id: oid, kind: 'mtl_commission', month: curMonth },
            }, { idempotencyKey: `comm_org_${oid}_${orgDaily(oid) ? today : curMonth}_${cur}` });
          } catch (e) { pi = null; }
          if (pi && pi.status === 'succeeded') {
            // Označit transakce jako vybrané -- bez toho nemá unified-doklad-cron co vystavit.
            const _scope = orgDaily(oid) ? '' : `&commission_month=lt.${curMonth}`;
            const r = await sb(`transactions?organization_id=eq.${oid}&or=(paid_to.is.null,paid_to.eq.organization)&currency=ilike.${encodeURIComponent(cur)}&commission_status=in.(pending,failed)&payment_method=in.(cash,qr,pis)${_scope}`, {
              method: 'PATCH', prefer: 'return=representation',
              body: JSON.stringify({ commission_status: 'collected', commission_collected_at: new Date().toISOString() }),
            });
            marked += (r && r.length) || 0;
            collected++;
          } else { anyFail = true; }
        }
        if (anyCharge && !anyFail) {
          await sb(`organizations?id=eq.${oid}`, { method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ commission_failed_at: null, commission_next_retry: null, account_suspended: false, cash_blocked: false }) });
          unpaidOrg.delete(oid);
        } else if (anyFail) {
          const first = o.commission_failed_at || new Date().toISOString();
          const next = new Date(Date.now() + 3 * 86400000).toISOString();
          await sb(`organizations?id=eq.${oid}`, { method: 'PATCH', prefer: 'return=minimal',
            body: JSON.stringify({ commission_failed_at: first, commission_next_retry: next }) });
          if (o.owner_id) await notifyMail(o.owner_id, 'Provizi MTL se nepodařilo strhnout', 'Zkusíme to znovu za tři dny. Zkontroluj prosím platební kartu v Platby a provize — po dvou týdnech bez úhrady se účet pozastaví.'); await notify(o.owner_id, 'commission_failed', `⚠️ Provizi MTL se nepodařilo strhnout. Zkusíme to znovu za tři dny.`, { organization_id: oid });
          failed++;
        }
      }
      // Karta chybí: bez ní se nedá strhnout nic a organizace o tom musí vědět dřív,
      // než jí to zastaví prodej lístků.
      if (billDay && !(o.commission_card_customer && o.commission_card_pm) && o.owner_id) {
        await notifyMail(o.owner_id, 'Doplň platební kartu pro provizi MTL', 'Bez karty nejde provizi z hotovosti a QR plateb strhnout. Doplň ji v Platby a provize.'); await notify(o.owner_id, 'commission_no_card', `Doplň platební kartu pro provizi MTL, jinak se pozastaví prodej lístků.`, { organization_id: oid });
      }
      // ---- POZASTAVENÍ po dvou týdnech neuhrazené provize, stejně jako u klubu ----
      if (o.commission_failed_at && (Date.now() - new Date(o.commission_failed_at).getTime()) > 14 * 86400000 && !o.account_suspended) {
        await sb(`organizations?id=eq.${oid}`, { method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ account_suspended: true, cash_blocked: true }) });
        if (o.owner_id) await notifyMail(o.owner_id, 'Účet je pozastavený — neuhrazená provize MTL', 'Provize se nepodařilo strhnout dva týdny. Po uhrazení se účet obnoví sám.'); await notify(o.owner_id, 'commission_suspended', `🚫 Neuhrazená provize MTL — prodej lístků je pozastavený.`, { organization_id: oid });
        suspended++;
      }
    }
    // ---- UVOLNĚNÍ: organizace s hodinami selhání, ale bez dluhu ----
    {
      const susOrgs = await sb(`organizations?or=(commission_failed_at.not.is.null,account_suspended.eq.true)&select=id,owner_id,account_suspended,cash_blocked`);
      for (const o of (susOrgs || [])) {
        if (unpaidOrg.has(o.id)) continue;
        await sb(`organizations?id=eq.${o.id}`, { method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ commission_failed_at: null, account_suspended: false, cash_blocked: false, commission_next_retry: null }) });
        if ((o.account_suspended || o.cash_blocked) && o.owner_id) await notify(o.owner_id, 'commission_cleared', `✅ Provize uhrazena — organizace je opět plně aktivní.`, { organization_id: o.id });
        lifted++;
      }
    }

    // marked = kolik transakcí dostalo commission_collected_at. Když je collected > 0 a marked = 0,
    // strhlo se, ale neoznačilo -- a pak nemá unified-doklad-cron co vystavit.
    // deferredMin = kolikrat byla castka pod minimem Stripe a proto se necekala jako chyba.
    return res.status(200).json({ ok: true, billDay, collected, failed, suspended, lifted, marked, deferredMin, markErr });
  } catch (e) {
    return res.status(500).json({ error: e.message, collected, failed, suspended, lifted });
  }
}
