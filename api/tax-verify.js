// MTL — /api/tax-verify  ·  validate a tax identifier, server-side (no key needed)
//   ?type=vat&id=CZ12345678   → EU VAT via VIES  (countryCode taken from the first 2 letters, or &cc=CZ)
//   ?type=ico&id=12345678      → Czech IČO via ARES (business register)
// Always returns HTTP 200 with { ok, valid, name?, address?, source?, reason? } so the
// UI can treat it as advisory — a VIES/ARES outage must never block onboarding.
//
// VIES REST: https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number  (POST)
// ARES REST: https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}  (GET)

// ÚDAJ O ZÁPISU (§ 435 OZ) pro doklady. Veřejný rejstřík (obchodní, spolkový, nadační, ...)
// dává ARES jako spisovou značku „L 1234/KSBR"; na doklad patří „L 1234 vedená u Krajského
// soudu v Brně". Kdo ve veřejném rejstříku není a má živnost, uvádí zápis v živnostenském
// rejstříku. Neznámý kód soudu zůstane, jak ho ARES vrátil -- nic se nedomýšlí.
const COURTS = {
  MSPH: 'Městského soudu v Praze', KSPH: 'Krajského soudu v Praze',
  KSCB: 'Krajského soudu v Českých Budějovicích', KSPL: 'Krajského soudu v Plzni',
  KSUL: 'Krajského soudu v Ústí nad Labem', KSHK: 'Krajského soudu v Hradci Králové',
  KSBR: 'Krajského soudu v Brně', KSOS: 'Krajského soudu v Ostravě',
};
export function aresRegister(j) {
  try {
    const vr = (Array.isArray(j && j.dalsiUdaje) ? j.dalsiUdaje : []).find((x) => x && x.spisovaZnacka);
    if (vr) {
      const m = /^\s*([A-Za-z]{1,3}\s*\d+)\s*\/\s*([A-Z]{4})\s*$/.exec(String(vr.spisovaZnacka));
      if (m && COURTS[m[2]]) return m[1].replace(/\s+/, ' ') + ' vedená u ' + COURTS[m[2]];
      return String(vr.spisovaZnacka).trim();
    }
    const reg = (j && j.seznamRegistraci) || {};
    if (reg.stavZdrojeRzp === 'AKTIVNI') return String(j.pravniForma || '') === '101' ? 'Fyzická osoba zapsaná v živnostenském rejstříku' : 'Zapsáno v živnostenském rejstříku';
  } catch (e) {}
  return null;
}

// SÍDLO Z ARES rozložené do polí formuláře (ulice, část obce, PSČ, obec). Bere se oficiální
// textová adresa z rejstříku („Jankovcova 1522/53, Holešovice, 17000 Praha 7") -- je to přesně
// to, co má být na dokladu. Formulář ho jen nabídne/doplní, uloží ho až poskytovatel.
export function aresAddr(j) {
  try {
    const t = String((j && j.sidlo && j.sidlo.textovaAdresa) || '').trim();
    const parts = t.split(',').map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    const m = /^(\d{3})\s?(\d{2})\s+(.+)$/.exec(parts[parts.length - 1]);
    if (!m) return null;
    return { line1: parts[0], line2: parts.slice(1, -1).join(', '), postal: m[1] + ' ' + m[2], city: m[3],
      country: String((j.sidlo && j.sidlo.kodStatu) || 'CZ').toUpperCase() };
  } catch (e) { return null; }
}

// OVĚŘENÍ DIČ VE VIES -- sdílí ho tenhle endpoint (nápověda ve formulářích) i brána před
// platbou v pay.js. requester = DIČ MTL: s ním VIES vrátí číslo konzultace (requestIdentifier),
// úřední doklad o tom, že jsme platnost ověřili (čl. 18 odst. 1 nařízení 282/2011).
// Vrací { ok, valid, name, address, ref } nebo { ok:false, error } při výpadku VIES.
export async function viesCheck(rawId, ccOpt, requester) {
  const raw = String(rawId || '').replace(/\s+/g, '').toUpperCase();
  let cc = '', num = '';
  if (ccOpt && !/^[A-Z]{2}/.test(raw)) { cc = String(ccOpt).toUpperCase().replace(/[^A-Z]/g, ''); num = raw.replace(/[^0-9A-Z]/g, ''); }
  else { cc = raw.slice(0, 2).replace(/[^A-Z]/g, ''); num = raw.slice(2).replace(/[^0-9A-Z]/g, ''); }
  if (cc === 'GR') cc = 'EL';
  if (cc.length !== 2 || !num) return { ok: true, valid: false, reason: 'format' };
  const body = { countryCode: cc, vatNumber: num };
  const rq = String(requester || '').replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]{2}[0-9A-Z]+$/.test(rq)) { body.requesterMemberStateCode = rq.slice(0, 2); body.requesterNumber = rq.slice(2); }
  let vr;
  try {
    vr = await fetch('https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
    });
  } catch (e) { return { ok: false, error: 'vies unreachable' }; }
  if (!vr.ok) return { ok: false, error: 'vies ' + vr.status };
  let vj = {}; try { vj = await vr.json(); } catch (e) {}
  // VIES sometimes reports a transient member-state outage; surface it as "can't verify".
  if (vj && vj.userError && vj.userError !== 'VALID' && vj.userError !== 'INVALID') return { ok: false, error: 'vies ' + vj.userError };
  return {
    ok: true, valid: !!vj.valid,
    name: (vj.name && vj.name !== '---') ? vj.name : null,
    address: (vj.address && vj.address !== '---') ? vj.address : null,
    ref: vj.requestIdentifier || null,
    source: 'vies',
  };
}

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
        register: aresRegister(j),
        addr: aresAddr(j),
        source: 'ares',
      });
    }

    // ── EU VAT via VIES ──
    return res.status(200).json(await viesCheck(raw, req.query && req.query.cc));
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || 'error' });
  }
}
