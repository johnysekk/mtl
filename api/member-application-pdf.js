// /api/member-application-pdf?id=<uuid>
//
// PŘIHLÁŠKA ZA ČLENA JAKO TISKNUTELNÝ DOKUMENT.
// Vzniká z dat, která už v databázi jsou: údaje žadatele opsané v okamžiku podání, znění
// přihlášky platné v té chvíli, čas souhlasu a rozhodnutí o přijetí. Nic se nedovyplňuje
// ručně, takže dokument nemůže říkat něco jiného než záznam.
//
// PODPIS SE NEKRESLÍ. Zaškrtnutí s časem, verzí znění a ověřeným účtem je prostý
// elektronický podpis podle eIDAS a pro přihlášku do spolku stačí. V dokumentu je proto
// záznam o souhlasu, ne prázdný podpisový řádek -- ten by svědčil o tom, že dokument
// ještě někdo musí podepsat, což není pravda.
//
// Kdo to smí stáhnout: žadatel sám, majitel nebo spolumajitel klubu, a zakladatel.

import PDFDocument from 'pdfkit';
import { DEJAVU_CZ } from './_dejavu-cz.js';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function sbGet(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc });
  if (!r.ok) throw new Error(`SB ${r.status} ${path}`);
  return r.json();
}

function czDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.getDate() + '. ' + (d.getMonth() + 1) + '. ' + d.getFullYear();
}
function czDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return czDate(iso) + ' v ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function buildPdf(app, gym) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const chunks = [];
      doc.on('data', (d) => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.registerFont('cz', DEJAVU_CZ); doc.font('cz');

      const W = 483;                    // šířka sazby mezi okraji
      const body = gym.member_app_body || 'příslušný orgán';

      // ── Hlavička ───────────────────────────────────────────────────────────────────
      doc.fontSize(17).fillColor('#111111').text('Přihláška za člena', 56, 56);
      doc.moveDown(0.2).fontSize(13).fillColor('#111111')
         .text(gym.legal_name || gym.name || '', { width: W });
      const addr = [gym.billing_line1, gym.billing_city, gym.billing_postal].filter(Boolean).join(', ');
      if (addr) doc.fontSize(9.5).fillColor('#666666').text(addr, { width: W });
      doc.moveDown(1);

      // ── Údaje žadatele ─────────────────────────────────────────────────────────────
      const row = (label, value) => {
        const y = doc.y;
        doc.fontSize(9).fillColor('#888888').text(label, 56, y, { width: 150 });
        doc.fontSize(11).fillColor('#111111').text(value || '—', 210, y, { width: W - 154 });
        doc.y = Math.max(doc.y, y + 16);
      };
      doc.fontSize(9).fillColor('#888888').text('ŽADATEL', 56, doc.y);
      doc.moveDown(0.4);
      row('Jméno a příjmení', app.applicant_name);
      if (app.applicant_birth) row('Datum narození', czDate(app.applicant_birth));
      row('E-mail', app.applicant_email);
      row('Telefon', app.applicant_phone);
      if (app.is_minor) {
        row('Zákonný zástupce', app.guardian_name);
        row('Kontakt na zástupce', app.guardian_contact);
      }
      if (app.member_type) row('Druh členství', app.member_type);

      // ── Znění přihlášky ────────────────────────────────────────────────────────────
      doc.moveDown(1);
      doc.moveTo(56, doc.y).lineTo(56 + W, doc.y).strokeColor('#DDDDDD').stroke();
      doc.moveDown(0.8);
      doc.fontSize(9).fillColor('#888888').text('ZNĚNÍ PŘIHLÁŠKY', 56, doc.y);
      doc.moveDown(0.4);
      doc.fontSize(10).fillColor('#222222')
         .text(gym.member_app_text || '', 56, doc.y, { width: W, align: 'left', lineGap: 2 });

      // ── Záznam o souhlasu (místo podpisu) ──────────────────────────────────────────
      doc.moveDown(1.2);
      const boxY = doc.y;
      doc.rect(56, boxY, W, 74).fillAndStroke('#F7F7F5', '#E2E0DB');
      doc.fillColor('#111111').fontSize(9.5)
         .text('Žadatel potvrdil elektronicky', 68, boxY + 10, { width: W - 24 });
      doc.fillColor('#444444').fontSize(9.5)
         .text(czDateTime(app.consent_at) + (app.consent_version ? ('  ·  znění ' + app.consent_version) : ''), 68, boxY + 26, { width: W - 24 })
         .text('účet: ' + (app.applicant_email || ''), 68, boxY + 42, { width: W - 24 })
         .fontSize(8.5).fillColor('#777777')
         .text('Zaškrtnutí s časovým razítkem a verzí znění je prostý elektronický podpis podle nařízení eIDAS.', 68, boxY + 56, { width: W - 24 });
      doc.y = boxY + 86; doc.x = 56;

      // ── Rozhodnutí ─────────────────────────────────────────────────────────────────
      if (app.status === 'approved' || app.status === 'rejected') {
        const dY = doc.y;
        const ok = app.status === 'approved';
        doc.rect(56, dY, W, 66).fillAndStroke(ok ? '#F0FBF0' : '#FEF2F2', ok ? '#CDEBD6' : '#FCA5A5');
        doc.fillColor(ok ? '#0F6E56' : '#b91c1c').fontSize(10.5)
           .text(ok ? 'Přijat za člena' : 'Přihláška zamítnuta', 68, dY + 10, { width: W - 24 });
        doc.fillColor('#444444').fontSize(9.5)
           .text(czDate(app.decided_at) + '  ·  ' + body, 68, dY + 27, { width: W - 24 });
        if (app.decided_note) doc.fontSize(9).fillColor('#666666').text(app.decided_note, 68, dY + 43, { width: W - 24 });
        doc.y = dY + 78; doc.x = 56;
      } else {
        doc.fontSize(9.5).fillColor('#888888')
           .text('O přijetí dosud nebylo rozhodnuto. Členství vzniká rozhodnutím, které činí ' + body + '.', 56, doc.y, { width: W });
        doc.moveDown(0.6);
      }

      // ── Patička ────────────────────────────────────────────────────────────────────
      doc.fontSize(8).fillColor('#999999')
         .text('Vystaveno z evidence klubu v aplikaci Martial Training Lab · ' + czDateTime(new Date().toISOString()),
               56, 780, { width: W, align: 'center' });

      doc.end();
    } catch (e) { reject(e); }
  });
}

export default async function handler(req, res) {
  try {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'missing id' });

    const rows = await sbGet(`gym_member_applications?id=eq.${encodeURIComponent(id)}&select=*`);
    const app = rows && rows[0];
    if (!app) return res.status(404).json({ error: 'not found' });

    const gyms = await sbGet(`gyms?id=eq.${encodeURIComponent(app.gym_id)}&select=name,legal_name,billing_line1,billing_city,billing_postal,owner_id,member_app_text,member_app_body`);
    const gym = (gyms && gyms[0]) || {};

    // Kdo to smí vidět: žadatel, majitel klubu nebo zakladatel. Bez tokenu nic.
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) return res.status(401).json({ error: 'unauthorized' });
    const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${auth}` } });
    if (!ur.ok) return res.status(401).json({ error: 'unauthorized' });
    const uid = (await ur.json()).id;
    let allowed = (uid === app.student_id) || (uid === gym.owner_id);
    if (!allowed) {
      const pr = await sbGet(`profiles?id=eq.${encodeURIComponent(uid)}&select=role`);
      allowed = !!(pr && pr[0] && pr[0].role === 'founder');
    }
    if (!allowed) {
      const co = await sbGet(`gym_coaches?gym_id=eq.${encodeURIComponent(app.gym_id)}&coach_id=eq.${encodeURIComponent(uid)}&select=co_owner`);
      allowed = !!(co && co[0] && co[0].co_owner);
    }
    if (!allowed) return res.status(403).json({ error: 'forbidden' });

    const pdf = await buildPdf(app, gym);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="prihlaska-${id.slice(0, 8)}.pdf"`);
    return res.status(200).send(pdf);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
