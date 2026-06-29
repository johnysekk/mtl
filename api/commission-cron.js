// /api/commission-cron.js
// Runs daily. Collects the off-Stripe (cash/QR) MTL commission that accrued as
// commission_status='pending' during the closed previous month, by charging the
// provider's card-on-file (commission_card_*) once we are on/after the 6th.
//
//  BILLING (only when day-of-month >= 6):
//    sum pending+failed cash/qr commission per gym & currency for any closed month
//    (commission_month < current YYYY-MM) -> Stripe PaymentIntent off_session on
//    the card -> success: rows 'collected' + clear the failure clock + notify (doklad);
//    failure: rows 'failed', start/keep commission_failed_at, notify "fix card in 2 weeks".
//
//  SUSPENSION (every run):
//    commission_failed_at older than GRACE_DAYS (14) and still unpaid ->
//      qr_bank gym         -> account_suspended = true  (whole gym frozen)
//      stripe + takes_cash -> cash_blocked = true        (only cash recording frozen)
//
//  LIFT (every run): a gym with a failure clock but NO remaining unpaid commission
//    -> clear commission_failed_at + account_suspended + cash_blocked + notify.
//
// vercel.json: { "path": "/api/commission-cron", "schedule": "0 8 * * *" }
// Needs env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY ; optional CRON_SECRET.

import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
  const curMonth = now.toISOString().slice(0, 7);
  let collected = 0, failed = 0, suspended = 0, lifted = 0;

  try {
    // ---- gather unpaid closed-month cash/qr commission, grouped by gym + currency ----
    const tx = await sb(`transactions?select=gym_id,currency,mtl_fee,commission_status,commission_month&payment_method=in.(cash,qr)&commission_status=in.(pending,failed)&commission_month=lt.${curMonth}&limit=20000`);
    const byGym = {};
    for (const t of (tx || [])) {
      if (!t.gym_id) continue;
      const cur = (t.currency || 'czk').toLowerCase();
      (byGym[t.gym_id] = byGym[t.gym_id] || {});
      byGym[t.gym_id][cur] = (byGym[t.gym_id][cur] || 0) + (t.mtl_fee || 0);
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
            }, { idempotencyKey: `comm_${gid}_${curMonth}_${cur}` });
          } catch (e) { pi = null; }

          if (pi && pi.status === 'succeeded') {
            await sb(`transactions?gym_id=eq.${gid}&payment_method=in.(cash,qr)&commission_status=in.(pending,failed)&currency=eq.${encodeURIComponent(cur)}&commission_month=lt.${curMonth}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ commission_status: 'collected' }) });
            try { await sb('commission_doklady', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({ gym_id: gid, owner_id: g.owner_id, period_month: prevMonth(curMonth), amount, currency: cur, pi_id: pi.id, status: 'issued' }) }); } catch (e) {}
            await notify(g.owner_id, 'commission_collected', `Provize MTL za hotovost/QR (${(amount / 100).toFixed(2)} ${cur.toUpperCase()}) byla stržena z karty. Doklad najdeš v účetnictví.`, { amount, currency: cur });
            collected++;
          } else {
            anyFail = true;
            await sb(`transactions?gym_id=eq.${gid}&payment_method=in.(cash,qr)&commission_status=eq.pending&currency=eq.${encodeURIComponent(cur)}&commission_month=lt.${curMonth}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ commission_status: 'failed' }) });
            failed++;
          }
        }
        if (anyCharge && anyFail) {
          const patch = { commission_next_retry: new Date(Date.now() + 3 * 86400000).toISOString() };
          if (!g.commission_failed_at) { patch.commission_failed_at = new Date().toISOString(); g.commission_failed_at = patch.commission_failed_at; }
          await sb(`gyms?id=eq.${gid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
          await notify(g.owner_id, 'commission_failed', `⚠️ Stržení provize MTL z karty selhalo. Aktualizuj kartu — další pokus za 3 dny. Pokud neuhradíš do 2 týdnů, účet bude pozastaven.`);
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
            await notify(g.owner_id, 'account_suspended', `🚫 Účet byl pozastaven kvůli neuhrazené provizi MTL. Gym je skrytý a nelze ho používat (tebou ani studenty), dokud provizi neuhradíš (aktualizuj kartu).`);
            suspended++;
          } else if (g.payment_mode !== 'qr_bank' && g.takes_cash && !g.cash_blocked) {
            await sb(`gyms?id=eq.${gid}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ cash_blocked: true }) });
            await notify(g.owner_id, 'cash_blocked', `🚫 Zaznamenávání hotovosti bylo pozastaveno kvůli neuhrazené provizi z hotovostních plateb. Stripe platby běží dál; cash odblokuješ úhradou provize (aktualizuj kartu).`);
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
      if (g.account_suspended || g.cash_blocked) await notify(g.owner_id, 'commission_cleared', `✅ Provize uhrazena — účet je opět plně aktivní.`);
      lifted++;
    }

    return res.status(200).json({ ok: true, billDay, collected, failed, suspended, lifted });
  } catch (e) {
    return res.status(500).json({ error: e.message, collected, failed, suspended, lifted });
  }
}
