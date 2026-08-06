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
const FOUNDER_UUID = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const SB  = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND = process.env.RESEND_API_KEY;
const MAIL_FROM = process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';

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
function _money(minor, cur){ return (minor/100).toFixed(2).replace('.',',')+' '+String(cur).toUpperCase(); }
function dokladHtml(ME, buyer, kind, period, cur, data, test){
  const _ph = test ? 'Nevypln\u011bno' : '';
  ME = ME || {}; const esc=function(x){ return String(x==null?'':x).replace(/[<>&]/g,function(c){return c==='<'?'&lt;':c==='>'?'&gt;':'&amp;';}); };
  const items = Object.values(data.rates);
  const rows = items.map(function(i){ return '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;">'+_methodLabel(i.method)+'</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">'+_pct(i.rate)+'</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center;">'+i.count+'</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">'+_money(i.gross,cur)+'</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;">'+_money(i.fee,cur)+'</td></tr>'; }).join('');
  const bank = items.filter(function(i){return i.method!=='stripe';}).reduce(function(a,i){return a+i.fee;},0);
  const strp = items.filter(function(i){return i.method==='stripe';}).reduce(function(a,i){return a+i.fee;},0);
  const total = data.total;
  const supLines = ['<b>'+esc(ME.name||'Martial Training Lab s.r.o.')+'</b>', ME.ico?('I\u010cO: '+esc(ME.ico)):(_ph?('I\u010cO: '+_ph):''), ME.sidlo?esc(ME.sidlo):'', ME.dic?('DI\u010c: '+esc(ME.dic)):(_ph?('DI\u010c: '+_ph):''), ME.vat_id?('VAT ID: '+esc(ME.vat_id)):''].filter(Boolean).join('<br>');
  const bName = (buyer && (buyer.legal_name || buyer.name)) || '\u2014';
  const buyLines = ['<b>'+esc(bName)+'</b>', (buyer&&buyer.tax_id)?('I\u010cO: '+esc(buyer.tax_id)):(_ph?('I\u010cO: '+_ph):''), (buyer&&buyer.billing_address)?esc(buyer.billing_address):'', (buyer&&buyer.vat_id)?('DI\u010c: '+esc(buyer.vat_id)):(_ph?('DI\u010c: '+_ph):'')].filter(Boolean).join('<br>');
  let vatBlock;
  if(ME.vat_payer){ const rate=ME.vat_rate||21; const base=total/(1+rate/100); const vat=total-base; vatBlock='<tr><td>Z\u00e1klad dan\u011b</td><td style="text-align:right;">'+_money(base,cur)+'</td></tr><tr><td>DPH '+rate+'%</td><td style="text-align:right;">'+_money(vat,cur)+'</td></tr>'; }
  else { vatBlock='<tr><td colspan="2" style="font-size:11px;color:#666;padding-top:6px;">Dodavatel nen\u00ed pl\u00e1tcem DPH.</td></tr>'; }
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">'
    +'<h2 style="margin:0 0 2px;">Doklad o provizi MTL</h2>'
    +'<div style="font-size:13px;color:#666;margin-bottom:14px;">Obdob\u00ed '+period+'</div>'
    +'<div style="display:flex;gap:24px;margin-bottom:8px;"><div style="flex:1;font-size:13px;"><div style="font-size:11px;text-transform:uppercase;color:#888;margin-bottom:4px;">Dodavatel</div>'+supLines+'</div><div style="flex:1;font-size:13px;"><div style="font-size:11px;text-transform:uppercase;color:#888;margin-bottom:4px;">Odb\u011bratel</div>'+buyLines+'</div></div>'
    +'<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:12px;"><thead><tr style="background:#f5f2ee;"><th style="padding:8px 10px;text-align:left;">Forma</th><th style="padding:8px 10px;">Sazba</th><th style="padding:8px 10px;">Transakc\u00ed</th><th style="padding:8px 10px;text-align:right;">Z\u00e1klad</th><th style="padding:8px 10px;text-align:right;">Provize</th></tr></thead><tbody>'+rows+'</tbody></table>'
    +'<table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:2px;">'+vatBlock+'<tr style="font-weight:800;"><td style="border-top:2px solid #333;padding-top:8px;">Celkem</td><td style="text-align:right;border-top:2px solid #333;padding-top:8px;">'+_money(total,cur)+'</td></tr></table>'
    +'<div style="margin-top:10px;font-size:12px;color:#555;">Bankovn\u00ed p\u0159evod (str\u017eeno z karty): <b>'+_money(bank,cur)+'</b> \u00b7 Stripe (\u017eiv\u011b): <b>'+_money(strp,cur)+'</b></div>'
    +'<p style="color:#999;font-size:11px;margin-top:18px;">Doklad o ji\u017e str\u017een\u00e9 / na\u00fa\u010dtovan\u00e9 provizi MTL za uveden\u00e9 obdob\u00ed. Nejde o v\u00fdzvu k platb\u011b.</p></div>';
}
// The receipt went out as HTML in the body, which cannot be filed or handed to an accountant.
// Same approach stripe-webhook already uses for its payment receipts: pdfkit with the DejaVu font,
// because the built-in fonts have no diacritics and Czech names come out mangled.
function dokladPdf(ME, buyer, kind, period, cur, data, test){
  return new Promise(function(resolve, reject){
    try{
      const doc = new PDFDocument({ size:'A4', margin:50 });
      const chunks=[]; doc.on('data', function(d){ chunks.push(d); }); doc.on('end', function(){ resolve(Buffer.concat(chunks)); }); doc.on('error', reject);
      doc.registerFont('cz', DEJAVU_CZ); doc.font('cz');
      const ph = test ? 'Nevypln\u011bno' : '';
      const B = buyer || {};
      doc.fontSize(22).fillColor('#E11111').text('MTL');
      doc.moveDown(0.15).fontSize(15).fillColor('#111111').text('Doklad o provizi MTL');
      doc.moveDown(0.1).fontSize(10).fillColor('#777777').text('Obdob\u00ed ' + periodLabel(period));
      doc.moveDown(1);

      const yTop = doc.y;
      doc.fontSize(9).fillColor('#888888').text('DODAVATEL', 50, yTop, { width:230 });
      doc.fontSize(11).fillColor('#111111').text(ME.name || 'Martial Training Lab s.r.o.', 50, doc.y, { width:230 });
      if (ME.ico) doc.fontSize(10).fillColor('#555555').text('I\u010cO: ' + ME.ico, 50, doc.y, { width:230 });
      if (ME.dic) doc.fontSize(10).fillColor('#555555').text('DI\u010c: ' + ME.dic, 50, doc.y, { width:230 });
      if (ME.sidlo) doc.fontSize(10).fillColor('#555555').text(ME.sidlo, 50, doc.y, { width:230 });
      const yLeft = doc.y;

      doc.fontSize(9).fillColor('#888888').text('ODB\u011aRATEL', 315, yTop, { width:230 });
      doc.fontSize(11).fillColor('#111111').text(B.legal_name || B.name || ph, 315, doc.y, { width:230 });
      if (B.tax_id) doc.fontSize(10).fillColor('#555555').text('I\u010cO: ' + B.tax_id, 315, doc.y, { width:230 });
      if (B.vat_id) doc.fontSize(10).fillColor('#555555').text('DI\u010c: ' + B.vat_id, 315, doc.y, { width:230 });
      if (B.billing_address) doc.fontSize(10).fillColor('#555555').text(B.billing_address, 315, doc.y, { width:230 });
      doc.y = Math.max(yLeft, doc.y) + 18;

      const cols = [50, 190, 260, 340, 440];
      const head = ['Forma','Sazba','Transakc\u00ed','Z\u00e1klad','Provize'];
      let y = doc.y;
      doc.fontSize(9).fillColor('#888888');
      head.forEach(function(h,i){ doc.text(h, cols[i], y, { width: (i>=3?105:(i===0?135:70)), align: (i>=3?'right':(i===0?'left':'center')) }); });
      y = doc.y + 4;
      doc.moveTo(50,y).lineTo(545,y).strokeColor('#dddddd').stroke(); y += 6;

      Object.values(data.rates).forEach(function(it){
        doc.fontSize(10).fillColor('#111111');
        doc.text(_methodLabel(it.method), cols[0], y, { width:135 });
        doc.text(_pct(it.rate), cols[1], y, { width:70, align:'center' });
        doc.text(String(it.count), cols[2], y, { width:70, align:'center' });
        doc.text(_money(it.gross, cur), cols[3], y, { width:105, align:'right' });
        doc.text(_money(it.fee, cur), cols[4], y, { width:105, align:'right' });
        y = doc.y + 5;
        doc.moveTo(50,y).lineTo(545,y).strokeColor('#eeeeee').stroke(); y += 5;
      });

      doc.y = y + 4;
      if (!ME.vat_payer) doc.fontSize(9).fillColor('#777777').text('Dodavatel nen\u00ed pl\u00e1tcem DPH.', 50, doc.y, { width:495 });
      doc.moveDown(0.5);
      const yT = doc.y;
      doc.fontSize(13).fillColor('#111111').text('Celkem', 50, yT, { width:230 });
      doc.text(_money(data.total, cur), 315, yT, { width:230, align:'right' });
      doc.y = Math.max(doc.y, yT) + 8;
      doc.fontSize(9).fillColor('#666666').text('Bankovn\u00ed p\u0159evod (str\u017eeno z karty): ' + _money(data.bank || 0, cur) + '  \u00b7  Stripe (\u017eiv\u011b): ' + _money(data.stripe || 0, cur), 50, doc.y, { width:495 });
      doc.moveDown(1).fontSize(9).fillColor('#999999').text('Doklad o ji\u017e str\u017een\u00e9 / na\u00fa\u010dtovan\u00e9 provizi MTL za uveden\u00e9 obdob\u00ed. Nejde o v\u00fdzvu k platb\u011b.', 50, doc.y, { width:495 });
      doc.end();
    }catch(e){ reject(e); }
  });
}

async function sendEmail(to, subject, html, attachments){
  if(!RESEND || !to) return;
  try{ await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:'Bearer '+RESEND, 'Content-Type':'application/json' }, body: JSON.stringify(Object.assign({ from: MAIL_FROM, to:[to], subject, html }, (attachments && attachments.length) ? { attachments } : {})) }); }catch(e){ console.error('doklad email', e.message); }
}

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ error: 'env' });
  const q = (req && req.query) || {};
  const preview = (q.preview === '1' || q.preview === 'true');
  // TEST MODE: daily doklad for the founder only, so Petr sees the commission receipt in real time.
  // LIVE stays exactly as before: one monthly doklad per provider, with the IChO/DIChC + VAT flow intact.
  let TEST = false; try { TEST = await isTestMode(); } catch (e) {}
  let period, dayStart = null, dayEnd = null;
  if (TEST) {
    const d = (q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date)) ? q.date : new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    period = d; dayStart = d + 'T00:00:00';
    dayEnd = new Date(new Date(d + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10) + 'T00:00:00';
  } else {
    period = (q.month && /^\d{4}-\d{2}$/.test(q.month)) ? q.month : prevMonth(new Date().toISOString().slice(0, 7));
  }
  let ME = {}; try { const _ps = await sb('platform_settings?id=eq.1&select=*'); ME = (_ps && _ps[0]) || {}; } catch (e) {}
  let issued = 0, skipped = 0, deferred = 0;
  try {
    // every collected commission row for the closed month (bank charged + Stripe live)
    const tx = await sb(`transactions?select=gym_id,coach_id,paid_to,currency,mtl_fee,mtl_fee_refunded,mtl_rate,gross_amount,payment_method&commission_status=in.(collected${preview?',pending,failed':''})&${TEST?`created_at=gte.${dayStart}&created_at=lt.${dayEnd}`:`commission_month=eq.${period}`}&mtl_fee=gt.0&limit=50000`);

    // bucket per provider + currency, with a per-(form,rate) breakdown
    const gymB = {}, coachB = {};
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
      if (isCoach && t.coach_id) add(bucket(coachB, t.coach_id, cur), t);
      else if (t.gym_id) add(bucket(gymB, t.gym_id, cur), t);
      else if (t.coach_id) add(bucket(coachB, t.coach_id, cur), t);
    }

    // resolve gym owners
    const gymIds = Object.keys(gymB);
    const gymMap = {};
    if (gymIds.length) { const gs = await sb(`gyms?id=in.(${gymIds.join(',')})&select=id,name,owner_id`); (gs || []).forEach(g => { gymMap[g.id] = g; }); }

    async function issue(kind, entityId, ownerId, cur, data) {
      const col = kind === 'gym' ? 'gym_id' : 'coach_id';
      if (TEST && String(ownerId) !== FOUNDER_UUID) { skipped++; return; } // test mode: founder club only
      // idempotent: one unified doklad per entity+period+currency
      const ex = await sb(`commission_doklady?select=id&${col}=eq.${entityId}&period_month=eq.${period}&currency=eq.${encodeURIComponent(cur)}&kind=eq.unified&limit=1`);
      if (ex && ex.length) { skipped++; return; }

      // ---- FOREIGN-VAT GATE (toggle: platform_settings.require_vat_foreign) --------------------
      // A cross-border EU B2B service must be reported in the souhrnne hlaseni, and that report
      // needs the CUSTOMER'S VAT ID. Without it we cannot file, so (when the toggle is on) we do
      // NOT issue the doklad: the commission simply stays pending and is invoiced retroactively
      // once the provider supplies their VAT ID. Nothing is lost, nobody is blocked from trading.
      // Safety: unknown country is treated as domestic -> we never block on uncertainty.
      let buyer = null;
      try {
        const _sel = (kind === 'gym')
          ? `gyms?id=eq.${entityId}&select=name,legal_name,billing_address,tax_id,vat_id,billing_country,country&limit=1`
          : `profiles?id=eq.${entityId}&select=name,legal_name,billing_address,tax_id,vat_id,country,billing_country&limit=1`;
        const _b = await sb(_sel);
        buyer = _b && _b[0];
      } catch (e) {}
      if (!TEST && ME && ME.require_vat_foreign) {
        const home = ctryCode({ country: ME.home_country }) || 'CZ';
        const bc = ctryCode(buyer);
        // defer ONLY for intra-EU cross-border B2B with no VAT ID. Unknown country, domestic, or a
        // non-EU buyer (US/TH/GB/CH) all issue normally - we never block on uncertainty or on exports.
        const euForeign = !!bc && bc !== home && EU_VAT.has(bc) && EU_VAT.has(home);
        const hasVat = !!(buyer && String(buyer.vat_id || '').trim());
        if (euForeign && !hasVat) {
          deferred++;
          if (ownerId) {
            try {
              await notify(ownerId, 'doklad_vat_needed',
                `\u26a0\ufe0f Doklad za ${period} zat\u00edm nevystaven \u2014 dopl\u0148 DI\u010c (VAT ID), a\u0165 ti ho m\u016f\u017eeme vystavit podle EU pravidel. Provize z\u016fst\u00e1v\u00e1 evidovan\u00e1 a douc\u0165ujeme ji zp\u011btn\u011b.`,
                { period, currency: cur, needs: 'vat_id' });
            } catch (e) {}
          }
          return;
        }
      }
      const items = Object.values(data.rates);
      const bank = items.filter(i => i.method !== 'stripe').reduce((a, i) => a + i.fee, 0);
      const strp = items.filter(i => i.method === 'stripe').reduce((a, i) => a + i.fee, 0);
      const body = { period_month: period, currency: cur, amount: data.total, bank_amount: bank, stripe_amount: strp, line_items: items, status: 'issued', kind: 'unified', owner_id: ownerId, charged_at: new Date().toISOString() };
      body[col] = entityId;
      await sb('commission_doklady', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(body) });
      issued++;
      if (ownerId) { try { await notify(ownerId, 'doklad_unified', `Doklad k provizi MTL za ${periodLabel(period)} (${(data.total / 100).toFixed(2)} ${cur.toUpperCase()}) je připraven. Najdeš ho v účetnictví.`, { period, currency: cur }); } catch (e) {} }
      try {
        // Route the commission invoice to the RIGHT billing e-mail: a gym's on gyms.invoice_email,
        // a coach's on profiles.invoice_email (they can differ). Fall back to the owner's account e-mail.
        let em = null;
        if (kind === 'gym') { const gr = await sb(`gyms?id=eq.${entityId}&select=invoice_email&limit=1`); em = (gr && gr[0] && gr[0].invoice_email) || null; }
        else { const pr = await sb(`profiles?id=eq.${ownerId}&select=invoice_email&limit=1`); em = (pr && pr[0] && pr[0].invoice_email) || null; }
        if (!em && ownerId) { const pr2 = await sb(`profiles?id=eq.${ownerId}&select=email&limit=1`); em = pr2 && pr2[0] && pr2[0].email; }
        if (em) {
          let _att = [];
          try {
            const _buf = await dokladPdf(ME, buyer, kind, period, cur, data, TEST);
            _att = [{ filename: `MTL-provize-${String(period).replace(/-/g,'')}.pdf`, content: _buf.toString('base64') }];
          } catch (e) { console.error('doklad pdf', e.message); }
          await sendEmail(em, `Doklad o provizi MTL — ${periodShort(period)}`, dokladHtml(ME, buyer, kind, period, cur, data, TEST), _att);
        } } catch (e) {}
    }

    if (preview) {
      let firstHtml = '';
      for (const gid of gymIds) { const g = gymMap[gid]; if (!g) continue; for (const cur of Object.keys(gymB[gid])) { const _b = (await sb(`gyms?id=eq.${gid}&select=name,legal_name,billing_address,tax_id,vat_id,billing_country,country&limit=1`))[0] || null; firstHtml = dokladHtml(ME, _b, 'gym', period, cur, gymB[gid][cur], TEST); break; } if (firstHtml) break; }
      if (!firstHtml) { for (const cid of Object.keys(coachB)) { for (const cur of Object.keys(coachB[cid])) { const _b = (await sb(`profiles?id=eq.${cid}&select=name,legal_name,billing_address,tax_id,vat_id,country,billing_country&limit=1`))[0] || null; firstHtml = dokladHtml(ME, _b, 'coach', period, cur, coachB[cid][cur], TEST); break; } if (firstHtml) break; } }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(firstHtml || ('<p style="font-family:sans-serif;padding:24px;">\u017d\u00e1dn\u00e1 provize za ' + period + ' (zkus jin\u00fd ?month=RRRR-MM).</p>'));
    }
    for (const gid of gymIds) { const g = gymMap[gid]; if (!g) continue; for (const cur of Object.keys(gymB[gid])) await issue('gym', gid, g.owner_id, cur, gymB[gid][cur]); }
    for (const cid of Object.keys(coachB)) { for (const cur of Object.keys(coachB[cid])) await issue('coach', cid, cid, cur, coachB[cid][cur]); }

    return res.status(200).json({ ok: true, period, issued, skipped, deferred });
  } catch (e) {
    console.error('unified-doklad-cron', e.message);
    return res.status(500).json({ error: e.message });
  }
}
