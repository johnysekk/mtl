// /api/_order-mail.js — POTVRZENÍ OBJEDNÁVKY A ODSTOUPENÍ NA TRVALÉM NOSIČI (e-mail).
//
// § 1824 OZ: kdo uzavře se spotřebitelem smlouvu na dálku (nákup v appce), musí mu ji potvrdit
// v textové podobě v přiměřené době, nejpozději před začátkem plnění, včetně informací podle
// § 1820 (kdo prodává, co, za kolik, jak je to s odstoupením). Platí pro KAŽDÝ placený nákup
// v appce, ne jen online koučing. Notifikace v appce trvalým nosičem není (obsah ovládá
// platforma), e-mail ano. Prodávajícím je poskytovatel -- MTL potvrzení posílá jeho jménem,
// stejně jako za něj vystavuje doklad. Údaje prodávajícího se berou ze SNÍMKU dokladu.
//
// Neposílá se: hotovost na místě (smlouva není na dálku), vstupenky (mají vlastní e-mail
// ticket-email.js), poplatky organizaci a EP (B2B). Jednou na transakci (transactions.order_mail_at).
//
// Env: RESEND_API_KEY, MAIL_FROM, APP_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY || process.env.RESEND_KEY;
const MAIL_FROM = process.env.MAIL_FROM || process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';
const APP_URL = (process.env.APP_URL || 'https://app.martialtraininglab.com').replace(/\/+$/, '');
const q = encodeURIComponent;
import { dokladPdfFor } from './_doklad-pdf.js';

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.prefer ? { Prefer: init.prefer } : {}) } });
  if (!r.ok) throw new Error(`SB ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
const one = async (p) => { try { return ((await sb(p)) || [])[0] || null; } catch (e) { return null; } };
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (minor, cur, en) => (Math.round(Number(minor) || 0) / 100).toLocaleString(en ? 'en-GB' : 'cs-CZ', { maximumFractionDigits: 2 }) + ' ' + (String(cur || 'CZK').toUpperCase() === 'CZK' && !en ? 'Kč' : String(cur || 'CZK').toUpperCase());
const dt = (v, en) => { try { return new Date(v).toLocaleString(en ? 'en-GB' : 'cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return String(v || ''); } };
const addr = (r, p = '') => [r[p + 'billing_line1'], r[p + 'billing_line2'], [r[p + 'billing_postal'], r[p + 'billing_city']].filter(Boolean).join(' '), r[p + 'billing_country']].filter(Boolean).join(', ');

async function sendMail(to, subject, html, attachments) {
  if (!RESEND_KEY || !to) return { ok: false, reason: !RESEND_KEY ? 'no RESEND_API_KEY' : 'no recipient' };
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, ...(attachments && attachments.length ? { attachments } : {}) }) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, id: j && j.id, error: r.ok ? null : (j && (j.message || j.name)) };
}
function shell(title, body, en) {
  return `<!doctype html><html><body style="margin:0;background:#f5f2ee;font-family:Arial,Helvetica,sans-serif;color:#141414;">
  <div style="max-width:560px;margin:0 auto;padding:22px 16px;"><div style="background:#fff;border-radius:14px;padding:22px;">
  <div style="font-size:19px;font-weight:800;margin-bottom:14px;">${esc(title)}</div>${body}
  <p style="font-size:12px;color:#888;line-height:1.5;margin:18px 0 0;">${en ? 'This e-mail is your confirmation in durable form. Keep it.' : 'Tento e-mail je potvrzení v textové podobě. Uschovej si ho.'}<br>Martial Training Lab · <a href="${APP_URL}" style="color:#888;">${APP_URL.replace(/^https?:\/\//, '')}</a></p>
  </div></div></body></html>`;
}
const row = (k, v) => `<tr><td style="padding:7px 0;border-bottom:1px solid #eee;color:#666;font-size:13px;vertical-align:top;">${k}</td><td style="padding:7px 0;border-bottom:1px solid #eee;font-size:13px;font-weight:700;text-align:right;">${v}</td></tr>`;

// Druh nákupu -> poučení o odstoupení (§ 1820 odst. 1 písm. g/h/j, § 1837).
export function withdrawalText(kind, en) {
  const C = {
    dated:  ['Jde o službu související s využitím volného času, kterou poskytovatel plní v určeném termínu. Právo na odstoupení od smlouvy do 14 dnů proto nemáš (§ 1837 písm. j) OZ). Rezervaci můžeš zrušit v appce podle storno podmínek uvedených u rezervace.',
             'This is a leisure service provided on a specific date, so the 14-day right of withdrawal does not apply (Section 1837(j) of the Czech Civil Code). You can cancel the booking in the app under the cancellation terms shown with it.'],
    pass:   ['Od smlouvy můžeš odstoupit do 14 dnů od nákupu, a to tlačítkem „Odstoupit od smlouvy“ v appce (Moje členství). Pokud permanentka na tvou žádost začala běžet hned, zaplatíš poměrnou část za dny, kdy běžela; zbytek ti prodávající vrátí do 14 dnů.',
             'You can withdraw within 14 days of purchase with the "Withdraw from contract" button in the app (My memberships). If the pass started right away at your request, you pay a proportionate part for the days it ran; the rest is refunded within 14 days.'],
    club:   ['Ukončení členství a případné vrácení členského příspěvku se řídí stanovami spolku.',
             'Ending the membership and any refund of the membership fee follow the association\'s statutes.'],
    clubother: ['Zrušení a případné vrácení platby se řídí podmínkami spolku uvedenými v appce.',
             'Cancellation and any refund follow the association\'s terms shown in the app.'],
    online: ['Od smlouvy můžeš odstoupit do 14 dnů tlačítkem „Odstoupit od smlouvy“ v appce (Moje online objednávky). Dokud kouč službu nedodá, vrátí se ti 100 %; u balíčku se vrací poměr nedodaných kusů. Úplným dodáním služby právo na odstoupení zaniká (udělil/a jsi k tomu souhlas uvedený níže).',
             'You can withdraw within 14 days with the "Withdraw from contract" button in the app (My online orders). Until the coach delivers, you get 100 % back; for a package, the undelivered share. Once the service is fully delivered, the right of withdrawal ends (you gave the consent shown below).'],
    plan:   ['Od smlouvy můžeš odstoupit do 14 dnů od první platby tlačítkem „Odstoupit od smlouvy“ v appce (Moje členství) — zaplatíš poměrnou část za dny, kdy předplatné běželo, zbytek se vrátí. Předplatné se obnovuje každý měsíc a můžeš ho kdykoli zrušit ke konci zaplaceného měsíce.',
             'You can withdraw within 14 days of the first payment with the "Withdraw from contract" button in the app (My memberships) — you pay for the days it ran, the rest is refunded. The subscription renews monthly and you can cancel any time at the end of the paid month.'],
    onsite: ['Nákup proběhl osobně v hotovosti v provozovně poskytovatele. Nejde o smlouvu uzavřenou na dálku, právo odstoupit do 14 dnů se proto nepoužije a zaplacená částka se nevrací.',
             'This purchase was paid in cash in person at the provider\'s premises. It is not a distance contract, so the 14-day right of withdrawal does not apply and the amount paid is not refunded.'],
    goods:  ['Od kupní smlouvy můžeš odstoupit do 14 dnů od převzetí zboží; zboží vrátíš prodávajícímu a peníze dostaneš zpět do 14 dnů od odstoupení.',
             'You can withdraw from the purchase within 14 days of receiving the goods; return them to the seller and you get your money back within 14 days.'],
  };
  return (C[kind] || C.dated)[en ? 1 : 0];
}

// Hlavní vstup: potvrzení k transakci. Volá se po zápisu platby (Stripe i převod/QR/PIS).
export async function sendOrderMail(txId) {
  try {
    if (!txId || !SB || !KEY) return { ok: false, reason: 'config' };
    // Jednou na transakci: kdo první nastaví order_mail_at, ten posílá.
    let claimed;
    try { claimed = await sb(`transactions?id=eq.${q(txId)}&order_mail_at=is.null`, { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ order_mail_at: new Date().toISOString() }) }); } catch (e) { return { ok: false, reason: 'claim: ' + e.message }; }
    const tx = claimed && claimed[0]; if (!tx) return { ok: true, skipped: 'already' };
    const type = String(tx.type || ''), pm = String(tx.payment_method || '');
    if (['event_ticket', 'event', 'org_fee', 'partner_sub', 'custom'].includes(type) || tx.org_fee_id || tx.ticket_id) return { ok: true, skipped: 'type' };

    let who = await one(`profiles?id=eq.${q(tx.paid_by || tx.member_id || '')}&select=email,name,lang`);
    // Kupující BEZ ÚČTU (kurz přes veřejnou stránku): e-mail z přihlášky do kurzu.
    if ((!who || !who.email) && type === 'course') {
      let cm = null;
      if (tx.payment_intent) { const cp = await one(`cohort_payments?stripe_pi=eq.${q(tx.payment_intent)}&select=cohort_member_id`); if (cp) cm = await one(`cohort_members?id=eq.${q(cp.cohort_member_id)}&select=email,name`); }
      if (!cm && tx.payment_intent) cm = await one(`cohort_members?pis_payment_id=eq.${q(tx.payment_intent)}&select=email,name`);
      if (cm && cm.email) who = { email: cm.email, name: cm.name || '', lang: null };
    }
    if (!who || !who.email) return { ok: true, skipped: 'no email' };
    const en = String(who.lang || '') === 'en';
    const dok = await one(`doklady?transaction_id=eq.${q(tx.id)}&select=doklad_no,sup_name,sup_ico,sup_address,item_label,participant_name,session_at,amount,currency`);

    // Prodávající: snímek dokladu, jinak aktuální údaje poskytovatele.
    let sName = dok && dok.sup_name, sIco = dok && dok.sup_ico, sAddr = dok && dok.sup_address, sMail = null, nonprofit = false;
    const g = tx.gym_id ? await one(`gyms?id=eq.${q(tx.gym_id)}&select=name,legal_name,tax_id,billing_line1,billing_line2,billing_city,billing_postal,billing_country,contact_email,invoice_email,org_form`) : null;
    const c = (!g || tx.paid_to === 'coach') && tx.coach_id ? await one(`profiles?id=eq.${q(tx.coach_id)}&select=name,legal_name,tax_id,billing_line1,billing_line2,billing_city,billing_postal,billing_country,contact_email,email`) : null;
    const src = (tx.paid_to === 'coach' && c) ? c : (g || c);
    if (src) { sName = sName || src.legal_name || src.name; sIco = sIco || src.tax_id; sAddr = sAddr || addr(src); sMail = src.contact_email || src.invoice_email || null; }
    nonprofit = !!(g && g.org_form === 'nonprofit' && tx.paid_to !== 'coach');

    // Druh nákupu
    let kind = 'dated', online = false, booking = null;
    if (type === 'coach_online') { kind = 'online'; online = true; }
    else if (type === 'coach_1to1' && /^\d+$/.test(String(tx.source_booking_id || ''))) { booking = await one(`bookings?id=eq.${q(tx.source_booking_id)}&select=type,qty,online_format`); if (booking && booking.type === 'online') { kind = 'online'; online = true; } }
    else if (type === 'membership') kind = (!tx.gym_id && tx.coach_id) ? 'plan' : (nonprofit ? 'club' : 'pass');
    else if (type === 'merch') kind = 'goods';
    if (kind === 'plan') online = true;
    // Hotovost na místě (provozovna poskytovatele) = smlouva uzavřená osobně, ne na dálku: bez práva
    // na odstoupení. Appka u takové permanentky tlačítko „Odstoupit od smlouvy" neukazuje.
    if (pm === 'cash' && (kind === 'goods' || kind === 'pass')) kind = 'onsite';
    // SPOLEK: žádné řeči o ochraně spotřebitele -- členský příspěvek ani služby spolku se tak
    // neposuzují. Jen odkaz na stanovy / podmínky spolku.
    if (nonprofit && kind !== 'club') kind = 'clubother';
    // Obnovu předplatného (invoice.paid) vylučuje volající (renewal) -- jednorázová permanentka
    // nebo nové členství po vypršení se potvrzuje vždy znovu.
    if (!booking && kind === 'online' && tx.payment_intent) booking = await one(`bookings?payment_intent=eq.${q(tx.payment_intent)}&select=qty,online_format`);

    // Souhlas se zahájením (online) -- znění a čas ze záznamu souhlasu.
    let consent = null;
    if (online) consent = await one(`consent_acceptances?user_id=eq.${q(tx.paid_by || tx.member_id)}&kind=in.(online_service_start,online_plan_start)&accepted_at=gte.${q(new Date(new Date(tx.created_at).getTime() - 86400000).toISOString())}&order=accepted_at.desc&limit=1&select=accepted_at,version_id,body_hash,meta`);
    let consentText = null;
    if (consent && consent.version_id) { const v = await one(`consent_versions?id=eq.${q(consent.version_id)}&select=body_text`); consentText = v && v.body_text; }

    const label = (dok && dok.item_label) || (booking && booking.online_format) || tx.plan || (en ? 'Purchase' : 'Nákup');
    const isTest = !!tx.test_mode;
    const rows = [
      row(en ? 'Service' : 'Služba', esc(label) + (booking && Number(booking.qty) > 1 ? ` (${booking.qty} ${en ? 'pcs' : 'ks'})` : '')),
      row(en ? 'Price' : 'Cena', esc(money(tx.gross_amount, tx.currency, en)) + (kind === 'plan' ? (en ? ' / month' : ' / měsíc') : '')),
      (dok && dok.session_at) ? row(en ? 'Date' : 'Termín', esc(dok.session_at)) : '',
      (dok && dok.participant_name) ? row(en ? 'Participant' : 'Účastník', esc(dok.participant_name)) : '',
      row(en ? 'Ordered' : 'Objednáno', esc(dt(tx.created_at, en))),
      row(en ? 'Payment' : 'Platba', esc(pm === 'qr' || pm === 'pis' ? (en ? 'bank transfer' : 'převodem') : pm === 'cash' ? (en ? 'cash' : 'hotově') : (en ? 'card' : 'kartou'))),
      dok && dok.doklad_no ? row(en ? 'Receipt no.' : 'Číslo dokladu', esc(dok.doklad_no)) : '',
      row(en ? 'Seller' : 'Prodávající', esc(sName || '') + (sIco ? `<div style="font-weight:400;color:#666;font-size:12px;">${en ? 'Reg. no.' : 'IČO'} ${esc(sIco)}</div>` : '') + (sAddr ? `<div style="font-weight:400;color:#666;font-size:12px;">${esc(sAddr)}</div>` : '') + (sMail ? `<div style="font-weight:400;color:#666;font-size:12px;">${esc(sMail)}</div>` : '')),
    ].join('');
    const body = `<p style="font-size:14px;line-height:1.5;margin:0 0 12px;">${en ? `Hi ${esc(who.name || '')}, this confirms your order.` : `Ahoj ${esc(who.name || '')}, potvrzujeme tvou objednávku.`}</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="font-size:12.5px;color:#555;line-height:1.5;margin:12px 0;">${nonprofit
        ? (en ? 'The provider is the association named above. Martial Training Lab only mediates the payment.' : 'Poskytovatelem je výše uvedený spolek. Martial Training Lab platbu jen zprostředkovává.')
        : (en ? 'The seller is the provider named above, a business. Martial Training Lab only mediates the order and payment.' : 'Prodávajícím je výše uvedený poskytovatel jako podnikatel. Martial Training Lab objednávku a platbu jen zprostředkovává.')}</p>
      <div style="background:#f5f2ee;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.55;margin:12px 0;"><b>${nonprofit ? (en ? 'Cancellation and refunds' : 'Zrušení a vrácení') : (en ? 'Right of withdrawal' : 'Odstoupení od smlouvy')}</b><br>${esc(withdrawalText(kind, en))}</div>
      ${consentText ? `<div style="border:1px solid #eee;border-radius:10px;padding:12px 14px;font-size:12.5px;line-height:1.55;margin:12px 0;"><b>${en ? 'Your consent' : 'Tvůj souhlas'}</b> (${esc(dt(consent.accepted_at, en))})<br>„${esc(consentText)}“</div>` : ''}
      <p style="margin:16px 0 0;"><a href="${APP_URL}" style="display:inline-block;background:#141414;color:#fff;text-decoration:none;padding:11px 16px;border-radius:10px;font-weight:700;font-size:14px;">${en ? 'Open the app' : 'Otevřít appku'}</a></p>`;
    const subj = (isTest ? '[TEST] ' : '') + (en ? 'Order confirmation — ' : 'Potvrzení objednávky — ') + label;
    // DOKLAD V PŘÍLOZE -- ten samý, co je v appce (snímek z tabulky doklady).
    let att = [];
    try { const pdf = await dokladPdfFor({ transactionId: tx.id, paymentIntent: tx.payment_intent, en }); if (pdf) att = [{ filename: pdf.filename, content: pdf.buffer.toString('base64') }]; } catch (e) { console.error('[order-mail] pdf', e.message); }
    const out = await sendMail(who.email, subj, shell(en ? 'Order confirmation' : 'Potvrzení objednávky', body + (att.length ? `<p style="font-size:12.5px;color:#555;margin:10px 0 0;">${en ? 'Your receipt is attached as PDF.' : 'Doklad o platbě máš v příloze (PDF).'}</p>` : ''), en), att);
    if (!out.ok) { try { await sb(`transactions?id=eq.${q(tx.id)}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ order_mail_at: null }) }); } catch (e) {} }
    return out;
  } catch (e) { console.error('[order-mail]', e.message); return { ok: false, reason: e.message }; }
}

// Potvrzení o odstoupení (§ 1829 OZ + směrnice 2023/2673: potvrdit obsah, datum a čas).
export async function sendWithdrawalMail({ userId, provider, label, statement, at, refundMinor, keepMinor, currency, method, pending, test }) {
  try {
    const who = await one(`profiles?id=eq.${q(userId)}&select=email,name,lang`);
    if (!who || !who.email) return { ok: true, skipped: 'no email' };
    const en = String(who.lang || '') === 'en';
    const rows = [
      row(en ? 'Contract' : 'Smlouva', esc(label || '')),
      row(en ? 'Seller' : 'Prodávající', esc(provider || '')),
      row(en ? 'Withdrawal sent' : 'Odstoupení odesláno', esc(dt(at || new Date().toISOString(), en))),
      Number(keepMinor) > 0 ? row(en ? 'Kept for the part provided' : 'Ponecháno za poskytnutou část', esc(money(keepMinor, currency, en))) : '',
      row(en ? 'Refund' : 'Vrací se', esc(money(refundMinor, currency, en)) + `<div style="font-weight:400;color:#666;font-size:12px;">${pending ? (en ? 'by bank transfer from the seller within 14 days' : 'převodem od prodávajícího do 14 dnů') : (method === 'card' ? (en ? 'to your card' : 'na kartu') : '')}</div>`),
    ].join('');
    const body = `<p style="font-size:14px;line-height:1.5;margin:0 0 12px;">${en ? 'We have received your withdrawal from the contract.' : 'Potvrzujeme přijetí tvého odstoupení od smlouvy.'}</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <div style="border:1px solid #eee;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.55;margin:12px 0;"><b>${en ? 'Your statement' : 'Tvé prohlášení'}</b><br>„${esc(statement || '')}“</div>`;
    return await sendMail(who.email, (test ? '[TEST] ' : '') + (en ? 'Withdrawal confirmation — ' : 'Potvrzení o odstoupení — ') + (label || ''), shell(en ? 'Withdrawal confirmation' : 'Potvrzení o odstoupení', body, en));
  } catch (e) { console.error('[withdrawal-mail]', e.message); return { ok: false, reason: e.message }; }
}

// Pro cesty, které znají jen payment_intent (Stripe).
export async function sendOrderMailForPi(pi) {
  if (!pi) return { ok: false };
  const t = await one(`transactions?payment_intent=eq.${q(pi)}&select=id&limit=1`);
  return t ? sendOrderMail(t.id) : { ok: false, reason: 'no tx' };
}
