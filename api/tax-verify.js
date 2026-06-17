// MTL — /api/tax-verify  ·  validate a tax identifier, server-side (no key needed)
//   ?type=vat&id=CZ12345678   → EU VAT via VIES  (countryCode taken from the first 2 letters, or &cc=CZ)
//   ?type=ico&id=12345678      → Czech IČO via ARES (business register)
// Always returns HTTP 200 with { ok, valid, name?, address?, source?, reason? } so the
// UI can treat it as advisory — a VIES/ARES outage must never block onboarding.
//
// VIES REST: https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number  (POST)
// ARES REST: https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}  (GET)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const type = String((req.query && req.query.type) || 'vat').toLowerCase();
    const raw = String((req.query && req.query.id) || '').replace(/\s+/g, '').toUpperCase();
    if (!raw) return res.status(400).json({ ok: false, error: 'no id' });

    // ── CZ IČO via ARES ──
    if (type === 'ico') {
      const ico = raw.replace(/[^0-9]/g, '');
      if (!/^\d{8}$/.test(ico)) return res.status(200).json({ ok: true, valid: false, reason: 'format' });
      let r;
      try {
        r = await fetch('https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/' + ico, { headers: { accept: 'application/json' } });
      } catch (e) { return res.status(200).json({ ok: false, error: 'ares unreachable' }); }
      if (r.status === 404) return res.status(200).json({ ok: true, valid: false });
      if (!r.ok) return res.status(200).json({ ok: false, error: 'ares ' + r.status });
      let j = {}; try { j = await r.json(); } catch (e) {}
      return res.status(200).json({
        ok: true, valid: true,
        name: j.obchodniJmeno || null,
        address: (j.sidlo && (j.sidlo.textovaAdresa || null)) || null,
        dic: j.dic || null,
        source: 'ares',
      });
    }

    // ── EU VAT via VIES ──
    let cc = '', num = '';
    if (req.query && req.query.cc) { cc = String(req.query.cc).toUpperCase().replace(/[^A-Z]/g, ''); num = raw.replace(/[^0-9A-Z]/g, ''); }
    else { cc = raw.slice(0, 2).replace(/[^A-Z]/g, ''); num = raw.slice(2).replace(/[^0-9A-Z]/g, ''); }
    if (cc.length !== 2 || !num) return res.status(200).json({ ok: true, valid: false, reason: 'format' });

    let vr;
    try {
      vr = await fetch('https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ countryCode: cc, vatNumber: num }),
      });
    } catch (e) { return res.status(200).json({ ok: false, error: 'vies unreachable' }); }
    if (!vr.ok) return res.status(200).json({ ok: false, error: 'vies ' + vr.status });
    let vj = {}; try { vj = await vr.json(); } catch (e) {}
    // VIES sometimes reports a transient member-state outage; surface it as "can't verify".
    if (vj && vj.userError && vj.userError !== 'VALID' && vj.userError !== 'INVALID') {
      return res.status(200).json({ ok: false, error: 'vies ' + vj.userError });
    }
    return res.status(200).json({
      ok: true,
      valid: !!vj.valid,
      name: (vj.name && vj.name !== '---') ? vj.name : null,
      address: (vj.address && vj.address !== '---') ? vj.address : null,
      source: 'vies',
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || 'error' });
  }
}
