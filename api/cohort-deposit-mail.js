// /api/cohort-deposit-mail — sends the course-deposit e-mail after the OWNER confirms a QR payment.
//
// The Stripe rail already sends this from stripe-webhook.js on checkout.session.completed. The QR
// rail is confirmed by hand in the owner's browser, and a browser can neither send mail nor build
// the doklad PDF, so that e-mail simply never went out: a QR course signup got nothing, a Stripe one
// got a receipt. This closes that gap.
//
// It deliberately IMPORTS the webhook's own builders rather than copying them. Two copies of a
// legally-relevant document would drift, and the whole point is that both rails send the SAME thing.
//
// POST { cohort_member_id, token }  ->  { ok, sent }
// Security: the caller must own the cohort's club (same ownership test the roster uses).
// Idempotent: refuses to send twice for the same member (cohort_members.deposit_mail_at).

import { sendResend, cohortDepositHtml, cohortDokladPdf } from './stripe-webhook.js';
import { isTestMode } from './_config.js';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const FOUNDER_UUID = '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c';
const MAIL_ADDR = ((process.env.MAIL_FROM || process.env.INVITE_FROM || 'no-reply@martialtraininglab.com').match(/<([^>]+)>/) || [])[1]
  || 'no-reply@martialtraininglab.com';

async function sbGet(path) {
  try { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc }); return r.ok ? await r.json() : []; }
  catch (e) { return []; }
}
async function sbPatch(path, body) {
  try { await fetch(`${SB}/rest/v1/${path}`, { method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify(body) }); } catch (e) {}
}
function _czDate(iso) {
  try { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return String(iso || ''); return parseInt(m[3], 10) + '. ' + parseInt(m[2], 10) + '. ' + m[1]; }
  catch (e) { return String(iso || ''); }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    if (!SB || !KEY) return res.status(500).json({ ok: false, error: 'server not configured' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const cmId = b.cohort_member_id;
    const token = req.headers['x-access-token'] || b.token || ((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!cmId) return res.status(400).json({ ok: false, error: 'no cohort_member_id' });
    if (!token) return res.status(401).json({ ok: false, error: 'no token' });

    // who is calling
    const ures = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!ures.ok) return res.status(401).json({ ok: false, error: 'bad token' });
    const uid = (await ures.json() || {}).id;
    if (!uid) return res.status(401).json({ ok: false, error: 'no user' });

    const mem = (await sbGet(`cohort_members?id=eq.${encodeURIComponent(cmId)}&select=id,cohort_id,name,email,tier,status,student_id,deposit_mail_at`))[0];
    if (!mem) return res.status(404).json({ ok: false, error: 'member not found' });

    const coh = (await sbGet(`gym_cohorts?id=eq.${encodeURIComponent(mem.cohort_id)}&select=id,gym_id,owner_id,name,currency,deposit_amount,price_student,price_regular,price_tiers,start_date`))[0];
    if (!coh) return res.status(404).json({ ok: false, error: 'cohort not found' });

    // caller must own the club (or be the cohort owner) -- same test the roster endpoints use
    let owns = coh.owner_id === uid;
    if (!owns && coh.gym_id) {
      const g = (await sbGet(`gyms?id=eq.${encodeURIComponent(coh.gym_id)}&select=owner_id`))[0];
      owns = !!(g && g.owner_id === uid);
    }
    if (!owns) return res.status(403).json({ ok: false, error: 'not owner' });

    // Nothing to send to: an app user already has the doklad in-app, exactly like the Stripe rail
    // (stripe-webhook.js gates on !mem.student_id for the same reason).
    if (!mem.email) return res.status(200).json({ ok: true, sent: false, reason: 'no email' });
    if (mem.student_id) return res.status(200).json({ ok: true, sent: false, reason: 'app user' });
    if (mem.deposit_mail_at) return res.status(200).json({ ok: true, sent: false, reason: 'already sent' });

    const gymRec = coh.gym_id ? (await sbGet(`gyms?id=eq.${encodeURIComponent(coh.gym_id)}&select=name,legal_name,tax_id,vat_id,vat_payer,vat_rate,billing_address`))[0] : null;
    const gymName = (gymRec && gymRec.name) || '';
    let ownerEmail = '';
    if (coh.owner_id) { const op = (await sbGet(`profiles?id=eq.${encodeURIComponent(coh.owner_id)}&select=email`))[0]; ownerEmail = (op && op.email) || ''; }

    const cur = coh.currency || 'CZK';
    const deposit = Number(coh.deposit_amount || 0);

    // tier price: named offers live in price_tiers; older cohorts fall back to student/regular
    let tierPrice = 0;
    const tiers = Array.isArray(coh.price_tiers) ? coh.price_tiers : null;
    if (tiers && tiers.length) {
      const hit = tiers.find(t => t && String(t.name) === String(mem.tier));
      tierPrice = Number(hit ? hit.price : tiers[0].price) || 0;
    } else {
      tierPrice = Number((mem.tier === 'student') ? coh.price_student : coh.price_regular) || 0;
    }
    const remainder = Math.max(0, tierPrice - deposit);
    const money = (x) => Math.round(x) + ' ' + cur;

    // doklad PDF -- same test-mode gate as the Stripe rail (test mode: founder's own club only)
    let attachments;
    let testMode = false; try { testMode = await isTestMode(); } catch (e) {}
    if (!(testMode && coh.owner_id !== FOUNDER_UUID)) {
      try {
        const buf = await cohortDokladPdf({
          gym: gymRec, gymName, buyer: (mem.name || mem.email || ''),
          item: ((coh.name || 'Kurz') + ' — záloha'), amount: deposit, cur,
          ref: 'QR/' + String(cmId).slice(0, 8), date: _czDate(new Date().toISOString().slice(0, 10)),
        });
        attachments = [{ filename: 'MTL-potvrzeni-o-platbe.pdf', content: buf.toString('base64') }];
      } catch (e) { console.error('cohort doklad pdf', e.message); }
    }

    const appUrl = (process.env.APP_URL || process.env.PUBLIC_URL || 'https://app.martialtraininglab.com').replace(/\/+$/, '');
    const fromName = (gymName || 'Martial Training Lab').replace(/["<>]/g, '');

    await sendResend(
      mem.email,
      (coh.name || 'Kurz') + ' \u2014 z\u00E1loha p\u0159ijata',
      cohortDepositHtml(
        mem.name, coh.name || 'Kurz', gymName, money(deposit),
        remainder > 0 ? money(remainder) : '', coh.start_date || '',
        appUrl + '/?myclass=' + encodeURIComponent(cmId)
      ),
      { from: '"' + fromName + '" <' + MAIL_ADDR + '>', replyTo: ownerEmail || undefined, attachments }
    );

    await sbPatch(`cohort_members?id=eq.${encodeURIComponent(cmId)}`, { deposit_mail_at: new Date().toISOString() });
    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    console.error('cohort-deposit-mail', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
