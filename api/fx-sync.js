// /api/fx-sync.js  — Vercel Cron (schedule daily, e.g. "0 15 * * 1-5" after ECB ~16:00 CET)
// Fetches ECB euro reference rates SERVER-SIDE (no CORS issue) and caches them in fx_rates.
// ECB feed is public, no key, no rate limit (but slow) -> call once/day only.
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const r = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    if (!r.ok) return res.status(502).json({ error: 'ECB HTTP ' + r.status });
    const xml = await r.text();
    const timeM = xml.match(/time=['"]([0-9-]+)['"]/);
    const date = timeM ? timeM[1] : new Date().toISOString().slice(0, 10);
    const rates = {};
    const re = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]/g;
    let m;
    while ((m = re.exec(xml))) { rates[m[1]] = parseFloat(m[2]); }
    if (!rates.CZK) return res.status(502).json({ error: 'no CZK rate parsed from ECB feed' });
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await supa.from('fx_rates').upsert({
      id: 'ecb-latest',
      data: { date, base: 'EUR', rates },
      updated_at: new Date().toISOString()
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, date, currencies: Object.keys(rates).length });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
