// EXCLUSIVE PARTNER -- zápis stupně do profilu a zprávy o něm. Jedno místo pro všechny cesty:
//   * zaplacení EP (webhook checkout.session.completed a /api/session při návratu z platby),
//   * přechod na vyšší stupeň (pay.js partner_change, a webhook, když banka chtěla potvrzení),
//   * přechod na nižší stupeň na konci období (webhook při zaplacení obnovy).
// Ceník je v _rate.js (EP_TIERS). Tady se jen zapisuje, CO kdo má, a posílají se zprávy.
import { EP_TIERS, EP_TIER_NAMES, EP_DEFAULT_TIER, EP_YEAR_MONTHS, epTierKey, epTierOf, epAmount, epRefDisc } from './_rate.js';
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

// PŘECHOD Z MĚSÍČNÍ NA ROČNÍ PLATBU ZAPLACEN. Volá pay.js hned po stržení a webhook u faktury za
// přechod (když banka chtěla platbu potvrdit). Proběhne jednou: kdo první smaže z předplatného
// ep_interval_pending, ten zapíše roční interval do metadat a pošle zprávy.
export async function finishEpYearly(uid, subId, { paid, currency } = {}) {
  let s = null; try { s = await stripe.subscriptions.retrieve(String(subId)); } catch (e) { return false; }
  const md = (s && s.metadata) || {};
  if (md.ep_interval_pending !== 'year' || ['active', 'trialing', 'past_due'].indexOf(s.status) < 0) return false;
  const it = s.items && s.items.data && s.items.data[0];
  const unit = it && it.price ? it.price.unit_amount : 0;
  const cur = String(currency || (it && it.price && it.price.currency) || 'czk').toUpperCase();
  try { await stripe.subscriptions.update(s.id, { metadata: { ep_interval: 'year', ep_amount: String(unit / 100), ep_interval_pending: '' } }); }
  catch (e) { console.error('ep yearly md', e.message); return false; }
  const peS = s.current_period_end || (it && it.current_period_end) || null;
  const pe = peS ? new Date(peS * 1000).toISOString() : null;
  if (pe) await sbPatch(`profiles?id=eq.${encodeURIComponent(uid)}&partner_sub=eq.${encodeURIComponent(subId)}`, { partner_renews_at: pe });
  const tier = epTierKey(md.ep_tier) || EP_DEFAULT_TIER;
  const pd = (paid != null) ? Number(paid) : null;
  await _notify(uid, 'ep_interval_year',
    `💳 Exclusive MTL Partner ${_name(tier)} teď platíš ročně: ${_money(unit / 100, false, cur)} za rok bez DPH (10 měsíců, 2 zdarma).`
      + (pd != null ? ` Z karty se strhlo ${_money(pd, false, cur)} — roční cena minus nevyčerpané dny měsíčního předplatného.` : '')
      + ` Fakturu najdeš ve Fakturách za předplatné.` + (pe ? ` Další platba ${_d(pe, false)}.` : ''),
    `💳 You now pay for Exclusive MTL Partner ${_name(tier)} yearly: ${_money(unit / 100, true, cur)} a year excl. VAT (10 months, 2 free).`
      + (pd != null ? ` ${_money(pd, true, cur)} was charged — the yearly price minus the unused days of your monthly subscription.` : '')
      + ` The invoice is under Subscription invoices.` + (pe ? ` Next payment ${_d(pe, true)}.` : ''),
    { tier, interval: 'year' });
  await _notifyFounder(uid, `🔁 Exclusive Partner {who} přešel na roční platbu · ${_money(unit / 100, false, cur)}/rok bez DPH.`);
  return true;
}

// PLÁN „OD KONCE ROKU MĚSÍČNĚ" (subscription schedule): do konce zaplaceného roku dnešní cena,
// pak měsíční za monthUnit (haléře/centy). Po jedné měsíční iteraci se plán uvolní a předplatné
// běží měsíčně samo. Volá pay.js (přechod na měsíční) a repriceEpForRefDisc (nová cena po slevě).
// Při chybě plán uvolní a vyhodí výjimku.
// Jen interval a počet: cena načtená ze Stripe nese i prázdná pole (meter, trial_period_days…),
// která by prices.create odmítl.
const _rec = (r) => ({ interval: r.interval, interval_count: r.interval_count || 1 });
// PRODUKT PŘEDPLATNÉHO MUSÍ BÝT AKTIVNÍ. První platba ho založí přes price_data.product_data a
// Stripe takový produkt vede jako neaktivní: novou cenu na něm vytvoří, ale předplatné na ni
// nepřevede („The product … is marked as inactive"). Proto se před každou změnou ceny zapne.
export async function epEnsureProduct(product) {
  try {
    const pr = await stripe.products.retrieve(product);
    if (pr && pr.active === false) await stripe.products.update(product, { active: true });
  } catch (e) { console.error('[ep] product activate', e.message); }
  return product;
}
async function _monthPrice(it, monthUnit) {
  const product = typeof it.price.product === 'string' ? it.price.product : it.price.product.id;
  await epEnsureProduct(product);
  const rec = it.price.recurring || {};
  return stripe.prices.create({ currency: it.price.currency, product, unit_amount: monthUnit,
    recurring: rec.interval === 'day' ? _rec(rec) : { interval: 'month', interval_count: 1 } });   // test: denně
}
const _phases = (p0, priceId, monthUnit) => [
  { items: p0.items.map((i) => ({ price: typeof i.price === 'string' ? i.price : i.price.id, quantity: i.quantity || 1 })),
    start_date: p0.start_date, end_date: p0.end_date, proration_behavior: 'none' },
  { items: [{ price: priceId, quantity: 1 }], iterations: 1, proration_behavior: 'none',
    metadata: { ep_interval: 'month', ep_amount: String(monthUnit / 100), ep_interval_next: '' } },
];
export async function epScheduleMonthly(sub, monthUnit, uid) {
  const it = sub.items.data[0];
  let sc = null;
  try {
    const np = await _monthPrice(it, monthUnit);
    sc = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
    await stripe.subscriptionSchedules.update(sc.id, { end_behavior: 'release', metadata: { ep_switch: 'month', user_id: uid }, phases: _phases(sc.phases[0], np.id, monthUnit) });
  } catch (e) {
    if (sc && sc.id) { try { await stripe.subscriptionSchedules.release(sc.id); } catch (e2) {} }
    throw e;
  }
}

// SLEVA Z EP ZA SHIKAI / BANKAI (20 / 50 %, _rate.js) U BĚŽÍCÍHO PŘEDPLATNÉHO. Volá referral-cron
// (skóre přivedených vzrostlo) a bankai-cron (Bankai potvrzený). Nová cena platí od další platby,
// běžící období se nepřepočítává. Jen dolů: kdo už platí stejně nebo méně, nic se nemění.
// Naplánovaný přechod dolů dostane slevu taky (cena příštího období i částka pro jeho zrušení);
// naplánovaný přechod na měsíční platbu se založí znovu s měsíční cenou po slevě.
export async function repriceEpForRefDisc(uid) {
  const p = ((await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=partner,partner_tier,partner_tier_next,partner_sub,ep_founding,coach_ref_score,bankai_eligible`)) || [])[0];
  const tier = epTierOf(p);
  if (!tier || !p.partner_sub) return false;
  const disc = epRefDisc(p); if (!disc) return false;
  const s = await _live(p.partner_sub);
  if (!s || s.cancel_at_period_end) return false;
  const md = s.metadata || {};
  if ((Number(md.ep_ref_disc) || 0) >= disc) return false;                       // tuhle slevu už má
  const it = s.items && s.items.data && s.items.data[0]; if (!it || !it.price) return false;
  const cur = String(it.price.currency || 'czk').toUpperCase();
  const rec = it.price.recurring || {};
  const yearly = rec.interval === 'year' || (rec.interval === 'day' && md.ep_interval === 'year');
  const mult = yearly ? EP_YEAR_MONTHS : 1;
  const has = (t) => Array.isArray(p.ep_founding) && p.ep_founding.indexOf(t) >= 0;
  const monthNow = epAmount(tier, cur, has(tier), disc);
  const next = epTierKey(p.partner_tier_next);
  const mNext = next ? epAmount(next, cur, md.ep_founding_next === '1' || has(next), disc) : null;
  const newUnit = (next ? mNext : monthNow) * mult * 100;
  const oldUnit = it.price.unit_amount;
  const metadata = { ep_ref_disc: String(disc), ep_month: String(monthNow),
    ...(next ? { ep_month_next: String(mNext), ep_prev_amount: String(Math.min(Number(md.ep_prev_amount) || Infinity, monthNow * mult * 100)) } : {}) };
  const product = typeof it.price.product === 'string' ? it.price.product : it.price.product.id;
  let from = null, newShown = null, oldShown = null, per = yearly ? 'year' : 'month';
  try {
    if (s.schedule) {
      // Naplánovaný přechod na měsíční: roční období doběhne, měsíční cena se sníží.
      const scId = typeof s.schedule === 'string' ? s.schedule : s.schedule.id;
      const sc = await stripe.subscriptionSchedules.retrieve(scId);
      if ((sc.metadata || {}).ep_switch !== 'month') return false;
      const mUnit = monthNow * 100, mOld = Math.round(oldUnit / EP_YEAR_MONTHS);
      if (mUnit >= mOld) { await stripe.subscriptions.update(s.id, { metadata: { ep_ref_disc: String(disc) } }); return false; }
      // Plán se upraví na místě (ne uvolnit a založit znovu): když úprava selže, přechod na
      // měsíční zůstane, jak byl -- jen bez slevy, a zkusí se to při dalším běhu.
      const np = await _monthPrice(it, mUnit);
      await stripe.subscriptionSchedules.update(scId, { phases: _phases(sc.phases[0], np.id, mUnit) });
      await stripe.subscriptions.update(s.id, { metadata: Object.assign({ ep_interval_next: 'month' }, metadata) });
      newShown = mUnit / 100; oldShown = mOld / 100; per = 'month';
    } else {
      if (newUnit >= oldUnit) { await stripe.subscriptions.update(s.id, { metadata: { ep_ref_disc: String(disc) } }); return false; }
      await epEnsureProduct(product);
      const np = await stripe.prices.create({ currency: it.price.currency, product, unit_amount: newUnit, recurring: _rec(rec) });
      await stripe.subscriptions.update(s.id, { items: [{ id: it.id, price: np.id }], proration_behavior: 'none', metadata });
      newShown = newUnit / 100; oldShown = oldUnit / 100;
    }
  } catch (e) { console.error('ep ref disc', e.message); return false; }
  const peS = s.current_period_end || it.current_period_end || null;
  from = peS ? new Date(peS * 1000).toISOString() : null;
  if (!next) await sbPatch(`profiles?id=eq.${encodeURIComponent(uid)}&partner_sub=eq.${encodeURIComponent(s.id)}`, { partner_price: monthNow });
  const lvl = disc >= 0.5 ? 'Bankai' : 'Shikai';
  const pct = Math.round(disc * 100);
  const perCs = per === 'year' ? '/rok' : '/měs', perEn = per === 'year' ? '/year' : '/mo';
  await _notify(uid, 'ep_ref_disc',
    `🎉 Máš ${lvl}: Exclusive MTL Partner ${_name(next || tier)} ti ${from ? `od další platby (${_d(from, false)})` : 'od další platby'} zlevní o ${pct} % — ${_money(newShown, false, cur)}${perCs} místo ${_money(oldShown, false, cur)}${perCs} bez DPH. Sleva ti zůstává natrvalo, sčítá se se zakládající cenou a platí i po změně stupně.`,
    `🎉 You reached ${lvl}: Exclusive MTL Partner ${_name(next || tier)} gets ${pct}% cheaper ${from ? `from your next payment (${_d(from, true)})` : 'from your next payment'} — ${_money(newShown, true, cur)}${perEn} instead of ${_money(oldShown, true, cur)}${perEn} excl. VAT. The discount stays for good, adds up with the founding price and applies after a tier change too.`,
    { tier: next || tier, disc });
  await _notifyFounder(uid, `🎉 Exclusive Partner {who} má ${lvl}: EP o ${pct} % levněji od další platby (${_money(newShown, false, cur)}${perCs}).`);
  return true;
}

// PŘECHOD Z ROČNÍ NA MĚSÍČNÍ PLATBU NAPLÁNOVÁN (pay.js). Platí od konce zaplaceného roku.
export async function notifyEpMonthlyScheduled(uid, tier, { month, currency, atIso } = {}) {
  const t = epTierKey(tier) || EP_DEFAULT_TIER;
  await _notify(uid, 'ep_interval_month_scheduled',
    `🗓️ Od ${_d(atIso, false)} platíš Exclusive MTL Partner ${_name(t)} měsíčně: ${_money(month, false, currency)}/měs bez DPH, první měsíční platba ${_d(atIso, false)}. Do té doby běží zaplacený rok a nic se z něj nevrací. Přechod můžeš do té doby zrušit v nabídce Exclusive Partner.`,
    `🗓️ From ${_d(atIso, true)} you pay for Exclusive MTL Partner ${_name(t)} monthly: ${_money(month, true, currency)}/mo excl. VAT, first monthly payment on ${_d(atIso, true)}. Until then your paid year runs on and nothing from it is refunded. You can cancel the change until then under Exclusive Partner.`,
    { tier: t, interval: 'month', at: atIso });
  await _notifyFounder(uid, `🔁 Exclusive Partner {who} přejde od ${_d(atIso, false)} z roční na měsíční platbu (${_money(month, false, currency)}/měs).`);
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
