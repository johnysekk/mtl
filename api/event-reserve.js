// /api/event-reserve — REZERVACE LÍSTKŮ NA AKCI (veřejná stránka, i bez účtu).
//
// Dřív se lístky zapisovaly z prohlížeče rovnou do databáze. To znamenalo:
//   • CENU určoval prohlížeč -- upravený požadavek zapsal lístek za 1 Kč;
//   • kapacitu hlídala jen stránka -- robot ji obešel a zaplnil akci nezaplacenými místy;
//   • žádný limit -- tisíc rezervací za minutu prošlo;
//   • lístek šlo připsat k cizímu účtu jen podle e-mailu.
// Teď to dělá server: cena a kapacita z akce, limit na IP i na e-mail, buyer_id jen z přihlášení.
// Místo drží 30 minut ('reserved'), pak ho release-cron uvolní -- stejně jako dřív.
//
// POST { event_id, cart:[{ tier_name, qty }], name, email, phone, age_ok, guard, minors:[{name,dob}],
//        lang, hp, method:'qr'|'card'|'pis', attendees:[{name,dob}] (jen přihlášený) }
//   ->  { ok, ticket_id, order_id, ids, total, currency, free }
// Přihlášený (Bearer token): jméno a e-mail z jeho profilu, lístky na jeho účet.

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const q = encodeURIComponent;
const CONSENT_VERSION = '2026-08-v1';            // = TICKET_CONSENT_VERSION v appce
const MAX_PER_ORDER = 20;
const MAX_OPEN_ORDERS_PER_EMAIL = 3;              // nezaplacené objednávky na akci a e-mail

async function sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}) },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}
function ipOf(req) {
  const xr = req.headers['x-real-ip']; if (xr) return String(xr).trim();
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}
// Limiter MTL (rl_hit): okno 10 minut, nad limit 429, při `ban`-násobku blokace IP na 24 h.
async function rlAllow(endpoint, ip, limit, ban) {
  try {
    const win = Math.floor(Date.now() / 600000);
    const r = await fetch(`${SB}/rest/v1/rpc/rl_hit`, { method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: `${ip}:${endpoint}:${win}`, p_ip: ip, p_endpoint: endpoint, p_window: win, p_limit: limit, p_ban_mult: ban || 0 }) });
    if (!r.ok) return true;
    let j = await r.json(); if (Array.isArray(j)) j = j[0]; else if (j && typeof j === 'object') j = Object.values(j)[0];
    return j !== false && j !== 'false';
  } catch (e) { return true; }
}
async function whoami(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  try {
    const r = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null; const u = await r.json(); return (u && u.id) ? u.id : null;
  } catch (e) { return null; }
}
function parseTiers(ev) {
  let t = null;
  try { t = (typeof ev.ticket_tiers === 'string') ? JSON.parse(ev.ticket_tiers || '[]') : ev.ticket_tiers; } catch (e) { t = null; }
  if (Array.isArray(t) && t.length) return t.map((x) => ({ name: String((x && x.name) || ''), price: Number((x && x.price) || 0), participant: !!(x && x.participant) }));
  return [{ name: '', price: Number(ev.ticket_price || 0), participant: false }];
}
function age(dob) { const b = new Date(dob); if (isNaN(b)) return null; const t = new Date(); let a = t.getFullYear() - b.getFullYear(); const m = t.getMonth() - b.getMonth(); if (m < 0 || (m === 0 && t.getDate() < b.getDate())) a--; return a; }
// Stejný otisk jako _waiverHash v appce -- záznamy souhlasů se pak dají porovnat.
function waiverHash(str) { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; const x = String(str || ''); for (let i = 0; i < x.length; i++) { const ch = x.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16); }

export default async function handler(req, res) {
  if (!SB || !KEY) return res.status(500).json({ ok: false, error: 'not configured' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    const ip = ipOf(req);
    if (!(await rlAllow('event-reserve', ip, 12, 10))) return res.status(429).json({ ok: false, error: 'Příliš mnoho pokusů. Zkus to za pár minut.' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.hp || b.website) return res.status(200).json({ ok: false, error: 'rejected' });   // past na roboty
    const EN = b.lang === 'en';

    // Účet kupujícího jen z přihlášení. Dřív stačilo znát cizí e-mail a lístek se připsal k cizímu účtu.
    const buyerId = await whoami(req);
    let name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    let email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    const phone = String(b.phone || '').trim().slice(0, 40) || null;
    if (buyerId) {
      const pr = ((await sb(`profiles?id=eq.${q(buyerId)}&select=name,email`)) || [])[0] || {};
      name = String(pr.name || name || '').trim().slice(0, 120) || 'Student';
      email = String(pr.email || email || '').trim().toLowerCase().slice(0, 200);
    } else if (name.split(' ').filter((x) => x.length >= 2).length < 2) {
      return res.status(400).json({ ok: false, error: EN ? 'Enter your full name' : 'Vyplň celé jméno' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return res.status(400).json({ ok: false, error: EN ? 'Check your e-mail' : 'Zkontroluj e-mail' });
    // Limit i na e-mail: přes různé IP adresy nejde zasypat akci rezervacemi jednoho „člověka".
    if (!(await rlAllow('event-reserve-mail', 'm:' + email, 6, 0))) return res.status(429).json({ ok: false, error: 'Příliš mnoho pokusů. Zkus to za pár minut.' });

    const ev = ((await sb(`events?id=eq.${q(String(b.event_id || ''))}&select=id,gym_id,status,starts_at,capacity,capacity_full,ticket_price,ticket_tiers,currency,terms_text,min_age`)) || [])[0];
    if (!ev) return res.status(404).json({ ok: false, error: 'not found' });
    if (ev.status !== 'approved') return res.status(403).json({ ok: false, error: EN ? 'Sales are closed' : 'Prodej je uzavřený', closed: true });
    if (ev.starts_at && Date.now() > new Date(ev.starts_at).getTime()) return res.status(403).json({ ok: false, error: EN ? 'The event has started' : 'Akce už začala', closed: true });

    // Košík: CENA ZE SERVERU, z ceníku akce. Klient posílá jen variantu a počet.
    const tiers = parseTiers(ev);
    // Varianta podle NÁZVU (stránka některé varianty nezobrazuje, takže pořadí nesedí s ceníkem).
    const cart = (Array.isArray(b.cart) ? b.cart : []).map((x) => ({ i: tiers.findIndex((t) => String(t.name || '') === String((x && x.tier_name) || '')), qty: Math.min(MAX_PER_ORDER, parseInt(x && x.qty, 10) || 0) }))
      .filter((x) => x.qty > 0 && x.i >= 0);
    if ((Array.isArray(b.cart) ? b.cart : []).some((x) => (parseInt(x && x.qty, 10) || 0) > 0 && !tiers.some((t) => String(t.name || '') === String((x && x.tier_name) || ''))))
      return res.status(400).json({ ok: false, error: EN ? 'This ticket type no longer exists — reload the page' : 'Tahle varianta lístku už neexistuje — obnov stránku' });
    const qty = cart.reduce((a, x) => a + x.qty, 0);
    if (!qty) return res.status(400).json({ ok: false, error: EN ? 'Pick at least one ticket' : 'Vyber aspoň jeden lístek' });
    if (qty > MAX_PER_ORDER) return res.status(400).json({ ok: false, error: EN ? 'Too many tickets in one order' : 'Moc lístků v jedné objednávce' });

    // Věk: zákonný zástupce za účastníky (z data narození), jinak prohlášení kupujícího.
    const minAge = parseInt(ev.min_age, 10) || 0;
    const partQty = cart.reduce((a, x) => a + (tiers[x.i].participant ? x.qty : 0), 0);
    const guard = !!b.guard;
    let minors = [];
    if (guard) {
      minors = (Array.isArray(b.minors) ? b.minors : []).slice(0, partQty).map((m) => ({ name: String((m && m.name) || '').trim().slice(0, 120), dob: String((m && m.dob) || '').slice(0, 10) }));
      if (minors.length < partQty || minors.some((m) => !m.name || age(m.dob) == null)) return res.status(400).json({ ok: false, error: EN ? 'Fill in every attendee name and date of birth' : 'Vyplň u každého účastníka jméno i datum narození' });
      if (minAge && minors.some((m) => age(m.dob) < minAge)) return res.status(400).json({ ok: false, error: EN ? `This event is ${minAge}+` : `Akce je od ${minAge} let` });
    } else if (minAge && !b.age_ok) {
      return res.status(400).json({ ok: false, error: EN ? `Confirm everyone is ${minAge}+` : `Potvrď, že všem je ${minAge} let nebo víc` });
    }

    // Kapacita na serveru. Rezervace (30 min) se počítá -- je to živé držení místa.
    const taken = ((await sb(`event_tickets?event_id=eq.${q(ev.id)}&status=in.(reserved,paid_claimed,paid,active)&select=id`)) || []).length;
    const cap = Number(ev.capacity || 0);
    if (ev.capacity_full || (cap > 0 && taken + qty > cap)) return res.status(409).json({ ok: false, error: EN ? 'Not enough places left' : 'Tolik volných míst už není', full: true, left: cap > 0 ? Math.max(0, cap - taken) : 0 });

    // Nezaplacené objednávky téhož e-mailu na téže akci -- strop, ať jeden člověk nedrží půl sálu.
    const open = (await sb(`event_tickets?event_id=eq.${q(ev.id)}&buyer_email=eq.${q(email)}&status=eq.reserved&select=order_id`)) || [];
    if (new Set(open.map((x) => x.order_id)).size >= MAX_OPEN_ORDERS_PER_EMAIL) return res.status(429).json({ ok: false, error: EN ? 'You already have unpaid orders — pay or wait 30 minutes' : 'Už máš nezaplacené objednávky — zaplať je, nebo počkej 30 minut' });

    const now = new Date().toISOString();
    const orderId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('o' + Date.now() + Math.random().toString(36).slice(2, 10));
    const cur = ev.currency || 'CZK';
    // Přihlášený vybírá účastníky ze svých dětí; jejich souhlasy řeší appka vlastními kroky.
    const attendees = buyerId ? (Array.isArray(b.attendees) ? b.attendees : []).map((m) => ({ name: String((m && m.name) || '').trim().slice(0, 120), dob: String((m && m.dob) || '').slice(0, 10) || null })) : [];
    const method = ['qr', 'card', 'pis'].includes(String(b.method || '')) ? String(b.method) : null;
    let mi = 0, ai = 0;
    const rows = [];
    for (const x of cart) {
      const t = tiers[x.i];
      for (let k = 0; k < x.qty; k++) {
        const who = (guard && t.participant) ? (minors[mi++] || null) : ((t.participant && attendees.length) ? (attendees[ai++] || null) : null);
        rows.push({ attr_src: (typeof b.attr_src === 'string' ? b.attr_src.slice(0, 200) : null),
          event_id: ev.id, buyer_id: buyerId, buyer_name: name, buyer_email: email, buyer_phone: phone,
          attendee_name: who ? who.name : null, attendee_dob: who ? who.dob : null,
          order_id: orderId, qty: 1, amount: Number(t.price) || 0, tier_name: t.name || null, currency: cur, status: 'reserved',
          payment_method: method === 'qr' ? 'qr' : (method === 'card' ? 'stripe' : null),
          consent_at: now, consent_version: CONSENT_VERSION + (minAge ? ('+age' + minAge) : '') + (who ? '+guardian' : '') });
      }
    }
    // Zdarma (celá objednávka 0): není co platit, lístky jsou rovnou platné.
    const free = rows.every((r) => !(Number(r.amount) > 0));
    if (free) rows.forEach((r) => { r.status = 'paid'; r.payment_method = null; });
    const ins = (await sb('event_tickets', { method: 'POST', prefer: 'return=representation', body: JSON.stringify(rows) })) || [];
    const ids = ins.map((r) => r.id);

    // Souhlas zástupce se zněním a otiskem (stejně jako dřív v appce, jen ho teď píše server).
    if (guard && minors.length) {
      try {
        const clause = EN ? 'I understand this ticket is non-refundable. Any refund is handled by the organizer directly; MTL is not responsible for the state of payments.'
          : 'Beru na vědomí, že tento lístek je nevratný. Případné refundace řeší pořadatel přímo, MTL nezodpovídá za stav plateb.';
        const title = EN ? 'Minor participation consent' : 'Souhlas zástupce s účastí nezletilého';
        const body = [(ev.terms_text && String(ev.terms_text).trim()) || '', clause,
          (EN ? `Guardian: ${name} (${email})` : `Zákonný zástupce: ${name} (${email})`)].filter(Boolean).join('\n\n---\n\n');
        await sb('waiver_acceptances', { method: 'POST', prefer: 'return=minimal', body: JSON.stringify(minors.map((m) => ({
          gym_id: ev.gym_id || null, version: 0, student_id: null, student_name: m.name, guest_email: email,
          guardian_name: name, body_title: title, body_text: body, body_hash: waiverHash(title + '|' + body), accepted_at: now }))) });
      } catch (e) { console.error('[event-reserve] guardian consent', e.message); }
    }

    const total = rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);
    return res.status(200).json({ ok: true, ticket_id: ids[0] || null, order_id: orderId, ids, total, currency: cur, qty, free });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 200) });
  }
}
