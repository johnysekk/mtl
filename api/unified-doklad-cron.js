// /api/unified-doklad-cron.js
// Runs monthly (schedule it a day or two AFTER commission-cron has billed the
// card-on-file, e.g. `0 6 7 * *`). Issues ONE unified MTL commission doklad per
// provider (gym owner / coach) per currency for the previous month, covering ALL
// commission MTL took that month:
//   - bank-transfer track (cash / qr / pis) — accrued and billed via card-on-file
//     by commission-cron (commission_status flips to 'collected' on a successful charge)
//   - Stripe — application_fee collected LIVE at payment time (stripe-webhook writes
//     the tx with commission_status='collected', payment_method='stripe')
// so a Stripe-only month, or a provider who switched Převod<->Stripe mid-month, still
// gets a single doklad. Every line item carries { method, rate, fee, count, gross } so
// the receipt itemises by FORM + RATE (transparency). amount = total; bank_amount /
// stripe_amount split the two rails. Idempotent per (entity, period, currency, kind).

import PDFDocument from 'pdfkit';
import { DEJAVU_CZ } from './_dejavu-cz.js';
import { isTestMode, minChargeFor } from './_config.js';
import { introFreeFor, STORE_COST } from './_rate.js';
import { pragueMonth, pragueDate, shiftMonth } from './_tz.js';
import { makePayToken } from './commission-pay-now.js';
import { undocumentedUnpaid, docNo as _docNoOf } from './_receipt.js';
import { vatMode, vatNoteFor } from './_vat.js';
const FOUNDER_UUID = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.INVITE_FROM || process.env.MAIL_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';

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

// EU/EEA member states that use the reverse-charge / souhrnne hlaseni regime. A buyer OUTSIDE
// this set (US, TH, UK, CH, ...) is an export of services - no souhrnne hlaseni, no VAT ID needed -
// so the foreign-VAT gate must NOT defer those. Only intra-EU B2B without a VAT ID is blocked.
const EU_VAT = new Set(['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK']);
// gyms store the country as billing_country; profiles use country. Accept either, plus a couple of
// long-form spellings, and normalise to an ISO-2 code. Unknown -> null -> treated as domestic.
const CTRY_ALIAS = { 'CESKO':'CZ','CESKA REPUBLIKA':'CZ','CZECH REPUBLIC':'CZ','CZECHIA':'CZ','SLOVENSKO':'SK','SLOVAKIA':'SK','POLSKO':'PL','POLAND':'PL','NEMECKO':'DE','GERMANY':'DE','RAKOUSKO':'AT','AUSTRIA':'AT','UNITED KINGDOM':'GB','UNITED STATES':'US','THAILAND':'TH' };
function ctryCode(row) {
  const raw = String((row && (row.billing_country || row.country)) || '').trim();
  if (!raw) return null;
  const up = raw.toUpperCase().replace(/[^A-Z ]/g, '').trim();
  if (CTRY_ALIAS[up]) return CTRY_ALIAS[up];
  if (/^[A-Z]{2}$/.test(up)) return up;
  return null;
}

const CZ_MONTHS = ['leden','\u00fanor','b\u0159ezen','duben','kv\u011bten','\u010derven','\u010dervenec','srpen','z\u00e1\u0159\u00ed','\u0159\u00edjen','listopad','prosinec'];
// The notification said 'za 2026-07', which is a database value, not something a person reads on
// a receipt. In TEST mode period is a DATE, so it renders as a date instead.
// Subject line wants a compact form; 2026-07 reads as a sort key, 07/2026 as a period.
function periodShort(p) {
  try {
    const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(p));
    if (md) return md[3] + '. ' + md[2] + '. ' + md[1];
    const mm = /^(\d{4})-(\d{2})$/.exec(String(p));
    if (mm) return mm[2] + '/' + mm[1];
    return p;
  } catch (e) { return p; }
}
function periodLabel(p) {
  try {
    const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(p));
    if (md) return Number(md[3]) + '. ' + Number(md[2]) + '. ' + md[1];
    const mm = /^(\d{4})-(\d{2})$/.exec(String(p));
    if (mm) return (CZ_MONTHS[Number(mm[2]) - 1] || p) + ' ' + mm[1];
    return p;
  } catch (e) { return p; }
}
function prevMonth(ym) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1, 1)); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); }

// ── JAZYK DOKLADU ────────────────────────────────────────────────────────────────────────
// E-mail, PDF a notifikace jdou v jazyce příjemce (profiles.lang zapisuje appka). Bez něj česky.
// Obsah dokladu (snímek) je v obou jazycích stejný -- mění se jen popisky.
const EN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function periodLabelL(p, lang) {
  if (lang !== 'en') return periodLabel(p);
  try {
    const md = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(p));
    if (md) return Number(md[3]) + ' ' + EN_MONTHS[Number(md[2]) - 1] + ' ' + md[1];
    const mm = /^(\d{4})-(\d{2})$/.exec(String(p));
    if (mm) return (EN_MONTHS[Number(mm[2]) - 1] || p) + ' ' + mm[1];
    return p;
  } catch (e) { return p; }
}
const _L = {
  cs: { title:'Faktura \u2014 provize MTL', issued:'Vystaveno', duzp:'Datum uskute\u010dn\u011bn\u00ed pln\u011bn\u00ed', period:'Obdob\u00ed', supplier:'Dodavatel', customer:'Odb\u011bratel',
        regno:'I\u010cO', vatid:'DI\u010c', register:'Zaps\u00e1no v obchodn\u00edm rejst\u0159\u00edku', phone:'Tel.', country:'St\u00e1t', inMtlOrg:'Organizace v MTL', inMtlGym:'Klub v MTL', inMtlCoach:'Kou\u010d v MTL',
        method:'Forma platby', rate:'Sazba', count:'Plateb', volume:'Objem plateb', fee:'Provize', base:'Z\u00e1klad dan\u011b', vat:'DPH', notVat:'Dodavatel nen\u00ed pl\u00e1tcem DPH.',
        total:'Celkem', payments:'Zprost\u0159edkovan\u00fdch plateb', vol:'objem',
        kOrg:'organizace', kGym:'klub', kCoachPayout:'kou\u010d \u00b7 re\u017eim klub', kCoach:'kou\u010d',
        mStripe:'Stripe (karta)', mPis:'Platba z banky', mQr:'QR platba', mCash:'Hotovost',
        test:'\u{1F9EA} TESTOVAC\u00cd RE\u017dIM \u2014 nejde o form\u00e1ln\u00ed da\u0148ov\u00fd doklad a k \u017e\u00e1dn\u00e9 skute\u010dn\u00e9 transakci nedo\u0161lo',
        forWhom:(n,ico,ent)=>'Odb\u011bratel: <b>'+n+'</b>'+(ico?(', I\u010cO '+ico):'')+(ent?(' \u00b7 '+ent):'')+'.',
        hello:'Dobr\u00fd den', attached:(no,per,tot)=>'v p\u0159\u00edloze pos\u00edl\u00e1me fakturu '+no+' za provizi MTL za obdob\u00ed <b>'+per+'</b> \u2014 celkem <b>'+tot+'</b>.',
        introTitle:'P\u0159ehled zprost\u0159edkovan\u00fdch plateb', introFee:'Provize MTL', introNone:(u)=>'Za toto obdob\u00ed nebyla \u00fa\u010dtov\u00e1na \u017e\u00e1dn\u00e1 provize'+(u?(' \u2014 zav\u00e1d\u011bc\u00ed obdob\u00ed plat\u00ed do '+u+'.'):'.')+' Nejde o da\u0148ov\u00fd doklad.',
        subjDoklad:'Faktura \u2014 provize MTL', subjIntro:'P\u0159ehled zprost\u0159edkovan\u00fdch plateb' },
  en: { title:'Invoice \u2014 MTL commission', issued:'Issued', duzp:'Date of supply', period:'Period', supplier:'Supplier', customer:'Customer',
        regno:'Reg. number', vatid:'VAT ID', register:'Commercial register', phone:'Phone', country:'Country', inMtlOrg:'Organisation in MTL', inMtlGym:'Club in MTL', inMtlCoach:'Coach in MTL',
        method:'Payment form', rate:'Rate', count:'Payments', volume:'Volume', fee:'Commission', base:'Tax base', vat:'VAT', notVat:'The supplier is not a VAT payer.',
        total:'Total', payments:'Payments intermediated', vol:'volume',
        kOrg:'organisation', kGym:'club', kCoachPayout:'coach \u00b7 club mode', kCoach:'coach',
        mStripe:'Stripe (card)', mPis:'Bank payment', mQr:'QR payment', mCash:'Cash',
        test:'\u{1F9EA} TEST MODE \u2014 not a formal tax document; no actual transaction took place',
        forWhom:(n,ico,ent)=>'Customer: <b>'+n+'</b>'+(ico?(', reg. no. '+ico):'')+(ent?(' \u00b7 '+ent):'')+'.',
        hello:'Hello', attached:(no,per,tot)=>'please find attached invoice '+no+' for the MTL commission for <b>'+per+'</b> \u2014 total <b>'+tot+'</b>.',
        introTitle:'Summary of intermediated payments', introFee:'MTL commission', introNone:(u)=>'No commission was charged for this period'+(u?(' \u2014 the introductory period runs until '+u+'.'):'.')+' This is not a tax document.',
        subjDoklad:'Invoice \u2014 MTL commission', subjIntro:'Summary of intermediated payments' },
};
function _t(lang){ return _L[lang === 'en' ? 'en' : 'cs']; }
function _methodLabel(m, lang){ const T=_t(lang); return m==='stripe'?T.mStripe:(m==='pis'?T.mPis:(m==='qr'?T.mQr:(m==='cash'?T.mCash:(m||'\u2014')))); }
// NÁKLAD OBCHODU S APLIKACEMI (online koučink koupený v nativní appce) je vlastní řádek -- není
// to provize MTL, ale poplatek Apple / Google (10 %) a DPH, kterou z něj MTL odvádí (21 %).
function _itemLabel(i, lang){
  if (i.store) return lang === 'en' ? 'App Store / Google Play fee (10 % + 21 % VAT) · online coaching bought in the mobile app' : 'Poplatek App Store / Google Play (10 % + 21 % DPH) · online koučink koupený v mobilní aplikaci';
  return _methodLabel(i.method, lang) + (i.acq ? (lang === 'en' ? ' \u00b7 acquisition (new member from MTL)' : ' \u00b7 akvizice (nov\u00fd \u010dlen z MTL)') : ''); }
function _pct(r, lang){ return r!=null ? (Math.round(r*1000)/10).toString().replace('.', lang==='en'?'.':',')+' %' : '\u2014'; }
function _money(minor, cur, lang){ return (Number(minor||0)/100).toFixed(2).replace('.', lang==='en'?'.':',')+' '+String(cur||'').toUpperCase(); }
function esc(x){ return String(x==null?'':x).replace(/[<>&"]/g,function(c){ return c==='<'?'&lt;':c==='>'?'&gt;':c==='&'?'&amp;':'&quot;'; }); }
function _czDate(d, lang){ try{ const x=new Date(d); return lang==='en' ? (x.getUTCDate()+' '+EN_MONTHS[x.getUTCMonth()]+' '+x.getUTCFullYear()) : (x.getUTCDate()+'. '+(x.getUTCMonth()+1)+'. '+x.getUTCFullYear()); }catch(e){ return String(d||''); } }
// ČÍSLO DOKLADU: uložené při vystavení (doc_no, MTL-2026-000041 -- přiděluje databáze).
// Starší doklady bez doc_no se zobrazují postaru jako MTL-<id>.
function _dokNo(s){ return (s && typeof s === 'object') ? (s.doc_no || ('MTL-' + (s.id != null ? s.id : 'X'))) : ('MTL-' + s); }
// Země jménem, v jazyce dokladu. Ukládá se dvoupísmenný kód; překlad až při vykreslení,
// aby PDF pro zahraniční klub neříkalo "Stát: SK", ale "Country: Slovakia".
const CC_NAMES = {
  BE:['Belgie','Belgium'], BG:['Bulharsko','Bulgaria'], HR:['Chorvatsko','Croatia'], CY:['Kypr','Cyprus'],
  CZ:['Česko','Czechia'], DK:['Dánsko','Denmark'], EE:['Estonsko','Estonia'], FI:['Finsko','Finland'],
  FR:['Francie','France'], DE:['Německo','Germany'], GR:['Řecko','Greece'], HU:['Maďarsko','Hungary'],
  IE:['Irsko','Ireland'], IT:['Itálie','Italy'], LV:['Lotyšsko','Latvia'], LT:['Litva','Lithuania'],
  LU:['Lucembursko','Luxembourg'], MT:['Malta','Malta'], NL:['Nizozemsko','Netherlands'], PL:['Polsko','Poland'],
  PT:['Portugalsko','Portugal'], RO:['Rumunsko','Romania'], SK:['Slovensko','Slovakia'], SI:['Slovinsko','Slovenia'],
  ES:['Španělsko','Spain'], SE:['Švédsko','Sweden'], AT:['Rakousko','Austria'],
  GB:['Spojené království','United Kingdom'], CH:['Švýcarsko','Switzerland'], NO:['Norsko','Norway'],
  TR:['Turecko','Türkiye'], US:['Spojené státy','United States'], CA:['Kanada','Canada'],
  AU:['Austrálie','Australia'], NZ:['Nový Zéland','New Zealand'], UA:['Ukrajina','Ukraine'],
};
function _ccName(cc, lang){
  const v = String(cc || '').trim().toUpperCase();
  if (!v) return '';
  const row = CC_NAMES[v];
  return row ? (lang === 'en' ? row[1] : row[0]) : v;
}
// KDO DLUŽÍ PROVIZI = komu přišly peníze. Banka a hotovost to píšou do paid_to, Stripe do payee_kind
// (gym / profile). Stejné pravidlo je v appce (_commOwner) a v commission-cron. Dřív se Stripe platba
// kouče na výplatní účet u skupinovky přičítala klubu, protože nesla gym_id a paid_to prázdné.
function commissionOwner(t) {
  const pk = t.paid_to || (t.payee_kind === 'profile' ? 'coach' : t.payee_kind) || null;
  if (pk === 'organization' && t.organization_id) return { kind: 'organization', id: t.organization_id };
  if (pk === 'coach' && t.coach_id) return { kind: 'coach', id: t.coach_id, identity: t.gym_id ? 'payout' : 'own' };
  if (pk === 'gym' && t.gym_id) return { kind: 'gym', id: t.gym_id };
  if (t.organization_id) return { kind: 'organization', id: t.organization_id };
  if (t.gym_id) return { kind: 'gym', id: t.gym_id };
  if (t.coach_id) return { kind: 'coach', id: t.coach_id, identity: 'own' };
  return null;
}
function _kindLabel(s, lang){ const T=_t(lang); return s.organization_id ? T.kOrg : (s.gym_id ? T.kGym : (s.billing_identity==='payout' ? T.kCoachPayout : T.kCoach)); }

// ── ODBĚRATEL ────────────────────────────────────────────────────────────────────────────
// Jedno čtení pro všechny tři druhy. Organizace se dřív četla z profiles podle id organizace,
// takže doklad organizace neměl odběratele vůbec.
async function loadBuyer(kind, entityId, ownerId, bp) {
  let sel;
  if (kind === 'gym') sel = `gyms?id=eq.${entityId}&select=name,legal_name,billing_line1,billing_line2,billing_city,billing_postal,tax_id,vat_id,vat_payer,billing_country,country,invoice_email,contact_email,billing_phone,contact_phone&limit=1`;
  else if (kind === 'organization') sel = `organizations?id=eq.${entityId}&select=name,legal_name,billing_line1,billing_line2,billing_city,billing_postal,tax_id,vat_id,vat_payer,billing_country,country,invoice_email,contact_email,contact_phone&limit=1`;
  else sel = `profiles?id=eq.${entityId}&select=name,email,country,${bp}legal_name,${bp}billing_line1,${bp}billing_line2,${bp}billing_city,${bp}billing_postal,${bp}tax_id,${bp}vat_id,${bp}vat_payer,${bp}billing_country,${bp}invoice_email,${bp}billing_phone&limit=1`;
  const r = ((await sb(sel)) || [])[0];
  if (!r) return null;
  const g = (k) => r[(kind === 'coach' ? bp : '') + k];
  const b = { name: r.name || null, legal_name: g('legal_name') || null, tax_id: g('tax_id') || null, vat_id: g('vat_id') || null,
    vat_payer: !!g('vat_payer'), billing_country: g('billing_country') || null, country: r.country || null,
    address: _billAddr(r, kind === 'coach' ? bp : '') || null,
    email: g('invoice_email') || r.contact_email || null, phone: g('billing_phone') || r.contact_phone || null };
  // Kam doklad poslat: fakturační e-mail subjektu, jinak účet toho, kdo platí.
  if (!b.email && ownerId) { try { const o = ((await sb(`profiles?id=eq.${ownerId}&select=email&limit=1`)) || [])[0]; b.email = (o && o.email) || null; } catch (e) {} }
  return b;
}

// ── SNÍMEK ───────────────────────────────────────────────────────────────────────────────
// Jediný popis dokladu. Z něj se ukládá řádek, kreslí PDF, tělo e-mailu i zobrazení v appce --
// dřív měl každý z nich jiný obsah a appka ukazovala nejchudší verzi.
// DUZP faktury za provizi: poslední den účtovaného měsíce (YYYY-MM), u denního období ten den.
function _duzpOf(period) {
  const p = String(period || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  const m = /^(\d{4})-(\d{2})$/.exec(p); if (!m) return null;
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`;
}
function buildSnap(kind, entityId, ownerId, identity, period, cur, data, ME, buyer, testMode) {
  const items = Object.values(data.rates || {});
  const bank = items.filter(i => i.method !== 'stripe').reduce((a, i) => a + i.fee, 0);
  const strp = items.filter(i => i.method === 'stripe').reduce((a, i) => a + i.fee, 0);
  const B = buyer || {};
  const legal = B.legal_name || B.name || null;
  const snap = { period_month: period, currency: cur, amount: data.total, bank_amount: bank, stripe_amount: strp, line_items: items,
    // Nestržená část v okamžiku vystavení (0 = uhrazeno celé). Viz _statusText.
    due_amount: Math.max(0, Math.round(data.due || 0)),
    // DUZP: souhrnná faktura za měsíc -> poslední den toho měsíce (u denního režimu ten den).
    duzp: _duzpOf(period),
    status: 'issued', kind: 'unified', owner_id: ownerId, charged_at: new Date().toISOString(), test_mode: !!testMode,
    billing_identity: (kind === 'coach') ? (identity || 'own') : null,
    cust_name: legal, cust_trade_name: (B.name && B.name !== legal) ? B.name : null,
    cust_ico: B.tax_id || null, cust_dic: B.vat_id || null, cust_address: B.address || null,
    cust_vat_payer: !!B.vat_payer, cust_country: B.billing_country || B.country || null,
    cust_email: B.email || null, cust_phone: B.phone || null,
    sup_name: ME.name || 'Martial Training Lab s.r.o.', sup_ico: ME.ico || null, sup_dic: ME.dic || null, sup_address: ME.sidlo || null,
    sup_vat_payer: !!ME.vat_payer, sup_vat_rate: (ME.vat_rate != null ? ME.vat_rate : null),
    sup_phone: ME.contact_phone || null, sup_email: ME.contact_email || null,
    // Zápis v obchodním rejstříku (spisová značka) -- údaj obchodní listiny podle § 435 OZ.
    sup_register: (ME.register_entry && String(ME.register_entry).trim()) || null,
    // Stát dodavatele do snímku -- stejně jako u odběratele (MTL: platform_settings.home_country).
    sup_country: String(ME.home_country || ME.country || 'CZ').toUpperCase(),
    gym_id: null, coach_id: null, organization_id: null };
  snap[kind === 'gym' ? 'gym_id' : (kind === 'organization' ? 'organization_id' : 'coach_id')] = entityId;
  // DAŇOVÝ REŽIM ze společné funkce (_vat.js) -- stejně jako doklad za EP. Dřív doklad o provizi
  // znal jen "plátce / neplátce": plátce účtoval českou DPH i slovenskému klubu s DIČ a neplátce
  // psal "není plátcem DPH" i tam, kde je identifikovanou osobou a daň odvede odběratel.
  // Provize je služba podnikateli (každý poskytovatel má IČO) -> kind 'service'.
  let V = vatMode(snap.sup_country, snap.cust_country, snap.cust_dic, { kind: 'service', supIsVatPayer: snap.sup_vat_payer });
  // need_vat sem dojde jen s vypnutou bránou require_vat_foreign (jinak se doklad odloží).
  // Pak doklad vznikne jako dřív, bez věty o režimu, kterou nejde doložit.
  if (V.mode === 'need_vat') V = snap.sup_vat_payer ? { mode: 'domestic', note: null } : { mode: 'no_vat_supplier', note: 'Dodavatel není plátcem DPH.' };
  snap.vat_mode = V.mode; snap.vat_note = V.note || null;
  return snap;
}
function _supLines(s, lang){ const T=_t(lang); return [s.sup_name, s.sup_address, s.sup_country ? _ccName(s.sup_country, lang) : '', s.sup_ico ? (T.regno+': ' + s.sup_ico) : '', s.sup_dic ? (T.vatid+': ' + s.sup_dic) : '', s.sup_register ? (T.register+': ' + s.sup_register) : '', s.sup_phone ? (T.phone+': ' + s.sup_phone) : '', s.sup_email ? ('E-mail: ' + s.sup_email) : ''].filter(Boolean); }
function _custLines(s, lang){ const T=_t(lang); return [s.cust_name || '\u2014', s.cust_trade_name ? ((s.organization_id ? T.inMtlOrg : (s.gym_id ? T.inMtlGym : T.inMtlCoach)) + ': ' + s.cust_trade_name) : '', s.cust_address, s.cust_country ? _ccName(s.cust_country, lang) : '', s.cust_ico ? (T.regno+': ' + s.cust_ico) : '', s.cust_dic ? (T.vatid+': ' + s.cust_dic) : '', s.cust_phone ? (T.phone+': ' + s.cust_phone) : '', s.cust_email ? ('E-mail: ' + s.cust_email) : ''].filter(Boolean); }

// DPH NA DOKLADU: rozpis základu a daně jen u domácího plnění plátce. Starší snímky bez
// vat_mode se chovají jako dřív (plátce = rozpis). Jinak věta o režimu ze snímku.
function _vatShow(s){ return !!s.sup_vat_payer && (!s.vat_mode || s.vat_mode === 'domestic'); }
function _vatText(s, lang){ const T=_t(lang); return vatNoteFor(s.vat_mode, s.vat_note, lang) || (s.sup_vat_payer ? '' : T.notVat); }
// STAV ÚHRADY -- hned pod hlavičkou faktury, ať je na první pohled jasné, jestli se má něco
// platit. Uhrazená faktura to říká výslovně (částka už byla stržena, nejde o výzvu k platbě);
// neuhrazená (stržení z karty do uzávěrky neprošlo) říká, kolik a do kdy zbývá.
// due_amount = co z faktury nebylo v okamžiku vystavení stržené (v haléřích/centech).
function _paidParts(s){
  const due = Math.max(0, Number(s.due_amount) || 0);
  const bankPaid = Math.max(0, (Number(s.bank_amount) || 0) - due);
  return { due, bankPaid, stripePaid: Math.max(0, Number(s.stripe_amount) || 0) };
}
function _statusText(s, lang){
  const en = lang === 'en'; const cur = s.currency; const P = _paidParts(s);
  const parts = [];
  if (P.bankPaid > 0) parts.push(en ? (_money(P.bankPaid, cur, lang) + ' was charged to the saved card on ' + _czDate(s.charged_at, lang))
                                    : (_money(P.bankPaid, cur, lang) + ' bylo strženo z uložené karty dne ' + _czDate(s.charged_at, lang)));
  if (P.stripePaid > 0) parts.push(en ? (_money(P.stripePaid, cur, lang) + ' was taken directly with each card payment')
                                      : (_money(P.stripePaid, cur, lang) + ' bylo strženo přímo při každé platbě kartou'));
  if (!P.due) {
    return { paid: true,
      head: en ? 'PAID IN FULL' : 'UHRAZENO V PLNÉ VÝŠI',
      body: (parts.length ? ((en ? 'The amount has already been charged: ' : 'Částka už byla stržena: ') + parts.join(en ? '; ' : '; ') + '. ') : '')
            + _paidOtherText(s, lang)
            + (en ? 'This is not a request for payment — there is nothing to pay.' : 'Nejde o výzvu k platbě — není co platit.') };
  }
  const dd = s.due_date ? _czDate(s.due_date + 'T12:00:00Z', lang) : '';
  return { paid: false,
    head: (en ? 'AMOUNT DUE: ' : 'K ÚHRADĚ: ') + _money(P.due, cur, lang) + (dd ? ((en ? ' — due ' : ' — splatnost ') + dd) : ''),
    body: (parts.length ? ((en ? 'Already paid: ' : 'Už uhrazeno: ') + parts.join('; ') + '. ') : '')
          + _dueText(s, en) };
}
// ÚHRADA STARŠÍCH FAKTUR TÍMTO STRŽENÍM (paid_other) -- informace o platbě, ne položka faktury.
function _paidOtherText(s, lang) {
  const en = lang === 'en'; const list = Array.isArray(s.paid_other) ? s.paid_other : [];
  if (!list.length) return '';
  const why = (r) => r === 'below_min' ? (en ? 'not charged earlier, below the 50 CZK minimum for a card charge' : 'dříve nestrženo, nedosáhlo minima 50 Kč pro platbu kartou')
                                      : (en ? 'outstanding after an unsuccessful charge' : 'doplatek po neúspěšném stržení');
  const items = list.map((o) => (en ? 'invoice ' : 'faktura ') + o.doc_no + ' (' + periodLabelL(o.period, lang) + ') ' + _money(o.amount, s.currency, lang) + ' — ' + why(o.reason));
  return (en ? 'The same charge also paid the remainder of older invoices: ' : 'Stejným stržením byl uhrazen i zbytek starších faktur: ') + items.join('; ') + '. ';
}
// Text nestržené části podle důvodu (due_reason; u starších snímků podle due_date).
function _dueText(s, en){
  const r = s.due_reason || (s.due_date ? 'failed' : 'below_min');
  if (r === 'failed') return en ? 'The remaining amount could not be charged to the saved card. We will try again automatically; you can also pay it right away in the app (Payments & commission) or via the Pay now button in the e-mail.'
                                : 'Zbývající částku se nepodařilo strhnout z uložené karty. Zkusíme to znovu automaticky; uhradit ji můžeš i hned v appce (Platby a provize) nebo tlačítkem Zaplatit hned v e-mailu.';
  if (r === 'not_charged') return en ? 'The remaining amount has not been charged yet. We will charge it to the saved card automatically; you can also pay it right away in the app (Payments & commission) or via the Pay now button in the e-mail.'
                                     : 'Zbývající částka zatím nebyla stržena. Strhneme ji z uložené karty automaticky; uhradit ji můžeš i hned v appce (Platby a provize) nebo tlačítkem Zaplatit hned v e-mailu.';
  if (r === 'no_card') return en ? 'There is no saved payment card to charge the remaining amount. Add one in Payments & commission, or pay right away via the Pay now button in the e-mail.'
                                 : 'Zbývající částku nebylo z čeho strhnout — chybí uložená platební karta. Doplň ji v Platby a provize, nebo zaplať hned tlačítkem Zaplatit hned v e-mailu.';
  return en ? 'The remaining amount is below the minimum for a card charge; it will be charged to the saved card together with the next commission. There is nothing to pay manually.'
            : 'Zbývající částka je pod minimem pro platbu kartou; strhneme ji z uložené karty spolu s další provizí. Ručně není potřeba nic platit.';
}
function _statusBoxHtml(s, lang){
  const st = _statusText(s, lang);
  const c = st.paid ? { bg:'#EAF7EE', bd:'#A8E6C0', fg:'#0E6B3A' } : { bg:'#FFF4E5', bd:'#F0C674', fg:'#8a5a00' };
  return '<div style="margin:14px 0 4px;padding:11px 14px;border-radius:10px;background:'+c.bg+';border:1.5px solid '+c.bd+';color:'+c.fg+';">'
    + '<div style="font-weight:800;font-size:14px;letter-spacing:.02em;">'+esc(st.head)+'</div>'
    + '<div style="font-size:12.5px;line-height:1.5;margin-top:3px;">'+esc(st.body)+'</div></div>';
}
function dokladHtml(s, lang){
  const T=_t(lang); const items = s.line_items || []; const cur = s.currency;
  const th = 'padding:8px 10px;font-size:11px;color:#666;font-weight:700;';
  const rows = items.map(function(i){ return '<tr><td style="padding:7px 10px;border-bottom:1px solid #eee;">'+esc(_itemLabel(i, lang))+'</td><td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:center;">'+_pct(i.rate, lang)+'</td><td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:center;">'+(i.count||0)+'</td><td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;">'+_money(i.gross,cur,lang)+'</td><td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;">'+_money(i.fee,cur,lang)+'</td></tr>'; }).join('');
  let vat = '';
  if (_vatShow(s)) { const rate = s.sup_vat_rate || 21; const base = s.amount / (1 + rate / 100); vat = '<tr><td>'+T.base+'</td><td style="text-align:right;">'+_money(base,cur,lang)+'</td></tr><tr><td>'+T.vat+' '+rate+' %</td><td style="text-align:right;">'+_money(s.amount - base,cur,lang)+'</td></tr>'; }
  else { const _vt=_vatText(s, lang); vat = _vt ? ('<tr><td colspan="2" style="font-size:11px;color:#666;padding-top:6px;">'+esc(_vt)+'</td></tr>') : ''; }
  const cnt = items.filter((i) => !i.store).reduce((a, i) => a + (i.count || 0), 0), vol = items.reduce((a, i) => a + (i.store ? (i.cut || 0) : (i.gross || 0)), 0);
  const col = function(lbl, lines){ return '<div style="flex:1;min-width:220px;font-size:13px;line-height:1.55;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#888;margin-bottom:4px;">'+lbl+'</div>'+lines.map(function(l,ix){ return ix===0?('<b>'+esc(l)+'</b>'):esc(l); }).join('<br>')+'</div>'; };
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a;">'
    + (s.test_mode ? '<div style="background:#FDECEC;border:1px solid #F3C0C0;border-radius:8px;color:#8a1c1c;font:700 12px/1.4 Arial,sans-serif;padding:9px 12px;margin-bottom:12px;">'+T.test+'</div>' : '')
    + '<h2 style="margin:0 0 4px;">'+T.title+'</h2>'
    + '<div style="font-size:13px;color:#555;">'+(s.id?(esc(_dokNo(s))+' \u00b7 '):'')+T.issued+' '+esc(_czDate(s.charged_at, lang))+(s.duzp?(' \u00b7 '+T.duzp+' '+esc(_czDate(s.duzp+'T12:00:00Z', lang))):'')+' \u00b7 '+T.period+' '+esc(periodLabelL(s.period_month, lang))+' \u00b7 '+esc(_kindLabel(s, lang))+'</div>'
    + _statusBoxHtml(s, lang)
    + '<div style="display:flex;flex-wrap:wrap;gap:24px;margin:18px 0 6px;">'+col(T.supplier, _supLines(s, lang))+col(T.customer, _custLines(s, lang))+'</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;"><thead><tr style="background:#f5f2ee;"><th style="'+th+'text-align:left;">'+T.method+'</th><th style="'+th+'">'+T.rate+'</th><th style="'+th+'">'+T.count+'</th><th style="'+th+'text-align:right;">'+T.volume+'</th><th style="'+th+'text-align:right;">'+T.fee+'</th></tr></thead><tbody>'+rows+'</tbody></table>'
    + '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:4px;">'+vat+'<tr style="font-weight:800;"><td style="border-top:2px solid #333;padding-top:8px;">'+T.total+'</td><td style="text-align:right;border-top:2px solid #333;padding-top:8px;">'+_money(s.amount,cur,lang)+'</td></tr></table>'
    + '<div style="margin-top:10px;font-size:12px;color:#555;">'+T.payments+': <b>'+cnt+'</b> \u00b7 '+T.vol+' <b>'+_money(vol,cur,lang)+'</b></div>'
    + '</div>';
}

function dokladPdf(s, lang){
  const T=_t(lang);
  return new Promise(function(resolve, reject){
    try{
      const doc = new PDFDocument({ size:'A4', margin:50 });
      const chunks=[]; doc.on('data', function(d){ chunks.push(d); }); doc.on('end', function(){ resolve(Buffer.concat(chunks)); }); doc.on('error', reject);
      doc.registerFont('cz', DEJAVU_CZ); doc.font('cz');
      const cur = s.currency;
      if (s.test_mode) {
        const _ty = doc.y;
        doc.rect(50, _ty, 495, 24).fillAndStroke('#FDECEC', '#F3C0C0');
        doc.fillColor('#8a1c1c').fontSize(9).text(T.test.replace('\u{1F9EA} ', ''), 58, _ty + 8, { width: 479, align: 'center', lineBreak: false });
        doc.y = _ty + 38; doc.x = 50;
      }
      doc.fontSize(22).fillColor('#E11111').text('MTL', 50, doc.y);
      doc.moveDown(0.15).fontSize(15).fillColor('#111111').text(T.title);
      doc.moveDown(0.1).fontSize(10).fillColor('#555555').text((s.id ? (_dokNo(s) + '  \u00b7  ') : '') + T.issued + ' ' + _czDate(s.charged_at, lang) + (s.duzp ? ('  \u00b7  ' + T.duzp + ' ' + _czDate(s.duzp + 'T12:00:00Z', lang)) : '') + '  \u00b7  ' + T.period + ' ' + periodLabelL(s.period_month, lang) + '  \u00b7  ' + _kindLabel(s, lang));
      doc.moveDown(0.7);
      { // STAV ÚHRADY -- rámeček hned pod hlavičkou
        const st = _statusText(s, lang);
        const c = st.paid ? { bg:'#EAF7EE', bd:'#A8E6C0', fg:'#0E6B3A' } : { bg:'#FFF4E5', bd:'#F0C674', fg:'#8a5a00' };
        const y0 = doc.y;
        doc.fontSize(9.5);
        const hBody = doc.heightOfString(st.body, { width: 475 });
        const hBox = 14 + 15 + hBody + 10;
        doc.rect(50, y0, 495, hBox).fillAndStroke(c.bg, c.bd);
        doc.fillColor(c.fg).fontSize(12).text(st.head, 60, y0 + 9, { width: 475 });
        doc.fontSize(9.5).text(st.body, 60, doc.y + 2, { width: 475 });
        doc.y = y0 + hBox + 14; doc.x = 50;
      }
      const yTop = doc.y;
      const colText = function(x, label, lines){
        doc.fontSize(9).fillColor('#888888').text(label, x, yTop, { width:230 });
        lines.forEach(function(l, ix){ if (ix === 0) doc.fontSize(11).fillColor('#111111').text(l, x, doc.y, { width:230 }); else doc.fontSize(10).fillColor('#555555').text(l, x, doc.y, { width:230 }); });
        return doc.y;
      };
      const yL = colText(50, T.supplier.toUpperCase(), _supLines(s, lang));
      const yR = colText(315, T.customer.toUpperCase(), _custLines(s, lang));
      doc.y = Math.max(yL, yR) + 18;
      const cols = [50, 190, 260, 330, 440];
      const head = [T.method, T.rate, T.count, T.volume, T.fee];
      let y = doc.y;
      doc.fontSize(9).fillColor('#888888');
      head.forEach(function(h,i){ doc.text(h, cols[i], y, { width: (i>=3?105:(i===0?135:70)), align: (i>=3?'right':(i===0?'left':'center')) }); });
      y = doc.y + 4; doc.moveTo(50,y).lineTo(545,y).strokeColor('#dddddd').stroke(); y += 6;
      (s.line_items || []).forEach(function(it){
        doc.fontSize(10).fillColor('#111111');
        doc.text(_itemLabel(it, lang), cols[0], y, { width:135 });
        doc.text(_pct(it.rate, lang), cols[1], y, { width:70, align:'center' });
        doc.text(String(it.count || 0), cols[2], y, { width:70, align:'center' });
        doc.text(_money(it.gross, cur, lang), cols[3], y, { width:105, align:'right' });
        doc.text(_money(it.fee, cur, lang), cols[4], y, { width:105, align:'right' });
        y = doc.y + 5; doc.moveTo(50,y).lineTo(545,y).strokeColor('#eeeeee').stroke(); y += 5;
      });
      doc.y = y + 4;
      if (_vatShow(s)) {
        const rate = s.sup_vat_rate || 21; const base = s.amount / (1 + rate / 100);
        doc.fontSize(10).fillColor('#555555').text(T.base + ': ' + _money(base, cur, lang) + '   \u00b7   ' + T.vat + ' ' + rate + ' %: ' + _money(s.amount - base, cur, lang), 50, doc.y, { width:495 });
      } else { const _vt=_vatText(s, lang); if (_vt) doc.fontSize(9).fillColor('#777777').text(_vt, 50, doc.y, { width:495 }); }
      doc.moveDown(0.5);
      const yT = doc.y;
      doc.fontSize(13).fillColor('#111111').text(T.total, 50, yT, { width:230 });
      doc.text(_money(s.amount, cur, lang), 315, yT, { width:230, align:'right' });
      doc.y = Math.max(doc.y, yT) + 10;
      const items = s.line_items || [];
      const _its = items.filter((i) => !i.store);   // řádek obchodu počítá tytéž platby jako řádek provize
      doc.fontSize(9).fillColor('#555555').text(T.payments + ': ' + _its.reduce((a, i) => a + (i.count || 0), 0) + '  \u00b7  ' + T.vol + ' ' + _money(items.reduce((a, i) => a + (i.store ? (i.cut || 0) : (i.gross || 0)), 0), cur, lang), 50, doc.y, { width:495 });
      doc.end();
    }catch(e){ reject(e); }
  });
}

function dokladMailHtml(s, hasPdf, lang){
  const T=_t(lang);
  if (!hasPdf) return dokladHtml(s, lang);
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:14px;line-height:1.6;">'
    + (s.test_mode ? '<div style="background:#FDECEC;border:1px solid #F3C0C0;border-radius:8px;color:#8a1c1c;font:700 12px/1.4 Arial,sans-serif;padding:9px 12px;margin-bottom:14px;">'+T.test+'</div>' : '')
    // OSLOVENÍ: doklad zní na právní subjekt (odběratel = právní název + IČO), ne na název klubu
    // v appce. Česky se právní jméno do oslovení neskloňuje dobře („Dobrý den, Petr Haiser"), proto
    // neutrální pozdrav a komu doklad patří stojí věcně ve větě pod ním.
    + '<p style="margin:0 0 10px;">' + T.hello + ',</p>'
    + '<p style="margin:0 0 10px;">' + T.attached(esc(_dokNo(s)), esc(periodLabelL(s.period_month, lang)), esc(_money(s.amount, s.currency, lang))) + '</p>'
    + (s.cust_name ? ('<p style="margin:0 0 10px;">' + T.forWhom(esc(s.cust_name), s.cust_ico ? esc(s.cust_ico) : '', s.cust_trade_name ? ((s.organization_id ? T.inMtlOrg : (s.gym_id ? T.inMtlGym : T.inMtlCoach)) + ' \u201e' + esc(s.cust_trade_name) + '\u201c') : '') + '</p>') : '')
    + _statusBoxHtml(s, lang)
    + ((!_statusText(s, lang).paid && s._payLink) ? ('<p style="margin:14px 0;"><a href="' + s._payLink + '" style="display:inline-block;padding:12px 22px;background:#E63946;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">' + (lang === 'en' ? 'Pay now' : 'Zaplatit hned') + '</a></p>') : '')
    + '<p style="margin:18px 0 0;color:#888;font-size:12px;">' + esc(s.sup_name || 'Martial Training Lab') + (s.sup_email ? (' \u00b7 ' + esc(s.sup_email)) : '') + (s.sup_phone ? (' \u00b7 ' + esc(s.sup_phone)) : '') + '</p></div>';
}

function introSummaryHtml(s, until, lang){
  const T=_t(lang); const items = s.line_items || [];
  const _cnt = items.reduce((a, i) => a + (i.count || 0), 0);
  const _vol = items.reduce((a, i) => a + (i.gross || 0), 0);
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">'
    + (s.test_mode ? '<div style="background:#FDECEC;border:1px solid #F3C0C0;border-radius:8px;color:#8a1c1c;font:700 12px/1.4 Arial,sans-serif;padding:9px 12px;margin-bottom:12px;">'+T.test+'</div>' : '')
    + '<h2 style="margin:0 0 2px;">'+T.introTitle+'</h2>'
    + '<div style="font-size:13px;color:#666;margin-bottom:14px;">' + T.period + ' ' + esc(periodLabelL(s.period_month, lang)) + '  \u00b7  ' + esc(_kindLabel(s, lang)) + '</div>'
    + '<div style="font-size:13px;margin-bottom:14px;"><b>' + esc(s.cust_name || '\u2014') + '</b>' + (s.cust_ico ? ('<br>' + T.regno + ': ' + esc(s.cust_ico)) : '') + '</div>'
    + '<table style="width:100%;border-collapse:collapse;">'
      + '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">' + T.payments + '</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;"><b>' + _cnt + '</b></td></tr>'
      + '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">' + T.volume + '</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;"><b>' + esc(_money(_vol, s.currency, lang)) + '</b></td></tr>'
      + '<tr><td style="padding:10px 0;font-weight:700;">' + T.introFee + '</td><td style="padding:10px 0;text-align:right;font-weight:700;">' + esc(_money(0, s.currency, lang)) + '</td></tr>'
    + '</table>'
    + '<p style="font-size:12px;color:#666;line-height:1.6;margin-top:14px;">' + T.introNone(until ? esc(_czDate(until, lang)) : '') + '</p>'
    + '</div>';
}

// Odeslání přes Resend. Vrací, jestli to prošlo -- dřív se odpověď nečetla, takže odmítnutý
// e-mail (neověřená doména, špatný odesílatel) vypadal stejně jako odeslaný.
async function sendEmail(to, subject, html, attachments){
  if (!RESEND) return { ok: false, error: 'RESEND_API_KEY není nastavený' };
  if (!to) return { ok: false, error: 'chybí adresa' };
  try{
    const r = await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:'Bearer '+RESEND, 'Content-Type':'application/json' }, body: JSON.stringify(Object.assign({ from: MAIL_FROM, to:[to], subject, html }, (attachments && attachments.length) ? { attachments } : {})) });
    if (!r.ok) { const t = await r.text(); console.error('doklad email', r.status, t.slice(0, 300)); return { ok: false, error: 'Resend ' + r.status + ': ' + t.slice(0, 200) }; }
    return { ok: true };
  }catch(e){ console.error('doklad email', e.message); return { ok: false, error: e.message }; }
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'env' });
  // ZAVŘENO. Dřív endpoint neověřoval nic: kdokoli mohl spustit vystavování dokladů a přes
  // ?preview=1 si stáhnout doklad prvního subjektu i s fakturačními údaji (jméno, IČO,
  // adresa, e-mail). Vercel cron posílá Authorization: Bearer <CRON_SECRET> sám, stejně tak
  // doklad-catchup-cron a stripe-webhook. Náhled z prohlížeče tím končí -- doklady se
  // prohlížejí v appce (Doklady provize MTL).
  {
    const _sec = process.env.CRON_SECRET;
    const _auth = (req && req.headers && req.headers.authorization) || '';
    if (!_sec) return res.status(500).json({ error: 'CRON_SECRET not configured' });
    if (_auth !== `Bearer ${_sec}`) return res.status(401).json({ error: 'unauthorized' });
  }
  const q = (req && req.query) || {};
  const preview = (q.preview === '1' || q.preview === 'true');
  // TEST MODE: daily doklad for the founder only, so Petr sees the commission receipt in real time.
  // LIVE stays exactly as before: one monthly doklad per provider, with the IChO/DIChC + VAT flow intact.
  let TEST = false; try { TEST = await isTestMode(); } catch (e) {}
  // A club or coach can be on daily without the whole platform being in test mode.
  let dailyAny = false;
  try {
    const _dg = await sb('gyms?commission_daily=is.true&select=id&limit=1');
    const _dc = await sb('profiles?commission_daily=is.true&select=id&limit=1');
    const _do = await sb('organizations?commission_daily=is.true&select=id&limit=1'); dailyAny = !!((_dg && _dg.length) || (_dc && _dc.length) || (_do && _do.length));
  } catch (e) {}
  const DAILY = TEST || dailyAny;
  // Testovací režim platformy. Doklad vystavený v testu musí být jako testovací poznat i v mailu,
  // který člověku zůstane ve schránce i po smazání testovacích dat.
  // POZOR: nesouvisí s proměnnou TEST výš -- ta znamená ruční spuštění cronu s ?test=1.
  let _TESTMODE = false;
  try {
    const _pc = await sb('platform_config?select=test_mode&id=eq.1');
    _TESTMODE = !!(_pc && _pc[0] && _pc[0].test_mode);
  } catch (e) {}
  let period, dayStart = null, dayEnd = null;
  if (DAILY) {
    // Today, not yesterday. commission-cron charges half an hour earlier, so the receipt should
    // describe that charge -- a receipt for the previous day documents money taken on a different
    // day and the two never reconcile.
    const d = (q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date)) ? q.date : new Date().toISOString().slice(0, 10);
    period = d; dayStart = d + 'T00:00:00';
    dayEnd = new Date(new Date(d + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10) + 'T00:00:00';
  } else {
    period = (q.month && /^\d{4}-\d{2}$/.test(q.month)) ? q.month : prevMonth(pragueMonth());
  }
  let ME = {}; try { const _ps = await sb('platform_settings?id=eq.1&select=*'); ME = (_ps && _ps[0]) || {}; } catch (e) {}
  let issued = 0, skipped = 0, deferred = 0;
  let window_diag = null;
  try {
    // every collected commission row for the closed month (bank charged + Stripe live)
    // CHANGED. The daily branch used to select on created_at, i.e. what was SOLD today, while
    // commission-cron charges by commission_status, i.e. what was OWED. On a day with no sales the
    // card was still charged and no receipt existed for it. Daily now reads commission_collected_at,
    // which commission-cron stamps at the moment the card goes through, so the receipt describes
    // exactly the charge that just happened. Preview keeps the old shape on purpose: it is a dry run
    // over what has not been billed yet, so it must still see pending rows.
    const _dailyFilter = preview
      ? `created_at=gte.${dayStart}&created_at=lt.${dayEnd}`
      : `commission_collected_at=gte.${dayStart}&commission_collected_at=lt.${dayEnd}`;
    const tx = await sb(`transactions?select=gym_id,coach_id,organization_id,paid_to,payee_kind,currency,mtl_fee,mtl_fee_refunded,mtl_rate,gross_amount,payment_method,acq_source,base_rate,store_fee&commission_status=in.(collected${preview?',pending,failed':''})&${DAILY?_dailyFilter:`commission_month=eq.${period}`}&mtl_fee=gt.0&limit=50000`);

    // ── DOKLAD AŽ PO STRŽENÍ ────────────────────────────────────────────────────────────
    // Doklad se vystavuje na UHRAZENOU provizi. Karetní provize je vybraná hned při platbě,
    // hotovost/QR/převod až strhnutím z karty od 6. dne dalšího měsíce. Tenhle cron ale běží
    // denně, takže 1. dne vystavil doklad jen s karetní částí -- a protože na období a měnu
    // vzniká jediný doklad, hotovostní část se pak už na žádný nedostala.
    //
    // Nově se pro každý subjekt a měnu čeká, dokud v tom období zůstává nestržená provize.
    // Jakmile poslední řádek zčerná na 'collected', vystaví se doklad kompletní.
    //
    // VÝJIMKA: částky pod minimem Stripe zůstávají 'pending' schválně a čekají, až přeteče.
    // Ty se ignorují, jinak by doklad nevznikl nikdy.
    const _minFor = (cur) => minChargeFor(cur);   // minima jsou v _config.js
    // ── KDY VZNIKÁ FAKTURA ─────────────────────────────────────────────────────────────
    // Před dnem stržení (6. den následujícího měsíce) se čeká, dokud je v období nestržená
    // provize nad minimum -- jinak by faktura vznikla jen s karetní částí.
    // Ode dne stržení se NEČEKÁ NA ČAS, ale na VÝSLEDEK stržení u každého subjektu zvlášť:
    //   - všechno stržené ('collected')                 -> faktura „Uhrazeno v plné výši"
    //   - stržení neprošlo ('failed')                    -> faktura s částkou „K úhradě"
    //   - subjekt nemá kartu (nejde strhnout)            -> faktura s částkou „K úhradě"
    //   - zbytek pod minimem karty                       -> faktura, zbytek „strhne se s další provizí"
    //   - 'pending' nad minimum A karta je               -> commission-cron se k subjektu ještě
    //     nedostal (běží dřív, ale může běžet déle nebo vynechat běh) -> počká se na příští běh.
    //   - pozastavený účet (commission-cron ho nestrhává)  -> faktura s částkou „K úhradě"
    // POJISTKA: 15. den následujícího měsíce se faktura vystaví VŽDY (lhůta pro fakturu do EU),
    // i kdyby stržení z jakéhokoli neznámého důvodu neproběhlo -- zbytek jako „K úhradě".
    // Pořadí cronů ani letní/zimní čas tak o ničem nerozhodují. Pozdější úhrada fakturu nemění,
    // vystaví se k ní „Doklad o uhrazené provizi MTL" (_receipt.js).
    const CHARGE_DAY = 6, LAST_DAY = 15;
    const _pastLast = !DAILY && /^\d{4}-\d{2}$/.test(String(period))
      && pragueDate() >= (shiftMonth(period, 1) + '-' + String(LAST_DAY).padStart(2, '0'));
    const _pastCutoff = !DAILY && /^\d{4}-\d{2}$/.test(String(period))
      && pragueDate() >= (shiftMonth(period, 1) + '-' + String(CHARGE_DAY).padStart(2, '0'));
    const _waiting = {};   // 'kind:id[|payout]:mena' -> { pending, failed }
    const _ent = {};       // 'kind:id' -> { card, failed_at }
    let _unpaidRows = [];
    const _wkey = (o, cur) => o.kind + ':' + o.id + (o.kind === 'coach' && o.identity === 'payout' ? '|payout' : '') + ':' + cur;
    if (!DAILY && !preview) {
      try {
        const unpaid = await sb(`transactions?select=gym_id,coach_id,organization_id,paid_to,payee_kind,currency,mtl_fee,mtl_fee_refunded,mtl_rate,gross_amount,payment_method,acq_source,base_rate,store_fee,commission_status&commission_status=in.(pending,failed)&commission_month=eq.${period}&mtl_fee=gt.0&limit=50000`);
        _unpaidRows = unpaid || [];
        (unpaid || []).forEach(r => {
          const net = (Number(r.mtl_fee) || 0) - (Number(r.mtl_fee_refunded) || 0);
          if (net <= 0) return;
          const o = commissionOwner(r); if (!o) return;     // stejné vlastnictví jako na faktuře
          const k = _wkey(o, String(r.currency || 'czk').toLowerCase());
          const w = (_waiting[k] = _waiting[k] || { pending: 0, failed: 0 });
          if (r.commission_status === 'failed') w.failed += net; else w.pending += net;
        });
        // Karta a hodiny selhání subjektů, které mají nestrženou provizi.
        const ids = { gym: new Set(), coach: new Set(), organization: new Set() };
        Object.keys(_waiting).forEach(k => { const [kind, idp] = k.split(':'); ids[kind] && ids[kind].add(idp.replace(/\|payout$/, '')); });
        const tbl = { gym: 'gyms', coach: 'profiles', organization: 'organizations' };
        for (const kind of Object.keys(ids)) {
          const list = [...ids[kind]]; if (!list.length) continue;
          const rows = await sb(`${tbl[kind]}?id=in.(${list.join(',')})&select=id,commission_card_pm,commission_card_customer,commission_failed_at,account_suspended`) || [];
          // Karta = obojí, co commission-cron ke stržení potřebuje (zákazník i platební metoda).
          rows.forEach(x => { _ent[kind + ':' + x.id] = { card: !!(x.commission_card_pm && x.commission_card_customer), failed_at: x.commission_failed_at || null, suspended: !!x.account_suspended }; });
        }
      } catch (e) { console.error('[doklad] kontrola nestržených:', e.message); }
    }
    // true = ještě se čeká na stržení, faktura se dnes nevystaví
    const _holdFor = (kind, entityId, cur) => {
      if (DAILY || preview) return false;
      const w = _waiting[kind + ':' + String(entityId || '') + ':' + String(cur || 'czk').toLowerCase()];
      if (!w) return false;
      const min = _minFor(cur);
      if (!_pastCutoff) return (w.pending + w.failed) >= min;
      if (_pastLast) return false;                       // pojistka: 15. den už se nečeká
      const e = _ent[kind + ':' + String(entityId || '').replace(/\|payout$/, '')] || {};
      if (e.suspended) return false;                     // pozastavený účet se nestrhává
      return w.pending >= min && !!e.card;
    };
    // Proč zůstala část faktury nestržená -- jde do faktury (due_reason) a řídí její text.
    const _dueReason = (kind, entityId, wkey, cur) => {
      const e = _ent[kind + ':' + String(entityId || '').replace(/\|payout$/, '')] || {};
      if (e.failed_at || e.suspended) return 'failed';   // pozastavení vzniká z neuhrazené provize
      if (!e.card) return 'no_card';
      // Nestrženo nad minimum, karta je, selhání není: stržení neproběhlo (pojistka 15. dne).
      const w = (_waiting[wkey] && _waiting[wkey].pending) || 0;
      if (w >= _minFor(cur) && !e.suspended) return 'not_charged';
      return 'below_min';
    };

    // Posbírat diagnostiku hned tady -- tx a buckety jsou lokální pro tenhle blok a u návratové
    // hodnoty už neexistují. Bez toho se z odpovědi nedá poznat, jestli filtr nic nenašel, nebo
    // našel transakce s nulovou provizí.
    window_diag = { daily: DAILY, test: TEST, dailyAny, dayStart, dayEnd,
                    txFound: (tx || []).length,
                    txWithFee: (tx || []).filter(r => (Number(r.mtl_fee) || 0) > 0).length };
    // bucket per provider + currency, with a per-(form,rate) breakdown
    const gymB = {}, coachB = {}, orgB = {};
    const bucket = (store, id, cur) => { store[id] = store[id] || {}; store[id][cur] = store[id][cur] || { total: 0, rates: {} }; return store[id][cur]; };
    const add = (b, t) => {
      const net = (t.mtl_fee || 0) - (t.mtl_fee_refunded || 0);
      if (net === 0) return;
      b.total += net;
      // Nativní nákup: z application fee je část náklad obchodu (store_fee) -- jde na vlastní
      // řádek. Při vrácení peněz se obě části krátí stejným poměrem jako celá application fee.
      const _sfAll = Number(t.store_fee) || 0;
      const _sf = _sfAll > 0 ? Math.min(net, Math.round(_sfAll * (t.mtl_fee ? net / t.mtl_fee : 1))) : 0;
      if (_sf !== 0) {
        const es = (b.rates.store = b.rates.store || { method: 'stripe', store: true, rate: STORE_COST, fee: 0, count: 0, gross: 0, cut: 0 });
        es.fee += _sf; es.count += 1; es.gross += (t.gross_amount || 0); es.cut += _sfAll;   // cut: o kolik je základ provize nižší než platba
      }
      const _cn = net - _sf;
      if (_cn === 0) return;
      // AKVIZIČNÍ PROVIZE (první platba člena, kterého přivedlo MTL) zvlášť a s popisem -- jinak
      // na dokladu stál řádek „Platba z banky 10 %" a nebylo poznat, proč je sazba jiná.
      const acq = (t.acq_source === 'mtl_discovery' || t.acq_source === 'mtl_ads') && t.mtl_rate != null && (t.base_rate != null ? Number(t.mtl_rate) > Number(t.base_rate) + 1e-9 : Number(t.mtl_rate) >= 0.05);   // bez base_rate: sazby žebříčku jsou max 2,5 %, akvizice 5 / 10 %
      const key = (t.payment_method || '?') + '|' + (t.mtl_rate != null ? String(t.mtl_rate) : 'na') + (acq ? '|acq' : '');
      const e = (b.rates[key] = b.rates[key] || { method: t.payment_method || null, rate: (t.mtl_rate != null ? Number(t.mtl_rate) : null), acq: acq || undefined, fee: 0, count: 0, gross: 0 });
      // Základ provize u nativního nákupu = cena po odečtení nákladu obchodu.
      e.fee += _cn; e.count += 1; e.gross += (t.gross_amount || 0) - _sfAll;
    };
    for (const t of (tx || [])) {
      const cur = (t.currency || 'czk').toLowerCase();
      const o = commissionOwner(t);
      if (!o) continue;
      if (o.kind === 'organization') add(bucket(orgB, o.id, cur), t);
      else if (o.kind === 'coach') add(bucket(coachB, o.id + (o.identity === 'payout' ? '|payout' : ''), cur), t);
      else add(bucket(gymB, o.id, cur), t);
    }
    // NESTRŽENÁ PROVIZE ZA OBDOBÍ patří na fakturu taky -- jako „K úhradě" (due). Dřív se na
    // fakturu dostalo jen stržené; co bylo pod minimem karty nebo stržení selhalo, se na
    // žádnou fakturu nedostalo nikdy (další měsíc už filtruje jiné období). Když se ještě
    // čeká na stržení (_holdFor), faktura se tenhle den stejně nevystaví.
    if (!DAILY && !preview) {
      for (const t of _unpaidRows) {
        const net = (t.mtl_fee || 0) - (t.mtl_fee_refunded || 0);
        if (net <= 0) continue;
        const cur = (t.currency || 'czk').toLowerCase();
        const o = commissionOwner(t);
        if (!o) continue;
        const b = (o.kind === 'organization') ? bucket(orgB, o.id, cur)
          : (o.kind === 'coach') ? bucket(coachB, o.id + (o.identity === 'payout' ? '|payout' : ''), cur)
          : bucket(gymB, o.id, cur);
        add(b, t); b.due = (b.due || 0) + net;
      }
    }

    // Majitele organizaci -- doklad zni na organizaci, ale plati ji jeji vlastnik.
    const orgIds = Object.keys(orgB);
    const orgMap = {};
    if (orgIds.length) {
      const os = await sb(`organizations?id=in.(${orgIds.join(',')})&select=id,name,owner_id`);
      (os || []).forEach(o => { orgMap[o.id] = o; });
    }

    // resolve gym owners
    const gymIds = Object.keys(gymB);
    const gymMap = {};
    if (gymIds.length) { const gs = await sb(`gyms?id=in.(${gymIds.join(',')})&select=id,name,owner_id`); (gs || []).forEach(g => { gymMap[g.id] = g; }); }

    const mailDiag = { sent: 0, failed: 0, lastError: null };
    async function issue(kind, entityId, ownerId, cur, data) {
      // Přípona |payout na klíči znamená klubové plnění kouče -> druhá fakturační identita.
      const _payout = /\|payout$/.test(String(entityId));
      if (_payout) entityId = String(entityId).replace(/\|payout$/, '');
      if (_payout) ownerId = entityId;
      const _bp = _payout ? 'payout_' : '';
      const identity = (kind === 'coach') ? (_payout ? 'payout' : 'own') : null;
      const col = kind === 'gym' ? 'gym_id' : (kind === 'organization' ? 'organization_id' : 'coach_id');
      let _intro = null, _lang = 'cs';
      try {
        const _p = (await sb(`profiles?id=eq.${encodeURIComponent(ownerId)}&select=billing_country,lang`))[0];
        _lang = (_p && _p.lang === 'en') ? 'en' : 'cs';
        _intro = await introFreeFor(sb, _p && _p.billing_country);
      } catch (e) { console.error('issue introFreeFor:', e.message); }
      if (TEST && !dailyAny && String(ownerId) !== FOUNDER_UUID) { skipped++; return; }
      // Jeden doklad na subjekt + období + měnu. U kouče ZVLÁŠŤ za každou identitu: vlastní 1:1 a
      // režim klub jsou dva plátci -- dřív druhý doklad narazil na první a nevznikl.
      // Nestržená provize za tohle období -> doklad počká na příští běh.
      if (_holdFor(kind, entityId + (_payout ? '|payout' : ''), cur)) { deferred++; return; }
      const _idf = (kind === 'coach') ? (_payout ? '&billing_identity=eq.payout' : '&or=(billing_identity.is.null,billing_identity.eq.own)') : '';
      const ex = await sb(`commission_doklady?select=id&${col}=eq.${entityId}&period_month=eq.${period}&currency=ilike.${encodeURIComponent(cur)}&kind=eq.unified${_idf}&limit=1`);
      if (ex && ex.length) { skipped++; return; }

      let buyer = null;
      try { buyer = await loadBuyer(kind, entityId, ownerId, _bp); } catch (e) { console.error('loadBuyer', e.message); }
      // Bez druhé identity se doklad NEVYSTAVÍ -- fakturovat provizi osobním údajům kouče by
      // znamenalo jiný subjekt, než který plnění poskytl. record-cash platbu bez identity odmítne,
      // takže sem se v praxi nedojde.
      if (_payout && !(buyer && buyer.legal_name)) { console.log('[doklad] kouc', entityId, 'nema identitu rezimu klub, doklad odlozen'); deferred++; return; }
      // ---- FOREIGN-VAT GATE (platform_settings.require_vat_foreign) ----
      if (!DAILY && ME && ME.require_vat_foreign) {
        const home = ctryCode({ country: ME.home_country }) || 'CZ';
        const bc = ctryCode(buyer);
        const euForeign = !!bc && bc !== home && EU_VAT.has(bc) && EU_VAT.has(home);
        const hasVat = !!(buyer && String(buyer.vat_id || '').trim());
        if (euForeign && !hasVat) {
          deferred++;
          if (ownerId) {
            try { await notify(ownerId, 'doklad_vat_needed', `\u26a0\ufe0f Faktura za ${periodLabel(period)} zat\u00edm nevystavena \u2014 dopl\u0148 DI\u010c (VAT ID), a\u0165 ti ji m\u016f\u017eeme vystavit podle EU pravidel. Provize z\u016fst\u00e1v\u00e1 evidovan\u00e1 a fakturu vystav\u00edme zp\u011btn\u011b.`, { period, currency: cur, needs: 'vat_id', msg_en: `\u26a0\ufe0f The invoice for ${periodLabelL(period, 'en')} has not been issued yet \u2014 add your VAT ID so we can issue it under EU rules. The commission stays on record and we will issue it retroactively.` }); } catch (e) {}
          }
          return;
        }
      }

      const snap = buildSnap(kind, entityId, ownerId, identity, period, cur, data, ME, buyer, _TESTMODE);
      // DŮVOD A SPLATNOST nestržené části. Selhání stržení -> splatnost = den pozastavení účtu
      // (14 dní od prvního selhání, jako v commission-cron). Chybí karta -> splatnost 14 dní od
      // vystavení. Pod minimem karty -> bez splatnosti, strhne se s další provizí.
      if (snap.due_amount > 0) {
        snap.due_reason = _dueReason(kind, entityId, kind + ':' + entityId + (_payout ? '|payout' : '') + ':' + String(cur || 'czk').toLowerCase(), cur);
        const _e = _ent[kind + ':' + entityId] || {};
        if (snap.due_reason === 'failed' && _e.failed_at) snap.due_date = pragueDate(new Date(Date.parse(_e.failed_at) + 14 * 86400000));
        else if (snap.due_reason === 'no_card' || snap.due_reason === 'not_charged' || (snap.due_reason === 'failed' && !_e.failed_at)) snap.due_date = pragueDate(new Date(Date.now() + 14 * 86400000));
      }
      // ÚHRADA STARŠÍCH FAKTUR TÍMTO STRŽENÍM. Když stržení provize za tenhle měsíc zaplatilo
      // i zbytek starší faktury (částka pod minimem, doplatek po neúspěšném stržení), uvede to
      // tahle faktura v rámečku úhrady -- mimo položky a mimo součet (DUZP i položky zůstávají
      // čistě za tenhle měsíc). Starší faktura se nemění; jako „uhrazenou" ji pozná appka podle
      // tohoto odkazu. Bere se jen faktura, za jejíž měsíc už nic nestrženého nezbývá.
      if (!DAILY && !preview && !(snap.due_amount > 0)) {
        try {
          const _olds = await undocumentedUnpaid(`${col}=eq.${entityId}&kind=eq.unified&currency=ilike.${encodeURIComponent(cur)}&period_month=lt.${period}${_idf}`);
          const _paid = [];
          for (const o of _olds) {
            const _left = await sb(`transactions?${col}=eq.${entityId}&commission_month=eq.${o.period_month}&currency=ilike.${encodeURIComponent(cur)}&commission_status=in.(pending,failed)&mtl_fee=gt.0&select=gym_id,coach_id,organization_id,paid_to,payee_kind,mtl_fee,mtl_fee_refunded&limit=1000`) || [];
            const _mine = _left.filter((t) => { const ow = commissionOwner(t); return ow && ow.kind === kind && String(ow.id) === String(entityId) && (kind !== 'coach' || (ow.identity === 'payout') === _payout); });
            if (_mine.length) continue;
            _paid.push({ ref: o.id, doc_no: _docNoOf(o), period: o.period_month, amount: Number(o.due_amount) || 0, reason: o.due_reason || (o.due_date ? 'failed' : 'below_min') });
          }
          if (_paid.length) snap.paid_other = _paid;
        } catch (e) { console.error('[doklad] parovani', e.message); }
      }
      let _ins;
      try { _ins = await sb('commission_doklady', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(snap) }); }
      catch (e) {
        // Databáze bez nových sloupců (SQL ještě nespuštěné): doklad se vystaví bez nich,
        // ne vůbec. Jiná chyba jde dál jako dřív.
        if (!/sup_register|vat_mode|vat_note|due_amount|due_date|due_reason|duzp|paid_other/.test(String(e && e.message))) throw e;
        console.warn('[doklad] commission_doklady: chybi novy sloupec -- spust sql/doklad-register.sql');
        // Neuhrazenou fakturu bez sloupců due_* vystavit nejde -- vypadala by jako uhrazená.
        if (snap.due_amount > 0) { deferred++; return; }
        delete snap.sup_register; delete snap.vat_mode; delete snap.vat_note; delete snap.due_amount; delete snap.due_date; delete snap.due_reason; delete snap.duzp; delete snap.paid_other;
        _ins = await sb('commission_doklady', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(snap) });
      }
      const row = Array.isArray(_ins) ? _ins[0] : _ins;
      snap.id = row && row.id;
      snap.doc_no = (row && row.doc_no) || null;   // číslo přidělila databáze při vložení
      issued++;
      // Kdo dostane víc zpráv naráz, musí poznat, která je která: klub/organizace jménem, kouč identitou.
      const _nm = ((kind === 'gym' || kind === 'organization') && buyer && buyer.name) ? (' \u2014 ' + buyer.name)
        : (kind === 'coach' ? (_payout ? ' \u2014 kou\u010d, re\u017eim klub' : ' \u2014 kou\u010d, soukrom\u00e9 lekce') : '');
      const _nmEn = ((kind === 'gym' || kind === 'organization') && buyer && buyer.name) ? (' \u2014 ' + buyer.name) : (kind === 'coach' ? (_payout ? ' \u2014 coach, club mode' : ' \u2014 coach, private sessions') : '');
      const _nmL = (_lang === 'en') ? _nmEn : _nm;

      // JEDNA NOTIFIKACE za provizi: kolik, jak se strhlo, a proklik PŘÍMO na doklad.
      if (ownerId) {
        const _how = function(lg){ return (snap.bank_amount > 0 && snap.stripe_amount > 0)
          ? (_money(snap.bank_amount, cur, lg) + (lg === 'en' ? ' charged to the card, ' : ' str\u017eeno z karty, ') + _money(snap.stripe_amount, cur, lg) + (lg === 'en' ? ' with card payments' : ' p\u0159i platb\u00e1ch kartou'))
          : (snap.bank_amount > 0 ? (lg === 'en' ? 'charged to the saved card' : 'str\u017eeno z ulo\u017een\u00e9 karty') : (lg === 'en' ? 'taken with card payments' : 'str\u017eeno p\u0159i platb\u00e1ch kartou')); };
        const _due = snap.due_amount > 0;
        const _dueCs = _due ? (` K \u00fahrad\u011b zb\u00fdv\u00e1 ${_money(snap.due_amount, cur)}` + (snap.due_date ? ` (splatnost ${_czDate(snap.due_date + 'T12:00:00Z', 'cs')})` : ' (strhne se s dal\u0161\u00ed proviz\u00ed)') + '.') : '';
        const _dueEn = _due ? (` Amount still due: ${_money(snap.due_amount, cur, 'en')}` + (snap.due_date ? ` (due ${_czDate(snap.due_date + 'T12:00:00Z', 'en')})` : ' (charged with the next commission)') + '.') : '';
        try { await notify(ownerId, 'doklad_unified', `${_due ? '\u26a0\ufe0f ' : ''}Provize MTL${_nm} za ${periodLabel(period)}: ${_money(snap.amount, cur)}${_due ? '' : ` (${_how('cs')})`}. Faktura je vystaven\u00e1.${_dueCs}`,
          { period, currency: cur, doklad_id: snap.id || null,
            gym_id: (kind === 'gym' ? entityId : null), organization_id: (kind === 'organization' ? entityId : null),
            coach_id: (kind === 'coach' ? entityId : null), gym_name: ((kind !== 'coach' && buyer && buyer.name) ? buyer.name : null),
            msg_en: `${_due ? '\u26a0\ufe0f ' : ''}MTL commission${_nmEn} for ${periodLabelL(period, 'en')}: ${_money(snap.amount, cur, 'en')}${_due ? '' : ` (${_how('en')})`}. The invoice has been issued.${_dueEn}` }); } catch (e) {}
      }

      // Neuhrazená faktura: v e-mailu tlačítko „Zaplatit hned" (stejný odkaz jako ve výzvě
      // z commission-cron). Jen do těla mailu -- do snímku se neukládá.
      if (snap.due_amount > 0 && snap.due_reason !== 'below_min') {
        try { snap._payLink = `${(process.env.APP_URL || 'https://app.martialtraininglab.com').replace(/\/+$/, '')}/pay-commission?token=${makePayToken(kind === 'organization' ? 'org' : kind, entityId, pragueMonth())}`; } catch (e) {}
      }
      // E-MAIL na fakturační adresu ze snímku -- stejnou, jaká je na dokladu.
      const em = snap.cust_email;
      if (!em) { mailDiag.failed++; mailDiag.lastError = 'bez adresy: ' + kind + ' ' + entityId; return; }
      let sent;
      if (_intro) {
        sent = await sendEmail(em, `${_TESTMODE ? '[TEST] ' : ''}${_t(_lang).subjIntro} \u2014 ${_lang === 'en' ? periodLabelL(period, 'en') : periodShort(period)}${_nmL}`, introSummaryHtml(snap, _intro.until, _lang), []);
      } else {
        let _att = [];
        try {
          const _buf = await dokladPdf(snap, _lang);
          _att = [{ filename: `${_dokNo(snap)}-${_lang === 'en' ? 'commission' : 'provize'}-${String(period).replace(/-/g,'')}.pdf`, content: _buf.toString('base64') }];
        } catch (e) { console.error('doklad pdf', e.message); }
        sent = await sendEmail(em, `${_TESTMODE ? '[TEST] ' : ''}${_t(_lang).subjDoklad} ${_dokNo(snap)} \u2014 ${_lang === 'en' ? periodLabelL(period, 'en') : periodShort(period)}${_nmL}`, dokladMailHtml(snap, _att.length > 0, _lang), _att);
      }
      if (sent && sent.ok) mailDiag.sent++; else { mailDiag.failed++; mailDiag.lastError = (sent && sent.error) || 'nezn\u00e1m\u00e1 chyba'; }
    }

    if (preview) {
      let firstHtml = '';
      const firstOf = (store) => { for (const id of Object.keys(store)) for (const c of Object.keys(store[id])) return [id, c]; return null; };
      const pick = firstOf(gymB) ? ['gym', ...firstOf(gymB)] : (firstOf(coachB) ? ['coach', ...firstOf(coachB)] : (firstOf(orgB) ? ['organization', ...firstOf(orgB)] : null));
      if (pick) {
        const [pk, pid, pc] = pick;
        const store = pk === 'gym' ? gymB : (pk === 'coach' ? coachB : orgB);
        const _pay = /\|payout$/.test(pid); const eid = String(pid).replace(/\|payout$/, '');
        const owner = pk === 'gym' ? (gymMap[eid] && gymMap[eid].owner_id) : (pk === 'organization' ? (orgMap[eid] && orgMap[eid].owner_id) : eid);
        const b = await loadBuyer(pk, eid, owner, _pay ? 'payout_' : '');
        firstHtml = dokladHtml(buildSnap(pk, eid, owner, pk === 'coach' ? (_pay ? 'payout' : 'own') : null, period, pc, store[pid][pc], ME, b, _TESTMODE));
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(firstHtml || ('<p style="font-family:sans-serif;padding:24px;">\u017d\u00e1dn\u00e1 provize za ' + esc(period) + ' (zkus jin\u00fd ?month=RRRR-MM).</p>'));
    }
    // ?only=gym:<id> | coach:<id> | organization:<id> -- vystaví jen pro jeden subjekt. Volá to
    // stripe-webhook hned po úhradě přes „Zaplatit hned", aby doklad nečekal na ranní běh
    // a aby se kvůli jednomu klubu neprocházeli všichni ostatní.
    const _only = String(q.only || '').trim();
    const _want = (kind, id) => !_only || _only === (kind + ':' + String(id).replace(/\|payout$/, ''));
    for (const gid of gymIds) { const g = gymMap[gid]; if (!g || !_want('gym', gid)) continue; for (const cur of Object.keys(gymB[gid])) await issue('gym', gid, g.owner_id, cur, gymB[gid][cur]); }
    for (const cid of Object.keys(coachB)) { if (!_want('coach', cid)) continue; for (const cur of Object.keys(coachB[cid])) await issue('coach', cid, cid, cur, coachB[cid][cur]); }
    // Organizace: doklad zni na ni, ale plati ji jeji majitel -- proto se ownerId bere z nej.
    for (const oid of orgIds) { const o = orgMap[oid]; if (!o || !_want('organization', oid)) continue;
      for (const cur of Object.keys(orgB[oid])) await issue('organization', oid, o.owner_id, cur, orgB[oid][cur]); }

    // DIAGNOSTIKA: kolik transakcí filtr našel, kolik dokladů vzniklo a JESTLI ODEŠEL E-MAIL.
    return res.status(200).json({ ok: true, period, issued, skipped, deferred, mail: mailDiag, mailFrom: MAIL_FROM, diag: window_diag });
  } catch (e) {
    console.error('unified-doklad-cron', e.message);
    return res.status(500).json({ error: e.message });
  }
}
