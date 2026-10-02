// /api/class-cancel — KLUB ZRUŠÍ TERMÍN LEKCE (předem, nebo zpětně „zapomněli jsme zrušit").
//
// Dřív klub termín zrušit nemohl vůbec; „neproběhla" šlo jen zpětně v docházce a nikomu se nic
// nevrátilo ani neoznámilo. Tady se jedním krokem vyřeší každý, kdo byl na termín přihlášený:
//   • kartou (Stripe)            → 100 % zpět automaticky, i s provizí MTL
//   • převodem / QR / Finbricks / hotově → podle volby klubu: vrátit (peníze vrací klub sám,
//                                    MTL je nedrží; provize z platby se ruší), nebo přesun na jiný
//                                    termín zdarma (student si ho vybere, nepočítá se do limitu)
//   • zkušební trénink zdarma    → nárok se vrací, nepočítá se ani jako zrušení
//   • nezaplacená rezervace      → zruší se, nic se nevrací
//   • členové s rezervací        → rezervace se uvolní
// Každý přihlášený dostane notifikaci s proklikem.
//
//   POST { action:'preview', gym_id, occ:{date,time,name} }
//   POST { action:'cancel',  gym_id, occ:{date,time,name,coach}, mode:'advance'|'forgot', note, choices:{bookingId:'refund'|'move'} }

import Stripe from 'stripe';
import { feeRefundableForPI, feeRefundableForTx, bankFeeRefundable } from './_fee-window.js';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

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

// Zrušit termín smí majitel klubu, spolumajitel a trenér s právem spravovat rozvrh.
async function canManage(gym, me) {
  if (String(gym.owner_id) === String(me)) return true;
  const gc = (await sb(`gym_coaches?gym_id=eq.${q(gym.id)}&coach_id=eq.${q(me)}&status=eq.active&select=can_manage_schedule,co_owner,full_autonomy`)) || [];
  return gc.some((x) => x.can_manage_schedule || x.co_owner || x.full_autonomy);
}

const BANK = ['qr', 'pis', 'cash'];
function kindOf(b) {
  if (b.is_trial) return 'trial';
  if (b.payment_intent && !BANK.includes(String(b.payment_method || ''))) return 'card';
  if (b.status === 'active' || b.status === 'paid_claimed') return 'bank';   // zaplaceno (nebo hlášeno jako zaplacené)
  return 'unpaid';
}
function dCz(date, time) {
  try { const d = new Date(String(date) + 'T00:00:00Z'); return `${d.getUTCDate()}. ${d.getUTCMonth() + 1}.${time ? ' ' + time : ''}`; } catch (e) { return String(date || ''); }
}

async function loadAffected(gym, occ) {
  const f = `gym_id=eq.${q(gym.id)}&class_date=eq.${q(occ.date)}&class_time=eq.${q(occ.time || '')}&class_name=eq.${q(occ.name || '')}`;
  const bookings = (await sb(`gym_bookings?${f}&status=in.(active,paid_claimed,reserved,pending)&select=*`)) || [];
  const resv = (await sb(`gym_class_reservations?${f}&select=id,student_id,student_name,child_name,status`)) || [];
  // Rezervace, které jsou jen držením místa k zaplacenému vstupu, se ukazují u vstupu, ne zvlášť.
  const bookedIds = new Set(bookings.map((b) => String(b.student_id || '')));
  const members = resv.filter((r) => r.status !== 'released' && !bookedIds.has(String(r.student_id || '')));
  return { bookings, resv, members };
}

async function notify(userId, cs, en, data) {
  if (!userId) return;
  try {
    const lang = (((await sb(`profiles?id=eq.${q(userId)}&select=lang`)) || [])[0] || {}).lang;
    await sb('notifications', { method: 'POST', prefer: 'return=minimal',
      body: JSON.stringify({ user_id: userId, type: 'system', read: false,
        data: JSON.stringify(Object.assign({ kind: 'class_cancelled', msg_cs: cs, msg_en: en }, data)), message: lang === 'en' ? en : cs }) });
  } catch (e) { console.error('[class-cancel] notify', e.message); }
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'not configured' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const me = await whoami(req);
    if (!me) return res.status(401).json({ error: 'no token' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const occ = b.occ || {};
    if (!b.gym_id || !occ.date) return res.status(400).json({ error: 'gym_id + occ.date required' });
    const gym = ((await sb(`gyms?id=eq.${q(b.gym_id)}&select=id,name,owner_id,stripe_account,currency`)) || [])[0];
    if (!gym) return res.status(404).json({ error: 'gym not found' });
    if (!(await canManage(gym, me))) return res.status(403).json({ error: 'forbidden' });

    const { bookings, resv, members } = await loadAffected(gym, occ);

    if (b.action === 'preview') {
      return res.status(200).json({ ok: true,
        bookings: bookings.map((x) => ({ id: x.id, kind: kindOf(x), name: x.child_name || x.student_name || x.guest_name || 'Student',
          has_account: !!x.student_id, amount: x.amount, currency: x.currency || gym.currency || 'CZK', method: x.payment_method || null })),
        members: members.map((r) => ({ id: r.id, name: r.child_name || r.student_name || 'Člen' })) });
    }

    if (b.action !== 'cancel') return res.status(400).json({ error: 'unknown action' });
    const mode = b.mode === 'forgot' ? 'forgot' : 'advance';
    const note = String(b.note || '').trim().slice(0, 300);
    const choices = b.choices || {};
    const nowIso = new Date().toISOString();
    const when = dCz(occ.date, occ.time);
    const cls = occ.name || 'lekce';
    const reasonCs = note ? ` Důvod: ${note}` : '';
    const reasonEn = note ? ` Reason: ${note}` : '';
    const mp = ((await sb(`profiles?id=eq.${q(me)}&select=name`)) || [])[0] || {};

    // 1) Termín je zrušený (rozvrh ho ukáže jako zrušený, nejde na něj nic koupit).
    // Bez spoléhání na unikátní index (v databázi není -- upsert s on_conflict padal): najít
    // záznam termínu a přepsat, jinak založit.
    {
      const f = `gym_id=eq.${q(gym.id)}&class_date=eq.${q(occ.date)}` +
        (occ.time ? `&class_time=eq.${q(occ.time)}` : '&class_time=is.null') +
        (occ.name ? `&class_name=eq.${q(occ.name)}` : '&class_name=is.null');
      const row = { gym_id: gym.id, class_date: occ.date, class_time: occ.time || null, class_name: occ.name || null,
        coach_id: occ.coach || null, status: 'cancelled', reason: mode, logged_by: me };
      const ex = (await sb(`gym_class_log?${f}&select=id&limit=1`)) || [];
      if (ex[0]) await sb(`gym_class_log?id=eq.${q(ex[0].id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(row) });
      else await sb('gym_class_log', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(row) });
    }

    const out = { refunded_card: [], bank_refund: [], moved: [], trials: [], unpaid: [], members: 0, errors: [] };

    for (const bk of bookings) {
      const k = kindOf(bk);
      const who = bk.child_name || bk.student_name || bk.guest_name || 'Student';
      const amt = Number(bk.amount || 0), cur = bk.currency || gym.currency || 'CZK';
      const money = `${amt} ${cur === 'CZK' ? 'Kč' : cur}`;
      const base = { gym_id: gym.id, gym_name: gym.name, booking_id: bk.id, class_name: cls, class_date: occ.date, class_time: occ.time || '' };
      try {
        if (k === 'trial') {
          await sb(`gym_bookings?id=eq.${q(bk.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled', club_cancelled_at: nowIso }) });
          // Nárok zpět: záznam o využitém zkušebním se smaže (nepočítá se ani jako zrušení).
          const tr = (await sb(`gym_trials?gym_id=eq.${q(gym.id)}&student_id=eq.${q(bk.student_id)}&child_name=eq.${q(bk.child_name || '')}&class_date=eq.${q(occ.date)}&select=id&order=created_at.desc&limit=1`)) || [];
          if (tr[0]) await sb(`gym_trials?id=eq.${q(tr[0].id)}`, { method: 'DELETE', prefer: 'return=minimal' });
          out.trials.push(who);
          await notify(bk.student_id,
            `🚫 ${gym.name} zrušil lekci ${cls} (${when}).${reasonCs} Tvůj zkušební trénink zdarma ti zůstává — rezervuj si jiný termín.`,
            `🚫 ${gym.name} cancelled ${cls} (${when}).${reasonEn} Your free trial class is still yours — book another time.`,
            Object.assign({ choice: 'trial' }, base));
        } else if (k === 'card') {
          // 100 % zpět automaticky, včetně provize MTL (chyba není na straně studenta).
          if (!stripe || !gym.stripe_account) throw new Error('stripe not configured');
          await stripe.refunds.create({ payment_intent: bk.payment_intent, refund_application_fee: await feeRefundableForPI(bk.payment_intent) }, { stripeAccount: gym.stripe_account });
          await sb(`gym_bookings?id=eq.${q(bk.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled', club_cancelled_at: nowIso, club_cancel_choice: 'refund' }) });
          out.refunded_card.push(`${who} · ${money}`);
          await notify(bk.student_id,
            `🚫 ${gym.name} zrušil lekci ${cls} (${when}).${reasonCs} Vracíme ti celou platbu ${money} na kartu — na účtu bývá do 5–10 dnů.`,
            `🚫 ${gym.name} cancelled ${cls} (${when}).${reasonEn} We are refunding the full ${money} to your card — it usually arrives within 5–10 days.`,
            Object.assign({ choice: 'refund', amount: amt, currency: cur }, base));
          await confirmRow(bk, gym, me, mp.name, occ, amt, cur, note);
        } else if (k === 'bank') {
          const ch = choices[bk.id] === 'move' ? 'move' : 'refund';
          if (ch === 'move') {
            // Zůstává zaplacený; student si vybere jiný termín (bez limitu přesunů, i zpětně).
            await sb(`gym_bookings?id=eq.${q(bk.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ club_cancelled_at: nowIso, club_cancel_choice: 'move' }) });
            out.moved.push(`${who} · ${money}`);
            await notify(bk.student_id,
              `🚫 ${gym.name} zrušil lekci ${cls} (${when}).${reasonCs} Zaplacený vstup ${money} ti zůstává — vyber si jiný termín, bez poplatku.`,
              `🚫 ${gym.name} cancelled ${cls} (${when}).${reasonEn} Your paid entry (${money}) stays — pick another time, free of charge.`,
              Object.assign({ choice: 'move' }, base));
          } else {
            // MTL peníze z převodu nedrží -- vrací je klub. Provize z té platby se ruší.
            await sb(`gym_bookings?id=eq.${q(bk.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled', club_cancelled_at: nowIso, club_cancel_choice: 'refund' }) });
            // Provize se odečte jen, dokud není stržená (pak už ne -- stejné pravidlo jako u karty).
            const tx = (await sb(`transactions?source_booking_id=eq.${q(bk.id)}&select=id,gross_amount,mtl_fee,commission_status`)) || [];
            for (const t of tx) {
              const patch = { status: 'refunded', refund_amount: t.gross_amount };
              if (bankFeeRefundable(t)) patch.mtl_fee_refunded = t.mtl_fee;
              await sb(`transactions?id=eq.${q(t.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(patch) });
            }
            const how = bk.payment_method === 'cash' ? 'hotově' : 'převodem na účet, ze kterého jsi platil/a';
            const howEn = bk.payment_method === 'cash' ? 'in cash' : 'by bank transfer to the account you paid from';
            out.bank_refund.push({ name: who, amount: amt, currency: cur, method: bk.payment_method || null });
            await notify(bk.student_id,
              `🚫 ${gym.name} zrušil lekci ${cls} (${when}).${reasonCs} Klub ti vrátí ${money} ${how}. Kdyby peníze do týdne nedorazily, napiš klubu.`,
              `🚫 ${gym.name} cancelled ${cls} (${when}).${reasonEn} The club will refund ${money} ${howEn}. If it has not arrived within a week, contact the club.`,
              Object.assign({ choice: 'refund', amount: amt, currency: cur }, base));
            await confirmRow(bk, gym, me, mp.name, occ, amt, cur, note);
          }
        } else {
          await sb(`gym_bookings?id=eq.${q(bk.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled', club_cancelled_at: nowIso }) });
          out.unpaid.push(who);
          await notify(bk.student_id,
            `🚫 ${gym.name} zrušil lekci ${cls} (${when}).${reasonCs} Rezervace je zrušená, nic neplatíš.`,
            `🚫 ${gym.name} cancelled ${cls} (${when}).${reasonEn} Your booking is cancelled, there is nothing to pay.`,
            Object.assign({ choice: 'none' }, base));
        }
      } catch (e) {
        console.error('[class-cancel] booking', bk.id, e.message);
        out.errors.push({ name: who, error: String(e.message || e).slice(0, 160) });
      }
    }

    // Členové: uvolnit rezervace (i držená místa k vstupům) a dát vědět.
    for (const r of resv) {
      try { await sb(`gym_class_reservations?id=eq.${q(r.id)}`, { method: 'DELETE', prefer: 'return=minimal' }); } catch (e) {}
    }
    for (const r of members) {
      out.members++;
      await notify(r.student_id,
        `🚫 ${gym.name} zrušil lekci ${cls} (${when}).${reasonCs} Tvoje rezervace se uvolnila, členství se tím nemění.`,
        `🚫 ${gym.name} cancelled ${cls} (${when}).${reasonEn} Your reservation was released; your membership is not affected.`,
        { choice: 'member', gym_id: gym.id, gym_name: gym.name, class_name: cls, class_date: occ.date, class_time: occ.time || '' });
    }
    return res.status(200).json({ ok: true, result: out });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}

// Potvrzení o zrušení (stejná tabulka jako při zrušení studentem), aby bylo dohledatelné,
// kolik se vrací a proč. Vystavuje ho klub.
async function confirmRow(bk, gym, me, myName, occ, refund, cur, note) {
  try {
    const tx = ((await sb(`transactions?source_booking_id=eq.${q(bk.id)}&select=id,gross_amount&limit=1`)) || [])[0] || null;
    await sb('cancel_confirmations', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify({
      booking_id: String(bk.id), booking_kind: 'dropin', transaction_id: tx ? tx.id : null,
      student_id: bk.student_id || null, participant_name: bk.child_name || bk.student_name || bk.guest_name || null,
      payer_name: bk.paid_by_name || bk.student_name || null,
      cancelled_by: me, cancelled_by_name: myName || null, cancelled_by_role: 'club',
      gym_id: gym.id, coach_id: bk.coach_id || null, provider_name: gym.name || null, class_name: occ.name || bk.class_name || null,
      session_at: `${occ.date}${occ.time ? ' ' + occ.time : ''}`, reason_key: 'club_cancelled', note: note || null,
      amount_paid: bk.amount, refund_amount: refund, currency: cur, payment_method: bk.payment_method || null,
      test_mode: !!bk.test_mode }) });
  } catch (e) { console.error('[class-cancel] confirmation', e.message); }
}
