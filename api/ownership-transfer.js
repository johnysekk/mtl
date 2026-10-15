// /api/ownership-transfer — PŘEVOD VLASTNICTVÍ KLUBU NEBO ORGANIZACE.
//
// POST { action, ... }   (přihlášený uživatel; token v x-access-token nebo Authorization)
//   request { kind:'gym', id, to }          majitel klubu -> aktivní spolumajitel (to = id profilu)
//   request { kind:'org', id, email, sub_offer }   majitel organizace -> libovolný účet MTL podle e-mailu;
//                                           sub_offer = dosavadní majitel nabízí, že předplatné profilu
//                                           dodavatele bude dál platit ze své karty
//   get     { id }                          podrobnosti převodu (příjemce, odesílatel, founder)
//   accept  { id, sub_choice }              příjemce převezme -- teprve tady se vlastnictví mění;
//                                           u dodavatele s běžícím předplatným vybere keep / own / cancel
//   decline { id }                          příjemce odmítne
//   cancel  { id }                          odesílatel žádost stáhne
//   admin   { kind, id, to | email, keep_old, sub_choice }   founder převede rovnou, bez potvrzení
//   paying  {}                              předplatná profilu dodavatele, která volající platí za
//                                           organizace, které už nevlastní (Platby a provize)
//
// CO SE PŘI PŘEVODU DĚJE (execute):
//   * owner_id na nového majitele. Zakladatel (gyms.founder_id) se nemění.
//   * KARTA NA PROVIZI SE ODPOJÍ: je to karta předchozího majitele a nikdo jiný ji nesmí
//     zatěžovat. Nový majitel přidá svou (klub: Nastavení klubu → Režim plateb a výplatní účet,
//     organizace: Platby a provize organizace).
//   * Klub: nový majitel přestane být spolumajitelem (je majitel); předchozí se jím stane
//     (keep_old), dokud ho nový neodebere. Záznam jde do historie klubu (gym_audit).
//   * Dodavatel s běžícím předplatným profilu -- podle volby nového majitele (sub_choice):
//       keep   dál platí karta dosavadního majitele (jen když to sám nabídl). Zastavit ho může
//              kdykoli on (Platby a provize) i nový majitel; nový ho může převzít na svou kartu (pay.js).
//       own    staré se ukončí ke konci období a nový majitel si hned založí navazující (první
//              platba v den konce, profil běží bez přerušení).
//       cancel staré doběhne a skončí.
//   * Stripe účet a fakturační údaje patří klubu / organizaci (právnímu subjektu), ne člověku:
//     zůstávají. Nový majitel je dostane v notifikaci ke kontrole.
//   * Oba dostanou notifikaci v appce a e-mail s proklikem.
import Stripe from 'stripe';
import { sbGet, sbWrite, esc, providerNotify, providerMail, APP, FOUNDER_UUID } from './_provider-mail.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
const EXPIRE_DAYS = 14;
const CARD_OFF = { commission_card_customer: null, commission_card_pm: null, commission_card_brand: null, commission_card_last4: null,
  commission_card_exp: null, commission_card_status: null, commission_card_added_at: null };

const one = async (path) => ((await sbGet(path)) || [])[0] || null;
const prof = (id) => one(`profiles?id=eq.${q(id)}&select=id,name,email,lang,deleted_at`);
const czDate = (d, en) => { try { return new Date(d).toLocaleDateString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric' }); } catch (e) { return ''; } };
const xferLink = (id) => `${APP}/?go=xfer&id=${q(id)}`;

async function entityOf(kind, id) {
  if (kind === 'gym') {
    const g = await one(`gyms?id=eq.${q(id)}&select=id,name,owner_id,deleted_at`);
    return g ? { kind, id: g.id, name: g.name || 'Klub', owner_id: g.owner_id, gone: !!g.deleted_at } : null;
  }
  if (kind === 'org') {
    const o = await one(`organizations?id=eq.${q(id)}&select=id,name,owner_id,kind,supplier_sub,supplier_cancelling,supplier_sub_by`);
    return o ? { kind, id: o.id, name: o.name || 'Organizace', owner_id: o.owner_id, orgKind: o.kind, supplier_sub: o.supplier_sub || null,
      supplier_cancelling: !!o.supplier_cancelling, payer: o.supplier_sub_by || o.owner_id } : null;
  }
  return null;
}
async function activeCoOwner(gymId, userId) {
  const r = await sbGet(`gym_coaches?gym_id=eq.${q(gymId)}&coach_id=eq.${q(userId)}&co_owner=eq.true&status=eq.active&select=id&limit=1`);
  return !!(r && r.length);
}
// BRÁNA NA 4. KLUB (sql/club-gate.sql): klub nad tři smí mít jen schválený řetězec (chain_verified).
// Databáze to hlídá u založení z appky; převod klubu jde přes server, proto se kontroluje tady --
// ať nový majitel dostane srozumitelnou zprávu. Founder (převod v Adminu) smí vždy.
async function overGymCap(userId) {
  const p = await one(`profiles?id=eq.${q(userId)}&select=chain_verified`);
  if (p && p.chain_verified) return false;
  const g = (await sbGet(`gyms?owner_id=eq.${q(userId)}&deleted_at=is.null&select=id`)) || [];
  return g.length >= 3;
}
const GYM_CAP_MSG = 'Nový majitel už má 3 kluby. Čtvrtý a další klub mu nejdřív musí schválit MTL — požádá o to v appce (Žádost o 4. klub).';
async function profileByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  // ilike bez zástupných znaků: '_' a '%' jsou v e-mailu běžné a v LIKE by zastupovaly cokoli.
  const pat = e.replace(/[\\%_]/g, (c) => '\\' + c);
  return one(`profiles?email=ilike.${q(pat)}&deleted_at=is.null&select=id,name,email,lang`);
}
async function supStripeEnd(subId) {
  if (!subId) return null;
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const s = await stripe.subscriptions.retrieve(subId);
    const pe = s.current_period_end || (s.items && s.items.data && s.items.data[0] && s.items.data[0].current_period_end) || null;
    return pe ? new Date(pe * 1000).toISOString() : null;
  } catch (e) { return null; }
}
// Co může nový majitel s předplatným dodavatele udělat. Zrušené (dobíhající) jde jen nahradit
// vlastním nebo nechat doběhnout; „dál platí dosavadní majitel" jen když to sám nabídl a pořád platí on.
function subChoices(E, X) {
  if (!E || E.orgKind !== 'supplier' || !E.supplier_sub) return [];
  if (E.supplier_cancelling) return ['own', 'cancel'];
  const keep = X ? (X.sub_offer && String(E.payer) === String(X.from_user)) : true;
  return keep ? ['keep', 'own', 'cancel'] : ['own', 'cancel'];
}

// VLASTNÍ PŘEVOD. E = entityOf, fromId = dosavadní majitel, toId = nový, subChoice viz výš.
async function execute(E, fromId, toId, keepOld, actorId, byAdmin, subChoice) {
  const table = E.kind === 'gym' ? 'gyms' : 'organizations';
  await sbWrite('PATCH', `${table}?id=eq.${q(E.id)}`, Object.assign({ owner_id: toId }, CARD_OFF));
  let subEnd = null;
  if (E.kind === 'gym') {
    // Nový majitel je majitel, ne spolumajitel; v týmu zůstává (třeba jako trenér).
    await sbWrite('PATCH', `gym_coaches?gym_id=eq.${q(E.id)}&coach_id=eq.${q(toId)}`, { co_owner: false });
    if (keepOld) {
      const ex = await sbGet(`gym_coaches?gym_id=eq.${q(E.id)}&coach_id=eq.${q(fromId)}&select=id&limit=1`);
      if (ex && ex.length) await sbWrite('PATCH', `gym_coaches?id=eq.${q(ex[0].id)}`, { co_owner: true, status: 'active' });
      // Na profilu klubu se jako trenér neukáže -- nový majitel to může změnit v Týmu.
      else await sbWrite('POST', 'gym_coaches', { gym_id: E.id, coach_id: fromId, status: 'active', co_owner: true, hidden_from_profile: true, deck_visible: false });
    }
    try { await sbWrite('POST', 'gym_audit', { gym_id: E.id, actor_id: actorId, action: 'owner_transferred', target_id: toId, meta: { from: fromId, to: toId, by_admin: !!byAdmin, keep_old: !!keepOld } }); }
    catch (e) { console.error('[ownership-transfer] audit', e.message); }
  } else if (E.supplier_sub && subChoice === 'keep') {
    // Na Stripe se nic nemění. Jen se zapamatuje, kdo platí (u předplatných z doby před sloupcem
    // supplier_sub_by chybí) -- podle toho ho dosavadní majitel najde v Platby a provize.
    subEnd = await supStripeEnd(E.supplier_sub);   // příští platba z jeho karty
    try { await sbWrite('PATCH', `organizations?id=eq.${q(E.id)}&supplier_sub_by=is.null`, { supplier_sub_by: E.payer || fromId }); } catch (e) {}
  } else if (E.supplier_sub) {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const s = await stripe.subscriptions.update(E.supplier_sub, { cancel_at_period_end: true });
      const pe = s.current_period_end || (s.items && s.items.data && s.items.data[0] && s.items.data[0].current_period_end) || null;
      subEnd = pe ? new Date(pe * 1000).toISOString() : null;
      // Appka podle toho novému majiteli nabídne navazující předplatné (pay.js).
      await sbWrite('PATCH', `organizations?id=eq.${q(E.id)}`, { supplier_cancelling: true, supplier_period_end: subEnd });
      // Kdo ho platí (u předplatných z doby před sloupcem supplier_sub_by chybí) -- zvlášť, ať
      // chybějící sloupec nezastaví zbytek.
      try { await sbWrite('PATCH', `organizations?id=eq.${q(E.id)}&supplier_sub_by=is.null`, { supplier_sub_by: E.payer || fromId }); } catch (e) {}
    } catch (e) { console.error('[ownership-transfer] supplier sub', e.message); }
  }
  return { subEnd };
}

// Oznámení o dokončeném převodu oběma stranám. choice = sub_choice (jen dodavatel s předplatným).
async function notifyDone(E, from, to, keepOld, byAdmin, subEnd, choice) {
  const isGym = E.kind === 'gym', isSup = E.orgKind === 'supplier';
  const now = new Date().toISOString();
  const fromNm = from ? (from.name || from.email) : '—', toNm = to ? (to.name || to.email) : '—';
  for (const side of ['to', 'from']) {
    const P = side === 'to' ? to : from; if (!P) continue;
    const en = P.lang === 'en';
    const d = subEnd ? czDate(subEnd, en) : '';
    const what = isGym ? (en ? 'the club' : 'klubu') : (en ? 'the organization' : 'organizace');
    const by = byAdmin ? (en ? 'The MTL administrator transferred' : 'Administrátor MTL převedl') : null;
    // Věta o předplatném profilu dodavatele podle volby.
    let subCs = '', subEn = '';
    if (isSup && choice) {
      if (side === 'to') {
        if (choice === 'keep') {
          subCs = ` Předplatné profilu dodavatele dál platí ${fromNm} ze své karty${d ? (' (další platba ' + d + ')') : ''}. Kdykoli ho můžeš převzít na svou kartu — naváže bez přerušení — nebo zrušit, obojí v Profilu dodavatele. Když ho ${fromNm} zastaví, dáme ti vědět.`;
          subEn = ` The supplier profile subscription is still paid by ${fromNm} from their card${d ? (' (next payment ' + d + ')') : ''}. You can take it over on your card at any time — it continues without a break — or cancel it, both in Supplier profile. If ${fromNm} stops it, we will let you know.`;
        } else if (choice === 'own') {
          subCs = ` Předplatné, které platil/a ${fromNm}, skončí ${d || 'na konci zaplaceného období'}. Pokud jsi navazující předplatné na svou kartu ještě nedokončil/a, založ ho v Profilu dodavatele — první platba se strhne až ${d || 'v den, kdy to staré skončí'} a profil poběží bez přerušení.`;
          subEn = ` The subscription paid by ${fromNm} ends ${d || 'at the end of the paid period'}. If you have not finished your own follow-on subscription yet, set it up in Supplier profile — your card is first charged only ${d ? ('on ' + d) : 'when the old one ends'} and the profile keeps running.`;
        } else {
          subCs = ` Předplatné profilu dodavatele skončí ${d || 'na konci zaplaceného období'}; potom se profil přestane zobrazovat. Znovu ho můžeš kdykoli zaplatit v Profilu dodavatele.`;
          subEn = ` The supplier profile subscription ends ${d || 'at the end of the paid period'}; after that the profile is no longer shown. You can pay for it again at any time in Supplier profile.`;
        }
      } else if (choice === 'keep') {
        subCs = ` Předplatné profilu dodavatele dál platíš ze své karty${d ? (' (další platba ' + d + ')') : ''}, i když organizaci už nevlastníš. Zastavit ho můžeš kdykoli: Platby a provize → Předplatné, které platíš za jiné.`;
        subEn = ` You keep paying the supplier profile subscription from your card${d ? (' (next payment ' + d + ')') : ''}, even though you no longer own the organization. You can stop it at any time: Payments & commission → Subscriptions you pay for others.`;
      } else {
        subCs = ` Tvoje předplatné profilu dodavatele se už neobnoví${d ? (' (zaplacené období končí ' + d + ')') : ''}.`;
        subEn = ` Your supplier profile subscription will not renew${d ? (' (the paid period ends ' + d + ')') : ''}.`;
      }
    }
    let cs, enT;
    if (side === 'to') {
      cs = `🔑 ${by ? (by + ' na tebe vlastnictví ' + what + ' ' + E.name) : ('Jsi nový majitel ' + what + ' ' + E.name)} (dosud ${fromNm}).`
        + (isSup ? '' : (' Odpojili jsme kartu na provizi předchozího majitele — přidej svou v ' + (isGym ? 'Nastavení klubu → Režim plateb a výplatní účet' : 'Platby a provize organizace → Karta na provizi') + ', jinak provizi nepůjde strhnout.'))
        + subCs
        + (isSup ? ' Zkontroluj fakturační údaje.'
          : (' Fakturační údaje, Stripe a bankovní účet zůstávají, jak je nastavil(a) ' + fromNm + '. ' + (isGym ? 'Pokud byl klub vedený' : 'Pokud byla organizace vedená') + ' na jeho/její IČO, přepiš fakturační údaje na sebe a připoj vlastní Stripe a bankovní účet — jinak budou platby kartou i převodem chodit dál jemu/jí.'));
      enT = `🔑 ${by ? (by + ' ownership of ' + what + ' ' + E.name + ' to you') : ('You are the new owner of ' + what + ' ' + E.name)} (previously ${fromNm}).`
        + (isSup ? '' : (' We disconnected the previous owner\'s commission card — add yours in ' + (isGym ? 'Club settings → Payment mode and payout account' : 'the organisation\'s Payments & commission → Commission card') + ', otherwise the commission cannot be charged.'))
        + subEn
        + (isSup ? ' Check the billing details.'
          : (' Billing details, the Stripe account and the bank account stay as ' + fromNm + ' set them. If the ' + (isGym ? 'club' : 'organization') + ' ran on their own company ID, replace the billing details with yours and connect your own Stripe and bank account — otherwise card and transfer payments keep going to them.'));
    } else {
      cs = `🔑 ${by ? (by + ' vlastnictví ' + what + ' ' + E.name + ' na ' + toNm) : ((isGym ? 'Klub ' : 'Organizaci ') + E.name + ' teď vlastní ' + toNm)}.`
        + (isSup ? subCs : ' Tvoje karta na provizi byla odpojena.')
        + (isGym ? (keepOld ? ' Zůstáváš spolumajitelem, dokud tě nový majitel neodebere.' : ' Ke klubu už nemáš přístup.') : ' K organizaci už nemáš přístup.');
      enT = `🔑 ${by ? (by + ' ownership of ' + what + ' ' + E.name + ' to ' + toNm) : ((isGym ? 'The club ' : 'The organization ') + E.name + ' is now owned by ' + toNm)}.`
        + (isSup ? subEn : ' Your commission card was disconnected.')
        + (isGym ? (keepOld ? ' You stay a co-owner until the new owner removes you.' : ' You no longer have access to the club.') : ' You no longer have access to the organization.');
    }
    await providerNotify(P.id, { kind: 'owner_xfer_done', side, entity: E.kind, id: E.id, name: E.name, supplier: isSup, sub_choice: choice || null, by_admin: !!byAdmin, at: now, msg_cs: cs, msg_en: enT });
    // Proklik: kdo dál platí za cizí organizaci, jde do Správy účtu (tam ho zastaví); ostatní do subjektu.
    const url = (side === 'from' && isSup && choice === 'keep') ? `${APP}/?go=paidfor` : `${APP}/?go=xferdone&k=${q(E.kind)}&id=${q(E.id)}&s=${side}`;
    await providerMail(P.email, en ? `Ownership transferred: ${E.name}` : `Převod vlastnictví: ${E.name}`,
      [en ? 'Hello,' : 'Dobrý den,', esc(en ? enT : cs)],
      { text: en ? 'Open in the app' : 'Otevřít v appce', url });
  }
}

async function readXfer(id) { return one(`ownership_transfers?id=eq.${q(id)}&select=*`); }
const expired = (x) => x.status === 'pending' && (Date.now() - new Date(x.created_at).getTime() > EXPIRE_DAYS * 86400000);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const token = req.headers['x-access-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'no token' });
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ error: 'bad token' });
    const uj = await ures.json(); const me = uj && (uj.id || (uj.user && uj.user.id));
    if (!me) return res.status(401).json({ error: 'no user' });
    const isFounder = me === FOUNDER_UUID;

    let b = req.body || {}; if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    const action = String(b.action || '');

    // ── PŘEDPLATNÁ, KTERÁ PLATÍM ZA CIZÍ ORGANIZACI ─────────────────────────────────────
    // Po převodu s volbou „dál platí dosavadní majitel" (keep). Zastavit / obnovit ho jde přes
    // /api/cancel-membership (ověří, že platí volající).
    if (action === 'paying') {
      const rows = (await sbGet(`organizations?supplier_sub_by=eq.${q(me)}&owner_id=neq.${q(me)}&supplier_sub=not.is.null`
        + `&select=id,name,owner_id,supplier_sub,supplier_cancelling,supplier_period_end,supplier_renews_at,supplier_price,supplier_currency,supplier_interval`)) || [];
      const items = [];
      for (const o of rows) {
        const ow = o.owner_id ? await prof(o.owner_id) : null;
        items.push({ id: o.id, name: o.name || '', owner_name: ow ? (ow.name || ow.email || '') : '', sub: o.supplier_sub,
          cancelling: !!o.supplier_cancelling, end: o.supplier_cancelling ? (o.supplier_period_end || await supStripeEnd(o.supplier_sub)) : null,
          next: o.supplier_cancelling ? null : (o.supplier_renews_at || await supStripeEnd(o.supplier_sub)),
          price: o.supplier_price || null, currency: o.supplier_currency || 'CZK', interval: o.supplier_interval || 'month' });
      }
      return res.status(200).json({ ok: true, items });
    }

    // ── ŽÁDOST MAJITELE ────────────────────────────────────────────────────────────────
    if (action === 'request' || action === 'admin') {
      const kind = String(b.kind || ''), id = String(b.id || '');
      if (!['gym', 'org'].includes(kind) || !id) return res.status(400).json({ error: 'bad request' });
      const E = await entityOf(kind, id);
      if (!E || E.gone) return res.status(404).json({ error: kind === 'gym' ? 'Klub nenalezen' : 'Organizace nenalezena' });
      if (action === 'admin' && !isFounder) return res.status(403).json({ error: 'forbidden' });
      if (action === 'request' && E.owner_id !== me) return res.status(403).json({ error: kind === 'gym' ? 'Klub může předat jen jeho majitel' : 'Organizaci může předat jen její majitel' });

      // Komu: u klubu (žádost majitele) jen aktivní spolumajitel; jinak účet podle e-mailu.
      let to = null;
      if (b.to) to = await prof(String(b.to));
      else if (b.email) to = await profileByEmail(b.email);
      if (!to || to.deleted_at) return res.status(404).json({ error: 'Účet MTL s tímhle e-mailem jsme nenašli' });
      if (to.id === E.owner_id) return res.status(400).json({ error: 'Tenhle účet už je majitel' });
      if (action === 'request' && kind === 'gym' && !(await activeCoOwner(id, to.id))) {
        return res.status(400).json({ error: 'Klub jde předat jen aktivnímu spolumajiteli. Nejdřív ho v Týmu udělej spolumajitelem.' });
      }
      if (action === 'request' && kind === 'gym' && (await overGymCap(to.id))) return res.status(409).json({ error: GYM_CAP_MSG });
      const from = await prof(E.owner_id);
      // Rozpracovaná žádost k tomuhle klubu / organizaci se nahrazuje novou.
      await sbWrite('PATCH', `ownership_transfers?kind=eq.${q(kind)}&entity_id=eq.${q(id)}&status=eq.pending`, { status: 'cancelled', decided_at: new Date().toISOString() });

      if (action === 'admin') {
        const keepOld = kind === 'gym' ? b.keep_old !== false : false;
        // Founder rozhoduje sám; „dál platí dosavadní karta" jde i bez nabídky (platící to v Správě
        // účtu kdykoli zastaví a dostane o tom notifikaci).
        const ch = subChoices(E, null);
        const subChoice = ch.length ? (ch.includes(String(b.sub_choice)) ? String(b.sub_choice) : 'own') : null;
        await sbWrite('POST', 'ownership_transfers', { kind, entity_id: id, entity_name: E.name, from_user: E.owner_id, to_user: to.id, status: 'accepted', keep_old: keepOld, by_admin: true, decided_at: new Date().toISOString(),
          ...(subChoice ? { sub_choice: subChoice } : {}) });
        const r = await execute(E, E.owner_id, to.id, keepOld, me, true, subChoice);
        await notifyDone(E, from, to, keepOld, true, r.subEnd, subChoice);
        return res.status(200).json({ ok: true, to_name: to.name || to.email });
      }

      // Nabídnout „budu dál platit ze své karty" může jen ten, kdo předplatné opravdu platí.
      const subOffer = !!(b.sub_offer && E.orgKind === 'supplier' && E.supplier_sub && !E.supplier_cancelling && String(E.payer) === String(me));
      const ins = await fetch(`${SB}/rest/v1/ownership_transfers`, { method: 'POST',
        headers: { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ kind, entity_id: id, entity_name: E.name, from_user: me, to_user: to.id, keep_old: true, ...(subOffer ? { sub_offer: true } : {}) }) });
      if (!ins.ok) { const t = await ins.text().catch(() => ''); throw new Error('insert ' + ins.status + ' ' + t.slice(0, 160)); }
      const X = (await ins.json())[0];
      const en = to.lang === 'en';
      const fromNm = (from && (from.name || from.email)) || '';
      const isSup = E.orgKind === 'supplier';
      const hasSub = isSup && !!E.supplier_sub;
      const cs = `🔑 ${fromNm} ti chce předat vlastnictví ${kind === 'gym' ? 'klubu' : 'organizace'} ${E.name}. Převezmeš ${kind === 'gym' ? 'klub' : 'organizaci'} se vším, včetně provizí MTL a dokladů.`
        + (hasSub ? (subOffer ? ` ${fromNm} nabízí, že bude předplatné profilu dodavatele dál platit ze své karty — při převzetí si vybereš, jestli to přijmeš, založíš si vlastní, nebo ho necháš skončit.` : ' Při převzetí si vybereš, jestli si založíš vlastní navazující předplatné profilu dodavatele, nebo ho necháš skončit.') : '')
        + ' Podívej se na podrobnosti a převzetí potvrď nebo odmítni (platí ' + EXPIRE_DAYS + ' dní).';
      const enT = `🔑 ${fromNm} wants to transfer ownership of ${kind === 'gym' ? 'the club' : 'the organization'} ${E.name} to you. You take it over with everything, including MTL commission and receipts.`
        + (hasSub ? (subOffer ? ` ${fromNm} offers to keep paying the supplier profile subscription from their card — when you accept, you choose whether to take that, set up your own, or let it end.` : ' When you accept, you choose whether to set up your own follow-on supplier profile subscription or let it end.') : '')
        + ' Check the details and accept or decline (valid for ' + EXPIRE_DAYS + ' days).';
      await providerNotify(to.id, { kind: 'owner_xfer_request', xfer_id: X.id, entity: kind, id, name: E.name, from_name: fromNm, msg_cs: cs, msg_en: enT });
      await providerMail(to.email, en ? `Ownership transfer: ${E.name}` : `Předání vlastnictví: ${E.name}`,
        [en ? 'Hello,' : 'Dobrý den,', esc(en ? enT : cs)], { text: en ? 'View and decide' : 'Zobrazit a rozhodnout', url: xferLink(X.id) });
      return res.status(200).json({ ok: true, id: X.id, to_name: to.name || to.email });
    }

    // ── PODROBNOSTI / ROZHODNUTÍ ─────────────────────────────────────────────────────────
    const xid = String(b.id || '');
    if (!xid) return res.status(400).json({ error: 'no id' });
    let X = await readXfer(xid);
    if (!X) return res.status(404).json({ error: 'Žádost o převod nenalezena' });
    const role = X.to_user === me ? 'to' : (X.from_user === me ? 'from' : (isFounder ? 'admin' : null));
    if (!role) return res.status(403).json({ error: 'forbidden' });
    if (expired(X)) { await sbWrite('PATCH', `ownership_transfers?id=eq.${q(xid)}`, { status: 'expired', decided_at: new Date().toISOString() }); X.status = 'expired'; }
    const E = await entityOf(X.kind, X.entity_id);
    const from = await prof(X.from_user), to = await prof(X.to_user);

    if (action === 'get') {
      const subEnd = (E && E.supplier_sub) ? await supStripeEnd(E.supplier_sub) : null;
      return res.status(200).json({ ok: true, role, transfer: { id: X.id, kind: X.kind, status: X.status, created_at: X.created_at, decided_at: X.decided_at, entity_id: X.entity_id },
        entity: E ? { name: E.name, supplier: E.orgKind === 'supplier', sub_end: subEnd, sub_cancelling: !!E.supplier_cancelling,
          sub_choices: X.status === 'pending' ? subChoices(E, X) : [], sub_choice: X.sub_choice || null } : { name: X.entity_name },
        from_name: from ? (from.name || from.email) : '', to_name: to ? (to.name || to.email) : '' });
    }
    if (X.status !== 'pending') return res.status(409).json({ error: ({ accepted: 'Převod už proběhl', declined: 'Převod byl odmítnut', cancelled: 'Žádost byla stažena', expired: 'Žádost vypršela' })[X.status] || 'Žádost už neplatí' });

    if (action === 'cancel') {
      if (role !== 'from' && role !== 'admin') return res.status(403).json({ error: 'forbidden' });
      await sbWrite('PATCH', `ownership_transfers?id=eq.${q(xid)}`, { status: 'cancelled', decided_at: new Date().toISOString() });
      if (to) await providerNotify(to.id, { kind: 'owner_xfer_cancelled', xfer_id: xid, entity: X.kind, id: X.entity_id, name: X.entity_name,
        msg_cs: `🔑 ${(from && (from.name || from.email)) || ''} stáhl/a žádost o předání ${X.kind === 'gym' ? 'klubu' : 'organizace'} ${X.entity_name || ''}. Nic se nemění.`,
        msg_en: `🔑 ${(from && (from.name || from.email)) || ''} withdrew the request to transfer ${X.entity_name || ''}. Nothing changes.` });
      return res.status(200).json({ ok: true });
    }
    if (role !== 'to') return res.status(403).json({ error: 'Rozhoduje ten, komu se předává' });

    if (action === 'decline') {
      await sbWrite('PATCH', `ownership_transfers?id=eq.${q(xid)}`, { status: 'declined', decided_at: new Date().toISOString() });
      if (from) await providerNotify(from.id, { kind: 'owner_xfer_declined', xfer_id: xid, entity: X.kind, id: X.entity_id, name: X.entity_name,
        msg_cs: `🔑 ${(to && (to.name || to.email)) || ''} odmítl/a převzetí ${X.kind === 'gym' ? 'klubu' : 'organizace'} ${X.entity_name || ''}. Vlastníkem zůstáváš ty.`,
        msg_en: `🔑 ${(to && (to.name || to.email)) || ''} declined to take over ${X.entity_name || ''}. You remain the owner.` });
      return res.status(200).json({ ok: true });
    }

    if (action === 'accept') {
      // Mezitím se mohlo cokoli změnit: klub smazán, majitel jiný, spolumajitelství odebráno.
      if (!E || E.gone) return res.status(409).json({ error: 'Klub ani organizace už neexistuje' });
      if (E.owner_id !== X.from_user) {
        await sbWrite('PATCH', `ownership_transfers?id=eq.${q(xid)}`, { status: 'cancelled', decided_at: new Date().toISOString() });
        return res.status(409).json({ error: 'Majitel se mezitím změnil -- žádost už neplatí' });
      }
      if (X.kind === 'gym' && !(await activeCoOwner(X.entity_id, me))) return res.status(409).json({ error: 'Už nejsi spolumajitel klubu -- převzít ho nejde' });
      if (X.kind === 'gym' && (await overGymCap(me))) return res.status(409).json({ error: 'Už máš 3 kluby. Čtvrtý a další ti nejdřív musí schválit MTL — požádej o to v appce (Žádost o 4. klub), pak převzetí dokonči.' });
      // Předplatné profilu dodavatele: volba je povinná a musí odpovídat dnešnímu stavu (mezitím ho
      // dosavadní majitel mohl zrušit -- pak už „dál platí on" nejde).
      const ch = subChoices(E, X);
      let subChoice = null;
      if (ch.length) {
        subChoice = String(b.sub_choice || '');
        if (!ch.includes(subChoice)) return res.status(400).json({ error: 'Vyber, co bude s předplatným profilu dodavatele' });
      }
      await sbWrite('PATCH', `ownership_transfers?id=eq.${q(xid)}`, { status: 'accepted', decided_at: new Date().toISOString(), ...(subChoice ? { sub_choice: subChoice } : {}) });
      const r = await execute(E, X.from_user, me, X.keep_old, me, false, subChoice);
      await notifyDone(E, from, to, X.keep_old, false, r.subEnd, subChoice);
      return res.status(200).json({ ok: true, kind: X.kind, entity_id: X.entity_id, sub_choice: subChoice });
    }
    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('[ownership-transfer]', e && e.message);
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
}
