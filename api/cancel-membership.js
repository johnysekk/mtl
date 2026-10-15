import Stripe from 'stripe';
import { feeRefundableForPI } from './_fee-window.js';
import { prorata } from './_prorata.js';
import { subMail } from './_sub-mail.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;

// Zruší členské předplatné. Subscription žije na connected accountu gymu/kouče,
// takže cancel i refund musí jít s { stripeAccount }.
//   (default)      -> cancel_at_period_end (člen dotrénuje, co zaplatil; bez refundu)
//   immediate=1    -> zrušit hned (žádný refund; zaplacené období propadá)
//   immediate=1&refund=1 -> zrušit hned + vrátit POMĚRNOU ČÁST poslední platby za nevyužité dny
//                           (_prorata.js). Provize MTL se vrací ve stejném poměru, jen do vystavení
//                           dokladu (_fee-window.js). Stripe poplatek se nevrací.
//   resume=1       -> vrátit zrušení (předplatné zase poběží)
//
// OVĚŘENÍ (dřív žádné: kdokoli s číslem předplatného ho mohl zrušit a nechat si vrátit peníze):
//   • příjemce platby (majitel / správce klubu s tímhle Stripe účtem, kouč s vlastním účtem) -- vše;
//   • člen, kterému předplatné patří (nebo kdo za něj platí) -- jen zrušení ke konci období a obnovení;
//   • Exclusive Partner (předplatné na účtu MTL, bez gymAccount) -- jen své vlastní.
//   • Profil dodavatele: ten, kdo ho platí (jeho karta) -- zrušení i obnovení; majitel organizace,
//     který ho neplatí (po převodu s volbou „dál platí dosavadní majitel") -- jen zrušení ke konci
//     období. Stav zrušení zapisuje server (platící už organizaci nevlastní a nemůže ji měnit) a
//     druhá strana dostane notifikaci s proklikem.

async function sbPost(path, body) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
}
async function sbPatch(path, body) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
}
const czD = (unix, en) => { try { return new Date(unix * 1000).toLocaleDateString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague' }); } catch (e) { return ''; } };
// Profil dodavatele placený někým jiným než majitelem: druhá strana se o zrušení / obnovení dozví.
async function supOtherSide(S, resume, pe) {
  if (String(S.owner) === String(S.payer)) return;
  const toId = S.isPayer ? S.owner : S.payer;
  const actor = ((await sb(`profiles?id=eq.${q(S.isPayer ? S.payer : S.owner)}&select=name,email`)) || [])[0] || {};
  const lang = (((await sb(`profiles?id=eq.${q(toId)}&select=lang`)) || [])[0] || {}).lang;
  const who = actor.name || actor.email || '', en = lang === 'en', d = pe ? czD(pe, en) : '';
  let cs, enT;
  if (S.isPayer) {
    cs = resume ? `🧰 ${who} znovu obnovil/a předplatné profilu dodavatele ${S.name} — dál ho platí ze své karty. Kdykoli ho můžeš převzít na svou kartu v Profilu dodavatele.`
      : `🧰 ${who} zastavil/a placení předplatného profilu dodavatele ${S.name} ze své karty. Profil poběží ${d ? ('do ' + d) : 'do konce zaplaceného období'}. Aby běžel dál bez přerušení, založ si v Profilu dodavatele vlastní navazující předplatné — první platba se strhne až ${d || 'v den, kdy to staré skončí'}.`;
    enT = resume ? `🧰 ${who} renewed the supplier profile subscription for ${S.name} — they keep paying it from their card. You can take it over on your card at any time in Supplier profile.`
      : `🧰 ${who} stopped paying the supplier profile subscription for ${S.name} from their card. The profile runs ${d ? ('until ' + d) : 'until the end of the paid period'}. To keep it running without a break, set up your own follow-on subscription in Supplier profile — your card is first charged only ${d ? ('on ' + d) : 'when the old one ends'}.`;
  } else {
    cs = `🧰 Majitel organizace ${S.name} zrušil předplatné profilu dodavatele, které platíš. Z tvé karty se už nic dalšího nestrhne; zaplacené období končí ${d || 'na konci období'}.`;
    enT = `🧰 The owner of ${S.name} cancelled the supplier profile subscription you pay for. Nothing more will be charged to your card; the paid period ends ${d || 'at the end of the period'}.`;
  }
  await sbPost('notifications', { user_id: toId, type: 'system', read: false, message: cs,
    data: JSON.stringify({ kind: 'sup_paidfor', target: S.isPayer ? 'owner' : 'payer', org_id: S.orgId, org_name: S.name, msg_cs: cs, msg_en: enT }) });
}

async function sb(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  try { const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }); if (!r.ok) return null; const u = await r.json(); return (u && u.id) || null; } catch (e) { return null; }
}
async function isPayee(me, acct) {
  const gyms = (await sb(`gyms?stripe_account=eq.${q(acct)}&select=id,owner_id`)) || [];
  for (const g of gyms) {
    if (String(g.owner_id) === String(me)) return true;
    const gc = (await sb(`gym_coaches?gym_id=eq.${q(g.id)}&coach_id=eq.${q(me)}&status=eq.active&select=co_owner,full_autonomy,can_manage_schedule`)) || [];
    if (gc.some((x) => x.co_owner || x.full_autonomy || x.can_manage_schedule)) return true;
  }
  const pr = (await sb(`profiles?or=(stripe_account.eq.${q(acct)},gym_payout_account.eq.${q(acct)})&id=eq.${q(me)}&select=id`)) || [];
  return pr.length > 0;
}

export default async function handler(req, res) {
  try {
    const { subscriptionId, gymAccount, immediate, resume, refund } = req.query;
    if (!subscriptionId) {
      return res.status(400).json({ error: 'Chybí subscriptionId' });
    }
    const me = await whoami(req);
    if (!me) return res.status(401).json({ error: 'Nejsi přihlášený' });
    const memberOp = String(immediate) !== '1';   // ke konci období nebo obnovení
    let mtlSub = null;                             // { userId } EP / { orgId } dodavatel -- kvůli e-mailu
    if (gymAccount) {
      if (!(await isPayee(me, gymAccount))) {
        const own = (await sb(`gym_memberships?stripe_subscription=eq.${q(subscriptionId)}&or=(student_id.eq.${q(me)},paid_by.eq.${q(me)})&select=id&limit=1`)) || [];
        if (!own.length || !memberOp) return res.status(403).json({ error: 'Tohle předplatné měnit nemůžeš' });
      }
    } else {
      // Předplatné na účtu MTL: Exclusive Partner (profil) nebo profil dodavatele (organizace).
      const ep = (await sb(`profiles?id=eq.${q(me)}&partner_sub=eq.${q(subscriptionId)}&select=id&limit=1`)) || [];
      const sup = ep.length ? [] : ((await sb(`organizations?supplier_sub=eq.${q(subscriptionId)}&select=id,name,owner_id,supplier_sub_by&limit=1`)) || []);
      if (!ep.length && !sup.length) return res.status(403).json({ error: 'Tohle předplatné měnit nemůžeš' });
      if (ep.length) mtlSub = { userId: me };
      else {
        // Kdo platí: metadata předplatného (user_id při založení), jinak supplier_sub_by, jinak majitel.
        const o = sup[0];
        let payer = o.supplier_sub_by || o.owner_id;
        try { const _md = (await stripe.subscriptions.retrieve(subscriptionId)).metadata || {}; if (_md.user_id) payer = _md.user_id; }
        catch (e) { console.error('supplier sub payer', e.message); }
        const isOwner = String(o.owner_id) === String(me), isPayer = String(payer) === String(me);
        if (!isOwner && !isPayer) return res.status(403).json({ error: 'Tohle předplatné měnit nemůžeš' });
        // Majitel, který nic neplatí: smí jen zrušit ke konci období. Obnovit by znamenalo strhávat cizí kartu.
        if (!isPayer && (String(resume) === '1' || !memberOp)) return res.status(403).json({ error: 'Tohle předplatné platí předchozí majitel. Obnovit ho může jen on; ty si v Profilu dodavatele můžeš založit vlastní navazující.' });
        mtlSub = { orgId: o.id, sup: { orgId: o.id, name: o.name || '', owner: o.owner_id, payer, isPayer } };
      }
    }
    const opts = gymAccount ? { stripeAccount: gymAccount } : undefined;

    let sub; let refunded = 0, refundId = null, currency = null, usedDays = null, totalDays = null;
    // EP s naplánovaným přechodem z roční na měsíční platbu řídí plán předplatného (pay.js) a Stripe
    // pak zrušení přímo na předplatném odmítne. Rušení přechod ruší taky: plán se nejdřív uvolní.
    if (mtlSub && String(resume) !== '1') {
      try {
        const _s = await stripe.subscriptions.retrieve(subscriptionId);
        if (_s && _s.schedule) {
          await stripe.subscriptionSchedules.release(typeof _s.schedule === 'string' ? _s.schedule : _s.schedule.id);
          if ((_s.metadata || {}).ep_interval_next) await stripe.subscriptions.update(subscriptionId, { metadata: { ep_interval_next: '' } });
        }
      } catch (e) { console.error('release schedule', e.message); }
    }
    if (String(resume) === '1') {
      sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false }, opts);
    } else if (String(immediate) === '1') {
      if (String(refund) === '1') {
        try {
          const subFull = await stripe.subscriptions.retrieve(
            subscriptionId, { expand: ['latest_invoice.payment_intent'] }, opts
          );
          const inv = subFull && subFull.latest_invoice;
          const pi = inv && (typeof inv.payment_intent === 'object'
            ? (inv.payment_intent && inv.payment_intent.id)
            : inv.payment_intent);
          if (pi) {
            // Zaplacené období poslední faktury; záloha = období předplatného.
            const line = inv.lines && inv.lines.data && inv.lines.data[0];
            const it = subFull.items && subFull.items.data && subFull.items.data[0];
            const pStart = (line && line.period && line.period.start) || subFull.current_period_start || (it && it.current_period_start);
            const pEnd = (line && line.period && line.period.end) || subFull.current_period_end || (it && it.current_period_end);
            const pr = prorata(inv.amount_paid || 0, (pStart || 0) * 1000, (pEnd || 0) * 1000);
            let already = 0;
            try { const t = ((await sb(`transactions?payment_intent=eq.${q(pi)}&select=refund_amount&limit=1`)) || [])[0]; already = Number(t && t.refund_amount) || 0; } catch (e) {}
            const amount = pr ? Math.max(0, pr.unused - already) : 0;
            currency = String(inv.currency || '').toUpperCase() || null;
            if (pr) { usedDays = pr.usedDays; totalDays = pr.totalDays; }
            if (amount > 0) {
              const rf = await stripe.refunds.create(
                { payment_intent: pi, amount, refund_application_fee: await feeRefundableForPI(pi) }, opts
              );
              refunded = (rf.amount || 0) / 100; refundId = rf.id;
            }
          }
        } catch (e) { console.error('membership refund error:', e.message); }
      }
      sub = await stripe.subscriptions.cancel(subscriptionId, opts);
    } else {
      sub = await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, opts);
    }

    // Novější verze API Stripe drží konec období u položky předplatného, ne u předplatného.
    const _pe = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || null;
    // EP / dodavatel: potvrzení e-mailem (zrušení s datem konce, nebo obnovení). Konec samotný
    // hlásí webhook (customer.subscription.deleted).
    if (mtlSub && String(immediate) !== '1') await subMail(mtlSub, String(resume) === '1' ? 'resume' : 'cancel', _pe, { test: sub.livemode === false });
    if (mtlSub && mtlSub.sup && String(immediate) !== '1') {
      const _res = String(resume) === '1';
      try { await sbPatch(`organizations?id=eq.${q(mtlSub.sup.orgId)}`, { supplier_cancelling: !_res, supplier_period_end: (!_res && _pe) ? new Date(_pe * 1000).toISOString() : null }); }
      catch (e) { console.error('supplier state', e.message); }
      try { await supOtherSide(mtlSub.sup, _res, _pe); } catch (e) { console.error('supplier other side', e.message); }
    }
    res.status(200).json({
      ok: true,
      status: sub.status,
      cancel_at_period_end: sub.cancel_at_period_end || false,
      current_period_end: _pe,
      refunded, refundId, currency, used_days: usedDays, total_days: totalDays,
    });
  } catch (err) {
    console.error('cancel-membership error:', err);
    res.status(500).json({ error: err.message });
  }
}
