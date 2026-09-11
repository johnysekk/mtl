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
import { isTestMode } from './_config.js';
import { introFreeFor } from './_rate.js';
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

function _methodLabel(m){ return m==='stripe'?'Stripe (karta)':(m==='pis'?'Platba z banky':(m==='qr'?'QR platba':(m==='cash'?'Hotovost':(m||'\u2014')))); }
function _pct(r){ return r!=null ? (Math.round(r*1000)/10).toString().replace('.',',')+' %' : '\u2014'; }
function _money(minor, cur){ return (Number(minor||0)/100).toFixed(2).replace('.',',')+' '+String(cur||'').toUpperCase(); }
// Na urovni modulu. Driv byla definovana jen uvnitr dokladHtml, ale pouzival ji i text e-mailu
// a prehled zavadeciho obdobi -- ReferenceError padl do tichého catch a E-MAIL NEODESEL NIKDY.
function esc(x){ return String(x==null?'':x).replace(/[<>&"]/g,function(c){ return c==='<'?'&lt;':c==='>'?'&gt;':c==='&'?'&amp;':'&quot;'; }); }
function _czDate(d){ try{ const x=new Date(d); return x.getUTCDate()+'. '+(x.getUTCMonth()+1)+'. '+x.getUTCFullYear(); }catch(e){ return String(d||''); } }
function _dokNo(id){ return 'MTL-' + id; }
function _kindLabel(s){ return s.organization_id ? 'organizace' : (s.gym_id ? 'klub' : (s.billing_identity==='payout' ? 'kou\u010d \u00b7 re\u017eim klub' : 'kou\u010d')); }

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
function buildSnap(kind, entityId, ownerId, identity, period, cur, data, ME, buyer, testMode) {
  const items = Object.values(data.rates || {});
  const bank = items.filter(i => i.method !== 'stripe').reduce((a, i) => a + i.fee, 0);
  const strp = items.filter(i => i.method === 'stripe').reduce((a, i) => a + i.fee, 0);
  const B = buyer || {};
  const legal = B.legal_name || B.name || null;
  const snap = { period_month: period, currency: cur, amount: data.total, bank_amount: bank, stripe_amount: strp, line_items: items,
    status: 'issued', kind: 'unified', owner_id: ownerId, charged_at: new Date().toISOString(), test_mode: !!testMode,
    billing_identity: (kind === 'coach') ? (identity || 'own') : null,
    cust_name: legal, cust_trade_name: (B.name && B.name !== legal) ? B.name : null,
    cust_ico: B.tax_id || null, cust_dic: B.vat_id || null, cust_address: B.address || null,
    cust_vat_payer: !!B.vat_payer, cust_country: B.billing_country || B.country || null,
    cust_email: B.email || null, cust_phone: B.phone || null,
    sup_name: ME.name || 'Martial Training Lab s.r.o.', sup_ico: ME.ico || null, sup_dic: ME.dic || null, sup_address: ME.sidlo || null,
    sup_vat_payer: !!ME.vat_payer, sup_vat_rate: (ME.vat_rate != null ? ME.vat_rate : null),
    sup_phone: ME.contact_phone || null, sup_email: ME.contact_email || null,
    gym_id: null, coach_id: null, organization_id: null };
  snap[kind === 'gym' ? 'gym_id' : (kind === 'organization' ? 'organization_id' : 'coach_id')] = entityId;
  return snap;
}
function _supLines(s){ return [s.sup_name, s.sup_address, s.sup_ico ? ('I\u010cO: ' + s.sup_ico) : '', s.sup_dic ? ('DI\u010c: ' + s.sup_dic) : '', s.sup_phone ? ('Tel.: ' + s.sup_phone) : '', s.sup_email ? ('E-mail: ' + s.sup_email) : ''].filter(Boolean); }
function _custLines(s){ return [s.cust_name || '\u2014', s.cust_trade_name ? ((s.organization_id ? 'Organizace v MTL: ' : (s.gym_id ? 'Klub v MTL: ' : 'Kou\u010d v MTL: ')) + s.cust_trade_name) : '', s.cust_address, s.cust_ico ? ('I\u010cO: ' + s.cust_ico) : '', s.cust_dic ? ('DI\u010c: ' + s.cust_dic) : '', (s.cust_country && String(s.cust_country).toUpperCase() !== 'CZ') ? ('St\u00e1t: ' + s.cust_country) : '', s.cust_phone ? ('Tel.: ' + s.cust_phone) : '', s.cust_email ? ('E-mail: ' + s.cust_email) : ''].filter(Boolean); }
function _howCharged(s){
  const parts = [];
  if (s.bank_amount > 0) parts.push('Provize z hotovosti, QR a plateb z banky (' + _money(s.bank_amount, s.currency) + ') byla str\u017eena z ulo\u017een\u00e9 platebn\u00ed karty dne ' + _czDate(s.charged_at) + '.');
  if (s.stripe_amount > 0) parts.push('Provize z plateb kartou (' + _money(s.stripe_amount, s.currency) + ') byla str\u017eena p\u0159\u00edmo p\u0159i ka\u017ed\u00e9 platb\u011b.');
  return parts.join(' ');
}
const _TEST_BANNER = '\u{1F9EA} TESTOVAC\u00cd RE\u017dIM \u2014 nejde o form\u00e1ln\u00ed da\u0148ov\u00fd doklad a k \u017e\u00e1dn\u00e9 skute\u010dn\u00e9 transakci nedo\u0161lo';

function dokladHtml(s){
  const items = s.line_items || [];
  const cur = s.currency;
  const th = 'padding:8px 10px;font-size:11px;color:#666;font-weight:700;';
  const rows = items.map(function(i){ return '<tr><td style="padding:7px 10px;border-bottom:1px solid #eee;">'+esc(_methodLabel(i.method))+'</td><td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:center;">'+_pct(i.rate)+'</td><td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:center;">'+(i.count||0)+'</td><td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;">'+_money(i.gross,cur)+'</td><td style="padding:7px 10px;border-bottom:1px solid #eee;text-align:right;">'+_money(i.fee,cur)+'</td></tr>'; }).join('');
  let vat = '';
  if (s.sup_vat_payer) { const rate = s.sup_vat_rate || 21; const base = s.amount / (1 + rate / 100); vat = '<tr><td>Z\u00e1klad dan\u011b</td><td style="text-align:right;">'+_money(base,cur)+'</td></tr><tr><td>DPH '+rate+' %</td><td style="text-align:right;">'+_money(s.amount - base,cur)+'</td></tr>'; }
  else vat = '<tr><td colspan="2" style="font-size:11px;color:#666;padding-top:6px;">Dodavatel nen\u00ed pl\u00e1tcem DPH.</td></tr>';
  const cnt = items.reduce((a, i) => a + (i.count || 0), 0), vol = items.reduce((a, i) => a + (i.gross || 0), 0);
  const col = function(lbl, lines){ return '<div style="flex:1;min-width:220px;font-size:13px;line-height:1.55;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#888;margin-bottom:4px;">'+lbl+'</div>'+lines.map(function(l,ix){ return ix===0?('<b>'+esc(l)+'</b>'):esc(l); }).join('<br>')+'</div>'; };
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a;">'
    + (s.test_mode ? '<div style="background:#FDECEC;border:1px solid #F3C0C0;border-radius:8px;color:#8a1c1c;font:700 12px/1.4 Arial,sans-serif;padding:9px 12px;margin-bottom:12px;">'+_TEST_BANNER+'</div>' : '')
    + '<h2 style="margin:0 0 4px;">Doklad o provizi MTL</h2>'
    + '<div style="font-size:13px;color:#555;">'+(s.id?(esc(_dokNo(s.id))+' \u00b7 '):'')+'Vystaveno '+esc(_czDate(s.charged_at))+' \u00b7 Obdob\u00ed '+esc(periodLabel(s.period_month))+' \u00b7 '+esc(_kindLabel(s))+'</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:24px;margin:18px 0 6px;">'+col('Dodavatel', _supLines(s))+col('Odb\u011bratel', _custLines(s))+'</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;"><thead><tr style="background:#f5f2ee;"><th style="'+th+'text-align:left;">Forma platby</th><th style="'+th+'">Sazba</th><th style="'+th+'">Plateb</th><th style="'+th+'text-align:right;">Objem plateb</th><th style="'+th+'text-align:right;">Provize</th></tr></thead><tbody>'+rows+'</tbody></table>'
    + '<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:4px;">'+vat+'<tr style="font-weight:800;"><td style="border-top:2px solid #333;padding-top:8px;">Celkem</td><td style="text-align:right;border-top:2px solid #333;padding-top:8px;">'+_money(s.amount,cur)+'</td></tr></table>'
    + '<div style="margin-top:10px;font-size:12px;color:#555;">Zprost\u0159edkovan\u00fdch plateb: <b>'+cnt+'</b> \u00b7 objem <b>'+_money(vol,cur)+'</b></div>'
    + '<p style="font-size:12px;color:#555;margin-top:10px;line-height:1.55;">'+esc(_howCharged(s))+' Nejde o v\u00fdzvu k platb\u011b.</p>'
    + '</div>';
}

function dokladPdf(s){
  return new Promise(function(resolve, reject){
    try{
      const doc = new PDFDocument({ size:'A4', margin:50 });
      const chunks=[]; doc.on('data', function(d){ chunks.push(d); }); doc.on('end', function(){ resolve(Buffer.concat(chunks)); }); doc.on('error', reject);
      doc.registerFont('cz', DEJAVU_CZ); doc.font('cz');
      const cur = s.currency;
      if (s.test_mode) {
        const _ty = doc.y;
        doc.rect(50, _ty, 495, 24).fillAndStroke('#FDECEC', '#F3C0C0');
        doc.fillColor('#8a1c1c').fontSize(9).text(_TEST_BANNER.replace('\u{1F9EA} ', ''), 58, _ty + 8, { width: 479, align: 'center', lineBreak: false });
        doc.y = _ty + 38; doc.x = 50;
      }
      doc.fontSize(22).fillColor('#E11111').text('MTL', 50, doc.y);
      doc.moveDown(0.15).fontSize(15).fillColor('#111111').text('Doklad o provizi MTL');
      doc.moveDown(0.1).fontSize(10).fillColor('#555555').text((s.id ? (_dokNo(s.id) + '  \u00b7  ') : '') + 'Vystaveno ' + _czDate(s.charged_at) + '  \u00b7  Obdob\u00ed ' + periodLabel(s.period_month) + '  \u00b7  ' + _kindLabel(s));
      doc.moveDown(1);
      const yTop = doc.y;
      const colText = function(x, label, lines){
        doc.fontSize(9).fillColor('#888888').text(label, x, yTop, { width:230 });
        lines.forEach(function(l, ix){ if (ix === 0) doc.fontSize(11).fillColor('#111111').text(l, x, doc.y, { width:230 }); else doc.fontSize(10).fillColor('#555555').text(l, x, doc.y, { width:230 }); });
        return doc.y;
      };
      const yL = colText(50, 'DODAVATEL', _supLines(s));
      const yR = colText(315, 'ODB\u011aRATEL', _custLines(s));
      doc.y = Math.max(yL, yR) + 18;
      const cols = [50, 190, 260, 330, 440];
      const head = ['Forma platby','Sazba','Plateb','Objem plateb','Provize'];
      let y = doc.y;
      doc.fontSize(9).fillColor('#888888');
      head.forEach(function(h,i){ doc.text(h, cols[i], y, { width: (i>=3?105:(i===0?135:70)), align: (i>=3?'right':(i===0?'left':'center')) }); });
      y = doc.y + 4; doc.moveTo(50,y).lineTo(545,y).strokeColor('#dddddd').stroke(); y += 6;
      (s.line_items || []).forEach(function(it){
        doc.fontSize(10).fillColor('#111111');
        doc.text(_methodLabel(it.method), cols[0], y, { width:135 });
        doc.text(_pct(it.rate), cols[1], y, { width:70, align:'center' });
        doc.text(String(it.count || 0), cols[2], y, { width:70, align:'center' });
        doc.text(_money(it.gross, cur), cols[3], y, { width:105, align:'right' });
        doc.text(_money(it.fee, cur), cols[4], y, { width:105, align:'right' });
        y = doc.y + 5; doc.moveTo(50,y).lineTo(545,y).strokeColor('#eeeeee').stroke(); y += 5;
      });
      doc.y = y + 4;
      if (s.sup_vat_payer) {
        const rate = s.sup_vat_rate || 21; const base = s.amount / (1 + rate / 100);
        doc.fontSize(10).fillColor('#555555').text('Z\u00e1klad dan\u011b: ' + _money(base, cur) + '   \u00b7   DPH ' + rate + ' %: ' + _money(s.amount - base, cur), 50, doc.y, { width:495 });
      } else doc.fontSize(9).fillColor('#777777').text('Dodavatel nen\u00ed pl\u00e1tcem DPH.', 50, doc.y, { width:495 });
      doc.moveDown(0.5);
      const yT = doc.y;
      doc.fontSize(13).fillColor('#111111').text('Celkem', 50, yT, { width:230 });
      doc.text(_money(s.amount, cur), 315, yT, { width:230, align:'right' });
      doc.y = Math.max(doc.y, yT) + 10;
      const items = s.line_items || [];
      doc.fontSize(9).fillColor('#555555').text('Zprost\u0159edkovan\u00fdch plateb: ' + items.reduce((a, i) => a + (i.count || 0), 0) + '  \u00b7  objem ' + _money(items.reduce((a, i) => a + (i.gross || 0), 0), cur), 50, doc.y, { width:495 });
      doc.moveDown(0.6).fontSize(9).fillColor('#666666').text(_howCharged(s) + ' Nejde o v\u00fdzvu k platb\u011b.', 50, doc.y, { width:495 });
      doc.end();
    }catch(e){ reject(e); }
  });
}

// Krátký průvodní text k příloze. Když PDF nevznikne, jde celý doklad v těle.
function dokladMailHtml(s, hasPdf){
  if (!hasPdf) return dokladHtml(s);
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;font-size:14px;line-height:1.6;">'
    + (s.test_mode ? '<div style="background:#FDECEC;border:1px solid #F3C0C0;border-radius:8px;color:#8a1c1c;font:700 12px/1.4 Arial,sans-serif;padding:9px 12px;margin-bottom:14px;">'+_TEST_BANNER+'</div>' : '')
    + '<p style="margin:0 0 10px;">Dobr\u00fd den' + (s.cust_name ? (', ' + esc(s.cust_trade_name || s.cust_name)) : '') + ',</p>'
    + '<p style="margin:0 0 10px;">v p\u0159\u00edloze pos\u00edl\u00e1me doklad ' + esc(_dokNo(s.id)) + ' o provizi MTL za obdob\u00ed <b>' + esc(periodLabel(s.period_month)) + '</b> \u2014 celkem <b>' + esc(_money(s.amount, s.currency)) + '</b>.</p>'
    + '<p style="margin:0 0 10px;color:#666;font-size:13px;">' + esc(_howCharged(s)) + ' Nejde o v\u00fdzvu k platb\u011b.</p>'
    + '<p style="margin:18px 0 0;color:#888;font-size:12px;">' + esc(s.sup_name || 'Martial Training Lab') + (s.sup_email ? (' \u00b7 ' + esc(s.sup_email)) : '') + (s.sup_phone ? (' \u00b7 ' + esc(s.sup_phone)) : '') + '</p></div>';
}

// ── PŘEHLED PŘI NULOVÉ PROVIZI ───────────────────────────────────────────────────────────────
// V zaváděcím období se provize neúčtuje, takže "Doklad o provizi MTL" by tvrdil něco, co se
// nestalo. Posílá se PŘEHLED odebrané služby s jasným "provize nebyla účtována".
function introSummaryHtml(s, until){
  const items = s.line_items || [];
  const _cnt = items.reduce((a, i) => a + (i.count || 0), 0);
  const _vol = items.reduce((a, i) => a + (i.gross || 0), 0);
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">'
    + (s.test_mode ? '<div style="background:#FDECEC;border:1px solid #F3C0C0;border-radius:8px;color:#8a1c1c;font:700 12px/1.4 Arial,sans-serif;padding:9px 12px;margin-bottom:12px;">'+_TEST_BANNER+'</div>' : '')
    + '<h2 style="margin:0 0 2px;">P\u0159ehled zprost\u0159edkovan\u00fdch plateb</h2>'
    + '<div style="font-size:13px;color:#666;margin-bottom:14px;">Obdob\u00ed ' + esc(periodLabel(s.period_month)) + '  \u00b7  ' + esc(_kindLabel(s)) + '</div>'
    + '<div style="font-size:13px;margin-bottom:14px;"><b>' + esc(s.cust_name || '\u2014') + '</b>' + (s.cust_ico ? ('<br>I\u010cO: ' + esc(s.cust_ico)) : '') + '</div>'
    + '<table style="width:100%;border-collapse:collapse;">'
      + '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">Zprost\u0159edkovan\u00fdch plateb</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;"><b>' + _cnt + '</b></td></tr>'
      + '<tr><td style="padding:8px 0;border-bottom:1px solid #eee;">Objem</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;"><b>' + esc(_money(_vol, s.currency)) + '</b></td></tr>'
      + '<tr><td style="padding:10px 0;font-weight:700;">Provize MTL</td><td style="padding:10px 0;text-align:right;font-weight:700;">' + esc(_money(0, s.currency)) + '</td></tr>'
    + '</table>'
    + '<p style="font-size:12px;color:#666;line-height:1.6;margin-top:14px;">Za toto obdob\u00ed nebyla \u00fa\u010dtov\u00e1na \u017e\u00e1dn\u00e1 provize' + (until ? (' \u2014 zav\u00e1d\u011bc\u00ed obdob\u00ed plat\u00ed do ' + esc(_czDate(until)) + '.') : '.') + ' Nejde o da\u0148ov\u00fd doklad.</p>'
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
    period = (q.month && /^\d{4}-\d{2}$/.test(q.month)) ? q.month : prevMonth(new Date().toISOString().slice(0, 7));
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
    const tx = await sb(`transactions?select=gym_id,coach_id,organization_id,paid_to,currency,mtl_fee,mtl_fee_refunded,mtl_rate,gross_amount,payment_method&commission_status=in.(collected${preview?',pending,failed':''})&${DAILY?_dailyFilter:`commission_month=eq.${period}`}&mtl_fee=gt.0&limit=50000`);

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
      const key = (t.payment_method || '?') + '|' + (t.mtl_rate != null ? String(t.mtl_rate) : 'na');
      const e = (b.rates[key] = b.rates[key] || { method: t.payment_method || null, rate: (t.mtl_rate != null ? Number(t.mtl_rate) : null), fee: 0, count: 0, gross: 0 });
      e.fee += net; e.count += 1; e.gross += (t.gross_amount || 0);
    };
    for (const t of (tx || [])) {
      const cur = (t.currency || 'czk').toLowerCase();
      // attribution: a coach payout (own account / 1:1) goes to the coach; otherwise the gym.
      const isCoach = (t.paid_to === 'coach') || (t.coach_id && !t.gym_id);
      // Klubové plnění kouče (skupinovka, členství) nese gym_id a jde na jeho účet režimu
      // klub -- fakturuje se tedy jeho druhé identitě. Klíč kbelíku to nese v příponě.
      const _clubMode = !!(isCoach && t.coach_id && t.gym_id);
      // Organizace fakturuje MTL jako samostatny subjekt -- ani klub, ani kouc.
      if (t.paid_to === 'organization' && t.organization_id) add(bucket(orgB, t.organization_id, cur), t);
      else if (isCoach && t.coach_id) add(bucket(coachB, t.coach_id + (_clubMode ? '|payout' : ''), cur), t);
      else if (t.gym_id) add(bucket(gymB, t.gym_id, cur), t);
      else if (t.coach_id) add(bucket(coachB, t.coach_id, cur), t);
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
      let _intro = null;
      try {
        const _p = (await sb(`profiles?id=eq.${encodeURIComponent(ownerId)}&select=billing_country`))[0];
        _intro = await introFreeFor(sb, _p && _p.billing_country);
      } catch (e) { console.error('issue introFreeFor:', e.message); }
      if (TEST && !dailyAny && String(ownerId) !== FOUNDER_UUID) { skipped++; return; }
      // Jeden doklad na subjekt + období + měnu. U kouče ZVLÁŠŤ za každou identitu: vlastní 1:1 a
      // režim klub jsou dva plátci -- dřív druhý doklad narazil na první a nevznikl.
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
            try { await notify(ownerId, 'doklad_vat_needed', `\u26a0\ufe0f Doklad za ${periodLabel(period)} zat\u00edm nevystaven \u2014 dopl\u0148 DI\u010c (VAT ID), a\u0165 ti ho m\u016f\u017eeme vystavit podle EU pravidel. Provize z\u016fst\u00e1v\u00e1 evidovan\u00e1 a vystav\u00edme ho zp\u011btn\u011b.`, { period, currency: cur, needs: 'vat_id' }); } catch (e) {}
          }
          return;
        }
      }

      const snap = buildSnap(kind, entityId, ownerId, identity, period, cur, data, ME, buyer, _TESTMODE);
      const _ins = await sb('commission_doklady', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(snap) });
      const row = Array.isArray(_ins) ? _ins[0] : _ins;
      snap.id = row && row.id;
      issued++;
      // Kdo dostane víc zpráv naráz, musí poznat, která je která: klub/organizace jménem, kouč identitou.
      const _nm = ((kind === 'gym' || kind === 'organization') && buyer && buyer.name) ? (' \u2014 ' + buyer.name)
        : (kind === 'coach' ? (_payout ? ' \u2014 kou\u010d, re\u017eim klub' : ' \u2014 kou\u010d, soukrom\u00e9 lekce') : '');

      // JEDNA NOTIFIKACE za provizi: kolik, jak se strhlo, a proklik PŘÍMO na doklad.
      if (ownerId) {
        const how = (snap.bank_amount > 0 && snap.stripe_amount > 0)
          ? (_money(snap.bank_amount, cur) + ' str\u017eeno z karty, ' + _money(snap.stripe_amount, cur) + ' p\u0159i platb\u00e1ch kartou')
          : (snap.bank_amount > 0 ? 'str\u017eeno z ulo\u017een\u00e9 karty' : 'str\u017eeno p\u0159i platb\u00e1ch kartou');
        try { await notify(ownerId, 'doklad_unified', `Provize MTL${_nm} za ${periodLabel(period)}: ${_money(snap.amount, cur)} (${how}). Doklad je vystaven\u00fd.`,
          { period, currency: cur, doklad_id: snap.id || null,
            gym_id: (kind === 'gym' ? entityId : null), organization_id: (kind === 'organization' ? entityId : null),
            coach_id: (kind === 'coach' ? entityId : null), gym_name: ((kind !== 'coach' && buyer && buyer.name) ? buyer.name : null) }); } catch (e) {}
      }

      // E-MAIL na fakturační adresu ze snímku -- stejnou, jaká je na dokladu.
      const em = snap.cust_email;
      if (!em) { mailDiag.failed++; mailDiag.lastError = 'bez adresy: ' + kind + ' ' + entityId; return; }
      let sent;
      if (_intro) {
        sent = await sendEmail(em, `${_TESTMODE ? '[TEST] ' : ''}P\u0159ehled zprost\u0159edkovan\u00fdch plateb \u2014 ${periodShort(period)}${_nm}`, introSummaryHtml(snap, _intro.until), []);
      } else {
        let _att = [];
        try {
          const _buf = await dokladPdf(snap);
          _att = [{ filename: `${_dokNo(snap.id || 'X')}-provize-${String(period).replace(/-/g,'')}.pdf`, content: _buf.toString('base64') }];
        } catch (e) { console.error('doklad pdf', e.message); }
        sent = await sendEmail(em, `${_TESTMODE ? '[TEST] ' : ''}Doklad o provizi MTL ${_dokNo(snap.id || '')} \u2014 ${periodShort(period)}${_nm}`, dokladMailHtml(snap, _att.length > 0), _att);
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
    for (const gid of gymIds) { const g = gymMap[gid]; if (!g) continue; for (const cur of Object.keys(gymB[gid])) await issue('gym', gid, g.owner_id, cur, gymB[gid][cur]); }
    for (const cid of Object.keys(coachB)) { for (const cur of Object.keys(coachB[cid])) await issue('coach', cid, cid, cur, coachB[cid][cur]); }
    // Organizace: doklad zni na ni, ale plati ji jeji majitel -- proto se ownerId bere z nej.
    for (const oid of orgIds) { const o = orgMap[oid]; if (!o) continue;
      for (const cur of Object.keys(orgB[oid])) await issue('organization', oid, o.owner_id, cur, orgB[oid][cur]); }

    // DIAGNOSTIKA: kolik transakcí filtr našel, kolik dokladů vzniklo a JESTLI ODEŠEL E-MAIL.
    return res.status(200).json({ ok: true, period, issued, skipped, deferred, mail: mailDiag, mailFrom: MAIL_FROM, diag: window_diag });
  } catch (e) {
    console.error('unified-doklad-cron', e.message);
    return res.status(500).json({ error: e.message });
  }
}
