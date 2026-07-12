// /api/stripe-webhook.js — Stripe webhook (záchranná síť, ať neunikne žádná platba)
// Vyžaduje env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Nastavení ve Stripe Dashboard → Developers → Webhooks → Add endpoint:
//   URL: https://app.muaythailab.co/api/stripe-webhook
//   Events: checkout.session.completed, charge.refunded, charge.dispute.created
//   Signing secret → ulož do env STRIPE_WEBHOOK_SECRET
//
// DŮLEŽITÉ: webhook musí číst RAW body (proto bodyParser:false), jinak selže ověření podpisu.

import Stripe from 'stripe';
import crypto from 'crypto';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
export const config = { api: { bodyParser: false } };

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sbHeaders = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };

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
async function sendResend(to, subject, html, opts) {
  if (!RESEND || !to) return;
  try {
    const body = { from: (opts && opts.from) || MAIL_FROM, to: [to], subject, html };
    if (opts && opts.replyTo) body.reply_to = opts.replyTo;
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) console.error('resend', r.status, await r.text().catch(() => ''));
  } catch (e) { console.error('resend', e.message); }
}
function cohortDepositHtml(name, courseName, gymName, depositTxt, remainderTxt, startTxt) {
  const hi = name ? ('Ahoj ' + _esc(name) + ',') : 'Ahoj,';
  return `<!doctype html><html><body style="margin:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#171717;">
  <div style="max-width:480px;margin:0 auto;padding:28px 22px;">
    <div style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#E11;margin-bottom:4px;">MARTIAL TRAINING LAB</div>
    <div style="font-size:12px;color:#888;margin-bottom:22px;">Be More.</div>
    <p style="font-size:15px;line-height:1.6;">${hi}</p>
    <p style="font-size:15px;line-height:1.6;">Tvoje místo v kurzu <b>${_esc(courseName)}</b>${gymName ? (' u <b>' + _esc(gymName) + '</b>') : ''} je rezervované — zálohu <b>${_esc(depositTxt)}</b> máme. 🥊</p>
    ${startTxt ? `<p style="font-size:14px;line-height:1.6;">Start: <b>${_esc(startTxt)}</b></p>` : ''}
    ${remainderTxt ? `<p style="font-size:14px;line-height:1.6;color:#555;">Zbytek 1. měsíce (<b>${_esc(remainderTxt)}</b>) doplatíš na místě přes QR — kartou, žádná hotovost.</p>` : ''}
    <p style="font-size:13px;line-height:1.6;color:#555;margin-top:18px;">Těšíme se na tebe na tréninku. Kdyby cokoliv, odpověz na tenhle e-mail.</p>
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
async function rerateGymMemberships(ownerId, pct) {
  try {
    const gyms = await sbGet(`gyms?owner_id=eq.${encodeURIComponent(ownerId)}&select=id,stripe_account`);
    for (const g of gyms || []) {
      if (!g.stripe_account) continue;
      const mems = await sbGet(`gym_memberships?gym_id=eq.${encodeURIComponent(g.id)}&status=in.(active,cancelling)&select=stripe_subscription`);
      for (const m of mems || []) {
        if (!m.stripe_subscription) continue;
        try {
          await stripe.subscriptions.update(m.stripe_subscription, { application_fee_percent: pct }, { stripeAccount: g.stripe_account });
        } catch (e) { console.error('rerate sub', m.stripe_subscription, e.message); }
      }
    }
  } catch (e) { console.error('rerateGymMemberships', e); }
}

function rawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(Buffer.from(data)));
    req.on('error', reject);
  });
}

// ── Event ticket email (Resend). Needs env: RESEND_API_KEY, optional TICKET_EMAIL_FROM, PUBLIC_URL ──
async function sendTicketEmail(s, m) {
  const key = process.env.RESEND_API_KEY; if (!key) return;
  const email = (s.customer_details && s.customer_details.email) || s.customer_email; if (!email) return;
  const qtok = m.qr_token || ''; const evId = m.mtl_event_id || ''; if (!qtok || !evId) return;
  const origin = process.env.PUBLIC_URL || 'https://app.muaythailab.co';
  const checkinUrl = `${origin}/?evcheckin=1&ev=${encodeURIComponent(evId)}&tok=${encodeURIComponent(qtok)}`;
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=${encodeURIComponent(checkinUrl)}`;
  const title = m.mtl_event || 'your event';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#111;">`
    + `<h2 style="margin:0 0 6px;">\uD83C\uDF9F\uFE0F ${title}</h2>`
    + `<p style="color:#444;">Your ticket is confirmed. Show this QR code at the door:</p>`
    + `<p style="text-align:center;margin:18px 0;"><img src="${qrImg}" width="240" height="240" alt="Ticket QR" style="border:1px solid #eee;border-radius:12px;"></p>`
    + `<p style="text-align:center;color:#888;font-size:13px;">You can also open your ticket anytime in the MTL Coaches app under My events.</p>`
    + `<p style="text-align:center;"><a href="${origin}" style="color:#E8001D;font-weight:bold;text-decoration:none;">Open MTL Coaches \u2192</a></p></div>`;
  const from = process.env.TICKET_EMAIL_FROM || 'MTL Coaches <tickets@muaythailab.co>';
  await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: email, subject: `\uD83C\uDF9F\uFE0F Your ticket \u2014 ${title}`, html }) });
}

// Records ONE row per Stripe payment into the transactions ledger, with EXACT fees from the charge's balance_transaction.
// Resolve a connected Stripe account to the ENTITY that owns the money (and therefore owns
// welcome_free_until). Without this, transactions written by Stripe carry no payee_id and the
// welcome cap - which is scoped by payee_id in pay.js / record-cash.js - simply cannot see them.
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
      const g = (await sbGet(`gyms?or=(stripe_account.eq.${a},gym_payout_account.eq.${a})&select=id&limit=1`))[0];
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
//   * pay.js at creation        -> welcome 0% / acquisition 10% (5% EP) / ladder
//   * cron-attendance when the welcome window ended -> ALWAYS base, which silently threw
//     away an acquisition window that was still running
//   * gym-rerate when the owner crossed a tier -> ALWAYS the ladder rate, which blew away
//     BOTH a running welcome window (breaking a 0% promise made to the provider) and an
//     open acquisition window (MTL losing its own finder's fee)
// and nothing at all ever ended an acquisition window, so an MTL-sourced membership was
// billed 10% forever. mtl_acq had one writer and zero readers.
//
// PRECEDENCE: welcome (0) beats acquisition (10 / 5) beats the provider's ladder rate.
// Welcome wins because it is a promise made to the provider; when it ends, the sub lands
// on whatever is correct AT THAT MOMENT (still inside the 2 months -> acquisition; else ladder).
//
// Returns null when it cannot decide (Stripe call failed) -> the caller must CHANGE NOTHING.
// Never guess with someone's money.
async function subRateFor(stripe, acct, subId, sub, ladderPct, welcomeActive) {
  if (welcomeActive) return 0;
  const md = (sub && sub.metadata) || {};
  if (md.mtl_acq === '1') {
    const pct = parseFloat(md.mtl_acq_pct || '0') || 0;
    if (pct > 0) {
      let paid;
      try {
        const invs = await stripe.invoices.list({ subscription: subId, status: 'paid', limit: 3 }, { stripeAccount: acct });
        paid = ((invs && invs.data) || []).length;
      } catch (e) { return null; }            // cannot count -> do not touch the rate
      if (paid < 2) return pct;               // first two months -> the acquisition rate
    }
  }
  return ladderPct;
}

// Apply it. Returns true if the rate actually changed.
async function applySubRate(stripe, acct, subId, sub, ladderPct, welcomeActive) {
  const want = await subRateFor(stripe, acct, subId, sub, ladderPct, welcomeActive);
  if (want === null) return false;                                  // undecidable -> leave alone
  const cur = (sub.application_fee_percent != null) ? Number(sub.application_fee_percent) : null;
  if (cur === want) return false;
  const md = Object.assign({}, (sub && sub.metadata) || {});
  if (md.mtl_acq === '1' && want !== 0 && want === ladderPct) md.mtl_acq = 'done';   // window closed
  await stripe.subscriptions.update(subId, { application_fee_percent: want, metadata: md }, { stripeAccount: acct });
  return true;
}

async function recordTransaction(acct, pi, fields) {
  if (!pi) return;
  try {
    const ex = await sbGet(`transactions?payment_intent=eq.${encodeURIComponent(pi)}&select=id`);
    if (ex && ex.length) return;
    let gross = fields.gross != null ? fields.gross : null, stripeFee = null, mtlFee = null, net = null, currency = fields.currency || null, chargeId = null;
    if (acct) {
      try {
        let ch = null;
        if (String(pi).startsWith('ch_')) {
          ch = await stripe.charges.retrieve(pi, { expand: ['balance_transaction'] }, { stripeAccount: acct });
        } else {
          const intent = await stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge.balance_transaction'] }, { stripeAccount: acct });
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
            gross = bt.amount; net = bt.net; currency = bt.currency || currency;
            let sFee = 0, aFee = 0;
            if (Array.isArray(bt.fee_details)) {
              for (const fd of bt.fee_details) {
                if (fd.type === 'stripe_fee') sFee += fd.amount;
                else if (fd.type === 'application_fee') aFee += fd.amount;
              }
            }
            if (sFee === 0 && aFee === 0) { aFee = ch.application_fee_amount || 0; sFee = (bt.fee || 0) - aFee; }
            stripeFee = sFee; mtlFee = aFee;
          } else {
            gross = ch.amount; mtlFee = ch.application_fee_amount || 0; net = gross - mtlFee;
          }
        }
      } catch (e) { console.error('recordTransaction fee', e.message); }
    }
    const _payee = await resolvePayee(acct);
    await sbPost('transactions', {
      payment_intent: pi, charge_id: chargeId, payee_account: acct || null, type: fields.type,
      payee_id: _payee.id, payee_kind: _payee.kind,
      member_id: fields.member_id || null, coach_id: fields.coach_id || null, gym_id: fields.gym_id || null, plan: fields.plan || null,
      gross_amount: gross, stripe_fee: stripeFee, mtl_fee: (((fields.welcome_waived||0)>0 && (mtlFee===0||mtlFee==null)) ? (fields.welcome_waived||0) : mtlFee), mtl_rate: ((gross>0 && ((((fields.welcome_waived||0)>0 && (mtlFee===0||mtlFee==null)) ? (fields.welcome_waived||0) : mtlFee))>0) ? Math.round(((((((fields.welcome_waived||0)>0 && (mtlFee===0||mtlFee==null)) ? (fields.welcome_waived||0) : mtlFee))/gross))*10000)/10000 : 0), mtl_fee_refunded: ((fields.welcome_waived||0)>0 ? (fields.welcome_waived||0) : 0), net_amount: net, currency,
      income_class: fields.income_class || null,
      payment_method: 'stripe', commission_status: 'collected', commission_month: new Date().toISOString().slice(0,7),
      status: 'paid', created_at: new Date().toISOString(),
    });
    try { if (fields.member_id && gross != null) await ecoPurchase(fields.member_id, gross / 100, currency, pi); } catch (e) {}
  } catch (e) { console.error('recordTransaction', e.message); }
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
    const rows = await sbGet('profiles?id=eq.7e08d4bb-0efa-47ae-bd6a-85e9bd04400c&select=mtl_eco_pixel,mtl_eco_capi_token');
    const f = rows && rows[0];
    _ECO_CFG = (f && f.mtl_eco_pixel && f.mtl_eco_capi_token) ? { pixel: f.mtl_eco_pixel, token: f.mtl_eco_capi_token } : { pixel: '', token: '' };
  } catch (e) { _ECO_CFG = { pixel: '', token: '' }; }
  return _ECO_CFG;
}
async function ecoPurchase(buyerId, amount, cur, pi) {
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
      custom_data: { value: Number(amount || 0), currency: (cur || 'CZK'), content_type: 'customer' }
    };
    const url = 'https://graph.facebook.com/v21.0/' + encodeURIComponent(cfg.pixel) + '/events?access_token=' + encodeURIComponent(cfg.token);
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [evt] }) });
  } catch (e) { console.error('ecoPurchase', e.message); }
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
      const _ww = parseInt(m.mtl_welcome_waived||'0',10)||0;

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
        const existing = pi ? await sbGet(`bookings?payment_intent=eq.${encodeURIComponent(pi)}&select=id`) : [];
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
              });
              if (slot.coach_profile_id) await sbPost('notifications', {
                user_id: slot.coach_profile_id, type: 'booking', read: false,
                message: `📅 Nová rezervace (potvrzeno platbou) na ${slot.date} ${slot.time}.`,
              });
              await payAmbassador(slot.coach_profile_id, amount, currency, m.discipline, pi);
              await recordTransaction(event.account, pi, { type: 'coach_inperson', welcome_waived: _ww, member_id: m.student_id, coach_id: slot.coach_profile_id, plan: 'Lekce 1:1', gross: amount, currency });
            }
          } else if (m.booking_type === 'online' && m.coach_profile_id) {
            await sbPost('bookings', {
              slot_id: null, student_id: m.student_id || null, coach_id: m.coach_profile_id,
              coach_name: m.coach_name || 'Kouč', payment_intent: pi, amount,
              training_date: new Date().toISOString().slice(0, 10), training_time: null,
              status: 'active', type: 'online', currency, online_format: m.online_fmt || null, discipline: m.discipline || null,
            });
            await sbPost('notifications', {
              user_id: m.coach_profile_id, type: 'booking', read: false,
              message: `🌐 Nová online objednávka (potvrzeno platbou).`,
            });
            await payAmbassador(m.coach_profile_id, amount, currency, m.discipline, pi);
            await recordTransaction(event.account, pi, { type: 'coach_online', welcome_waived: _ww, member_id: m.student_id, coach_id: m.coach_profile_id, plan: m.online_fmt || 'Online', gross: amount, currency });
          }
        }
      } else if (m.mtl_payment_type === 'drop_in' || m.mtl_payment_type === 'membership') {
        // GYM skupinová lekce (direct charge na účtu gymu) → 0,5 % ambassadorovi disciplíny
        await payGymAmbassador(m.mtl_disc, parseInt(m.mtl_base || '0', 10), m.mtl_currency || 'CZK', s.id, s.payment_intent);
        if (m.mtl_payment_type === 'drop_in') { const dpi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id); if (dpi) await recordTransaction(event.account, dpi, { type: 'drop_in', welcome_waived: _ww, member_id: m.student_id || m.member_id, gym_id: m.gym_id, coach_id: m.coach_profile_id || m.coach_id, plan: m.mtl_plan || 'Drop-in', currency: m.mtl_currency || 'CZK', income_class: m.mtl_income || 'side' }); }
        else {
          // MEMBERSHIP (subscription): link the subscription to the row + record the FIRST payment NOW,
          // independent of client timing / the gym_memberships lookup (which used to fail on the first invoice).
          const sub = typeof s.subscription === 'string' ? s.subscription : (s.subscription && s.subscription.id);
          if (m.membership_id && sub) { try { await sbPatch('gym_memberships', `id=eq.${encodeURIComponent(m.membership_id)}`, { stripe_subscription: sub, status: 'active' }); } catch (e) { console.error('link sub', e.message); } }
          try {
            const invId = typeof s.invoice === 'string' ? s.invoice : (s.invoice && s.invoice.id);
            let payId = null;
            if (invId) { const invObj = await stripe.invoices.retrieve(invId, { stripeAccount: event.account }); payId = (typeof invObj.payment_intent === 'string' ? invObj.payment_intent : (invObj.payment_intent && invObj.payment_intent.id)) || (typeof invObj.charge === 'string' ? invObj.charge : (invObj.charge && invObj.charge.id)); }
            if (payId) await recordTransaction(event.account, payId, { type: 'membership', member_id: m.student_id || m.member_id, gym_id: m.gym_id, plan: m.mtl_plan || 'Membership', currency: m.mtl_currency || 'CZK', income_class: m.mtl_income || 'side' });
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
          const fee = (m.mtl_rate != null && m.mtl_rate !== '') ? Math.round(amount * parseFloat(m.mtl_rate) * 100) / 100 : ((m.mtl_welcome === '1') ? 0 : Math.round(amount * 0.03 * 100) / 100)  /* Stripe base 3% (was 0.035 = old ladder) */;
          await sbPost('cohort_payments', { cohort_member_id: cmId, cohort_id: cohId || null, kind: 'deposit', amount, currency: cur, mtl_fee: fee, stripe_pi: pi || null, status: 'paid', created_at: new Date().toISOString() });
          await sbPatch('cohort_members', `id=eq.${encodeURIComponent(cmId)}`, { status: 'deposit_paid' });
          try { const _cd = ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=discipline`)) || [])[0]; if (_cd && _cd.discipline) await payGymAmbassador(_cd.discipline, amount, cur, s.id, pi); } catch (e) { console.error('cohort amb deposit', e.message); }
          // NOTE follow-up: ambassador 0.5% on cohort deposits not wired yet (needs mtl_disc/mtl_base in metadata).
          try {
            const coh = cohId ? ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=owner_id,name,gym_id,deposit_amount,price_student,price_regular,currency,start_date,gym_meta_pixel,capi_token`)) || [])[0] : null;
            const mem = ((await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=name,email,tier,fbp,fbc`)) || [])[0];
            if (coh && coh.owner_id) await sbPost('notifications', { user_id: coh.owner_id, type: 'system', read: false, message: '\uD83D\uDCDA Nov\u00FD zaplacen\u00FD z\u00E1pis do kurzu' + (coh.name ? (' "' + coh.name + '"') : '') + '.' });
            if (mem && mem.email && coh) {
              let gymName = '';
              try { const g = await sbGet(`gyms?id=eq.${encodeURIComponent(coh.gym_id)}&select=name`); gymName = (g && g[0] && g[0].name) || ''; } catch (e) {}
              let ownerEmail = '';
              try { if (coh.owner_id) { const op = await sbGet(`profiles?id=eq.${encodeURIComponent(coh.owner_id)}&select=email`); ownerEmail = (op && op[0] && op[0].email) || ''; } } catch (e) {}
              const cur2 = (coh.currency || cur || 'CZK');
              const tierPrice = Number((mem.tier === 'student') ? coh.price_student : coh.price_regular) || 0;
              const remainder = Math.max(0, tierPrice - Number(coh.deposit_amount || 0));
              const money = (x) => Math.round(x) + ' ' + cur2;
              const fromName = (gymName || 'Martial Training Lab').replace(/["<>]/g, '');
              await sendResend(mem.email, (coh.name || 'Kurz') + ' \u2014 z\u00E1loha p\u0159ijata', cohortDepositHtml(mem.name, coh.name || 'Kurz', gymName, money(amount), remainder > 0 ? money(remainder) : '', coh.start_date || ''), { from: '"' + fromName + '" <' + MAIL_ADDR + '>', replyTo: ownerEmail || undefined });
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
          const fee = (m.mtl_rate != null && m.mtl_rate !== '') ? Math.round(amount * parseFloat(m.mtl_rate) * 100) / 100 : ((m.mtl_welcome === '1') ? 0 : Math.round(amount * 0.03 * 100) / 100)  /* Stripe base 3% (was 0.035 = old ladder) */;
          await sbPost('cohort_payments', { cohort_member_id: cmId, cohort_id: cohId || null, kind: 'first_month', amount, currency: cur, mtl_fee: fee, stripe_pi: pi || null, status: 'paid', created_at: new Date().toISOString() });
          await sbPatch('cohort_members', `id=eq.${encodeURIComponent(cmId)}`, { status: 'enrolled' });
          try { const _cd2 = ((await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(cohId)}&select=discipline`)) || [])[0]; if (_cd2 && _cd2.discipline) await payGymAmbassador(_cd2.discipline, amount, cur, s.id, pi); } catch (e) { console.error('cohort amb firstmonth', e.message); }
        }
      } else if (m.mtl_payment_type === 'partner_sub') {
        // Exclusive MTL Partner subscription zaplacena → zapni partner sazby
        const uid = m.user_id || s.client_reference_id;
        const sub = typeof s.subscription === 'string' ? s.subscription : (s.subscription && s.subscription.id);
        const cust = typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id);
        if (uid) {
          await sbPatch('profiles', `id=eq.${encodeURIComponent(uid)}`, { partner: true, partner_sub: sub || null, stripe_customer: cust || null });
          await rerateGymMemberships(uid, 3); // existující členství → 3 % od příští faktury (Exclusive Partner)
          await sbPost('notifications', { user_id: uid, type: 'system', read: false, data: JSON.stringify({ kind: 'partner_granted' }), message: '⭐ Teď jsi Exclusive MTL Partner! Ze všeho (lekce, členství, eventy, kurzy) si necháváš 99 % — provize MTL jen 1 %. A když ti MTL přivede nového člena přes objevení v appce, máš akvizici za půlku: 5 % místo 10 % (první 2 měsíce členství / první 1:1 lekce), pak zpět na 1 %. 🥊' });
          await sbPost('notifications', { user_id: '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c', type: 'system', read: false, message: `⭐ Nový Exclusive MTL Partner (user ${uid}).` });
        }
      } else if (m.mtl_payment_type === 'event_ticket') {
        // Event ticket (direct charge on payee account) — backstop confirm if user closed tab before redirect
        if (m.ticket_id) {
          const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id);
          await sbPatch('event_tickets', `id=eq.${encodeURIComponent(m.ticket_id)}`, { status: 'paid', stripe_ref: pi });
          await recordTransaction(event.account, pi, { type: 'event_ticket', welcome_waived: _ww, member_id: m.student_id || m.buyer_id, gym_id: m.gym_id, coach_id: m.payout_coach_id, plan: m.mtl_event || 'Event', currency: m.mtl_currency || 'CZK', income_class: m.mtl_income || 'side' });
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
      const rows = await sbGet(`profiles?partner_sub=eq.${encodeURIComponent(sub.id)}&select=id`);
      const uid = rows[0] && rows[0].id;
      if (uid) {
        await sbPatch('profiles', `id=eq.${encodeURIComponent(uid)}`, { partner: false, partner_sub: null });
        await rerateGymMemberships(uid, 5); // zpět na 5 % od příští faktury
        await sbPost('notifications', { user_id: uid, type: 'system', read: false, data: JSON.stringify({ kind: 'partner_ended' }), message: '⭐ Teď už nejsi Exclusive MTL Partner. Děkujeme za tvoji přízeň! Provize se vrátila na standard 3,5 % (dle MTL Ligy případně 3 % nebo 2 %).' });
      }
    } else if (event.type === 'charge.dispute.created') {
      const d = event.data.object;
      const pi = typeof d.payment_intent === 'string' ? d.payment_intent : (d.payment_intent && d.payment_intent.id);
      if (pi) await sbPatch('bookings', `payment_intent=eq.${encodeURIComponent(pi)}`, { refund_requested: true, refund_reason: '(DISPUTE přes Stripe)' });
    } else if (event.type === 'invoice.paid') {
      // Renewal of a membership subscription on a connected (gym) account -> extend the period
      const inv = event.data.object;
      const sub = typeof inv.subscription === 'string' ? inv.subscription : (inv.subscription && inv.subscription.id);
      if (sub) {
        let periodEnd = null;
        try { const line = inv.lines && inv.lines.data && inv.lines.data[0]; if (line && line.period && line.period.end) periodEnd = new Date(line.period.end * 1000).toISOString(); } catch (e) {}
        const patch = { status: 'active', payment_status: 'ok', payment_failed_at: null, last_invoice_url: null };
        if (periodEnd) patch.period_end = periodEnd;
        await sbPatch('gym_memberships', `stripe_subscription=eq.${encodeURIComponent(sub)}`, patch);
        try { const ipi = (typeof inv.payment_intent === 'string' ? inv.payment_intent : (inv.payment_intent && inv.payment_intent.id)) || (typeof inv.charge === 'string' ? inv.charge : (inv.charge && inv.charge.id)); const mem = (await sbGet(`gym_memberships?stripe_subscription=eq.${encodeURIComponent(sub)}&select=*`))[0]; let _wwMemb=0, _incClass='side'; try{ const _so=await stripe.subscriptions.retrieve(sub,{stripeAccount:event.account}); if(_so&&_so.metadata){ _incClass=_so.metadata.mtl_income||'side'; if((inv.application_fee_amount||0)===0){ const _br=parseFloat(_so.metadata.mtl_acq_base||'0')||0; if(_br>0) _wwMemb=Math.round((inv.amount_paid||inv.total||0)*_br/100); } } }catch(e){ console.error('memb meta',e.message); }
        // THE ACQUISITION DROP that pay.js's own comment promised and nobody ever wrote.
        // Two invoices paid = the 2-month window is done -> the sub falls to the provider's
        // CURRENT ladder rate (recomputed live, not the stale mtl_acq_base in metadata).
        try{
          const _so2 = await stripe.subscriptions.retrieve(sub, { stripeAccount: event.account });
          const _mem2 = (await sbGet(`gym_memberships?stripe_subscription=eq.${encodeURIComponent(sub)}&select=gym_id,coach_id,paid_to`))[0];
          let _ownerId = null;
          if (_mem2 && _mem2.paid_to === 'coach' && _mem2.coach_id) _ownerId = _mem2.coach_id;
          else if (_mem2 && _mem2.gym_id) { const _g=(await sbGet(`gyms?id=eq.${_mem2.gym_id}&select=owner_id,welcome_free_until`))[0]; _ownerId = _g && _g.owner_id; }
          if (_ownerId) {
            const _op = (await sbGet(`profiles?id=eq.${_ownerId}&select=partner,coach_ref_score,bankai_eligible,welcome_free_until`))[0] || {};
            const _sc = _op.coach_ref_score || 0;
            const _ladder = _op.partner ? 1 : ((_sc >= 5 && _op.bankai_eligible) ? 2 : (_sc >= 2 ? 2.5 : 3));
            const _wActive = !!(_op.welcome_free_until && new Date(_op.welcome_free_until).getTime() > Date.now());
            await applySubRate(stripe, event.account, sub, _so2, _ladder, _wActive);
          }
        }catch(e){ console.error('acq drop', e.message); } if (ipi && mem) await recordTransaction(event.account, ipi, { type: 'membership', welcome_waived: _wwMemb, income_class: _incClass, member_id: mem.student_id || mem.member_id, gym_id: mem.gym_id, coach_id: mem.coach_id, plan: mem.plan_name || 'Membership', currency: inv.currency }); } catch (e) { console.error('record membership', e.message); }
      }
    } else if (event.type === 'invoice.payment_failed') {
      const inv = event.data.object;
      const sub = typeof inv.subscription === 'string' ? inv.subscription : (inv.subscription && inv.subscription.id);
      if (sub) {
        await sbPatch('gym_memberships', `stripe_subscription=eq.${encodeURIComponent(sub)}`, { payment_status: 'past_due', payment_failed_at: new Date().toISOString(), last_invoice_url: inv.hosted_invoice_url || null });
        try { const mem = (await sbGet(`gym_memberships?stripe_subscription=eq.${encodeURIComponent(sub)}&select=*`))[0]; if (mem && (mem.student_id || mem.member_id)) await sbPost('notifications', { user_id: mem.student_id || mem.member_id, type: 'system', read: false, data: JSON.stringify({ kind: 'membership_payment_failed', url: inv.hosted_invoice_url || '', gym_id: mem.gym_id }), message: '⚠️ Platba členství ' + (mem.plan_name || '') + ' se nezdařila. Aktualizuj kartu / zaplať odkaz v appce.' }); } catch (e) { console.error('notify failed pay', e.message); }
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
