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
//   POST { action:'preview', gym_id, occ:{date,time,name,cid} }
//   POST { action:'cancel',  gym_id, occ:{date,time,name,cid,coach}, mode:'advance'|'forgot', note, choices:{bookingId:'refund'|'move'} }
// Termín se páruje přes `cid` lekce (class_id v tabulkách) + datum. Bez cid (lekce mimo rozvrh)
// postaru podle času a názvu.
//
// UKONČENÍ LEKCE (smazání jednorázové, nebo opakovaná „tento a všechny další termíny"): rozvrh
// zkrátí appka (opakovaná dostane `until`, jednorázová zmizí), tady se vyřeší každý, kdo je na
// některý z rušených termínů přihlášený -- stejně jako při zrušení jednoho termínu.
//   POST { action:'end_preview', gym_id, cls:{cid,name,once,date,time,slots}, from:'YYYY-MM-DD' }
//   POST { action:'end',         gym_id, cls:{...}, from, note, choices:{bookingId:'refund'|'move'}, transfer_to:[cid…] }
// Permanentky „jen na tyto lekce" napojené na ukončenou opakovanou lekci: end_preview je vrátí
// (passes), end jejich držitelům nabídne přesun na lekce transfer_to, nebo vrácení (_pass-transfer.js).

import Stripe from 'stripe';
import { feeRefundableForPI, feeRefundableForTx, bankFeeRefundable } from './_fee-window.js';
import { passHolders, offerForEndedClass } from './_pass-transfer.js';

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

const cidOf = (o) => { const c = String((o && o.cid) || '').trim(); return /^[A-Za-z0-9_-]{1,40}$/.test(c) ? c : null; };

// Hodnota do or=(…) PostgRESTu: v uvozovkách (čas má dvojtečku, název může mít čárku).
const pq = (v) => '"' + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
// S cid i řádky bez class_id (spouštěč je k rozvrhu nepřiřadil) -- ty postaru podle času a názvu.
const legacyOr = (cid, time, name) => '&or=' + q(`(class_id.eq.${pq(cid)},and(class_id.is.null${time != null ? `,class_time.eq.${pq(time)}` : ''}${name ? `,class_name.eq.${pq(name)}` : ''}))`);

async function loadAffected(gym, occ) {
  const cid = cidOf(occ);
  const f = `gym_id=eq.${q(gym.id)}&class_date=eq.${q(occ.date)}` + (cid ? legacyOr(cid, occ.time || '', occ.name || null) :
    `&class_time=eq.${q(occ.time || '')}` + (occ.name ? `&class_name=eq.${q(occ.name)}` : '&or=(class_name.is.null,class_name.eq.)'));
  const bookings = (await sb(`gym_bookings?${f}&status=in.(active,paid_claimed,reserved,pending)&select=*`)) || [];
  const resv = (await sb(`gym_class_reservations?${f}&select=id,student_id,student_name,child_name,status,class_date,class_time,class_id`)) || [];
  return split(bookings, resv);
}
// Rezervace, které jsou jen držením místa k zaplacenému vstupu, se ukazují u vstupu, ne zvlášť.
function split(bookings, resv) {
  const bookedIds = new Set(bookings.map((b) => `${b.class_date}|${b.class_time}|${b.student_id || ''}`));
  const members = resv.filter((r) => r.status !== 'released' && !bookedIds.has(`${r.class_date}|${r.class_time}|${r.student_id || ''}`));
  return { bookings, resv, members };
}

// Všechny rezervace na termíny lekce od data `from` (včetně). Opakovaná lekce: jen dny a časy
// jejích termínů (dvě lekce téhož názvu v jiný čas zůstanou netknuté); jednorázová: její datum.
// S cid: všechny termíny té lekce od data (i její další verze -- appka ukončí všechny).
async function loadAffectedFrom(gym, cls, from) {
  const name = String(cls.name || '').trim();
  const cid = cidOf(cls);
  const nf = cid ? legacyOr(cid, null, name || null) : name ? `&class_name=eq.${q(name)}` : '&or=(class_name.is.null,class_name.eq.)';
  const df = cls.once ? `&class_date=eq.${q(cls.date || '')}` : `&class_date=gte.${q(from)}`;
  const f = `gym_id=eq.${q(gym.id)}${df}${nf}`;
  const slots = (Array.isArray(cls.slots) ? cls.slots : []).map((x) => `${Number(x.day)}@${String(x.time || '').slice(0, 5)}`);
  const hit = (r) => {
    const t = String(r.class_time || '').slice(0, 5);
    if (cid && r.class_id) return !cls.once || String(r.class_date) >= String(from);
    if (cls.once) return String(r.class_date) >= String(from) && t === String(cls.time || '').slice(0, 5);
    const dow = new Date(String(r.class_date) + 'T12:00:00Z').getUTCDay();
    return slots.includes(`${dow}@${t}`);
  };
  const bookings = ((await sb(`gym_bookings?${f}&status=in.(active,paid_claimed,reserved,pending)&select=*`)) || []).filter(hit);
  const resv = ((await sb(`gym_class_reservations?${f}&select=id,student_id,student_name,child_name,status,class_date,class_time,class_id`)) || []).filter(hit);
  return split(bookings, resv);
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
    const isEnd = b.action === 'end' || b.action === 'end_preview';
    const occ = b.occ || {};
    const cls = b.cls || {};
    const from = String(b.from || '').slice(0, 10);
    if (!b.gym_id) return res.status(400).json({ error: 'gym_id required' });
    if (!isEnd && !occ.date) return res.status(400).json({ error: 'occ.date required' });
    if (isEnd && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || (cls.once ? !cls.date : !(Array.isArray(cls.slots) && cls.slots.length))))
      return res.status(400).json({ error: 'cls + from required' });
    const gym = ((await sb(`gyms?id=eq.${q(b.gym_id)}&select=id,name,owner_id,stripe_account,currency,schedule`)) || [])[0];
    if (!gym) return res.status(404).json({ error: 'gym not found' });
    if (!(await canManage(gym, me))) return res.status(403).json({ error: 'forbidden' });

    const aff = isEnd ? await loadAffectedFrom(gym, cls, from) : await loadAffected(gym, occ);
    const endCid = (isEnd && !cls.once) ? cidOf(cls) : null;
    const holders = endCid ? await passHolders(gym.id, endCid, from) : [];

    if (b.action === 'preview' || b.action === 'end_preview') {
      return res.status(200).json({ ok: true,
        bookings: aff.bookings.map((x) => ({ id: x.id, kind: kindOf(x), student_id: x.student_id || null, child_name: x.child_name || null, name: x.child_name || x.student_name || x.guest_name || 'Student',
          has_account: !!x.student_id, amount: x.amount, currency: x.currency || gym.currency || 'CZK', method: x.payment_method || null,
          date: x.class_date || null, time: x.class_time || null })),
        members: aff.members.map((r) => ({ id: r.id, student_id: r.student_id || null, child_name: r.child_name || null, name: r.child_name || r.student_name || 'Člen', date: r.class_date || null, time: r.class_time || null })),
        passes: holders.map((m) => ({ id: m.id, name: m.child_name ? `${m.child_name} (${m.student_name || ''})` : (m.student_name || 'Člen'), plan: m.plan_name || null, period_end: m.period_end || null })) });
    }
    if (b.action !== 'cancel' && b.action !== 'end') return res.status(400).json({ error: 'unknown action' });
    // Náhradní lekce pro permanentky -- ověřit dřív, než se cokoli vyřídí.
    const xfer = { to: [], names: '' };
    if (b.action === 'end' && endCid && holders.length) {
      let arr = []; try { arr = typeof gym.schedule === 'string' ? JSON.parse(gym.schedule || '[]') : (gym.schedule || []); if (typeof arr === 'string') arr = JSON.parse(arr); } catch (e) { arr = []; }
      const today = new Date().toISOString().slice(0, 10);
      const live = (Array.isArray(arr) ? arr : []).filter((c) => c && !c.once && c.cid && c.cid !== endCid && !(c.until && c.until < today));
      const want = Array.isArray(b.transfer_to) ? b.transfer_to.map(String) : [];
      xfer.to = [...new Set(want.filter((x) => live.some((c) => c.cid === x)))];
      xfer.names = xfer.to.map((x) => String((live.find((c) => c.cid === x) || {}).name || '').trim()).filter(Boolean).join(', ');
      if (!xfer.to.length && live.length) return res.status(400).json({ error: 'Vyber lekce, na které permanentky nabídneš přesunout.' });
    }

    const ctx = {
      gym, me, choices: b.choices || {},
      mode: b.mode === 'forgot' ? 'forgot' : 'advance',
      note: String(b.note || '').trim().slice(0, 300),
      nowIso: new Date().toISOString(),
      myName: ((((await sb(`profiles?id=eq.${q(me)}&select=name`)) || [])[0]) || {}).name || null,
      // Ukončená opakovaná lekce: zpráva říká, že lekce končí (ne že „vypadl jeden termín").
      ended: b.action === 'end' && !cls.once,
    };
    const out = { refunded_card: [], bank_refund: [], moved: [], trials: [], unpaid: [], members: 0, errors: [] };

    if (b.action === 'cancel') {
      // Termín je zrušený (rozvrh ho ukáže jako zrušený, nejde na něj nic koupit).
      // Bez spoléhání na unikátní index (v databázi není -- upsert s on_conflict padal): najít
      // záznam termínu a přepsat, jinak založit.
      const cid = cidOf(occ);
      const f = `gym_id=eq.${q(gym.id)}&class_date=eq.${q(occ.date)}` + (cid ? legacyOr(cid, occ.time || '', occ.name || null) :
        (occ.time ? `&class_time=eq.${q(occ.time)}` : '&class_time=is.null') +
        (occ.name ? `&class_name=eq.${q(occ.name)}` : '&class_name=is.null'));
      const row = { gym_id: gym.id, class_date: occ.date, class_time: occ.time || null, class_name: occ.name || null, class_id: cid,
        coach_id: occ.coach || null, status: 'cancelled', reason: ctx.mode, logged_by: me };
      const ex = (await sb(`gym_class_log?${f}&select=id&limit=1`)) || [];
      if (ex[0]) await sb(`gym_class_log?id=eq.${q(ex[0].id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify(row) });
      else await sb('gym_class_log', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(row) });
      await settle(ctx, occ, aff, out);
      // ČLENOVÉ BEZ REZERVACE, na které se termín vztahuje (permanentka / členství pokrývá lekci):
      // appka je spočítá stejně jako docházku; server ověří, že mají u klubu běžící členství, a dá
      // jim vědět. Zpětné „neproběhla" nikoho neobtěžuje.
      if (ctx.mode !== 'forgot' && Array.isArray(b.covered) && b.covered.length) {
        const had = new Set(aff.members.concat(aff.bookings).map((r) => `${r.student_id || ''}|${r.child_name || ''}`));
        const want = [...new Map(b.covered.slice(0, 500).filter((c) => c && c.student_id).map((c) => [`${c.student_id}|${c.child_name || ''}`, c])).values()]
          .filter((c) => !had.has(`${c.student_id}|${c.child_name || ''}`));
        const ids = [...new Set(want.map((c) => String(c.student_id)))];
        const live = new Set();
        for (let i = 0; i < ids.length; i += 100) {
          const rows = (await sb(`gym_memberships?gym_id=eq.${q(gym.id)}&student_id=in.(${ids.slice(i, i + 100).map(q).join(',')})&status=in.(active,cancelling)&select=student_id`)) || [];
          rows.forEach((r) => live.add(String(r.student_id)));
        }
        const when = dCz(occ.date, occ.time), clsN = occ.name || 'lekce';
        const rCs = ctx.note ? ` Důvod: ${ctx.note}` : '', rEn = ctx.note ? ` Reason: ${ctx.note}` : '';
        const sent = new Set();
        out.covered = 0;
        for (const c of want) {
          if (!live.has(String(c.student_id)) || sent.has(String(c.student_id))) continue;
          sent.add(String(c.student_id));
          const kid = c.child_name ? ` (${String(c.child_name).slice(0, 80)})` : '';
          await notify(c.student_id,
            `🚫 ${gym.name} zrušil lekci ${clsN} (${when})${kid}.${rCs} Na ten termín nechoď — permanentka ani členství se tím nemění.`,
            `🚫 ${gym.name} cancelled ${clsN} (${when})${kid}.${rEn} Don't come for that class — your pass or membership is not affected.`,
            { choice: 'covered', gym_id: gym.id, gym_name: gym.name, class_name: clsN, class_id: occ.cid || null, class_date: occ.date, class_time: occ.time || '' });
          out.covered++;
        }
      }
    } else {
      // Ukončení: termíny zmizí z rozvrhu samy (appka zapíše `until` / jednorázovou smaže), takže
      // se nic nezapisuje do evidence lekcí -- jen se vyřeší přihlášení, termín po termínu.
      const keys = [...new Set(aff.bookings.concat(aff.resv).map((r) => `${r.class_date}|${String(r.class_time || '')}`))].sort();
      for (const k of keys) {
        const [d, t] = k.split('|');
        const o = { date: d, time: t, name: String(cls.name || '').trim() || null, cid: cidOf(cls) };
        const on = (r) => String(r.class_date) === d && String(r.class_time || '') === t;
        await settle(ctx, o, { bookings: aff.bookings.filter(on), resv: aff.resv.filter(on), members: aff.members.filter(on) }, out);
      }
      // Permanentky na tuhle lekci: nabídka přesunu na lekce, které klub vybral (jen běžící
      // opakované lekce téhož klubu), nebo rovnou vrácení, když náhrada není.
      if (endCid && holders.length)
        out.passes = await offerForEndedClass({ gym, cid: endCid, fromName: String(cls.name || '').trim() || 'lekce', fromYmd: from, toCids: xfer.to, toNames: xfer.names, note: ctx.note });
    }
    return res.status(200).json({ ok: true, result: out });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}

// Vyřeší každého přihlášeného na jeden termín: vrácení / přesun / uvolnění + notifikace s proklikem.
async function settle(ctx, occ, aff, out) {
  const { gym, me, choices, note, nowIso } = ctx;
  const { bookings, resv, members } = aff;
  const when = dCz(occ.date, occ.time);
  const cls = occ.name || 'lekce';
  const reasonCs = note ? ` Důvod: ${note}` : '';
  const reasonEn = note ? ` Reason: ${note}` : '';
  // Úvod zprávy: zrušený termín, nebo konec opakované lekce (od kterého data už nebude).
  const headCs = ctx.ended ? `🚫 ${gym.name} ukončil lekci ${cls} — termín ${when} už nebude.` : `🚫 ${gym.name} zrušil lekci ${cls} (${when}).`;
  const headEn = ctx.ended ? `🚫 ${gym.name} discontinued ${cls} — the ${when} class will not take place.` : `🚫 ${gym.name} cancelled ${cls} (${when}).`;

  for (const bk of bookings) {
    const k = kindOf(bk);
    const who = bk.child_name || bk.student_name || bk.guest_name || 'Student';
    const amt = Number(bk.amount || 0), cur = bk.currency || gym.currency || 'CZK';
    const money = `${amt} ${cur === 'CZK' ? 'Kč' : cur}`;
    const base = { gym_id: gym.id, gym_name: gym.name, booking_id: bk.id, class_name: cls, class_id: occ.cid || bk.class_id || null, class_date: occ.date, class_time: occ.time || '' };
    try {
      if (k === 'trial') {
        await sb(`gym_bookings?id=eq.${q(bk.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled', club_cancelled_at: nowIso }) });
        // Nárok zpět: záznam o využitém zkušebním se smaže (nepočítá se ani jako zrušení).
        const tr = (await sb(`gym_trials?gym_id=eq.${q(gym.id)}&student_id=eq.${q(bk.student_id)}&child_name=eq.${q(bk.child_name || '')}&class_date=eq.${q(occ.date)}&select=id&order=created_at.desc&limit=1`)) || [];
        if (tr[0]) await sb(`gym_trials?id=eq.${q(tr[0].id)}`, { method: 'DELETE', prefer: 'return=minimal' });
        out.trials.push(who);
        await notify(bk.student_id,
          `${headCs}${reasonCs} Tvůj zkušební trénink zdarma ti zůstává — rezervuj si jiný termín.`,
          `${headEn}${reasonEn} Your free trial class is still yours — book another time.`,
          Object.assign({ choice: 'trial' }, base));
      } else if (k === 'card') {
        // 100 % zpět automaticky, včetně provize MTL (chyba není na straně studenta).
        if (!stripe || !gym.stripe_account) throw new Error('stripe not configured');
        await stripe.refunds.create({ payment_intent: bk.payment_intent, refund_application_fee: await feeRefundableForPI(bk.payment_intent) }, { stripeAccount: gym.stripe_account });
        await sb(`gym_bookings?id=eq.${q(bk.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled', club_cancelled_at: nowIso, club_cancel_choice: 'refund' }) });
        out.refunded_card.push(`${who} · ${money}`);
        await notify(bk.student_id,
          `${headCs}${reasonCs} Vracíme ti celou platbu ${money} na kartu — na účtu bývá do 5–10 dnů.`,
          `${headEn}${reasonEn} We are refunding the full ${money} to your card — it usually arrives within 5–10 days.`,
          Object.assign({ choice: 'refund', amount: amt, currency: cur }, base));
        await confirmRow(bk, gym, me, ctx.myName, occ, amt, cur, note);
      } else if (k === 'bank') {
        const ch = choices[bk.id] === 'move' ? 'move' : 'refund';
        if (ch === 'move') {
          // Zůstává zaplacený; student si vybere jiný termín (bez limitu přesunů, i zpětně).
          await sb(`gym_bookings?id=eq.${q(bk.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ club_cancelled_at: nowIso, club_cancel_choice: 'move' }) });
          out.moved.push(`${who} · ${money}`);
          await notify(bk.student_id,
            `${headCs}${reasonCs} Zaplacený vstup ${money} ti zůstává — vyber si jiný termín, bez poplatku.`,
            `${headEn}${reasonEn} Your paid entry (${money}) stays — pick another time, free of charge.`,
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
            `${headCs}${reasonCs} Klub ti vrátí ${money} ${how}. Kdyby peníze do týdne nedorazily, napiš klubu.`,
            `${headEn}${reasonEn} The club will refund ${money} ${howEn}. If it has not arrived within a week, contact the club.`,
            Object.assign({ choice: 'refund', amount: amt, currency: cur }, base));
          await confirmRow(bk, gym, me, ctx.myName, occ, amt, cur, note);
        }
      } else {
        await sb(`gym_bookings?id=eq.${q(bk.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ status: 'cancelled', club_cancelled_at: nowIso }) });
        out.unpaid.push(who);
        await notify(bk.student_id,
          `${headCs}${reasonCs} Rezervace je zrušená, nic neplatíš.`,
          `${headEn}${reasonEn} Your booking is cancelled, there is nothing to pay.`,
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
      `${headCs}${reasonCs} Tvoje rezervace se uvolnila, členství se tím nemění.`,
      `${headEn}${reasonEn} Your reservation was released; your membership is not affected.`,
      { choice: 'member', gym_id: gym.id, gym_name: gym.name, class_name: cls, class_id: occ.cid || null, class_date: occ.date, class_time: occ.time || '' });
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
