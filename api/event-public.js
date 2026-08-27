// /api/event-public — public, accountless read for an event ticket page (?event=<id>).
// Mirror of cohort-public.js, deliberately: courses already sell to people without an MTL account
// and events could not, which cost a fight night most of its audience -- friends, family and people
// off Instagram do not install a training app to buy a 600 CZK ticket.
//
// Returns the event, its ticket tiers, how many places are left, the club's payment details for the
// QR rail, and the provider's LEGAL name straight from the connected Stripe account, because that is
// who the buyer is actually contracting with. No PII, no auth.
//
// ?tk=<ticketId> returns one ticket instead, for the "here is your ticket" page an accountless buyer
// lands on -- same shape as cohort-public's ?cm= branch.

const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbGet(path) {
  try {
    const r = await fetch(_SUPA + '/rest/v1/' + path, { headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY } });
    return r.ok ? await r.json() : [];
  } catch (e) { return []; }
}

// events.ticket_tiers je TEXT s JSONem: [{name, price}]. Kdyz je prazdny, akce ma jedinou cenu
// v events.ticket_price -- a presne takhle to cte i klient v index.html:8048, kde prazdne pole
// nahradi jednim radkem z ticket_price. Bez toho zalozniho kroku by se akce s jedinou cenou
// zobrazila jako vyprodana/neprodejna, protoze by nemela zadny cenik.
// Nazev nechavame prazdny stejne jako klient: u jedine ceny neni co odlisovat a "Ticket" by se
// zbytecne vypisovalo pod tlacitkem.
function parseTiers(ev) {
  let t = null;
  try { t = (typeof ev.ticket_tiers === 'string') ? JSON.parse(ev.ticket_tiers || '[]') : ev.ticket_tiers; } catch (e) { t = null; }
  if (Array.isArray(t) && t.length) {
    return t.map((x) => ({ name: String((x && x.name) || ''), price: Number((x && x.price) || 0) }));
  }
  return [{ name: '', price: Number(ev.ticket_price || 0) }];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ---- one ticket (?tk=) -------------------------------------------------------------------
    const tk = (req.query && req.query.tk) || '';
    if (tk) {
      const tr = await sbGet(`event_tickets?id=eq.${encodeURIComponent(tk)}&select=id,event_id,buyer_name,buyer_email,amount,currency,status,checked_in_at,created_at`);
      const t = tr && tr[0];
      if (!t) return res.status(404).json({ ok: false, error: 'ticket not found' });
      const er = await sbGet(`events?id=eq.${encodeURIComponent(t.event_id)}&select=id,title,starts_at,ends_at,venue,address,city,country,poster`);
      const e = (er && er[0]) || {};
      let gymName = '';
      try {
        const g0 = await sbGet(`events?id=eq.${encodeURIComponent(t.event_id)}&select=gym_id`);
        const gid = g0 && g0[0] && g0[0].gym_id;
        if (gid) { const g = await sbGet(`gyms?id=eq.${encodeURIComponent(gid)}&select=name`); gymName = (g && g[0] && g[0].name) || ''; }
      } catch (e2) {}
      return res.status(200).json({
        ok: true,
        ticket: { id: t.id, name: t.buyer_name, amount: t.amount, currency: t.currency, status: t.status, checked_in: !!t.checked_in_at },
        event: { id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, venue: e.venue, address: e.address, city: e.city, country: e.country, poster: e.poster || null, gym_name: gymName },
      });
    }

    // ---- the event page (?event=) ------------------------------------------------------------
    const id = (req.query && req.query.event) || '';
    if (!id) return res.status(400).json({ ok: false, error: 'missing event' });

    const rows = await sbGet(`events?id=eq.${encodeURIComponent(id)}&select=id,gym_id,created_by,status,type,title,description,poster,disciplines,city,country,venue,address,starts_at,ends_at,capacity,capacity_full,ticket_price,ticket_tiers,currency,terms_text,payout_coach_id`);
    const ev = rows && rows[0];
    if (!ev) return res.status(404).json({ ok: false, error: 'not found' });

    // Same shape of gate cohort-public uses: say no on arrival rather than after the form is filled.
    if (ev.status !== 'approved') {
      return res.status(403).json({ ok: false, error: 'closed', closed: true, reason: 'not_approved' });
    }
    const _started = ev.starts_at && (Date.now() > new Date(ev.starts_at).getTime());
    if (_started) {
      return res.status(403).json({ ok: false, error: 'closed', closed: true, reason: 'started' });
    }

    // Who receives the money. An event can be paid out to a coach instead of the club, which is why
    // payout_coach_id exists; the buyer needs the right IBAN on the QR, not the club's by default.
    // The HOST is whoever receives the money, and that is deliberately not "the club": an event can
    // be paid out to a coach (payout_coach_id), and gyms.kind lets a gyms row be a promoter or a
    // venue rather than a training club. Resolving a host instead of a gym is what makes this page
    // work unchanged the day a promoter is allowed to create an event.
    let payee = { payment_mode: null, receiver_id_type: null, receiver_id_value: null, receiver_name: null };
    let gymName = '', legalName = '', stripeAccount = null, hostKind = null, hostId = null;
    try {
      if (ev.payout_coach_id) {
        const p = await sbGet(`profiles?id=eq.${encodeURIComponent(ev.payout_coach_id)}&select=name,legal_name,payment_mode,receiver_id_type,receiver_id_value,receiver_name,stripe_account,gym_payout_account`);
        const pp = p && p[0];
        if (pp) {
          hostKind = 'coach'; hostId = ev.payout_coach_id;
          gymName = pp.name || '';
          legalName = pp.legal_name || pp.receiver_name || '';
          stripeAccount = pp.gym_payout_account || pp.stripe_account || null;
          payee = { payment_mode: pp.payment_mode || null, receiver_id_type: pp.receiver_id_type || null, receiver_id_value: pp.receiver_id_value || null, receiver_name: pp.receiver_name || null };
        }
      } else if (ev.gym_id) {
        const g = await sbGet(`gyms?id=eq.${encodeURIComponent(ev.gym_id)}&select=name,legal_name,payment_mode,receiver_id_type,receiver_id_value,receiver_name,stripe_account`);
        const gg = g && g[0];
        if (gg) {
          hostKind = 'gym'; hostId = ev.gym_id;
          gymName = gg.name || '';
          legalName = gg.legal_name || gg.receiver_name || '';
          stripeAccount = gg.stripe_account || null;
          payee = { payment_mode: gg.payment_mode || null, receiver_id_type: gg.receiver_id_type || null, receiver_id_value: gg.receiver_id_value || null, receiver_name: gg.receiver_name || null };
        }
      }
    } catch (e) {}

    // Pravni nazev porizujeme z MTL, ne ze Stripe. Puvodne se tahal pres stripe.accounts.retrieve,
    // coz funguje jen u poskytovatele na Stripe -- kdo bere prevodem, zadny Stripe ucet nema a
    // kupujici by na verejne strance nevidel, s kym vlastne uzavira smlouvu. legal_name je na
    // gyms i profiles a plni se pri fakturacnim nastaveni; receiver_name je zaloha, protoze u
    // bankovni koleje je to jmeno majitele uctu, ktere provider deklaroval.
    // Stejne poradi pouziva unified-doklad-cron pri vystavovani dokladu.
    const providerName = legalName || gymName;

    // Places taken. Counting ROWS is correct here and not an oversight: one row is one seat, which
    // is what lets every ticket carry its own QR and its own check-in. Reserved-but-unpaid counts,
    // because it is a live 30 minute hold; release-cron frees it if the payment never lands.
    let taken = 0;
    try {
      const t = await sbGet(`event_tickets?event_id=eq.${encodeURIComponent(id)}&status=in.(reserved,paid_claimed,paid,active)&select=id`);
      taken = Array.isArray(t) ? t.length : 0;
    } catch (e) {}
    const cap = Number(ev.capacity || 0);
    const soldOut = !!ev.capacity_full || (cap > 0 && taken >= cap);

    return res.status(200).json({
      ok: true,
      event: {
        id: ev.id, title: ev.title, description: ev.description || '', type: ev.type || null,
        poster: ev.poster || null, disciplines: ev.disciplines || '',
        starts_at: ev.starts_at, ends_at: ev.ends_at,
        venue: ev.venue || '', address: ev.address || '', city: ev.city || '', country: ev.country || '',
        currency: ev.currency || 'CZK',
        tiers: parseTiers(ev),
        capacity: cap || null, taken, sold_out: soldOut,
        terms_text: ev.terms_text || '',
        gym_id: ev.gym_id || null, gym_name: gymName, provider_name: providerName,
        // host_* is the generic form; gym_name stays so nothing already reading it breaks.
        host: { kind: hostKind, id: hostId, name: gymName, legal_name: providerName },
        stripe_account: stripeAccount,
        payment_mode: payee.payment_mode, receiver_id_type: payee.receiver_id_type,
        receiver_id_value: payee.receiver_id_value, receiver_name: payee.receiver_name,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
