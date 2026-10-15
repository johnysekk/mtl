// EXCLUSIVE PARTNER -- zápis stupně do profilu a zprávy o něm. Jedno místo pro všechny cesty:
//   * zaplacení EP (webhook checkout.session.completed a /api/session při návratu z platby),
//   * přechod na vyšší stupeň (pay.js partner_change, a webhook, když banka chtěla potvrzení),
//   * přechod na nižší stupeň na konci období (webhook při zaplacení obnovy).
// Ceník je v _rate.js (EP_TIERS). Tady se jen zapisuje, CO kdo má, a posílají se zprávy.
import { EP_TIERS, EP_TIER_NAMES, EP_DEFAULT_TIER, epTierKey } from './_rate.js';
import { rerateOwner } from './gym-rerate.js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// Běží předplatné? (aktivní, zkušební, nebo čeká na zaplacení obnovy)
async function _live(subId) {
  if (!subId) return null;
  try { const s = await stripe.subscriptions.retrieve(String(subId)); return (['active', 'trialing', 'past_due'].indexOf(s.status) >= 0) ? s : null; }
  catch (e) { return null; }
}
const ORDER = ['genin', 'chunin', 'jonin', 'kage'];

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H }); return r.ok ? r.json() : []; } catch (e) { return []; }
}
async function sbPatch(path, body, ret) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...H, Prefer: ret ? 'return=representation' : 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) { console.error('ep sbPatch', r.status, (await r.text()).slice(0, 300)); return ret ? [] : false; }
    return ret ? ((await r.json().catch(() => [])) || []) : true;
  } catch (e) { console.error('ep sbPatch', e.message); return ret ? [] : false; }
}
async function sbPost(path, body) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) console.error('ep sbPost', path, r.status, (await r.text()).slice(0, 300));
  } catch (e) { console.error('ep sbPost', path, e.message); }
}

const _pct = (r, en) => { const v = Math.round(r * 10000) / 100; return en ? (v + '%') : (String(v).replace('.', ',') + ' %'); };
// Co stupeň dává, jednou větou (zprávy, e-maily).
export function epPerks(tier, en) {
  const T = EP_TIERS[tier] || EP_TIERS[EP_DEFAULT_TIER];
  const cards = tier === 'kage'
    ? (en ? 'up to 20 partners on your club profile (10 on the club card)' : 'až 20 partnerů na profilu klubu (10 na kartě klubu)')
    : (en ? `up to ${T.partners} partners on your club card` : `až ${T.partners} partnerů na kartě klubu`);
  return en
    ? [T.rate > 0 ? `MTL commission ${_pct(T.rate, en)} on every payment` : 'no MTL commission',
       T.acq > 0 ? `${_pct(T.acq, en)} from a member who finds you in the app` : 'no fee for members who find you in the app',
       `${_pct(T.ads, en)} from a member who comes from an MTL ad`, cards].join(', ')
    : [T.rate > 0 ? `provize MTL ${_pct(T.rate, en)} z každé platby` : 'bez provize MTL',
       T.acq > 0 ? `z člena, který tě najde v appce, ${_pct(T.acq, en)}` : 'za člena, který tě najde v appce, nic',
       `z člena z reklamy MTL ${_pct(T.ads, en)}`, cards].join(', ');
}
const _name = (t) => EP_TIER_NAMES[t] || EP_TIER_NAMES[EP_DEFAULT_TIER];
const _d = (iso, en) => { try { return new Date(iso).toLocaleDateString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague' }); } catch (e) { return String(iso || '').slice(0, 10); } };
const _money = (amt, en, cur) => { const c = String(cur || 'CZK').toUpperCase(); return Number(amt).toLocaleString(en ? 'en-GB' : 'cs-CZ') + (c === 'CZK' ? (en ? ' CZK' : ' Kč') : (c === 'EUR' ? ' €' : (' ' + c))); };

async function _who(uid) {
  const p = ((await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=name,email,coach_status`)) || [])[0] || {};
  const g = ((await sbGet(`gyms?owner_id=eq.${encodeURIComponent(uid)}&select=id,name&limit=1`)) || [])[0] || null;
  return { p, g, label: (p.name || p.email || 'bez jména') + (g ? (' · klub ' + (g.name || '')) : (p.coach_status === 'approved' ? ' · kouč' : '')) + (p.email && p.name ? (' · ' + p.email) : '') };
}
async function _notify(uid, kind, cs, en, extra) {
  await sbPost('notifications', { user_id: uid, type: 'system', read: false,
    data: JSON.stringify(Object.assign({ kind, msg_cs: cs, msg_en: en }, extra || {})), message: cs });
}
async function _notifyFounder(uid, text) {
  const fid = (process.env.FOUNDER_UUID || '').trim(); if (!fid) return;
  try {
    const w = await _who(uid);
    await sbPost('notifications', { user_id: fid, type: 'system', read: false,
      data: JSON.stringify({ kind: 'new_provider', what: 'partner', user_id: uid, gym_id: w.g ? w.g.id : null }),
      message: text.replace('{who}', w.label) });
  } catch (e) { console.error('ep founder notif', e.message); }
}
const _withFounding = (arr, tier, on) => {
  const a = Array.isArray(arr) ? arr.slice() : [];
  if (on && a.indexOf(tier) < 0) a.push(tier);
  return a;
};

// EP ZAPLACENO. Zapíše se jen jednou: kdo první přepne partner_sub na tohle předplatné, ten
// přepočítá sazby a pošle zprávy (webhook a /api/session se mohou potkat). Předplatné musí
// opravdu běžet a nesmí přepsat jiné běžící -- jinak by šlo starou zaplacenou session
// (/api/session nechce přihlášení) přehrát a EP si vrátit po zrušení nebo zvýšit stupeň.
export async function activatePartner(s) {
  const m = (s && s.metadata) || {};
  const uid = m.user_id || s.client_reference_id;
  const sub = typeof s.subscription === 'string' ? s.subscription : (s.subscription && s.subscription.id);
  const cust = typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id);
  if (!uid || !sub) return false;
  const tier = epTierKey(m.ep_tier) || EP_DEFAULT_TIER;
  const founding = m.ep_founding === '1';
  // Cena se ukládá MĚSÍČNÍ (ep_month), i u ročního EP -- ceník a Admin pracují s měsíční.
  const paid = m.ep_month ? Number(m.ep_month) : null;
  const pcur = String(s.currency || 'czk').toUpperCase();
  if (!(await _live(sub))) return false;
  const cur = ((await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=ep_founding,partner_sub`)) || [])[0];
  if (!cur || cur.partner_sub === sub) return false;                         // už zapsané
  if (cur.partner_sub && (await _live(cur.partner_sub))) return false;      // běží jiné předplatné
  const cond = cur.partner_sub ? `partner_sub=eq.${encodeURIComponent(cur.partner_sub)}` : 'partner_sub=is.null';
  const rows = await sbPatch(`profiles?id=eq.${encodeURIComponent(uid)}&${cond}`, {
    partner: true, partner_tier: tier, partner_tier_next: null, partner_tier_from: null,
    ep_founding: _withFounding(cur.ep_founding, tier, founding),
    partner_sub: sub, stripe_customer: cust || null, partner_cancelling: false, partner_period_end: null,
    ...(paid ? { partner_price: paid, partner_currency: pcur } : {}),
  }, true);
  if (!rows.length) return false;                       // už zapsal někdo jiný
  // Existující členství a online předplatné -> sazba stupně od jejich příští platby.
  try { await rerateOwner(uid); } catch (e) { console.error('ep rerate', e.message); }
  const yr = m.ep_interval === 'year';
  await _notify(uid, 'partner_granted',
    `⭐ Jsi Exclusive MTL Partner ${_name(tier)}: ${epPerks(tier, false)}. Platí i pro stávající členství od jejich příští platby. Stupeň změníš kdykoli v nabídce Exclusive Partner. 🥊`,
    `⭐ You are an Exclusive MTL Partner ${_name(tier)}: ${epPerks(tier, true)}. Existing memberships switch at their next payment. You can change your tier any time under Exclusive Partner. 🥊`,
    { tier });
  await _notifyFounder(uid, `⭐ Nový Exclusive MTL Partner ${_name(tier)}: {who}` + (paid ? (` · ${_money(paid, false, pcur)}/měs. bez DPH` + (founding ? ' (zakládající cena)' : '') + (yr ? ', roční předplatné' : '')) : '') + '.');
  return true;
}

// PŘECHOD NA VYŠŠÍ STUPEŇ PO ZAPLACENÍ ROZDÍLU. Volá pay.js hned po úspěšném stržení a webhook
// u faktury za přechod (když banka chtěla platbu potvrdit). Jen nahoru a jen u téhož předplatného:
// opožděný nebo opakovaný webhook tak nevrátí starší stupeň ani nezapne EP po jeho konci.
export async function applyEpUpgrade(uid, tier, { founding, month, subId, currency } = {}) {
  tier = epTierKey(tier); if (!uid || !tier || !subId) return false;
  const cur = ((await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=ep_founding,partner_tier,partner_sub`)) || [])[0];
  if (!cur || cur.partner_sub !== subId) return false;
  if (ORDER.indexOf(tier) <= ORDER.indexOf(epTierKey(cur.partner_tier) || EP_DEFAULT_TIER)) return false;
  const rows = await sbPatch(`profiles?id=eq.${encodeURIComponent(uid)}&partner_sub=eq.${encodeURIComponent(subId)}&${cur.partner_tier ? `partner_tier=eq.${encodeURIComponent(cur.partner_tier)}` : 'partner_tier=is.null'}`, {
    partner: true, partner_tier: tier, partner_tier_next: null, partner_tier_from: null,
    ep_founding: _withFounding(cur.ep_founding, tier, !!founding),
    ...(month ? { partner_price: Number(month), partner_currency: String(currency || 'CZK').toUpperCase() } : {}),
  }, true);
  if (!rows.length) return false;
  try { await rerateOwner(uid); } catch (e) { console.error('ep up rerate', e.message); }
  await _notify(uid, 'ep_tier_up',
    `⭐ Přešel jsi na Exclusive MTL Partner ${_name(tier)}: ${epPerks(tier, false)}. Rozdíl za zbytek období je zaplacený a faktura vystavená; stávající členství se přepnou od jejich příští platby.`,
    `⭐ You moved up to Exclusive MTL Partner ${_name(tier)}: ${epPerks(tier, true)}. The difference for the rest of the period is paid and invoiced; existing memberships switch at their next payment.`,
    { tier });
  await _notifyFounder(uid, `⬆️ Exclusive Partner {who} přešel na ${_name(tier)}` + (month ? ` · ${_money(month, false, currency)}/měs. bez DPH` : '') + '.');
  return true;
}

// PŘECHOD NA NIŽŠÍ STUPEŇ NAPLÁNOVÁN (pay.js). Platí od konce zaplaceného období.
export async function notifyEpDowngradeScheduled(uid, from, to, atIso) {
  await _notify(uid, 'ep_tier_down_scheduled',
    `🗓️ Od ${_d(atIso, false)} přejdeš na Exclusive MTL Partner ${_name(to)}: ${epPerks(to, false)}. Do té doby ti zůstává ${_name(from)}. Přechod můžeš do té doby zrušit v nabídce Exclusive Partner.`,
    `🗓️ From ${_d(atIso, true)} you move to Exclusive MTL Partner ${_name(to)}: ${epPerks(to, true)}. Until then you keep ${_name(from)}. You can cancel the change until then under Exclusive Partner.`,
    { tier: to, from, at: atIso });
  await _notifyFounder(uid, `⬇️ Exclusive Partner {who} přejde od ${_d(atIso, false)} z ${_name(from)} na ${_name(to)}.`);
}

// NIŽŠÍ STUPEŇ NASTAL (webhook při zaplacení první faktury nového období).
// Zakládající cenu nižšího stupně (founding) si člověk drží od chvíle, kdy přechod nastal.
export async function applyEpDowngrade(uid, periodStartIso, { month, founding, subId, currency } = {}) {
  const p = ((await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=partner_tier,partner_tier_next,partner_tier_from,partner_sub,ep_founding`)) || [])[0];
  const to = p && epTierKey(p.partner_tier_next);
  if (!to || !subId || p.partner_sub !== subId) return null;
  // Faktura musí patřit do období, od kterého přechod platí (hodina rezervy na zaokrouhlení).
  if (p.partner_tier_from && periodStartIso && Date.parse(periodStartIso) < Date.parse(p.partner_tier_from) - 3600000) return null;
  const T = EP_TIERS[to];
  const rows = await sbPatch(`profiles?id=eq.${encodeURIComponent(uid)}&partner_sub=eq.${encodeURIComponent(subId)}&partner_tier_next=eq.${to}`, {
    partner_tier: to, partner_tier_next: null, partner_tier_from: null, ep_founding: _withFounding(p.ep_founding, to, !!founding),
    ...(month ? { partner_price: Number(month), partner_currency: String(currency || 'CZK').toUpperCase() } : {}),
  }, true);
  if (!rows.length) return null;
  try { await rerateOwner(uid); } catch (e) { console.error('ep down rerate', e.message); }
  await _notify(uid, 'ep_tier_down',
    `⭐ Od dnešního období jsi Exclusive MTL Partner ${_name(to)}: ${epPerks(to, false)}. Stávající členství se přepnou od jejich příští platby.` + (T.partners < 20 ? ` Partneři nad počet ${T.partners} se na kartě klubu skryjí, nesmažou se.` : ''),
    `⭐ From this period you are an Exclusive MTL Partner ${_name(to)}: ${epPerks(to, true)}. Existing memberships switch at their next payment.` + (T.partners < 20 ? ` Partners beyond ${T.partners} are hidden on your club card, not deleted.` : ''),
    { tier: to });
  return to;
}
