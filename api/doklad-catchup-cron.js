// /api/doklad-catchup-cron.js — dovystaví doklady o provizi za STARŠÍ období.
//
// PROČ: unified-doklad-cron vystavuje doklad vždy jen za PŘEDCHOZÍ měsíc. Od sql-49 navíc
// čeká, dokud je za to období něco neuhrazené. Když tedy klub zaplatí provizi za září až
// v listopadu, cron už v té době řeší období „říjen" a na září se nikdy nevrátí — doklad
// by nevznikl vůbec.
//
// Tenhle cron proto zavolá unified-doklad-cron znovu pro posledních 6 měsíců. Ten si sám
// hlídá, že na jedno období a měnu vystaví jediný doklad, takže opakované volání nic
// nezdvojí. Běží jednou denně, po měsíčním strhávání.

const APP = process.env.APP_URL || 'https://app.martialtraininglab.com';
const SECRET = process.env.CRON_SECRET || '';

function prevMonths(n) {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = 1; i <= n; i++) {
    d.setUTCMonth(d.getUTCMonth() - 1);
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (SECRET && auth !== `Bearer ${SECRET}`) return res.status(401).json({ error: 'unauthorized' });

  const months = prevMonths(6);
  const out = { months: [], errors: [] };
  for (const m of months) {
    try {
      const r = await fetch(`${APP}/api/unified-doklad-cron?month=${encodeURIComponent(m)}`, {
        headers: SECRET ? { Authorization: `Bearer ${SECRET}` } : {},
      });
      const j = await r.json().catch(() => ({}));
      // issued = kolik dokladů vzniklo, skipped = už existoval, deferred = čeká na úhradu
      out.months.push({ month: m, issued: j.issued ?? null, skipped: j.skipped ?? null, deferred: j.deferred ?? null });
    } catch (e) {
      out.errors.push({ month: m, error: (e && e.message) || 'error' });
    }
  }
  return res.status(200).json({ ok: true, ...out });
}
