// MTL — /api/ticket-email  (ESM, same style as pay.js / profile-badges.js)
// Sends the buyer their event ticket as an email with a scannable QR (encodes /?etk=<ticketId>).
// Called fire-and-forget from the app right after a ticket becomes paid (free RSVP or card).
const _RL_SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _RL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
function _rlIp(req) { const xr = req.headers['x-real-ip']; if (xr) return String(xr).trim(); const p = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return p.length ? p[p.length - 1] : ((req.socket && req.socket.remoteAddress) || 'unknown'); }
async function _rlAllow(endpoint, ip, limit, banMult) {
  try {
    const win = Math.floor(Date.now() / 600000);
    const r = await fetch(_RL_SUPA + '/rest/v1/rpc/rl_hit', { method: 'POST', headers: { apikey: _RL_KEY, Authorization: 'Bearer ' + _RL_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: ip + ':' + endpoint + ':' + win, p_ip: ip, p_endpoint: endpoint, p_window: win, p_limit: limit, p_ban_mult: banMult || 0 }) });
    if (!r.ok) return true;
    let _j = await r.json();
    if (Array.isArray(_j)) _j = _j[0];
    else if (_j && typeof _j === 'object') _j = Object.values(_j)[0];
    return _j !== false && _j !== 'false';
  } catch (e) { return true; }
}

export default async function handler(req, res) {
  try {
    if (!(await _rlAllow('ticket-email', _rlIp(req), 8, 10))) return res.status(429).json({ ok: false, error: 'Too many requests' });
    const ticketId =
      (req.query && req.query.ticketId) ||
      (req.body && (typeof req.body === 'string' ? JSON.parse(req.body || '{}').ticketId : req.body.ticketId));
    if (!ticketId) { res.status(400).json({ error: 'missing ticketId' }); return; }

    const SUPABASE_URL = process.env.SUPABASE_URL || 'https://iqeovcvchtyfwtyzpqrh.supabase.co';
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY ||
      process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SECRET ||
      process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    const RESEND_KEY = process.env.RESEND_API_KEY || process.env.RESEND_KEY;
    if (!SERVICE_KEY || !RESEND_KEY) { res.status(500).json({ error: 'server not configured' }); return; }

    const APP_URL = process.env.APP_URL || 'https://app.martialtraininglab.com';
    const MAIL_FROM = process.env.MAIL_FROM || process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';
    const sb = (path) => fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
    }).then(r => r.json()).catch(() => null);

    // ticket
    const tkArr = await sb('event_tickets?id=eq.' + encodeURIComponent(ticketId) + '&select=*');
    const tk = (tkArr && tkArr[0]) || null;
    if (!tk) { res.status(404).json({ error: 'ticket not found' }); return; }

    // Objednávka může nést víc lístků. Posílá se JEDEN e-mail se všemi -- tři samostatné maily za
    // jednu platbu vypadají jako chyba a člověk u dveří pak hledá, který z nich patří komu.
    // Voláno kterýmkoli lístkem z objednávky; sourozence si dohledáme sami.
    let tickets = [tk];
    if (tk.order_id) {
      const sib = await sb('event_tickets?order_id=eq.' + encodeURIComponent(tk.order_id)
        + '&status=in.(paid,active,paid_claimed)&order=created_at.asc&select=*');
      if (Array.isArray(sib) && sib.length) tickets = sib;
    }

    // event
    const evArr = await sb('events?id=eq.' + encodeURIComponent(tk.event_id) + '&select=title,starts_at,venue,city,country');
    const ev = (evArr && evArr[0]) || {};

    // buyer email (profile first, fall back to ticket buyer_email if present)
    let email = tk.buyer_email || null, name = tk.buyer_name || '';
    if (tk.buyer_id) {
      const pArr = await sb('profiles?id=eq.' + encodeURIComponent(tk.buyer_id) + '&select=email,name');
      const prof = (pArr && pArr[0]) || {};
      if (prof.email) email = prof.email;
      if (prof.name) name = prof.name;
    }
    if (!email) { res.status(200).json({ ok: false, reason: 'no email' }); return; }

    // Jeden QR na lístek. Sdílet jeden kód mezi třemi lidmi nejde -- u dveří se skenuje každý
    // zvlášť a checked_in_at je na řádku, ne na objednávce.
    const qrFor = (id) => 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=8&data='
      + encodeURIComponent(APP_URL + '/?etk=' + encodeURIComponent(id));
    const checkinUrl = APP_URL + '/?etk=' + encodeURIComponent(ticketId);
    const qrImg = qrFor(ticketId);

    let dt = '';
    try { if (ev.starts_at) dt = new Date(ev.starts_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) {}
    const venue = [ev.venue, ev.city, ev.country].filter(Boolean).join(', ');
    const esc = (x) => String(x || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const title = esc(ev.title || 'MTL Event');

    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;background:#0c0c0c;border-radius:18px;overflow:hidden;color:#fff;">' +
      '<div style="padding:26px 24px 8px;text-align:center;">' +
      '<div style="font-size:13px;letter-spacing:.16em;color:#F4D87A;font-weight:700;">MARTIAL TRAINING LAB</div>' +
      '<div style="font-size:22px;font-weight:800;margin:10px 0 2px;">🎟️ ' + title + '</div>' +
      (dt ? '<div style="font-size:14px;color:#c9c9c9;margin-top:6px;">' + esc(dt) + '</div>' : '') +
      (venue ? '<div style="font-size:13px;color:#9a9a9a;margin-top:2px;">' + esc(venue) + '</div>' : '') +
      '</div>' +
      (tickets.length > 1
        ? '<div style="text-align:center;color:#c9c9c9;font-size:13px;margin:2px 0 -6px;">' + tickets.length + ' tickets — one QR each</div>'
        : '') +
      // Každý lístek svůj blok. Číslování je kvůli dveřím: "ten druhý" se hledá líp než UUID.
      tickets.map(function(t, ix){
        const tid = t.id;
        const lbl = (t.tier_name || t.plan_name || '') || (tickets.length > 1 ? ('Ticket ' + (ix + 1) + ' of ' + tickets.length) : 'Your ticket');
        return '<div style="background:#fff;margin:18px 22px;border-radius:16px;padding:18px;text-align:center;">' +
          '<img src="' + qrFor(tid) + '" width="220" height="220" alt="Ticket QR" style="display:block;margin:0 auto;border-radius:10px;" />' +
          '<div style="color:#111;font-size:13px;font-weight:700;margin-top:12px;">' + esc(name || 'Your ticket') + '</div>' +
          (tickets.length > 1 ? '<div style="color:#666;font-size:12px;margin-top:2px;">' + esc(lbl) + '</div>' : '') +
          '<div style="color:#888;font-size:12px;margin-top:4px;">Show this QR at the event entrance to check in.</div>' +
          '<div style="color:#b0b0b0;font-size:10.5px;margin-top:8px;word-break:break-all;">' + esc(tid) + '</div>' +
          '</div>';
      }).join('') +
      '<div style="padding:4px 24px 26px;text-align:center;color:#7a7a7a;font-size:11px;line-height:1.5;">' +
      'If a QR doesn’t load, open: <a href="' + checkinUrl + '" style="color:#F4D87A;">' + esc(checkinUrl) + '</a>' +
      '</div></div>';

    const rRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: MAIL_FROM,
        to: [email],
        subject: '🎟️ Your ticket — ' + (ev.title || 'MTL Event'),
        html
      })
    });
    const rJson = await rRes.json().catch(() => ({}));
    if (!rRes.ok) { res.status(502).json({ error: 'resend failed', detail: rJson }); return; }
    res.status(200).json({ ok: true, id: rJson.id });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
}
