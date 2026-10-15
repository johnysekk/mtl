// /api/stripe-webhook.js — Stripe webhook (záchranná síť, ať neunikne žádná platba)
// Vyžaduje env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Nastavení ve Stripe Dashboard → Developers → Webhooks → Add endpoint:
//   URL: https://app.muaythailab.co/api/stripe-webhook
//   Events: checkout.session.completed, charge.refunded, charge.dispute.created
//   Signing secret → ulož do env STRIPE_WEBHOOK_SECRET
//
// DŮLEŽITÉ: webhook musí číst RAW body (proto bodyParser:false), jinak selže ověření podpisu.

import { issueReceipts, receiptMail, receiptTitle, docNo } from './_receipt.js';
import Stripe from 'stripe';
import { subMail } from './_sub-mail.js';
import { rerateOwner } from './gym-rerate.js';
import { activatePartner, applyEpUpgrade, applyEpDowngrade } from './_ep.js';
import { ladderRate as _mtlLadder, hasOrgRate as _hasOrgRate, gymOnboardingUntil as _gymObUntil, onlineRate as _mtlOnline, withStoreFee, STORE_COST, epTierOf as _epTierOf } from './_rate.js';
import { sendOrderMailForPi, withdrawalText as _wdText } from './_order-mail.js';
import { dokladPdfFor } from './_doklad-pdf.js';
import crypto from 'crypto';
import { isTestMode } from './_config.js';
import { approveMemberAppOnPayment, cohortPayer } from './_member-app.js';
import { sellKind, sellLabel, sellKindFor } from './_sell-kind.js';
import { pragueMonth } from './_tz.js';
import { pragueEndOfDay } from './_memb-term.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// Adresa appky pro interní volání (ep-doklad). DŘÍV NEBYLA DEFINOVANÁ: `${APP_URL}` spadlo na
// ReferenceError, try/catch ho spolkl a faktura za EP ani za dodavatele nevznikla nikdy.
const APP_URL = (process.env.APP_URL || 'https://app.martialtraininglab.com').replace(/\/+$/, '');

// KOMU PATŘÍ FAKTURA ZA PŘEDPLATNÉ NA ÚČTU MTL (EP, profil dodavatele). Dřív se hledalo podle
// profiles.partner_sub / organizations.supplier_sub -- jenže ty zapisuje checkout.session.completed
// a Stripe posílá první invoice.paid často DŘÍV. Pak se vlastník nenašel a faktura za první
// měsíc nevznikla vůbec. Metadata nese už samo předplatné (subscription_data.metadata v pay.js),
// takže se bere odtud; DB je jen záloha pro starší předplatná bez metadat.
// Id předplatného: v novějších verzích API Stripe přesunul z invoice.subscription do parent.
function _invSubId(inv) {
  const pick = (x) => (typeof x === 'string' ? x : (x && x.id) || null);
  const line = (inv.lines && inv.lines.data && inv.lines.data[0]) || {};
  return pick(inv.subscription)
    || pick(inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription)
    || pick(line.subscription)
    || pick(line.parent && line.parent.subscription_item_details && line.parent.subscription_item_details.subscription);
}
async function _platformSubOwner(inv) {
  const subId = _invSubId(inv); if (!subId) return null;
  let md = (inv.subscription_details && inv.subscription_details.metadata)
        || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.metadata) || {};
  if (!md.mtl_payment_type) { try { md = (await stripe.subscriptions.retrieve(subId)).metadata || {}; } catch (e) { md = {}; } }
  if (md.mtl_payment_type === 'partner_sub' && md.user_id) return { uid: md.user_id, org: null, billGym: md.ep_bill_gym || null, md, subId };
  if (md.mtl_payment_type === 'supplier_sub' && md.org_id) {
    let uid = md.user_id || null;
    if (!uid) { const o = await sbGet(`organizations?id=eq.${encodeURIComponent(md.org_id)}&select=owner_id&limit=1`); uid = o && o[0] && o[0].owner_id; }
    return uid ? { uid, org: md.org_id } : null;
  }
  if (md.mtl_payment_type) return null;                     // jiné předplatné na účtu MTL
  const w = await sbGet(`profiles?partner_sub=eq.${encodeURIComponent(subId)}&select=id&limit=1`);
  if (w && w[0]) return { uid: w[0].id, org: null, md, subId };
  const so = await sbGet(`organizations?supplier_sub=eq.${encodeURIComponent(subId)}&select=id,owner_id&limit=1`);
  return (so && so[0]) ? { uid: so[0].owner_id, org: so[0].id } : null;
}
// ep-doklad volá webhook interně; neúspěch musí být v logu, ne potichu ztracený doklad.
async function _callEpDoklad(body) {
  const r = await fetch(`${APP_URL}/api/ep-doklad`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ intSecret: process.env.PIS_INTERNAL_SECRET }, body)) });
  if (!r.ok) console.error('ep-doklad', r.status, (await r.text()).slice(0, 300));
}
export const config = { api: { bodyParser: false } };

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

// ── FAKTURAČNÍ ADRESA ────────────────────────────────────────────────────────────────────
// Pravda je v rozpadu billing_line1/line2/city/postal (potřebuje ho DAC7). Jednořádkový
// tvar je jen pro zobrazení na dokladu, takže se SKLÁDÁ při čtení, ne ukládá zvlášť --
// dvě kopie téže adresy se vždy rozejdou.
// Prefix pokrývá druhou fakturační identitu kouče (payout_).
function _billAddr(row, prefix) {
  try {
    if (!row) return null;
    const p = prefix || '';
    const g = (k) => {
      const v = row[p + k];
      return (v == null) ? '' : String(v).trim();
    };
    const l1 = g('billing_line1'), l2 = g('billing_line2');
    const city = g('billing_city'), zip = g('billing_postal');
    const parts = [l1, l2, ((zip ? zip + ' ' : '') + city).trim()]
      .filter((x) => x && x.trim());
    if (parts.length) return parts.join(', ');
    // Záloha pro řádky z doby před rozpadem, kde je jen složený tvar.
    const legacy = g('billing_address');
    return legacy || null;
  } catch (e) { return null; }
}

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: sbHeaders });
  return r.ok ? r.json() : [];
}
async function sbPost(table, row) {
  const r = await fetch(`${SB}/rest/v1/${table}`, { method: 'POST', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) { const t = await r.text().catch(() => ''); console.error('sbPost', table, r.status, t); return { ok: false, status: r.status, error: t }; }
  return { ok: true, status: r.status };
}
async function sbPatch(table, filter, patch, prefer) {
  // `prefer` is optional and defaults to the original behaviour, so every existing caller is
  // unchanged. Pass 'return=representation' to get the affected rows back - needed to know
  // whether THIS call was the one that flipped a row (idempotent credit consumption).
  const r = await fetch(`${SB}/rest/v1/${table}?${filter}`, { method: 'PATCH', headers: { ...sbHeaders, Prefer: prefer || 'return=minimal' }, body: JSON.stringify(patch) });
  if (!r.ok) { const t = await r.text().catch(() => ''); console.error('sbPatch', table, r.status, t); return { ok: false, status: r.status, error: t }; }
  if (prefer === 'return=representation') { try { return await r.json(); } catch (e) { return []; } }
  return { ok: true, status: r.status };
}

// Resend confirmation email (best-effort; never blocks the webhook). Mirrors invite-members.js.
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';
const MAIL_ADDR = (MAIL_FROM.match(/<([^>]+)>/) || [])[1] || 'no-reply@martialtraininglab.com';
function _esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
export async function sendResend(to, subject, html, opts) {
  if (!RESEND || !to) return;
  try {
    const body = { from: (opts && opts.from) || MAIL_FROM, to: [to], subject, html };
    if (opts && opts.replyTo) body.reply_to = opts.replyTo;
    if (opts && opts.attachments && opts.attachments.length) body.attachments = opts.attachments;
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error('resend', r.status, await r.text().catch(() => ''));
  } catch (e) { console.error('resend', e.message); }
}
function _czDate(iso){ try{ const m=String(iso||'').match(/^(\d{4})-(\d{2})-(\d{2})/); if(!m) return String(iso||''); return parseInt(m[3],10)+'. '+parseInt(m[2],10)+'. '+m[1]; }catch(e){ return String(iso||''); } }
export function cohortDepositHtml(name, courseName, gymName, depositTxt, remainderTxt, startTxt, _appUrl, nonprofit) {
  // Czech has vocative declension ('Petr' -> 'Petře'); getting it wrong reads worse than omitting,
  // so we greet without the name. (name kept in the signature for callers / future localisation.)
  const hi = 'Ahoj,';
  return `<!doctype html><html><body style="margin:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#171717;">
  <div style="max-width:480px;margin:0 auto;padding:28px 22px;">
    <div style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#E11;margin-bottom:4px;">MARTIAL TRAINING LAB</div>
    <div style="font-size:12px;color:#888;margin-bottom:22px;">Be More.</div>
    <p style="font-size:15px;line-height:1.6;">${hi}</p>
    <p style="font-size:15px;line-height:1.6;">Tvoje místo v kurzu <b>${_esc(courseName)}</b>${gymName ? (' u <b>' + _esc(gymName) + '</b>') : ''} je rezervované — zálohu <b>${_esc(depositTxt)}</b> máme. 🥊</p>
    ${startTxt ? `<p style="font-size:14px;line-height:1.6;">Začátek: <b>${_esc(_czDate(startTxt))}</b></p>` : ''}
    ${remainderTxt ? `<p style="font-size:14px;line-height:1.6;color:#555;">Zbytek 1. měsíce (<b>${_esc(remainderTxt)}</b>) doplatíš na místě přímo v klubu (kartou, QR nebo hotově — dle klubu).</p>` : ''}
    <p style="font-size:13px;line-height:1.6;color:#555;margin-top:18px;">Těšíme se na tebe na tréninku! S dotazy ke kurzu se obrať přímo na svůj klub.</p>
    <div style="background:#fff;border-radius:10px;padding:12px 14px;font-size:12.5px;line-height:1.55;color:#444;margin-top:14px;"><b>Potvrzení objednávky</b><br>Poskytovatel služby: ${gymName ? ('<b>' + _esc(gymName) + '</b>') : 'klub'}, jeho údaje najdeš na přiloženém dokladu. MTL platbu jen zprostředkovává.<br><br>${nonprofit
      ? ('<b>Zrušení a vrácení:</b> Zrušení a případné vrácení platby se řídí podmínkami poskytovatele.')
      : ('<b>Odstoupení od smlouvy:</b> ' + _esc(_wdText('dated', false)))}</div>
    <p style="font-size:12px;color:#aaa;line-height:1.6;margin-top:24px;">Tenhle e-mail ti přišel, protože ses přihlásil/a do kurzu${gymName ? (' u ' + _esc(gymName)) : ''}.</p>
  </div></body></html>`;
}

// MTL Ambassador 0,5% — pošle 0,5 % základu ambassadorovi dané disciplíny (z provize MTL).
// Aktivuje se, jakmile existuje ambassador (profil s verify_disciplines + stripe_account).
// MTL Ambassador 0,5 % z GYM skupinových lekcí (z čisté provize MTL — gym nese Stripe fee).
// Gym jede direct charge na účtu gymu; application_fee MTL končí na platform balance,
// odkud pošleme 0,5 % základu ambassadorovi dané disciplíny (transfer mezi účty = bez Stripe fee).
// Vyžaduje: webhook nasazený + naslouchání Connect eventům (event.account je u gym plateb).
async function payGymAmbassador(discCsv, base, currency, idemKey, pi) {
  try {
    if (!base || base <= 0) return;
    const discs = (discCsv || '').split(',').filter(Boolean);
    if (!discs.length) return;
    const ambs = await sbGet(`profiles?select=id,stripe_account,verify_disciplines`);
    const amb = (ambs || []).find(a => a.stripe_account && (() => {
      try { const v = a.verify_disciplines ? (typeof a.verify_disciplines === 'string' ? JSON.parse(a.verify_disciplines) : a.verify_disciplines) : []; return Array.isArray(v) && v.some(x => discs.includes(x)); } catch (e) { return false; }
    })());
    if (!amb) return;
    const cut = Math.round(base * 0.005 * 100); // 0,5 % základu v minor units
    if (cut > 0) await stripe.transfers.create(
      { amount: cut, currency: (currency || 'czk').toLowerCase(), destination: amb.stripe_account, description: 'MTL Ambassador 0.5% (gym)', ...(pi ? { transfer_group: pi } : {}), metadata: { mtl_kind: 'ambassador', ...(pi ? { mtl_pi: pi } : {}) } },
      idemKey ? { idempotencyKey: 'gymamb_' + idemKey } : undefined
    );
  } catch (e) { console.error('payGymAmbassador', e); }
}
async function payAmbassador(coachId, amount, currency, disc, idemKey) {
  try {
    if (!coachId || !amount || amount <= 0) return;
    let discs = [];
    if (disc) { discs = [disc]; }
    else {
      const cps = await sbGet(`profiles?id=eq.${encodeURIComponent(coachId)}&select=disciplines`);
      try { const cp = cps[0]; discs = cp && cp.disciplines ? (typeof cp.disciplines === 'string' ? JSON.parse(cp.disciplines) : cp.disciplines) : []; } catch (e) {}
      // jen pokud má kouč JEDINOU disciplínu (jinak neznáme atribuci)
      if (Array.isArray(discs) && discs.length > 1) return;
    }
    if (!Array.isArray(discs) || !discs.length) return;
    // NOTE: při škále filtrovat na straně DB; zatím prosté načtení profilů.
    const ambs = await sbGet(`profiles?select=id,stripe_account,verify_disciplines`);
    const amb = (ambs || []).find(a => a.id !== coachId && a.stripe_account && (() => {
      try { const v = a.verify_disciplines ? (typeof a.verify_disciplines === 'string' ? JSON.parse(a.verify_disciplines) : a.verify_disciplines) : []; return Array.isArray(v) && v.some(x => discs.includes(x)); } catch (e) { return false; }
    })());
    if (!amb) return;
    const cut = Math.round(amount * 0.005 * 100); // 0,5 % základu v minor units
    if (cut > 0) await stripe.transfers.create({ amount: cut, currency: (currency || 'CZK').toLowerCase(), destination: amb.stripe_account, description: 'MTL Ambassador 0.5%', ...(idemKey ? { transfer_group: idemKey } : {}), metadata: { mtl_kind: 'ambassador', ...(idemKey ? { mtl_pi: idemKey } : {}) } }, idemKey ? { idempotencyKey: 'amb_' + idemKey } : undefined);
  } catch (e) { console.error('payAmbassador', e); }
}

// CLAWBACK: when MTL refunds its own commission, reverse the ambassador's 0.5% proportionally.
// Finds the ambassador transfer by transfer_group = payment_intent (set at payout) and reverses
// (transfer.amount * fraction) minus whatever was already reversed (idempotent for partial->full).
async function clawbackAmbassador(pi, fraction) {
  try {
    if (!pi || !(fraction > 0)) return;
    let list;
    try { list = await stripe.transfers.list({ transfer_group: pi, limit: 20 }); } catch (e) { console.error('amb list', e.message); return; }
    for (const tr of (list && list.data) || []) {
      if (!(tr.metadata && tr.metadata.mtl_kind === 'ambassador')) continue;
      const target = Math.round((tr.amount || 0) * Math.min(1, fraction));
      const toReverse = target - (tr.amount_reversed || 0);
      if (toReverse > 0) {
        try { await stripe.transfers.createReversal(tr.id, { amount: toReverse, description: 'MTL Ambassador clawback (refund)', metadata: { mtl_clawback: '1', mtl_pi: pi } }); } catch (e) { console.error('amb reversal', e.message); }
      }
    }
  } catch (e) { console.error('clawbackAmbassador', e); }
}

// Přepíše application_fee_percent na VŠECH aktivních membership subscriptions
// gymů vlastněných daným uživatelem (Partner: 4 %, jinak 5 %). Aplikuje se na
// BUDOUCÍ faktury; minulé zůstávají. Nemění, co platí člen — jen MTL cut.
function rawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

// ── Event ticket email (Resend). Needs env: RESEND_API_KEY, optional TICKET_EMAIL_FROM, APP_URL ──
async function sendTicketEmail(s, m) {
  const key = process.env.RESEND_API_KEY; if (!key) return;
  const email = (s.customer_details && s.customer_details.email) || s.customer_email; if (!email) return;
  const qtok = m.qr_token || ''; const evId = m.mtl_event_id || ''; if (!qtok || !evId) return;
  const origin = APP_URL;
  const checkinUrl = `${origin}/?evcheckin=1&ev=${encodeURIComponent(evId)}&tok=${encodeURIComponent(qtok)}`;
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=${encodeURIComponent(checkinUrl)}`;
  const title = m.mtl_event || 'your event';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#111;">`
    + `<h2 style="margin:0 0 6px;">\uD83C\uDF9F\uFE0F ${title}</h2>`
    + `<p style="color:#444;">Your ticket is confirmed. Show this QR code at the door:</p>`
    + `<p style="text-align:center;margin:18px 0;"><img src="${qrImg}" width="240" height="240" alt="Ticket QR" style="border:1px solid #eee;border-radius:12px;"></p>`
    + `<p style="text-align:center;color:#888;font-size:13px;">You can also open your ticket anytime in the Martial Training Lab app under My events.</p>`
    + `<p style="text-align:center;"><a href="${origin}" style="color:#E8001D;font-weight:bold;text-decoration:none;">Open Martial Training Lab \u2192</a></p></div>`;
  const from = process.env.TICKET_EMAIL_FROM || process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';
  await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: email, subject: `\uD83C\uDF9F\uFE0F Your ticket \u2014 ${title}`, html }) });
}

// Records ONE row per Stripe payment into the transactions ledger, with EXACT fees from the charge's balance_transaction.
// Resolve a connected Stripe account to the ENTITY that owns the money (and therefore owns
// Without this, transactions written by Stripe carry no payee_id at all.
const _payeeCache = {};
async function resolvePayee(acct) {
  if (!acct) return { id: null, kind: null };
  if (_payeeCache[acct] !== undefined) return _payeeCache[acct];
  let out = { id: null, kind: null };
  try {
    const a = encodeURIComponent(String(acct).trim());
    const p = (await sbGet(`profiles?or=(stripe_account.eq.${a},gym_payout_account.eq.${a})&select=id&limit=1`))[0];
    if (p && p.id) out = { id: p.id, kind: 'profile' };
    else {
      const g = (await sbGet(`gyms?stripe_account=eq.${a}&select=id&limit=1`))[0];   // gyms has no gym_payout_account
      if (g && g.id) out = { id: g.id, kind: 'gym' };
    }
  } catch (e) { console.error('resolvePayee', e.message); }
  _payeeCache[acct] = out;
  return out;
}

// ---------------------------------------------------------------------------
// THE ONE RULE for what application_fee_percent a membership subscription carries.
//
// This field was being set from THREE places that knew nothing about each other:
//   * pay.js at creation        -> acquisition 20% (10% EP, first month only) / ladder
//   * cron-attendance at renewal -> ALWAYS base, which silently threw
//     away an acquisition window that was still running
//   * gym-rerate when the owner crossed a tier -> ALWAYS the ladder rate, which blew away
//     open acquisition window (MTL losing its own finder's fee)
// and nothing at all ever ended an acquisition window, so an MTL-sourced membership was
// billed 10% forever. mtl_acq had one writer and zero readers.
//
// PRECEDENCE: acquisition (20 / 10 EP, first month only) beats the provider's ladder rate.
// Welcome wins because it is a promise made to the provider; when it ends, the sub lands
// on whatever is correct AT THAT MOMENT (still inside the 2 months -> acquisition; else ladder).
//
// Returns null when it cannot decide (Stripe call failed) -> the caller must CHANGE NOTHING.
// Never guess with someone's money.
async function subRateFor(stripe, acct, subId, sub, ladderPct) {
  // ODSTRANENO: `if (welcomeActive) return 0;`. Uvitaci okno bylo zruseno -- pri zakladu 2 %
  // na Stripe a 2,5 % na bance uz neni co zlevnovat, a to okno stalo za vic kodu na penezni
  // ceste nez samotny zebricek. Zbyva precedence: akvizice > zebricek.
  const md = (sub && sub.metadata) || {};
  if (md.mtl_acq === '1') {
    const pct = parseFloat(md.mtl_acq_pct || '0') || 0;
    if (pct > 0) {
      let paid;
      try {
        const invs = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 3 }, { stripeAccount: acct });
        paid = ((invs && invs.data) || []).length;
      } catch (e) { return null; }            // cannot count -> do not touch the rate
      // CHANGED: was `paid < 2` -- the acquisition rate rode the first TWO paid invoices.
      // Acquisition is now a single 20% (10% EP) charge on the first month only, so it comes
      // off after one. The rule lives in _rate.js; this is the subscription mirror of it.
      if (paid < 1) return pct;               // first month only -> the acquisition rate
    }
  }
  return ladderPct;
}

// Apply it. Returns true if the rate actually changed.
async function applySubRate(stripe, acct, subId, sub, ladderPct) {
  // Online předplatné koupené v nativní appce nese i poplatek obchodu (mtl_native, _rate.js).
  ladderPct = withStoreFee(ladderPct, sub);
  const want = await subRateFor(stripe, acct, subId, sub, ladderPct);
  if (want === null) return false;                                  // undecidable -> leave alone
  const cur = (sub.application_fee_percent != null) ? Number(sub.application_fee_percent) : null;
  if (cur === want) return false;
  const md = Object.assign({}, (sub && sub.metadata) || {});
  if (md.mtl_acq === '1' && want !== 0 && want === ladderPct) md.mtl_acq = 'done';   // window closed
  await stripe.subscriptions.update(subId, { application_fee_percent: want, metadata: md }, { stripeAccount: acct });
  return true;
}

// Zástupce zaplatil za mladistvého -> mladistvý se to musí dozvědět. Na QR koleji mu to
// říká klient hned po potvrzení platby; na Stripe koleji se platí mimo appku, takže tady
// je jediné místo, kde se to dá spolehlivě poslat.
async function notifyPaidForMinor(m, item, amount, currency) {
  try {
    const forWhom = m && m.student_id, payer = m && m.paid_by;
    if (!forWhom || !payer || forWhom === payer) return;
    const who = (m.paid_by_name || '').trim();
    const price = (Number(amount) || 0) + ' ' + String(currency || 'CZK').toUpperCase();
    await sbPost('notifications', {
      user_id: forWhom, type: 'system', read: false,
      data: JSON.stringify({ kind: 'paid_for_you', item: item || '', amount: amount, currency: currency,
        msg_en: '\u2705 ' + (who ? (who + ' paid for you') : 'Your guardian paid for you') + ': ' + (item || 'training') + ' \u00B7 ' + price + '. The booking is confirmed.' }),
      message: '\u2705 ' + (who ? (who + ' za tebe zaplatil') : 'Z\u00E1stupce za tebe zaplatil')
             + ': ' + (item || 'tr\u00E9nink') + ' \u00B7 ' + price + '. Rezervace plat\u00ED.',
    });
  } catch (e) { console.error('notifyPaidForMinor', e.message); }
}

// JEDINY zapis Stripe transakce. Vola ho webhook i /api/session (zaloha pri navratu studenta).
// Session mela driv vlastni chudsi kopii, takze podle toho, kdo vyhral, v transakci chybely
// dropin_plan_id, proof_checked, platce, payee, acq_months nebo disciplina.
// PŮVOD ČLENA Z METADAT. pay.js posílá jen příznak mtl_acq='1' (ne název zdroje), zatímco
// sloupec transactions.acq_source a _rate.js pracují s hodnotou 'mtl_discovery' -- kdyby se
// uložila jednička, kontrola „akvizice jen za první platbu" by ji nepoznala.
function _acqSrcFrom(m) {
  try {
    if (!m) return null;
    // Reklamní zdroj se musí přenést, ne sloučit s organickým objevem -- jinak by nešlo
    // doložit, že za ten příchod MTL zaplatilo.
    if (String(m.acq || '') === 'mtl_ads' || String(m.acq_source || '') === 'mtl_ads') return 'mtl_ads';
    if (String(m.mtl_acq || '') === '1') return 'mtl_discovery';
    if (String(m.acq || '') === 'mtl_discovery') return 'mtl_discovery';
    if (String(m.acq_source || '') === 'mtl_discovery') return 'mtl_discovery';
  } catch (e) {}
  return null;
}
export async function recordTransaction(acct, pi, fields) {
  if (!pi) return { status: 'no-pi' };
  try {
    const ex = await sbGet(`transactions?payment_intent=eq.${encodeURIComponent(pi)}&select=id,gross_amount`);
    const _existing = (ex && ex.length) ? ex[0] : null;
    if (_existing && _existing.gross_amount != null) {
      // Transakci už zapsal někdo jiný (návrat ze Stripe, nebo invoice.paid u první platby
      // předplatného). Potvrzení objednávky je idempotentní -- pošle se, pokud ještě neodešlo.
      if (!fields.renewal && !fields.noOrderMail) { try { await sendOrderMailForPi(pi); } catch (e) {} }
      return { status: 'exists', gross: _existing.gross_amount };
    }
    let gross = fields.gross != null ? fields.gross : null, stripeFee = null, mtlFee = null, net = null, currency = fields.currency || null, chargeId = null;
    // Nákup v nativní appce: část application fee je náklad obchodu (_rate.js STORE_COST). Pozná se
    // z metadat platby (jednorázově) nebo ho předá volající (předplatné -- metadata má subscription).
    let _native = fields.native === true;
    if (acct) {
      try {
        let ch = null;
        if (String(pi).startsWith('ch_')) {
          ch = await stripe.charges.retrieve(pi, { expand: ['balance_transaction'] }, { stripeAccount: acct });
        } else {
          const intent = await stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge.balance_transaction'] }, { stripeAccount: acct });
          if (intent && intent.metadata && intent.metadata.mtl_native === '1') _native = true;
          ch = intent && intent.latest_charge;
          if (typeof ch === 'string') ch = await stripe.charges.retrieve(ch, { expand: ['balance_transaction'] }, { stripeAccount: acct });
        }
        if (ch && typeof ch === 'object') {
          chargeId = ch.id; currency = ch.currency;
          let bt = ch.balance_transaction;
          if (typeof bt === 'string') { try { bt = await stripe.balanceTransactions.retrieve(bt, { stripeAccount: acct }); } catch (e) {} }
          if (bt && typeof bt === 'object') {
            // Direct charges: bt.fee is COMBINED (Stripe + application fee); bt.net already nets both.
            // Split via fee_details; net = bt.net (no extra subtraction of the app fee).
            let sFee = 0, aFee = 0;
            if (Array.isArray(bt.fee_details)) {
              for (const fd of bt.fee_details) {
                if (fd.type === 'stripe_fee') sFee += fd.amount;
                else if (fd.type === 'application_fee') aFee += fd.amount;
              }
            }
            if (sFee === 0 && aFee === 0) { aFee = ch.application_fee_amount || 0; sFee = (bt.fee || 0) - aFee; }

            // A balance transaction is in the account's SETTLEMENT currency, not the currency the
            // student actually paid in. A EUR charge on a CZK-settled Stripe account comes back as
            // bt.currency='czk' with bt.amount already converted — so blindly taking bt.currency
            // recorded a EUR club's income as Kc, and the dashboards then showed "41 827 Kc" for
            // money that was charged in EUR. Keep the PRESENTMENT figures (what the club priced and
            // the student paid); convert the fees back with bt.exchange_rate when Stripe converted.
            const _settled = String(bt.currency || '').toLowerCase();
            const _charged = String(ch.currency || '').toLowerCase();
            if (_settled && _charged && _settled !== _charged) {
              const rate = Number(bt.exchange_rate) || 0;                 // presentment -> settlement
              const back = (v) => (rate > 0 ? Math.round((Number(v) || 0) / rate) : 0);
              currency = ch.currency;
              gross = ch.amount;
              aFee = ch.application_fee_amount != null ? ch.application_fee_amount : back(aFee);
              sFee = back(sFee);
              net = gross - aFee - sFee;
            } else {
              currency = bt.currency || currency;
              gross = bt.amount;
              net = bt.net;
            }
            stripeFee = sFee; mtlFee = aFee;
          } else {
            gross = ch.amount; mtlFee = ch.application_fee_amount || 0; net = gross - mtlFee;
          }
        }
      } catch (e) { console.error('recordTransaction fee', e.message); }
    }
    // ROZDĚLENÍ APPLICATION FEE u nativního nákupu: store_fee = náklad obchodu (12,1 % z toho, co
    // student zaplatil), zbytek je provize MTL. mtl_rate je pak sazba PROVIZE ze základu po odečtení
    // nákladu obchodu -- stejná jako na webu, takže na dokladu sedí do stejného řádku.
    const storeFee = (_native && gross > 0 && mtlFee > 0) ? Math.min(mtlFee, Math.round(gross * STORE_COST)) : 0;
    const _commBase = (gross || 0) - storeFee;
    const mtlRate = (_commBase > 0 && (mtlFee - storeFee) > 0) ? Math.round(((mtlFee - storeFee) / _commBase) * 10000) / 10000 : 0;
    if (_existing) {
      // Radek bez penez (ulozeny driv, kdyz Stripe data nevydal): doplnit castky, nic jineho neprepisovat.
      if (gross == null) return { status: 'no-charge-data', payId: pi };
      await sbPatch('transactions', `payment_intent=eq.${encodeURIComponent(pi)}`, { charge_id: chargeId, gross_amount: gross, stripe_fee: stripeFee, mtl_fee: mtlFee, net_amount: net, currency, ...(storeFee > 0 ? { store_fee: storeFee, mtl_rate: mtlRate } : {}) });
      const _dnU = await issueStripeDokladForPi(pi, { slotId: fields.slot_id || null });
      return { status: 'updated', gross, stripeFee, mtlFee, net, dokladNo: _dnU };
    }
    const _payee = await resolvePayee(acct);
    // Okno nového klubu (14 dní): přidaní v tu dobu jsou klubu vlastní, ne přivedení MTL.
    try { if (fields.gym_id && (fields.acq_source === 'mtl_discovery' || fields.acq_source === 'mtl_ads') && await _gymObUntil(sbGet, fields.gym_id)) fields = Object.assign({}, fields, { acq_source: 'direct' }); } catch (e) {}
    const _txIns = await sbPost('transactions', {
      // PŮVOD ČLENA. Bez tohohle sloupce nezůstala u karetních plateb žádná stopa, proč se
      // účtovalo 20 % místo běžné sazby: účtovalo se správně, ale doložit to nešlo. Navíc se
      // podle něj kontroluje, že se akvizice vezme JEN ZA PRVNÍ platbu -- kontrola nad prázdným
      // sloupcem nemůže fungovat, takže se mohla naúčtovat víckrát.
      // Hotovostní cesta (record-cash.js) to zapisuje odjakživa, Stripe ne.
      acq_source: (fields.acq_source || null),
      payment_intent: pi, charge_id: chargeId, payee_account: acct || null, type: fields.type,
      payee_id: _payee.id, payee_kind: _payee.kind,
      member_id: fields.member_id || null, coach_id: fields.coach_id || null, gym_id: fields.gym_id || null, plan: fields.plan || null,
      discipline: fields.discipline || null,
      // Pojmenovana cena za vstup: prichazi z metadata (mtl_dropin_plan / mtl_need_proof).
      // proof_checked=false znamena "klub jeste musi videt doklad". Bez tohohle by sleva
      // pres Stripe zmizela beze stopy.
      dropin_plan_id: fields.dropin_plan_id || null,
      proof_checked: (fields.need_proof ? false : null),
      // Plátce zvlášť od účastníka -- stejná dvojice, jakou zapisuje record-cash.js.
      // Bez toho doklad neví, na koho má znít Odběratel a koho uvést jako Účastníka.
      paid_by: fields.paid_by || null, paid_by_name: fields.paid_by_name || null,
      gross_amount: gross, stripe_fee: stripeFee, mtl_fee: mtlFee, mtl_rate: mtlRate, mtl_fee_refunded: 0, net_amount: net, currency,
      ...(storeFee > 0 ? { store_fee: storeFee } : {}),
      ...(fields.acq_months != null ? { acq_months: fields.acq_months } : {}),
      ...(fields.base_rate != null ? { base_rate: fields.base_rate } : {}),
      income_class: fields.income_class || null,
      // Kolik mesicu platba pokryla. Pise se jen kdyz to volajici vi, at se u vsech ostatnich
      // typu plateb nic nemeni a stary radek bez toho sloupce se cte jako jeden mesic.
      ...(fields.months != null ? { months: Math.max(1, parseInt(fields.months, 10) || 1) } : {}),
      cohort_id: fields.cohort_id || null,
      payment_method: 'stripe', commission_status: 'collected', commission_month: pragueMonth(),
      status: 'paid', created_at: new Date().toISOString(),
    });
    // INSERT neprosel = transakci mezitim zapsal /api/session a doklad vystavuje on. Druhe cislo
    // v rade by zustalo jako dira (vlozeni dokladu pak spadne na unikatnim transaction_id).
    if (_txIns && _txIns.ok === false) return { status: 'insert-failed', http: _txIns.status, dberror: _txIns.error };
    try { if (fields.member_id && gross != null) await ecoPurchase(fields.member_id, gross / 100, currency, pi,
      { type: fields.type || null, gymId: fields.gym_id || null, acqSource: fields.acq_source || null }); } catch (e) {}
    // Doklad jako SNIMEK hned po zapsani platby -- stejne jako u hotovosti. Vystavuje ho ten, komu
    // se povedl INSERT transakce (unikatni payment_intent pusti jen jednoho): webhook, nebo /api/session.
    const dokladNo = await issueStripeDokladForPi(pi, { slotId: fields.slot_id || null });
    // Potvrzení objednávky e-mailem (§ 1824 OZ) -- až po dokladu, bere z něj údaje prodávajícího.
    // Obnova předplatného (invoice.paid) není nová smlouva -- ta se nepotvrzuje.
    if (!fields.renewal && !fields.noOrderMail) { try { await sendOrderMailForPi(pi); } catch (e) { console.error('order mail', e.message); } }
    return { status: 'recorded', gross, stripeFee, mtlFee, net, dokladNo };
  } catch (e) { console.error('recordTransaction', e.message); return { status: 'error:' + e.message }; }
}


// Server-side Meta Purchase (CAPI) for a cohort deposit. Shares event_id cp_<member_id> with
// the browser Purchase pixel so Meta de-duplicates. Uses the cohort's OWN pixel + secret token.
async function cohortCapiPurchase(coh, cmId, email, amount, cur, fbp, fbc) {
  try {
    if (!coh || !coh.gym_meta_pixel || !coh.capi_token) return;
    const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
    const user_data = {};
    if (email) user_data.em = [sha(email)];
    if (fbp) user_data.fbp = fbp;
    if (fbc) user_data.fbc = fbc;
    const evt = {
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: 'cp_' + cmId,
      user_data,
      custom_data: { value: Number(amount || 0), currency: cur || 'CZK' }
    };
    const url = 'https://graph.facebook.com/v21.0/' + encodeURIComponent(coh.gym_meta_pixel) + '/events?access_token=' + encodeURIComponent(coh.capi_token);
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [evt] }) });
  } catch (e) { console.error('cohortCapiPurchase', e.message); }
}

// MTL Ecosystem Pixel — server-side Purchase for any customer transaction. Reads the founder's
// ecosystem pixel + token once, and the buyer's marketing consent + fbp/fbc from their profile.
// Consent-gated and no-ops cleanly until the pixel/token are configured in Admin -> MTL Ads.
let _ECO_CFG = null;
async function _ecoCfg() {
  if (_ECO_CFG) return _ECO_CFG;
  try {
    const rows = await sbGet('profiles?id=eq.'+encodeURIComponent((process.env.FOUNDER_UUID || '').trim())+'&select=mtl_eco_pixel,mtl_eco_capi_token');
    const f = rows && rows[0];
    _ECO_CFG = (f && f.mtl_eco_pixel && f.mtl_eco_capi_token) ? { pixel: f.mtl_eco_pixel, token: f.mtl_eco_capi_token } : { pixel: '', token: '' };
  } catch (e) { _ECO_CFG = { pixel: '', token: '' }; }
  return _ECO_CFG;
}
// OPTIMALIZACE NA ČLENSTVÍ. Meta hledá takové lidi, jaké události jí hlásíš. Když dostane
// jen „Purchase", natlačí ti levné jednorázové vstupy; členství je přitom pro klub i pro MTL
// mnohem cennější. Posílá se proto navíc událost 'Subscribe' s hodnotou -- na tu se pak
// kampaň optimalizuje. Druh nákupu jde i do custom_data, ať se dá filtrovat.
async function ecoPurchase(buyerId, amount, cur, pi, meta) {
  try {
    if (!buyerId || !amount) return;
    const cfg = await _ecoCfg();
    if (!cfg.pixel || !cfg.token) return;
    const rows = await sbGet('profiles?id=eq.' + encodeURIComponent(buyerId) + '&select=marketing_consent,email,fbp,fbc');
    const b = rows && rows[0];
    if (!b || !b.marketing_consent) return;
    const sha = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
    const user_data = {};
    if (b.email) user_data.em = [sha(b.email)];
    if (b.fbp) user_data.fbp = b.fbp;
    if (b.fbc) user_data.fbc = b.fbc;
    const evt = {
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: 'mtlpur_' + (pi || (buyerId + '_' + Date.now())),
      user_data,
      custom_data: {
        value: Number(amount || 0), currency: (cur || 'CZK'), content_type: 'customer',
        content_category: (meta && meta.type) || undefined,
        content_ids: (meta && meta.gymId) ? [String(meta.gymId)] : undefined,
        // Odkud ten člověk přišel. V Ads Manageru se podle toho dá poznat, co přinesla reklama.
        acq_source: (meta && meta.acqSource) || undefined,
      }
    };
    const url = 'https://graph.facebook.com/v21.0/' + encodeURIComponent(cfg.pixel) + '/events?access_token=' + encodeURIComponent(cfg.token);
    const batch = [evt];

    // U ČLENSTVÍ NAVÍC 'Subscribe'. Je to standardní událost Mety, takže na ni jde kampaň
    // rovnou optimalizovat; vlastní událost by se musela učit od nuly. Vlastní event_id, aby
    // se nesloučila s Purchase.
    if (meta && meta.type === 'membership') {
      batch.push({
        event_name: 'Subscribe',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_id: 'mtlsub_' + (pi || (buyerId + '_' + Date.now())),
        user_data,
        custom_data: {
          value: Number(amount || 0), currency: (cur || 'CZK'),
          content_ids: meta.gymId ? [String(meta.gymId)] : undefined,
          acq_source: meta.acqSource || undefined,
        },
      });
    }
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: batch }) });
  } catch (e) { console.error('ecoPurchase', e.message); }
}


// ── „ZAPLATIT HNED": CO SE DĚJE PO ÚHRADĚ ───────────────────────────────────────────────────
// Dřív webhook jen srovnal stav: řádky na collected, účet odblokovaný. Majitel se nedozvěděl
// nic -- upozornění „provize uhrazena" posílal jen commission-cron, a to jen u účtů, které
// měly ještě commission_failed_at; ten tady ale mažeme, takže se k nim cron už nedostal.

// Uvidí klub student? Stejné podmínky jako deck v appce (ensureGymsLoaded + canSell +
// _mtlPayReady). Když se změní tam, musí se změnit i tady.
function _gymMissing(g) {
  const miss = [];
  if (g.status !== 'approved') miss.push('approved');
  if (g.suspended) miss.push('suspended');
  if (g.deleted_at) miss.push('deleted');
  const mode = g.payment_mode || (g.stripe_account ? 'stripe' : ((g.receiver_id_value || g.receiver_name) ? 'qr_bank' : null));
  if (!mode) miss.push('paymode');
  else if (mode === 'stripe') { if (!g.stripe_account) miss.push('stripe'); else if (g.charges_enabled === false) miss.push('stripe_pending'); }
  else if (!g.receiver_id_value || !g.receiver_name) miss.push('iban');
  if (mode !== 'stripe' && g.commission_card_status !== 'active') miss.push('card');
  ['legal_name', 'tax_id', 'billing_line1', 'billing_city', 'billing_postal', 'billing_country']
    .forEach((f) => { if (!String(g[f] || '').trim()) miss.push(f); });
  if (!String(g.terms_text || '').trim()) miss.push('terms');
  else if (g.org_form === 'nonprofit' && !g.terms_file_url) miss.push('statutes');
  return miss;
}
const _MISS = {
  approved: ['schválení klubu', 'club approval'], suspended: ['zrušení pozastavení ze strany MTL', 'MTL lifting its suspension'],
  deleted: ['obnovení klubu', 'restoring the club'], paymode: ['výběr způsobu plateb', 'choosing a payment mode'],
  stripe: ['připojení Stripe', 'connecting Stripe'], stripe_pending: ['dokončení ověření u Stripe', 'finishing Stripe verification'],
  iban: ['IBAN a jméno majitele účtu', 'IBAN and account holder'], card: ['uloženou kartu ke stržení provize', 'a saved card for the commission charge'],
  legal_name: ['právní název', 'legal name'], tax_id: ['IČO', 'company ID'], billing_line1: ['fakturační adresu', 'billing address'],
  billing_city: ['město', 'city'], billing_postal: ['PSČ', 'postcode'], billing_country: ['zemi', 'country'],
  terms: ['provozní řád a pravidla klubu', 'club rules'], statutes: ['stanovy (u spolku povinné)', 'statutes (required for a non-profit)'],
};

async function _paynowNotify(m, s, settled) {
  const kind = m.owner_kind, id = String(m.owner_id);
  let ownerId = null, gym = null, name = '';
  if (kind === 'gym') {
    gym = ((await sbGet(`gyms?id=eq.${encodeURIComponent(id)}&select=*`)) || [])[0];
    if (!gym) return; ownerId = gym.owner_id; name = gym.name || '';
  } else if (kind === 'org') {
    const o = ((await sbGet(`organizations?id=eq.${encodeURIComponent(id)}&select=owner_id,name`)) || [])[0];
    if (!o) return; ownerId = o.owner_id; name = o.name || '';
  } else { ownerId = id; }
  if (!ownerId) return;
  const p = ((await sbGet(`profiles?id=eq.${encodeURIComponent(ownerId)}&select=lang`)) || [])[0];
  const en = !!(p && p.lang === 'en');

  const cur = String(m.currency || s.currency || 'czk').toUpperCase();
  const amt = (Number(s.amount_total || 0) / 100).toFixed(2);
  const money = (lg) => (lg === 'en' ? amt : amt.replace('.', ',')) + ' ' + (cur === 'CZK' && lg !== 'en' ? 'Kč' : cur);

  let vis = '', visEn = '';
  if (gym) {
    const miss = _gymMissing(gym);
    if (!miss.length) {
      vis = 'Klub je zase vidět v hledání a dá se u něj platit.';
      visEn = 'The club is visible in search again and students can pay.';
    } else {
      vis = 'V hledání se klub ukáže, až bude hotové: ' + miss.map((k) => (_MISS[k] || [k])[0]).join(', ') + '.';
      visEn = 'The club will show in search once this is done: ' + miss.map((k) => (_MISS[k] || [k, k])[1]).join(', ') + '.';
    }
  } else if (kind === 'coach') {
    vis = 'Tvůj profil je zase aktivní.'; visEn = 'Your profile is active again.';
  } else {
    vis = 'Organizace je zase aktivní.'; visEn = 'The organization is active again.';
  }
  const who = name ? (' (' + name + ')') : '';
  // Faktura už existovala jako neuhrazená -> říct, že je tím uhrazená, a prokliknout na ni.
  // Jinak faktura teprve vznikne (_paynowDoklad) a přijde e-mailem.
  const _st = Array.isArray(settled) ? settled : [];
  const _nos = _st.map((d) => (Array.isArray(d.line_items) ? d.line_items.map((x) => x.doc_no || ('MTL-' + x.ref)).join(', ') : '')).join(', ');
  const _rcs = _st.map((d) => docNo(d)).join(', ');
  const msg = `\u2705 Provize MTL uhrazena${who}: ${money('cs')}. ${vis} ` + (_st.length ? `Faktura ${_nos} je tím uhrazená — Doklad o uhrazené provizi MTL ${_rcs} ti přišel e-mailem.` : 'Faktura o provizi ti přijde e-mailem, jakmile bude vystavená.');
  const msgEn = `\u2705 MTL commission paid${who}: ${money('en')}. ${visEn} ` + (_st.length ? `Invoice ${_nos} is now paid — Receipt for paid MTL commission ${_rcs} was sent by e-mail.` : 'The commission invoice will arrive by e-mail once it is issued.');
  await sbPost('notifications', {
    user_id: ownerId, type: 'system', read: false,
    // S uhrazenou fakturou vede proklik rovnou na ni (doklad_unified + doklad_id).
    data: JSON.stringify({ kind: _st.length ? 'doklad_unified' : 'commission_cleared', doklad_id: _st.length ? _st[0].id : null,
      gym_id: kind === 'gym' ? id : null, coach_id: kind === 'coach' ? id : null,
      organization_id: kind === 'org' ? id : null, msg_cs: msg, msg_en: msgEn }),
    message: en ? msgEn : msg,
  });
}

// DOKLAD HNED, kde to jde. Doklad se vystavuje za UZAVŘENÉ období a jen když je v něm
// všechno stržené -- což úhrada právě zařídila. Proto se pro každý uzavřený měsíc v úhradě
// zavolá unified-doklad-cron hned, jen pro tenhle subjekt. Za běžící měsíc doklad přijde
// po jeho skončení jako vždy.
// V DENNÍM REŽIMU (testovací provoz nebo commission_daily) se nevolá: tam je období den a
// na den vzniká jediný doklad. Vystavit ho teď by vyřadilo ranní stržení téhož dne.
async function _paynowDoklad(m, rows, curM) {
  const pc = ((await sbGet('platform_config?id=eq.1&select=test_mode')) || [])[0];
  if (pc && pc.test_mode) return;
  for (const t of ['gyms', 'profiles', 'organizations']) {
    const d = await sbGet(`${t}?commission_daily=is.true&select=id&limit=1`);
    if (d && d.length) return;
  }
  const months = [...new Set(rows.map((r) => String(r.commission_month || '')).filter((x) => x && x < curM))];
  const only = ({ gym: 'gym', coach: 'coach', org: 'organization' })[m.owner_kind] + ':' + String(m.owner_id);
  const base = (process.env.APP_URL || 'https://app.martialtraininglab.com').replace(/\/+$/, '');
  const sec = process.env.CRON_SECRET || '';
  for (const mo of months.sort()) {
    await fetch(`${base}/api/unified-doklad-cron?month=${encodeURIComponent(mo)}&only=${encodeURIComponent(only)}`,
      { headers: sec ? { Authorization: 'Bearer ' + sec } : {} });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  let event;
  try {
    const buf = await rawBody(req);
    const sig = req.headers['stripe-signature'];
    // Dva endpointy (tvůj účet + connected/gym) = dva podpisové klíče. Zkus oba.
    const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_WEBHOOK_SECRET_CONNECT].filter(Boolean);
    let lastErr = null;
    for (const sec of secrets) {
      try { event = stripe.webhooks.constructEvent(buf, sig, sec); lastErr = null; break; }
      catch (e) { lastErr = e; }
    }
    if (!event) throw (lastErr || new Error('No webhook secret configured'));
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const m = s.metadata || {};

      // ── DOPLATEK NESTRŽENÉ PROVIZE („Zaplatit hned" z e-mailu) ───────────────────────
      // Řádky, které cron označil jako 'failed', se tímto považují za vybrané a odpočet do
      // pozastavení účtu se zruší. Doklad o provizi vystaví měsíční doklad-cron jako u
      // běžného stržení -- tady se jen srovná stav, aby se nestrhávalo podruhé.
      if (m.mtl_kind === 'commission_paynow' && m.owner_kind && m.owner_id) {
        try {
          const col = ({ gym: 'gym_id', coach: 'coach_id', org: 'organization_id' })[m.owner_kind];
          if (col) {
            const cur = String(m.currency || '').toLowerCase();
            // Stejný rozsah, jaký spočítala platební stránka (commission-pay-now): pending
            // i failed. V denním režimu cron řádky na 'failed' nepřepisuje, takže samotné
            // 'failed' by doplatek nespároval a provize by se strhla ještě jednou.
            const _curM = pragueMonth();
            const _flt = `${col}=eq.${encodeURIComponent(m.owner_id)}&commission_status=in.(pending,failed)` +
              `&commission_month=lte.${_curM}&payment_method=in.(cash,qr,pis)` +
              (cur ? `&currency=ilike.${encodeURIComponent(cur)}` : '');
            // Které měsíce se tímhle uhrazují -- kvůli okamžitému dokladu níž. Prázdný seznam
            // znamená opakované doručení webhooku: nic se nemění a nic se znovu neoznamuje.
            const _rows = (await sbGet(`transactions?${_flt}&select=commission_month`)) || [];
            await sbPatch('transactions', _flt,
              { commission_status: 'collected', commission_collected_at: new Date().toISOString() });
            // Faktury vystavené jako neuhrazené (stržení 6. dne neprošlo) se NEMĚNÍ -- k těm, které
            // tahle platba uhradila, se vystaví samostatné potvrzení o úhradě (_receipt.js).
            let _settled = [];
            // Platba zaplatila i měsíc, který ještě nemá fakturu -> úhradu uvede ta nová faktura
            // (vystaví ji _paynowDoklad níž) a doklad o úhradě se nevystavuje. Jinak jeden doklad.
            let _newMonth = false;
            try {
              for (const _m of [...new Set(_rows.map((r) => String(r.commission_month || '')).filter(Boolean))]) {
                const _iv = await sbGet(`commission_doklady?${col}=eq.${encodeURIComponent(m.owner_id)}&period_month=eq.${_m}&kind=eq.unified` + (cur ? `&currency=ilike.${encodeURIComponent(cur)}` : '') + '&select=id&limit=1');
                if (!(_iv && _iv.length)) { _newMonth = true; break; }
              }
            } catch (e) {}
            if (_rows.length && !_newMonth) {
              try {
                _settled = await issueReceipts(`${col}=eq.${encodeURIComponent(m.owner_id)}&kind=eq.unified` + (cur ? `&currency=ilike.${encodeURIComponent(cur)}` : ''), {
                  method: 'card_paynow', noNotify: true,   // zprávu pošle _paynowNotify (jedna za platbu)
                  mail: async (to, inv, r) => {
                    let en = false; try { const p = ((await sbGet(`profiles?id=eq.${encodeURIComponent(inv.owner_id || inv.coach_id)}&select=lang`)) || [])[0]; en = !!(p && p.lang === 'en'); } catch (e) {}
                    const _rm = await receiptMail(r, en, inv.kind);
                    await sendResend(to, `${receiptTitle(inv.kind, en)} ${docNo(r)}`, _rm.html, { attachments: _rm.attachments });
                  },
                });
              } catch (e) { console.error('[commission_paynow] receipt', e && e.message); }
            }
            const tbl = ({ gym: 'gyms', coach: 'profiles', org: 'organizations' })[m.owner_kind];
            await sbPatch(tbl, `id=eq.${encodeURIComponent(m.owner_id)}`,
              { commission_failed_at: null, commission_next_retry: null, account_suspended: false, cash_blocked: false });
            if (_rows.length) {
              try { await _paynowNotify(m, s, _settled); } catch (e) { console.error('[commission_paynow] notify', e && e.message); }
              try { await _paynowDoklad(m, _rows, _curM); } catch (e) { console.error('[commission_paynow] doklad', e && e.message); }
            }
          }
        } catch (e) { console.error('[commission_paynow]', e && e.message); }
        return res.status(200).json({ received: true });
      }

      // ---- Consume a referral credit, server-side, ONLY once the payment really succeeded ----
      // This used to happen in the browser after returning from Stripe: close the tab and the
      // credit was never consumed, so it could be redeemed again and again. pay.js verifies the
      // credit and passes the row id; here we burn it. Idempotent: the UPDATE is filtered on
      // consumed=false, so a webhook retry can never double-decrement.
      if (m.mtl_credit_row && m.mtl_credit_user) {
        try {
          const _upd = await sbPatch('referral_credits', `id=eq.${encodeURIComponent(m.mtl_credit_row)}&consumed=eq.false`, { consumed: true }, 'return=representation');
          if (Array.isArray(_upd) && _upd.length) {   // we were the one who flipped it -> decrement once
            const _p = await sbGet(`profiles?id=eq.${encodeURIComponent(m.mtl_credit_user)}&select=student_credits`);
            const _sc = (_p && _p[0]) ? Number(_p[0].student_credits || 0) : 0;
            await sbPatch('profiles', `id=eq.${encodeURIComponent(m.mtl_credit_user)}`, { student_credits: Math.max(0, _sc - 1) });
          }
        } catch (e) { console.error('consume credit', e.message); }
      }
      // jen lekce koučů (gym jede direct-charge na účet gymu, ne přes platformu)
      if (m.booking_type === 'inperson' || m.booking_type === 'online') {
        const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id);
        // IDEMPOTENCE: existuje už booking pro tento payment_intent?
        const existing = pi ? await sbGet(`bookings?payment_intent=eq.${encodeURIComponent(pi)}&select=id,coach_id,student_id`) : [];
        if (!existing.length) {
          const amount = parseInt(m.base_amount || '0', 10);
          const currency = m.booking_currency || 'CZK';
          if (m.booking_type === 'inperson' && m.slot_id) {
            const slots = await sbGet(`slots?id=eq.${encodeURIComponent(m.slot_id)}&select=*`);
            const slot = slots[0];
            if (slot) {
              await sbPatch('slots', `id=eq.${encodeURIComponent(m.slot_id)}`, { booked: true, student: m.student_id || null });
              await sbPost('bookings', {
                slot_id: slot.id, student_id: m.student_id || null, coach_id: slot.coach_profile_id,
                coach_name: m.coach_name || 'Kouč', payment_intent: pi, amount,
                training_date: slot.date, training_time: slot.time,
                status: 'active', type: 'inperson', currency, discipline: m.discipline || null,
                student_name: m.student_name || null,
                paid_by: m.paid_by || null, paid_by_name: m.paid_by_name || null,
                minor_booking: !!(m.paid_by && m.student_id && m.paid_by !== m.student_id),
              });
              // ODSTRANENO: druha notifikace kouci o te same rezervaci. Klient ji posila taky, na
              // navratu ze Stripe (kind coach_new_inperson) -- a posila ji bohatsi: format lekce,
              // castku, kterou kouc dostane, a priznak referral bonusu. Tahle mela jen datum a cas
              // a nemela ani `data`, takze se nedala prokliknout. Dve notifikace o jedne veci jsou
              // horsi nez jedna; nechavame tu popisnejsi.
              await payAmbassador(slot.coach_profile_id, amount, currency, m.discipline, pi);
              await recordTransaction(event.account, pi, { acq_source: _acqSrcFrom(m), type: 'coach_inperson', slot_id: m.slot_id || null, discipline: m.discipline || null, member_id: m.student_id, coach_id: slot.coach_profile_id, plan: 'Lekce 1:1', gross: amount, currency, paid_by: m.paid_by || null, paid_by_name: m.paid_by_name || null });
            await notifyPaidForMinor(m, 'Lekce 1:1', amount, currency);
            }
          } else if (m.booking_type === 'online' && m.coach_profile_id) {
            await sbPost('bookings', {
              slot_id: null, student_id: m.student_id || null, coach_id: m.coach_profile_id,
              coach_name: m.coach_name || 'Kouč', payment_intent: pi, amount,
              training_date: new Date().toISOString().slice(0, 10), training_time: null,
              status: 'active', type: 'online', currency, online_format: m.online_fmt || null, discipline: m.discipline || null,
              qty: Math.max(1, parseInt(m.online_qty || '1', 10) || 1),
              student_name: m.student_name || null,
              paid_by: m.paid_by || null, paid_by_name: m.paid_by_name || null,
              minor_booking: !!(m.paid_by && m.student_id && m.paid_by !== m.student_id),
            });
            // ODSTRANENO ze stejneho duvodu: klient posila kind coach_new_online s formatem
            // objednavky, castkou a referral bonusem.
            await payAmbassador(m.coach_profile_id, amount, currency, m.discipline, pi);
            await recordTransaction(event.account, pi, { acq_source: _acqSrcFrom(m), type: 'coach_online', discipline: m.discipline || null, member_id: m.student_id, coach_id: m.coach_profile_id, plan: m.online_fmt || 'Online', gross: amount, currency, paid_by: m.paid_by || null, paid_by_name: m.paid_by_name || null });
            await notifyPaidForMinor(m, m.online_fmt || 'Online lekce', amount, currency);
          }
        } else {
          // Rezervaci uz zalozila appka po navratu ze Stripe. Driv tu webhook skoncil a transakci
          // ani doklad nezapsal -- kdyz je nezapsal ani /api/session, nevznikly vubec.
          // recordTransaction je idempotentni: existujici transakci nezmeni.
          const _b0 = existing[0] || {};
          const _onl = (m.booking_type === 'online');
          await recordTransaction(event.account, pi, { acq_source: _acqSrcFrom(m), type: _onl ? 'coach_online' : 'coach_inperson', slot_id: _onl ? null : (m.slot_id || null), discipline: m.discipline || null, member_id: m.student_id || _b0.student_id || null, coach_id: _b0.coach_id || m.coach_profile_id || null, plan: _onl ? (m.online_fmt || 'Online') : 'Lekce 1:1', gross: parseInt(m.base_amount || '0', 10), currency: m.booking_currency || 'CZK', paid_by: m.paid_by || null, paid_by_name: m.paid_by_name || null });
        }
      } else if (m.mtl_payment_type === 'drop_in' || m.mtl_payment_type === 'membership') {
        // GYM skupinová lekce (direct charge na účtu gymu) → 0,5 % ambassadorovi disciplíny
        await payGymAmbassador(m.mtl_disc, parseInt(m.mtl_base || '0', 10), m.mtl_currency || 'CZK', s.id, s.payment_intent);
        if (m.mtl_payment_type === 'drop_in') { const dpi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id); if (dpi) await recordTransaction(event.account, dpi, { acq_source: _acqSrcFrom(m), type: 'drop_in', discipline: m.discipline || m.disc || null, member_id: m.student_id || m.member_id, gym_id: m.gym_id, coach_id: m.coach_profile_id || m.coach_id, plan: m.mtl_plan || 'Drop-in', currency: m.mtl_currency || 'CZK', income_class: m.mtl_income || 'side',
          dropin_plan_id: m.mtl_dropin_plan || null,
          need_proof: (String(m.mtl_need_proof || '') === '1') }); }
        else if (m.mtl_membership_kind === 'one_time') {
          // MULTI-MONTH MEMBERSHIP (3/6/12 months) — a ONE-TIME payment, no subscription. Activate
          // the row and stamp period_end = now + N months; nothing renews, it simply expires then.
          // (The monthly plan below is untouched and still a real Stripe subscription.)
          const _mo = Math.max(1, parseInt(m.mtl_months || '1', 10) || 1);
          let _end = new Date(); _end.setMonth(_end.getMonth() + _mo);
          if (m.mtl_ends_on) {
            const _fixed = pragueEndOfDay(m.mtl_ends_on);   // konec dne v Praze, ne v UTC
            if (!isNaN(_fixed.getTime()) && _fixed > new Date()) _end = _fixed;
          }
          const _pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id);
          if (m.membership_id) {
            try {
              await sbPatch('gym_memberships', `id=eq.${encodeURIComponent(m.membership_id)}`, {
                status: 'active', payment_status: 'paid', months: _mo, period_end: _end.toISOString(), cancelled_at: null
              });
            } catch (e) { console.error('one-time membership activate', e.message); }
          }
          try {
            // Přijetí za člena u spolku: platba činí rozhodnutí klubu účinným (_member-app.js).
            if (m.mtl_online !== '1') await approveMemberAppOnPayment({ gymId: m.gym_id, studentId: m.student_id || m.member_id || null });
            // ONLINE PŘEDPLATNÉ KOUČE NA 3/6/12 MĚSÍCŮ (jednorázově kartou): platba patří kouči,
            // bez klubu a bez akvizice -- stejně jako měsíční předplatné níž.
            if (_pi) await recordTransaction(event.account, _pi, { type: 'membership', member_id: m.student_id || m.member_id, gym_id: m.gym_id || null, plan: m.mtl_plan || 'Membership', currency: m.mtl_currency || 'CZK', income_class: m.mtl_income || 'side', acq_source: _acqSrcFrom(m), acq_months: (m.mtl_acq_months ? parseInt(m.mtl_acq_months,10) : null), base_rate: (m.mtl_base_rate ? parseFloat(m.mtl_base_rate) : null), months: _mo, ...(m.mtl_online === '1' ? { coach_id: m.coach_id || null, paid_to: 'coach', acq_source: 'direct' } : {}) });
          } catch (e) { console.error('record one-time membership', e.message); }
          if (m.mtl_online === '1' && m.coach_id && m.membership_id) {
            try {
              const _om = (await sbGet(`gym_memberships?id=eq.${encodeURIComponent(m.membership_id)}&select=student_name,plan_name,amount,currency`))[0] || {};
              const _amt = `${Number(_om.amount || 0).toLocaleString('cs-CZ')} ${String(_om.currency || m.mtl_currency || 'CZK').toUpperCase()}`;
              const _endCs = _end.toLocaleDateString('cs-CZ'), _endEn = _end.toLocaleDateString('en-GB');
              const _cs = `🌐 Nový předplatitel: ${_om.student_name || 'Svěřenec'} si předplatil/a „${_om.plan_name || m.mtl_plan || ''}" na ${_mo} měsíců za ${_amt} (jednorázově kartou). Platí do ${_endCs}, samo se neobnovuje.`;
              const _en = `🌐 New subscriber: ${_om.student_name || 'A student'} bought "${_om.plan_name || m.mtl_plan || ''}" for ${_mo} months, ${_amt} (one-off card payment). Active until ${_endEn}, it does not renew.`;
              await sbPost('notifications', { user_id: m.coach_id, type: 'system', read: false, data: JSON.stringify({ kind: 'online_plan_new', membership_id: m.membership_id, student_id: m.student_id || null, msg_cs: _cs, msg_en: _en }), message: _cs });
            } catch (e) { console.error('online plan notify', e.message); }
          }
        }
        else {
          // MEMBERSHIP (subscription): link the subscription to the row + record the FIRST payment NOW,
          // independent of client timing / the gym_memberships lookup (which used to fail on the first invoice).
          const sub = typeof s.subscription === 'string' ? s.subscription : (s.subscription && s.subscription.id);
          // Přijetí za člena i u předplatného -- dřív jen u jednorázového členství.
          await approveMemberAppOnPayment({ gymId: m.gym_id, studentId: m.student_id || m.member_id || null });
          if (m.membership_id && sub) { try { await sbPatch('gym_memberships', `id=eq.${encodeURIComponent(m.membership_id)}`, { stripe_subscription: sub, status: 'active' }); } catch (e) { console.error('link sub', e.message); } }
          // ONLINE PŘEDPLATNÉ KOUČE: kouči podrobná notifikace s proklikem do jeho online sekce (Předplatitelé).
          if (m.mtl_online === '1' && m.coach_id && m.membership_id) {
            try {
              const _om = (await sbGet(`gym_memberships?id=eq.${encodeURIComponent(m.membership_id)}&select=student_name,plan_name,amount,currency`))[0] || {};
              const _amt = `${Number(_om.amount || 0).toLocaleString('cs-CZ')} ${String(_om.currency || m.mtl_currency || 'CZK').toUpperCase()}`;
              const _cs = `🌐 Nový předplatitel: ${_om.student_name || 'Svěřenec'} si předplatil/a „${_om.plan_name || m.mtl_plan || ''}" za ${_amt} měsíčně. Předplatné se obnovuje každý měsíc kartou.`;
              const _en = `🌐 New subscriber: ${_om.student_name || 'A student'} subscribed to "${_om.plan_name || m.mtl_plan || ''}" for ${_amt} a month. It renews monthly by card.`;
              await sbPost('notifications', { user_id: m.coach_id, type: 'system', read: false, data: JSON.stringify({ kind: 'online_plan_new', membership_id: m.membership_id, student_id: m.student_id || null, msg_cs: _cs, msg_en: _en }), message: _cs });
            } catch (e) { console.error('online plan notify', e.message); }
          }
          try {
            const invId = typeof s.invoice === 'string' ? s.invoice : (s.invoice && s.invoice.id);
            let payId = null;
            if (invId) { const invObj = await stripe.invoices.retrieve(invId, { stripeAccount: event.account }); payId = (typeof invObj.payment_intent === 'string' ? invObj.payment_intent : (invObj.payment_intent && invObj.payment_intent.id)) || (typeof invObj.charge === 'string' ? invObj.charge : (invObj.charge && invObj.charge.id)); }
            if (payId) await recordTransaction(event.account, payId, { type: 'membership', member_id: m.student_id || m.member_id, gym_id: m.gym_id || null, ...(m.mtl_online === '1' ? { coach_id: m.coach_id || null, paid_to: 'coach', acq_source: 'direct', native: m.mtl_native === '1' } : {}), plan: m.mtl_plan || 'Membership', currency: m.mtl_currency || 'CZK', income_class: m.mtl_income || 'side', acq_source: _acqSrcFrom(m), acq_months: (m.mtl_acq_months ? parseInt(m.mtl_acq_months,10) : null), base_rate: (m.mtl_base_rate ? parseFloat(m.mtl_base_rate) : null) });
          } catch (e) { console.error('record membership at checkout', e.message); }
        }
      } else if (m.mtl_payment_type === 'cohort_deposit') {
        // Cohort signup deposit (accountless, direct charge on the provider's connected account
        // with MTL's application_fee). Idempotent on the payment_intent.
        const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id);
        const cmId = m.cohort_member_id, cohId = m.cohort_id;
        const already = pi ? await sbGet(`cohort_payments?stripe_pi=eq.${encodeURIComponent(pi)}&select=id`) : [];
        if (cmId && (!already || already.length === 0)) {
          const amount = (s.amount_total || 0) / 100;
          const cur = (m.mtl_currency || s.currency || 'CZK').toUpperCase();
          const fee = (m.mtl_rate != null && m.mtl_rate !== '') ? Math.round(amount * parseFloat(m.mtl_rate) * 100) / 100 : (Math.round(amount * 0.03 * 100) / 100)  /* Stripe base 3% (was 0.035 = old ladder) */;
          const _sFee = await cohortStripeFee(pi, event.account);
          const _cpRes = await sbPost('cohort_payments', { cohort_member_id: cmId, cohort_id: cohId || null, kind: 'deposit', amount, currency: cur, mtl_fee: fee, stripe_fee: _sFee, payment_method: 'stripe', stripe_pi: pi || null, status: 'paid', created_at: new Date().toISOString() });
          if (_cpRes && _cpRes.ok === false) {
            // A migration-added column (payment_method / stripe_fee) may be missing in cohort_payments;
            // retry with the core columns so the payment is still logged (run cohort-payment-method.sql
            // + cohort-stripe-fee.sql to restore the full breakdown).
            console.error('cohort_payments full insert failed, retrying core columns:', _cpRes.error);
            await sbPost('cohort_payments', { cohort_member_id: cmId, cohort_id: cohId || null, kind: 'deposit', amount, currency: cur, mtl_fee: fee, status: 'paid', created_at: new Date().toISOString() });
          }
          {
            const _prev = Number((((await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=paid_amount`)) || [])[0] || {}).paid_amount || 0);
            await sbPatch('cohort_members', `id=eq.${encodeURIComponent(cmId)}`, { status: 'deposit_paid', paid_amount: Math.round((_prev + amount) * 100) / 100 });
          }
          // PŘIJETÍ ZA ČLENA U SPOLKU: zaplacením zálohy se přihláška TOHO, kdo platil, schválí
          // (_member-app.js -- stejně pro kartu, Finbricks, QR i hotovost).
          { const _payer = await cohortPayer(cmId); if (_payer) await approveMemberAppOnPayment(_payer); }
          // Also record a ledger transaction so the club DASHBOARD shows this cohort deposit
          // (dashboards read `transactions`, not `cohort_payments`). Idempotent on payment_intent.
          try {
            const _cg = ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=gym_id`)) || [])[0];
            const _cm = ((await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=student_id`)) || [])[0];
            await recordTransaction(event.account, pi, { type: 'course', member_id: (_cm && _cm.student_id) || null, gym_id: (_cg && _cg.gym_id) || null, income_class: 'cohort_deposit', noOrderMail: true, cohort_id: cohId || null });
          } catch (e) { console.error('cohort deposit tx', e.message); }
          try { const _cd = ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=discipline`)) || [])[0]; if (_cd && _cd.discipline) await payGymAmbassador(_cd.discipline, amount, cur, s.id, pi); } catch (e) { console.error('cohort amb deposit', e.message); }
          // NOTE follow-up: ambassador 0.5% on cohort deposits not wired yet (needs mtl_disc/mtl_base in metadata).
          try {
            const coh = cohId ? ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=owner_id,name,gym_id,deposit_amount,price_student,price_regular,currency,start_date,gym_meta_pixel,capi_token`)) || [])[0] : null;
            const mem = ((await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=name,email,tier,fbp,fbc,student_id`)) || [])[0];
            if (coh && coh.owner_id) await sbPost('notifications', { user_id: coh.owner_id, type: 'system', read: false, data: JSON.stringify({ kind: 'cohort_deposit_paid', cohort_id: cohId || null, cohort_member_id: cmId || null, cohort_name: coh.name || '', msg_en: '\uD83D\uDCDA New paid course enrolment' + (coh.name ? (' "' + coh.name + '"') : '') + '.' }), message: '\uD83D\uDCDA Nov\u00FD zaplacen\u00FD z\u00E1pis do kurzu' + (coh.name ? (' "' + coh.name + '"') : '') + '.' });
            // In-app notification to the student too (match the accountless member by e-mail to a profile).
            try {
              if (mem && mem.email) {
                const _sp = await sbGet(`profiles?email=eq.${encodeURIComponent(mem.email)}&select=id&limit=1`);
                const _sid = _sp && _sp[0] && _sp[0].id;
                if (_sid) await sbPost('notifications', { user_id: _sid, type: 'system', read: false, data: JSON.stringify({ kind: 'cohort_deposit_mine', cohort_id: cohId || null, cohort_member_id: cmId || null, cohort_name: coh.name || '', msg_en: '\u2705 Course deposit' + (coh.name ? (' "' + coh.name + '"') : '') + ' received. Your spot is reserved.' }), message: '\u2705 Z\u00E1loha za kurz' + (coh.name ? (' "' + coh.name + '"') : '') + ' p\u0159ijata. M\u00EDsto m\u00E1\u0161 rezervovan\u00E9.' });
              }
            } catch (e) { console.error('cohort student notif', e.message); }
            // E-MAIL SE ZÁLOHOU A DOKLADEM DOSTANE KAŽDÝ ZÁKAZNÍK -- s účtem i bez, v testu i naostro.
            // Uživatel s účtem bez e-mailu v přihlášce: e-mail z jeho profilu.
            let _toMail = (mem && mem.email) || '';
            if (!_toMail && mem && mem.student_id) { try { const _sp2 = await sbGet(`profiles?id=eq.${encodeURIComponent(mem.student_id)}&select=email`); _toMail = (_sp2 && _sp2[0] && _sp2[0].email) || ''; } catch (e) {} }
            if (_toMail && coh) {
              let gymName = ''; let gymRec = null;
              try { const g = await sbGet(`gyms?id=eq.${encodeURIComponent(coh.gym_id)}&select=name,legal_name,org_form,tax_id,vat_id,vat_payer,vat_rate,billing_line1,billing_line2,billing_city,billing_postal`); gymRec = (g && g[0]) || null; gymName = (gymRec && gymRec.name) || ''; } catch (e) {}
              let ownerEmail = '';
              try { if (coh.owner_id) { const op = await sbGet(`profiles?id=eq.${encodeURIComponent(coh.owner_id)}&select=email`); ownerEmail = (op && op[0] && op[0].email) || ''; } } catch (e) {}
              const cur2 = (coh.currency || cur || 'CZK');
              const tierPrice = Number((mem.tier === 'student') ? coh.price_student : coh.price_regular) || 0;
              const remainder = Math.max(0, tierPrice - Number(coh.deposit_amount || 0));
              const money = (x) => Math.round(x) + ' ' + cur2;
              const fromName = (gymName || 'Martial Training Lab').replace(/["<>]/g, '');
              let _dokAtt = undefined;
              try {
                // Doklad jen ze SNÍMKU (stejný jako v appce, /doklad-layout.js).
                const _snapPdf = pi ? await dokladPdfFor({ paymentIntent: pi }) : null;
                const _dokBuf = _snapPdf ? _snapPdf.buffer : null;   // bez snímku žádný doklad -- neskládá se z dnešních dat
                if (_dokBuf) _dokAtt = [{ filename: 'MTL-potvrzeni-o-platbe.pdf', content: _dokBuf.toString('base64') }];
              } catch (e) { console.error('cohort doklad pdf', e.message); }
              await sendResend(_toMail, (coh.name || 'Kurz') + ' \u2014 z\u00E1loha p\u0159ijata', cohortDepositHtml(mem.name, coh.name || 'Kurz', gymName, money(amount), remainder > 0 ? money(remainder) : '', coh.start_date || '', (APP_URL + '/?myclass=' + encodeURIComponent(cmId)), !!(gymRec && gymRec.org_form === 'nonprofit')), { from: '"' + fromName + '" <' + MAIL_ADDR + '>', replyTo: ownerEmail || undefined, attachments: _dokAtt });
            }
            try { await cohortCapiPurchase(coh, cmId, (mem && mem.email) || '', amount, cur, (mem && mem.fbp) || '', (mem && mem.fbc) || ''); } catch (e) {}
          } catch (e) { console.error('cohort confirm', e.message); }
        }
      } else if (m.mtl_payment_type === 'cohort_first_month') {
        // On-site first-month remainder paid via QR. Records the payment and enrolls the member.
        const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id);
        const cmId = m.cohort_member_id, cohId = m.cohort_id;
        const already = pi ? await sbGet(`cohort_payments?stripe_pi=eq.${encodeURIComponent(pi)}&select=id`) : [];
        if (cmId && (!already || already.length === 0)) {
          const amount = (s.amount_total || 0) / 100;
          const cur = (m.mtl_currency || s.currency || 'CZK').toUpperCase();
          const fee = (m.mtl_rate != null && m.mtl_rate !== '') ? Math.round(amount * parseFloat(m.mtl_rate) * 100) / 100 : (Math.round(amount * 0.03 * 100) / 100)  /* Stripe base 3% (was 0.035 = old ladder) */;
          const _sFee = await cohortStripeFee(pi, event.account);
          await sbPost('cohort_payments', { cohort_member_id: cmId, cohort_id: cohId || null, kind: 'first_month', amount, months: Math.max(1, parseInt(m.mtl_months || '1', 10) || 1), currency: cur, mtl_fee: fee, stripe_fee: _sFee, payment_method: 'stripe', stripe_pi: pi || null, status: 'paid', created_at: new Date().toISOString() });
          {
            const _prev2 = Number((((await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=paid_amount`)) || [])[0] || {}).paid_amount || 0);
            // months_paid: 1 bylo natvrdo. Kdyz student zaplati doplatek 1. mesice A ROVNOU
            // dalsi mesice jednou platbou, pokryva to mesicu vic -- mtl_months rika kolik.
            // Bez toho by mu appka zamkla lekce, ktere ma zaplacene.
            const _mn = Math.max(1, parseInt(m.mtl_months || '1', 10) || 1);
            await sbPatch('cohort_members', `id=eq.${encodeURIComponent(cmId)}`, { status: 'enrolled', paid_amount: Math.round((_prev2 + amount) * 100) / 100, months_paid: _mn });
          }
          try {
            const _cg = ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=gym_id`)) || [])[0];
            const _cm = ((await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=student_id`)) || [])[0];
            await recordTransaction(event.account, pi, { type: 'course', member_id: (_cm && _cm.student_id) || null, gym_id: (_cg && _cg.gym_id) || null, income_class: 'cohort_first_month', months: Math.max(1, parseInt(m.mtl_months || '1', 10) || 1), cohort_id: (m.cohort_id || null) });
          } catch (e) { console.error('cohort first_month tx', e.message); }
          try { const _cd2 = ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=discipline`)) || [])[0]; if (_cd2 && _cd2.discipline) await payGymAmbassador(_cd2.discipline, amount, cur, s.id, pi); } catch (e) { console.error('cohort amb firstmonth', e.message); }
        }
      } else if (m.mtl_payment_type === 'cohort_month') {
        // Month 2+ of a multi-month course: a full monthly payment. Bumps months_paid (only on real
        // Stripe confirmation, so a bailed checkout never advances it), records the payment + fee.
        const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id);
        const cmId = m.cohort_member_id, cohId = m.cohort_id;
        const already = pi ? await sbGet(`cohort_payments?stripe_pi=eq.${encodeURIComponent(pi)}&select=id`) : [];
        if (cmId && (!already || already.length === 0)) {
          const amount = (s.amount_total || 0) / 100;
          const cur = (m.mtl_currency || s.currency || 'CZK').toUpperCase();
          const fee = (m.mtl_rate != null && m.mtl_rate !== '') ? Math.round(amount * parseFloat(m.mtl_rate) * 100) / 100 : (Math.round(amount * 0.03 * 100) / 100);
          const _sFee = await cohortStripeFee(pi, event.account);
          await sbPost('cohort_payments', { cohort_member_id: cmId, cohort_id: cohId || null, kind: 'month', amount, months: Math.max(1, parseInt(m.mtl_months || '1', 10) || 1), currency: cur, mtl_fee: fee, stripe_fee: _sFee, payment_method: 'stripe', stripe_pi: pi || null, status: 'paid', created_at: new Date().toISOString() });
          {
            const _mr = (((await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=paid_amount,months_paid`)) || [])[0]) || {};
            const _prevPaid = Number(_mr.paid_amount || 0);
            // trust the month index from metadata if present, else increment
            const _mm = (m.mtl_month != null && m.mtl_month !== '') ? parseInt(m.mtl_month, 10) : (Number(_mr.months_paid || 0) + 1);
            await sbPatch('cohort_members', `id=eq.${encodeURIComponent(cmId)}`, { paid_amount: Math.round((_prevPaid + amount) * 100) / 100, months_paid: _mm });
          }
          try {
            const _cg = ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=gym_id`)) || [])[0];
            const _cm = ((await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=student_id`)) || [])[0];
            await recordTransaction(event.account, pi, { type: 'course', member_id: (_cm && _cm.student_id) || null, gym_id: (_cg && _cg.gym_id) || null, income_class: 'cohort_month', months: Math.max(1, parseInt(m.mtl_months || '1', 10) || 1), cohort_id: (m.cohort_id || null) });
          } catch (e) { console.error('cohort month tx', e.message); }
          try { const _cd3 = ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=discipline`)) || [])[0]; if (_cd3 && _cd3.discipline) await payGymAmbassador(_cd3.discipline, amount, cur, s.id, pi); } catch (e) { console.error('cohort amb month', e.message); }
        }
      } else if (m.mtl_payment_type === 'partner_sub') {
        // Exclusive MTL Partner zaplacen -> stupeň, sazby, zprávy (_ep.js; jen jednou, i když
        // to stihne dřív /api/session při návratu z platby).
        await activatePartner(s);
      } else if (m.mtl_payment_type === 'supplier_sub') {
        // PROFIL DODAVATELE ZAPLACEN -> zobrazí se klubům, koučům a pořadatelům (organizations.supplier_sub).
        // Stejně jako EP: cena se uloží k organizaci, ať je v Adminu vidět, kdo platí zakládající cenu.
        const orgId = m.org_id;
        const sub = typeof s.subscription === 'string' ? s.subscription : (s.subscription && s.subscription.id);
        const cust = typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id);
        if (orgId) {
          // Cena BEZ DPH (sup_net) -- tou se řídí ceník; DPH se případně přičítá při platbě.
          const _paid = m.sup_net ? Number(m.sup_net) : ((typeof s.amount_total === 'number') ? Math.round(s.amount_total / 100) : null);
          await sbPatch('organizations', `id=eq.${encodeURIComponent(orgId)}`, {
            supplier_sub: sub || null, supplier_customer: cust || null, supplier_cancelling: false, supplier_period_end: null,
            supplier_interval: (m.sup_interval === 'year' ? 'year' : 'month'),
            ...(_paid ? { supplier_price: _paid, supplier_currency: String(s.currency || 'czk').toUpperCase() } : {}),
          });
          // KDO PŘEDPLATNÉ PLATÍ (jeho karta). Po převodu organizace ho appka novému majiteli nenabídne
          // obnovit -- strhávalo by se předchozímu. Zvlášť, ať chybějící sloupec nezastaví zveřejnění.
          try { if (m.user_id) await sbPatch('organizations', `id=eq.${encodeURIComponent(orgId)}`, { supplier_sub_by: m.user_id }); } catch (e) { console.error('supplier_sub_by', e.message); }
          const _o = ((await sbGet(`organizations?id=eq.${encodeURIComponent(orgId)}&select=owner_id,name`)) || [])[0] || {};
          const _uid = _o.owner_id || m.user_id || null;
          // PŘEVZETÍ předplatného, které platil někdo jiný (po převodu organizace): staré se teď
          // nastaví ke konci období -- naposledy se z cizí karty strhlo to, co už je zaplacené.
          let _oldEnd = null;
          if (m.replaces_sub) {
            try {
              const _old = await stripe.subscriptions.retrieve(m.replaces_sub);
              if (!_old.cancel_at_period_end && ['active', 'trialing', 'past_due'].includes(_old.status)) {
                const _u = await stripe.subscriptions.update(m.replaces_sub, { cancel_at_period_end: true });
                _oldEnd = _u.current_period_end || (_u.items && _u.items.data && _u.items.data[0] && _u.items.data[0].current_period_end) || null;
                const _payer = (_old.metadata && _old.metadata.user_id) || null;
                if (_payer && String(_payer) !== String(_uid)) {
                  const _pl = (((await sbGet(`profiles?id=eq.${encodeURIComponent(_payer)}&select=lang`)) || [])[0] || {}).lang;
                  const _d = _oldEnd ? new Date(_oldEnd * 1000).toLocaleDateString(_pl === 'en' ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague' }) : '';
                  const _cs = '🧰 Nový majitel organizace ' + (_o.name || '') + ' převzal předplatné profilu dodavatele na svou kartu. Z tvé karty se už nic dalšího nestrhne' + (_d ? ('; období, které jsi zaplatil/a, končí ' + _d) : '') + '.';
                  const _en = '🧰 The new owner of ' + (_o.name || '') + ' took the supplier profile subscription over on their card. Nothing more will be charged to your card' + (_d ? ('; the period you paid for ends ' + _d) : '') + '.';
                  await sbPost('notifications', { user_id: _payer, type: 'system', read: false, message: _cs,
                    data: JSON.stringify({ kind: 'sup_paidfor', target: 'payer', org_id: orgId, org_name: _o.name || '', msg_cs: _cs, msg_en: _en }) });
                }
              }
            } catch (e) { console.error('supplier takeover', e.message); }
          }
          // Navazující předplatné (začíná až koncem toho starého): profil už je zveřejněný, nic se
          // nestrhlo -- zpráva to musí říct, ne „je zveřejněný".
          const _anc = m.sup_anchor ? Number(m.sup_anchor) : 0;
          const _ancD = _anc ? new Date(_anc * 1000).toLocaleDateString('cs-CZ', { timeZone: 'Europe/Prague' }) : '';
          if (_uid) await sbPost('notifications', { user_id: _uid, type: 'system', read: false,
            data: JSON.stringify({ kind: 'supplier_live', org_id: orgId, org_name: _o.name || '' }),
            message: _anc
              ? ('🧰 Předplatné profilu dodavatele ' + (_o.name || '') + ' teď platíš ze své karty. První platba se strhne ' + _ancD + ', profil běží bez přerušení. Faktura přijde e-mailem po každé platbě.')
              : ('🧰 Profil dodavatele ' + (_o.name || '') + ' je zveřejněný — kluby, kouči a pořadatelé ho teď najdou v sekci Dodavatelé. Faktura za předplatné přijde e-mailem.') });
          await sbPost('notifications', { user_id: (process.env.FOUNDER_UUID || '').trim(), type: 'system', read: false,
            data: JSON.stringify({ kind: 'new_provider', what: 'supplier', org_id: orgId }),
            message: _anc
              ? ('🧰 Dodavatel ' + (_o.name || orgId) + ': založeno navazující předplatné (první platba ' + _ancD + ').')
              : ('🧰 Dodavatel zaplatil a je zveřejněný: ' + (_o.name || orgId) + '. Zkontroluj profil.') });
        }
      } else if (m.mtl_payment_type === 'event_ticket') {
        // Event ticket (direct charge on payee account) — backstop confirm if user closed tab before redirect
        if (m.ticket_id) {
          const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id);
          // Objednávka může nést víc lístků na jednu platbu. Překlápí se všechny naráz -- kdyby
          // se potvrdil jen ten, jehož id nese metadata, zbytek by zůstal viset jako rezervace
          // a release-cron by je za půl hodiny uvolnil, přestože jsou zaplacené.
          {
            let _tScope = `id=eq.${encodeURIComponent(m.ticket_id)}`;
            try {
              const _t0 = await sbGet(`event_tickets?id=eq.${encodeURIComponent(m.ticket_id)}&select=order_id`);
              const _oid = _t0 && _t0[0] && _t0[0].order_id;
              if (_oid) _tScope = `order_id=eq.${encodeURIComponent(_oid)}`;
            } catch (e) {}
            await sbPatch('event_tickets', _tScope, { status: 'paid', stripe_ref: pi });
          }
          await recordTransaction(event.account, pi, { type: 'event_ticket',  member_id: m.student_id || m.buyer_id, gym_id: m.gym_id, coach_id: m.payout_coach_id, plan: m.mtl_event || 'Event', currency: m.mtl_currency || 'CZK', income_class: m.mtl_income || 'side' });
          await payGymAmbassador(m.mtl_disc, parseInt(m.mtl_base || '0', 10), m.mtl_currency || 'CZK', s.id, s.payment_intent);
          try { await sendTicketEmail(s, m); } catch (e) { console.error('ticket email', e.message); }
        }
      }
    } else if (event.type === 'charge.refunded') {
      const ch = event.data.object;
      const pi = typeof ch.payment_intent === 'string' ? ch.payment_intent : (ch.payment_intent && ch.payment_intent.id);
      if (pi) {
        const full = ch.amount_refunded >= ch.amount_captured;
        const pct = ch.amount_captured ? Math.round((ch.amount_refunded / ch.amount_captured) * 100) : 100;
        await sbPatch('bookings', `payment_intent=eq.${encodeURIComponent(pi)}`, full ? { status: 'cancelled', refund_pct: pct } : { refund_pct: pct });
        let mtlFeeRefunded = 0, _afFrac = 0;
        try { if (ch.application_fee) { const afId = typeof ch.application_fee === 'string' ? ch.application_fee : ch.application_fee.id; const af = await stripe.applicationFees.retrieve(afId); mtlFeeRefunded = af.amount_refunded || 0; if (af.amount) _afFrac = (af.amount_refunded || 0) / af.amount; } } catch (e) { console.error('appfee refund', e.message); }
        try { await sbPatch('transactions', `payment_intent=eq.${encodeURIComponent(pi)}`, { status: full ? 'refunded' : 'partial_refund', refund_amount: ch.amount_refunded, mtl_fee_refunded: mtlFeeRefunded }); } catch (e) {}
        if (_afFrac > 0) await clawbackAmbassador(pi, _afFrac);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      // Exclusive MTL Partner zrušen / neuhrazen → vypni partner sazby
      const sub = event.data.object;
      // PROČ A KDY SKONČILO -- do e-mailu i notifikace. Stripe pošle tuhle událost v okamžiku konce:
      // u zrušeného předplatného s koncem zaplaceného období, u neuhrazeného po posledním pokusu.
      const _endInfo = { reason: (sub.cancellation_details && sub.cancellation_details.reason) || null, endedAt: sub.ended_at || sub.canceled_at || null, test: sub.livemode === false };
      const _whyCs = _endInfo.reason === 'payment_failed' ? ' Platbu za další období se nepodařilo strhnout z karty ani po opakovaných pokusech.'
        : (_endInfo.reason === 'cancellation_requested' ? ' Předplatné jsi zrušil/a, proto skončilo s koncem zaplaceného období.' : '');
      const _whyEn = _endInfo.reason === 'payment_failed' ? ' The payment for the next period could not be charged to your card, not even after repeated attempts.'
        : (_endInfo.reason === 'cancellation_requested' ? ' You cancelled it, so it ended when the paid period ran out.' : '');
      // Profil dodavatele: předplatné skončilo -> profil se přestane zobrazovat (nic se nemaže,
      // po novém zaplacení se ukáže zase).
      try {
        const _so = (await sbGet(`organizations?supplier_sub=eq.${encodeURIComponent(sub.id)}&select=id,owner_id,name`)) || [];
        for (const o of _so) {
          await sbPatch('organizations', `id=eq.${encodeURIComponent(o.id)}`, { supplier_sub: null, supplier_cancelling: false, supplier_period_end: null, supplier_renews_at: null });
          if (o.owner_id) {
            const _cs = '🧰 Předplatné profilu dodavatele ' + (o.name || '') + ' skončilo.' + _whyCs + ' Kluby, kouči ani pořadatelé tě v sekci Dodavatelé nenajdou a sleva s Kartou MTL se studentům nezobrazuje. Nic se nesmazalo — po novém zaplacení se profil ukáže do minuty.';
            const _en = '🧰 The subscription for the supplier profile ' + (o.name || '') + ' has ended.' + _whyEn + ' Clubs, coaches and organizers no longer find you under Suppliers and students no longer see your MTL Card discount. Nothing was deleted — pay again and the profile goes live within a minute.';
            await sbPost('notifications', { user_id: o.owner_id, type: 'system', read: false,
              data: JSON.stringify({ kind: 'supplier_ended', org_id: o.id, org_name: o.name || '', reason: _endInfo.reason, msg_cs: _cs, msg_en: _en }), message: _cs });
          }
          await subMail({ orgId: o.id }, 'ended', null, _endInfo);
        }
      } catch (e) { console.error('supplier ended', e.message); }
      const rows = await sbGet(`profiles?partner_sub=eq.${encodeURIComponent(sub.id)}&select=id`);
      const uid = rows[0] && rows[0].id;
      if (uid) {
        // Úplné zrušení EP: stupeň pryč a zakládající místa se uvolní (drží se jen do zrušení).
        await sbPatch('profiles', `id=eq.${encodeURIComponent(uid)}`, { partner: false, partner_sub: null, partner_renews_at: null, partner_cancelling: false, partner_period_end: null,
          partner_tier: null, partner_tier_next: null, partner_tier_from: null, ep_founding: [], partner_price: null, partner_currency: null });
        // Zpět na vlastní sazbu (základ / Shikai / Bankai / organizace) -- dřív natvrdo 5 %.
        try { await rerateOwner(uid); } catch (e) { console.error('ep end rerate', e.message); }
        await subMail({ userId: uid }, 'ended', null, _endInfo);
        await sbPost('notifications', { user_id: uid, type: 'system', read: false, data: JSON.stringify({ kind: 'partner_ended' }), message: '⭐ Teď už nejsi Exclusive MTL Partner. Díky za přízeň! Provize se vrátila na tvou vlastní sazbu: základ 2 % u plateb kartou a 2,5 % u převodu, nižší se Shikai, Bankai nebo sazbou organizace. Z člena z appky 10 %. Reklama od MTL a partneři na kartě klubu jsou jen pro Exclusive Partnery: klub z reklamy vypadne a partneři se skryjí (nesmažou).' });
      }
    } else if (event.type === 'charge.dispute.created') {
      const d = event.data.object;
      const pi = typeof d.payment_intent === 'string' ? d.payment_intent : (d.payment_intent && d.payment_intent.id);
      if (pi) await sbPatch('bookings', `payment_intent=eq.${encodeURIComponent(pi)}`, { refund_requested: true, refund_reason: '(DISPUTE přes Stripe)' });
    } else if (event.type === 'invoice.paid') {
      // Renewal of a membership subscription on a connected (gym) account -> extend the period
      const inv = event.data.object;

      // DOKLAD ZA EP PŘEDPLATNÉ. Faktura od Stripe není doklad od MTL, takže si ho
      // vystavujeme sami (ep-doklad) -- pro účetnictví poskytovatele i pro dotace.
      try {
        const _ow = event.account ? null : await _platformSubOwner(inv);   // EP běží na platformním účtu, ne na connected
        // Nulová faktura (navazující předplatné se začátkem v budoucnu) není platba -- bez dokladu.
        // EP: PŘECHOD MEZI STUPNI. Faktura za přechod nahoru (billing_reason subscription_update)
        // zapíše vyšší stupeň -- důležité, když banka chtěla platbu potvrdit a pay.js ji nedočkal.
        // První zaplacená obnova po naplánovaném přechodu dolů (subscription_cycle) zapíše nižší.
        // Musí to být PŘED dokladem, ať doklad nese stupeň, za který se platí.
        let _epTier = null;
        if (_ow && !_ow.org) {
          const _md = _ow.md || {};
          const _ln0 = (inv.lines && inv.lines.data && inv.lines.data[0]) || null;
          try {
            if (inv.billing_reason === 'subscription_update' && _md.ep_tier_pending) {
              // Jen když tenhle přechod pořád čeká na předplatném, které běží. Opožděný nebo
              // opakovaný webhook (Stripe zkouší až 3 dny) nesmí vrátit starší stupeň.
              const _live = await stripe.subscriptions.retrieve(_ow.subId).catch(() => null);
              const _lmd = (_live && _live.metadata) || {};
              if (_live && ['active', 'trialing', 'past_due'].indexOf(_live.status) >= 0 && _lmd.ep_tier_pending === _md.ep_tier_pending) {
                await applyEpUpgrade(_ow.uid, _md.ep_tier_pending, { founding: _md.ep_founding_pending === '1', month: _md.ep_month_pending, subId: _ow.subId, currency: inv.currency });
                await stripe.subscriptions.update(_ow.subId, { metadata: { ep_tier: _md.ep_tier_pending, ep_month: _md.ep_month_pending || '',
                  ep_founding: _md.ep_founding_pending === '1' ? '1' : (_lmd.ep_founding || ''), ep_tier_pending: '', ep_month_pending: '', ep_founding_pending: '' } });
              }
            } else if (inv.billing_reason === 'subscription_cycle') {
              const _to = await applyEpDowngrade(_ow.uid, _ln0 && _ln0.period ? new Date(_ln0.period.start * 1000).toISOString() : null,
                { month: _md.ep_month_next || null, founding: _md.ep_founding_next === '1', subId: _ow.subId, currency: inv.currency });
              if (_to) await stripe.subscriptions.update(_ow.subId, { metadata: { ep_tier: _to, ep_month: _md.ep_month_next || '',
                ep_founding: _md.ep_founding_next === '1' ? '1' : '', ep_tier_next: '', ep_month_next: '', ep_founding_next: '', ep_prev_amount: '' } });
            }
          } catch (e) { console.error('ep tier change', e.message); }
          try { const _pp = ((await sbGet(`profiles?id=eq.${encodeURIComponent(_ow.uid)}&select=partner,partner_tier`)) || [])[0]; _epTier = _epTierOf(_pp); } catch (e) {}
        }
        if (_ow && Number(inv.amount_paid != null ? inv.amount_paid : inv.total) > 0) {
          const _line = (inv.lines && inv.lines.data && inv.lines.data[0]) || null;
          // DALŠÍ PLATBA: konec právě zaplaceného období = den příštího stržení. Appka ho ukazuje
          // ve správě předplatného (EP v Platby a provize, dodavatel v profilu dodavatele).
          try {
            const _pe = _line && _line.period && _line.period.end ? new Date(_line.period.end * 1000).toISOString() : null;
            if (_pe) {
              if (_ow.org) await sbPatch('organizations', `id=eq.${encodeURIComponent(_ow.org)}`, { supplier_renews_at: _pe });
              else await sbPatch('profiles', `id=eq.${encodeURIComponent(_ow.uid)}`, { partner_renews_at: _pe });
            }
          } catch (e) { console.error('renews_at', e.message); }
          await _callEpDoklad({
            invoice_id: inv.id, user_id: _ow.uid, org_id: _ow.org, bill_gym_id: _ow.billGym || null,
            amount: (inv.amount_paid != null ? inv.amount_paid : inv.total) / 100,
            currency: inv.currency, test_mode: !inv.livemode,
            ep_tier: _epTier, change: inv.billing_reason === 'subscription_update',
            period_start: _line && _line.period ? new Date(_line.period.start * 1000).toISOString() : null,
            period_end: _line && _line.period ? new Date(_line.period.end * 1000).toISOString() : null,
          });
        }
      } catch (e) { console.error('ep doklad', e.message); }

      const sub = typeof inv.subscription === 'string' ? inv.subscription : (inv.subscription && inv.subscription.id);
      if (sub) {
        let periodEnd = null;
        // Nejpozdější konec ze všech řádků faktury. U kalendářního měsíce má první faktura navíc
        // jednorázovou položku „zbytek měsíce", jejíž období končí hned -- první řádek by tak
        // nastavil konec členství na teď.
        try { ((inv.lines && inv.lines.data) || []).forEach((line) => { if (line && line.period && line.period.end) { const _e = new Date(line.period.end * 1000).toISOString(); if (!periodEnd || _e > periodEnd) periodEnd = _e; } }); } catch (e) {}
        const patch = { status: 'active', payment_status: 'ok', payment_failed_at: null, last_invoice_url: null };
        if (periodEnd) patch.period_end = periodEnd;
        await sbPatch('gym_memberships', `stripe_subscription=eq.${encodeURIComponent(sub)}`, patch);
        try { const ipi = (typeof inv.payment_intent === 'string' ? inv.payment_intent : (inv.payment_intent && inv.payment_intent.id)) || (typeof inv.charge === 'string' ? inv.charge : (inv.charge && inv.charge.id)); const mem = (await sbGet(`gym_memberships?stripe_subscription=eq.${encodeURIComponent(sub)}&select=*`))[0]; let _wwMemb=0, _incClass='side'; try{ const _so=await stripe.subscriptions.retrieve(sub,{stripeAccount:event.account}); if(_so&&_so.metadata){ _incClass=_so.metadata.mtl_income||'side'; if((inv.application_fee_amount||0)===0){ const _br=parseFloat(_so.metadata.mtl_acq_base||'0')||0; if(_br>0) _wwMemb=Math.round((inv.amount_paid||inv.total||0)*_br/100); } } }catch(e){ console.error('memb meta',e.message); }
        // THE ACQUISITION DROP that pay.js's own comment promised and nobody ever wrote.
        // Two invoices paid = the 2-month window is done -> the sub falls to the provider's
        // CURRENT ladder rate (recomputed live, not the stale mtl_acq_base in metadata).
        try{
          const _so2 = await stripe.subscriptions.retrieve(sub, { stripeAccount: event.account });
          let _subWasAcq=false, _subLadder=null;
        try{ const _smd=(_so2&&_so2.metadata)||{}; if(_smd.mtl_acq==='1'){ const _invs=await stripe.invoices.list({ subscription: sub, status:'paid', limit:3 }, { stripeAccount: event.account }); _subWasAcq = (((_invs&&_invs.data)||[]).filter((i)=>(i.amount_paid||0)>0).length <= 2); } }catch(e){}
          const _mem2 = (await sbGet(`gym_memberships?stripe_subscription=eq.${encodeURIComponent(sub)}&select=gym_id,coach_id,paid_to`))[0];
          let _ownerId = null;
          if (_mem2 && _mem2.paid_to === 'coach' && _mem2.coach_id) _ownerId = _mem2.coach_id;
          else if (_mem2 && _mem2.gym_id) { const _g=(await sbGet(`gyms?id=eq.${_mem2.gym_id}&select=owner_id`))[0]; _ownerId = _g && _g.owner_id; }
          if (_ownerId) {
            // org_rate_until musí být v selectu: sazba z asociace se pozná jen podle toho data
            // (sloupec profiles.org_rate neexistuje). Bez něj vyšel členovi asociace základ 2 %
            // místo 1,5 % a webhook mu tu vyšší sazbu nastavil na předplatné.
            const _op = (await sbGet(`profiles?id=eq.${_ownerId}&select=partner,partner_tier,org_rate_until,coach_ref_score,bankai_eligible`))[0] || {};
            const _sc = _op.coach_ref_score || 0;
            // Delegováno na _rate.js. Tady dřív seděla vlastní kopie žebříčku s vlastními čísly, a přesně
            // ta se rozešla: EP mělo 1 % místo 0,5 % a founding se neřešil vůbec, takže každý běh zvedal
            // sazbu tomu, komu ji gym-rerate.js právě snížil. Jedno pravidlo, jedno místo.
            let _ladder = _mtlLadder('stripe', { partner: _epTierOf(_op), org: _hasOrgRate(_op), score: _sc, bankai: _op.bankai_eligible }) * 100;
            // Online předplatné kouče: vlastní online sazba, žádná akvizice.
            if (((_so2 && _so2.metadata) || {}).mtl_online === '1') _ladder = _mtlOnline({ partner: _epTierOf(_op), score: _sc, bankai: _op.bankai_eligible }) * 100;
            _subLadder = _ladder / 100;
            await applySubRate(stripe, event.account, sub, _so2, _ladder);
          }
        }catch(e){ console.error('acq drop', e.message); } if (ipi && mem) await recordTransaction(event.account, ipi, { renewal: true, native: (((inv.subscription_details || {}).metadata || {}).mtl_native === '1'), type: 'membership',  income_class: _incClass, member_id: mem.student_id || mem.member_id, gym_id: mem.gym_id, coach_id: mem.coach_id, plan: mem.plan_name || 'Membership', currency: inv.currency , acq_source: (_subWasAcq ? 'mtl_discovery' : null), acq_months: (_subWasAcq ? 1 : null), base_rate: (_subLadder != null ? _subLadder : null) }); } catch (e) { console.error('record membership', e.message); }
      }
    } else if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object;
      const sub = typeof inv.subscription === 'string' ? inv.subscription : (inv.subscription && inv.subscription.id);
      // EP: PŘEDPLATNÉ SE NEPODAŘILO STRHNOUT. Vystaví se faktura s částkou „K úhradě" (jen
      // jednou -- další neúspěšné pokusy už ji mají, ep-doklad hlídá invoice_id). Až Stripe
      // platbu později strhne (invoice.paid), vznikne k ní samostatné potvrzení o úhradě;
      // vystavená faktura se nemění. Stejný postup jako u provize.
      if (!event.account) {
        try {
          const _ow = await _platformSubOwner(inv);
          // Neprošlý doplatek za přechod EP na vyšší stupeň fakturu nedělá: přechod se bez
          // zaplacení neprovede (pay.js, pending_if_incomplete) a dlužit tedy není co.
          if (_ow && inv.billing_reason !== 'subscription_update') {
            const _line = (inv.lines && inv.lines.data && inv.lines.data[0]) || null;
            const _umd = _ow.md || {};
            await _callEpDoklad({
              ep_tier: _ow.org ? null : (_umd.ep_tier_next || _umd.ep_tier || null),
              unpaid: true, invoice_id: inv.id, user_id: _ow.uid, org_id: _ow.org, bill_gym_id: _ow.billGym || null,
              amount: (inv.amount_due != null ? inv.amount_due : inv.total) / 100,
              currency: inv.currency, test_mode: !inv.livemode,
              pay_url: inv.hosted_invoice_url || null,
              next_attempt: inv.next_payment_attempt ? new Date(inv.next_payment_attempt * 1000).toISOString() : null,
              period_start: _line && _line.period ? new Date(_line.period.start * 1000).toISOString() : null,
              period_end: _line && _line.period ? new Date(_line.period.end * 1000).toISOString() : null,
            });
          }
        } catch (e) { console.error('ep unpaid doklad', e.message); }
      }
      if (sub) {
        await sbPatch('gym_memberships', `stripe_subscription=eq.${encodeURIComponent(sub)}`, { payment_status: 'past_due', payment_failed_at: new Date().toISOString(), last_invoice_url: inv.hosted_invoice_url || null });
        try { const mem = (await sbGet(`gym_memberships?stripe_subscription=eq.${encodeURIComponent(sub)}&select=*`))[0]; if (mem && (mem.student_id || mem.member_id)) await sbPost('notifications', { user_id: mem.student_id || mem.member_id, type: 'system', read: false, data: JSON.stringify({ kind: 'membership_payment_failed', url: inv.hosted_invoice_url || '', gym_id: mem.gym_id, msg_en: '\u26a0\ufe0f The payment for your membership ' + (mem.plan_name || '') + ' failed. Update your card or pay via the link in the app.' }), message: '⚠️ Platba členství ' + (mem.plan_name || '') + ' se nezdařila. Aktualizuj kartu / zaplať odkaz v appce.' }); } catch (e) { console.error('notify failed pay', e.message); }
      }
    } else if (event.type === 'account.updated') {
      const acct = event.data.object;
      const ready = !!(acct && acct.charges_enabled);
      try { await sbPatch('profiles', `stripe_account=eq.${encodeURIComponent(acct.id)}`, { charges_enabled: ready }); } catch (e) {}
      try { await sbPatch('gyms', `stripe_account=eq.${encodeURIComponent(acct.id)}`, { charges_enabled: ready }); } catch (e) {}
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    res.status(200).json({ received: true, error: err.message }); // 200, ať Stripe neretryuje donekonečna na našich chybách
  }
}

// ── VYSTAVENÍ DOKLADU ────────────────────────────────────────────────────────────────────
// Doklad se pořizuje jako SNÍMEK ve chvíli platby: identita dodavatele, odběratel, popis
// a částka se opíšou tak, jak platí teď. Vykreslení už nikdy nesahá na živé `gyms`/`profiles`,
// takže pozdější změna názvu nebo vstup do DPH staré doklady nepřepíše.
// Číslo přiděluje doklad_next(series_key) atomicky; klíč je IČO poskytovatele V TOMTO OKAMŽIKU.
// Selhání nesmí shodit zápis platby -- peníze jsou důležitější než papír, doklad se dá doplnit.
// Doklad ke Stripe platbe podle zapsane transakce. Vola ho ten, kdo transakci zalozil -- webhook
// i /api/session (zaloha, kdyz webhook nedorazi). Data bere z radku transakce, takze doklad je
// stejny bez ohledu na to, ktera cesta vyhrala. Kdyz doklad k platbe uz je, nevystavi druhy.
// POLOZKA NA DOKLADU: druh + nazev ("Clenstvi · Zacatecnici", "Jednorazovy vstup · Bordelari").
// Pise se do snimku pri vystaveni. Driv tam byl jen nazev tarifu, nebo u banky syrovy typ "drop_in".
function _dokItemLabel(type, name, sk) {
  // sk = 'membership' | 'pass' (z _sell-kind.js podle prodávajícího); bez něj „Členství" jako dřív.
  const T = { membership: (sk === 'online' ? 'Online předplatné' : sk === 'pass' ? 'Permanentka' : 'Členství'), drop_in: 'Jednorázový vstup', coach_inperson: 'Soukromá lekce 1:1', coach_1to1: 'Soukromá lekce 1:1',
    coach_online: 'Online lekce', event_ticket: 'Vstupenka', event: 'Vstupenka', merch: 'Zboží', course: 'Kurz' };
  const t = T[String(type || '')] || '';
  const n = String(name || '').trim();
  // Obecne zastupne nazvy, ktere by jen opakovaly druh.
  const generic = /^(membership|drop-in|drop-in lekce|lekce 1:1|online|event|merch|platba)$/i;
  if (!t) return n || 'Platba';
  if (!n || generic.test(n) || n.toLowerCase() === t.toLowerCase()) return t;
  return t + ' · ' + n;
}
export async function issueStripeDokladForPi(pi, hint) {
  try {
    if (!pi) return null;
    const tx = ((await sbGet(`transactions?payment_intent=eq.${encodeURIComponent(pi)}&select=id,gross_amount,currency,member_id,coach_id,gym_id,plan,type,paid_by_name,test_mode&limit=1`)) || [])[0];
    if (!tx || tx.gross_amount == null) return null;
    const ex = (await sbGet(`doklady?or=(payment_intent.eq.${encodeURIComponent(pi)},transaction_id.eq.${tx.id})&select=doklad_no&limit=1`)) || [];
    if (ex.length) return String(ex[0].doklad_no);
    let _cust = null;
    if (tx.member_id) _cust = ((await sbGet(`profiles?id=eq.${encodeURIComponent(tx.member_id)}&select=name,email`)) || [])[0] || null;
    // Termin lekce ZAFIXOVANY TED. Slot z metadat platby (rezervace jeste nemusi existovat),
    // jinak rezervace podle platby. Nic se nenajde = doklad termin neuvede, nedokresli ho.
    let _sess = null;
    try {
      const _slotId = hint && hint.slotId;
      if (_slotId) { const _sl = ((await sbGet(`slots?id=eq.${encodeURIComponent(_slotId)}&select=date,time`)) || [])[0]; if (_sl && _sl.date) _sess = _sl.date + (_sl.time ? ' ' + _sl.time : ''); }
      if (!_sess) { const _bk = ((await sbGet(`bookings?payment_intent=eq.${encodeURIComponent(pi)}&select=training_date,training_time,type&limit=1`)) || [])[0]; if (_bk && _bk.type !== 'online' && _bk.training_date) _sess = _bk.training_date + (_bk.training_time ? ' ' + _bk.training_time : ''); }
      if (!_sess) { const _gb = ((await sbGet(`gym_bookings?payment_intent=eq.${encodeURIComponent(pi)}&select=class_date,class_time&limit=1`)) || [])[0]; if (_gb && _gb.class_date) _sess = String(_gb.class_date).slice(0, 10) + (_gb.class_time ? ' ' + _gb.class_time : ''); }
    } catch (e) {}
    return await issueDoklad({ sessionAt: _sess,
      transactionId: tx.id, paymentIntent: pi,
      gymId: tx.gym_id || null, coachId: tx.gym_id ? null : (tx.coach_id || null),
      // ODBERATEL JE PLATCE, ucastnik je ten, komu sluzba patri (uvede se jen kdyz se lisi).
      customerName: tx.paid_by_name || (_cust && _cust.name) || null,
      customerEmail: (_cust && _cust.email) || null,
      participantName: (_cust && _cust.name) || null,
      itemLabel: _dokItemLabel(tx.type, tx.plan, (tx.type === 'membership') ? await sellKindFor(sbGet, { gymId: tx.gym_id, paidTo: tx.paid_to }) : null), amount: tx.gross_amount,
      currency: tx.currency, paymentMethod: 'stripe', testMode: !!tx.test_mode,
    });
  } catch (e) { console.error('issueStripeDokladForPi', e && e.message); return null; }
}

async function issueDoklad({ transactionId, paymentIntent, gymId, coachId, customerName, customerEmail, participantName, itemLabel, amount, currency, paymentMethod, testMode, sessionAt }) {
  try {
    if (!transactionId && !paymentIntent) return null;
    let sup = null;
    if (gymId) {
      sup = (await sbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=legal_name,name,tax_id,vat_id,vat_payer,vat_rate,billing_line1,billing_line2,billing_city,billing_postal,owner_id,timezone`))[0] || null;
    } else if (coachId) {
      sup = (await sbGet(`profiles?id=eq.${encodeURIComponent(coachId)}&select=legal_name,name,tax_id,vat_id,vat_payer,vat_rate,billing_line1,billing_line2,billing_city,billing_postal,timezone`))[0] || null;
    }
    if (!sup) return null;
    const ico = String(sup.tax_id || '').replace(/\s/g, '');
    if (!ico) {
      // TICHÉ NEVYSTAVENÍ BYLO HORŠÍ NEŽ CHYBA. Bez IČO se doklad vystavit nedá (číselná řada
      // je vedená na IČO), ale doteď se jen vrátilo null: platba proběhla, doklad nikde a nikdo
      // se nic nedozvěděl. Teď to jde do logu a poskytovateli přijde notifikace, ať to doplní.
      console.error('[doklad] chybí IČO poskytovatele → nevystaveno', { transactionId, paymentIntent, gymId, coachId });
      try {
        const _uid = gymId ? (sup.owner_id || null) : (coachId || null);
        if (_uid) {
          await sbPost('notifications', {
            user_id: _uid, type: 'system', read: false,
            data: JSON.stringify({ kind: 'doklad_blocked', reason: 'tax_id', transaction_id: transactionId || null }),
            message: '⚠️ Doklad k platbě se nevystavil — chybí IČO ve fakturačních údajích. Doplň ho a napiš nám, doklad pak vystavíme zpětně.',
          });
        }
      } catch (e) {}
      return null;
    }                      // bez IČO nemá řada klíč; přihláška ho vyžaduje

    // ŘADA SE SLUČUJE V RÁMCI ÚČTU, NE V RÁMCI IČO.
    // Kdo má pod jedním IČO dva kluby a k tomu profil kouče, má JEDNU souvislou řadu -- je to
    // jeden účetní subjekt a jeden člověk, který ji vykazuje. Kdyby ale totéž IČO používaly dva
    // různé účty (v testu to povolujeme), sdílenou řadou by si navzájem braly čísla a ani jeden
    // by neviděl, proč mu v ní chybí. Proto je v klíči i vlastník účtu.
    const ownerId = gymId ? (sup.owner_id || null) : (coachId || null);
    if (!ownerId) return null;
    const key = 'ico:' + ico + ':acct:' + ownerId;

    // JEDEN KROK: číslo i zápis dokladu dělá databázová funkce doklad_issue (sql-49).
    // Dřív se číslo vyzvedlo zvlášť (doklad_next) a doklad se zapisoval druhým voláním --
    // když to druhé selhalo, číslo bylo propálené a doklad nikde (díra po 2026-000009).
    // Teď je to jedna transakce: buď obojí, nebo nic a číslo se vrátí do řady.
    const _issRes = await fetch(`${SB}/rest/v1/rpc/doklad_issue`, {
      method: 'POST', headers: sbHeaders,
      body: JSON.stringify({ p_key: key, p_row: {
        transaction_id: transactionId || null, payment_intent: paymentIntent || null,
        sup_name: sup.legal_name || sup.name || null,
        sup_ico: ico, sup_dic: sup.vat_id || null, sup_address: _billAddr(sup) || null,
        sup_vat_payer: !!sup.vat_payer, sup_vat_rate: (sup.vat_rate != null ? sup.vat_rate : null),
        sup_tz: sup.timezone || null,   // pásmo dodavatele (datum dokladu v jeho místním čase)
        cust_name: customerName || null, cust_email: customerEmail || null,
        participant_name: ((participantName && String(participantName).trim() &&
          String(participantName).trim() !== String(customerName || '').trim()) ? String(participantName).trim() : null),
        item_label: itemLabel || null,
        amount: Math.round(Number(amount) || 0), currency: String(currency || 'CZK').toUpperCase(),
        payment_method: paymentMethod || null, test_mode: !!testMode,
        session_at: sessionAt || null,   // termín lekce při vystavení (sql/doklad-issue-session.sql)
      } }),
    });
    if (!_issRes.ok) {
      const _t = await _issRes.text().catch(() => '');
      console.error('[doklad] doklad_issue selhalo — nic se nevystavilo, řada je celá', {
        transactionId, paymentIntent, key, status: _issRes.status, error: _t.slice(0, 300),
      });
      return null;   // hodinový cron to zkusí znovu
    }
    let no = await _issRes.json();
    if (no && typeof no === 'object') no = Array.isArray(no) ? no[0] : Object.values(no)[0];
    if (!no) return null;
    return String(no);
  } catch (e) { console.error('issueDoklad', e && e.message); return null; }
}
