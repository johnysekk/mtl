// /api/invite-members  — branded magic-link invites for IMPORTED members, sent via Resend.
// Called by the roster ("Pozvat vybrané / Pozvat všechny čekající"). Bypasses Supabase's
// per-hour OTP email rate limit (Resend does the sending), and lets the email be branded
// with the gym's name. Falls back to client-side signInWithOtp in index.html if this 404s.
//
// ENV required on Vercel:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already set for other endpoints)
//   RESEND_API_KEY                            (from resend.com)
//   INVITE_FROM   (optional, default "Martial Training Lab <no-reply@martialtraininglab.com>")
//
// Resend domain martialtraininglab.com must be verified (DNS) so the From address is allowed.

const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  try {
    const SB = process.env.SUPABASE_URL;
    const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND = process.env.RESEND_API_KEY;
    const FROM = process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';
    const MAIL_ADDR = (FROM.match(/<([^>]+)>/) || [])[1] || 'no-reply@martialtraininglab.com';
    if (!SB || !SR) return res.status(500).json({ error: 'config (supabase)' });
    if (!RESEND) return res.status(500).json({ error: 'config (resend) — set RESEND_API_KEY' });

    const admin = createClient(SB, SR, { auth: { persistSession: false, autoRefreshToken: false } });

    // who is calling
    const token = req.headers['x-access-token'] || '';
    const { data: ures } = await admin.auth.getUser(token);
    const uid = ures && ures.user && ures.user.id;
    if (!uid) return res.status(401).json({ error: 'bad token' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const gymId = body.gymId;
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!gymId || !ids.length) return res.status(400).json({ error: 'gymId + ids required' });

    // verify the caller actually owns this gym
    const { data: gym } = await admin.from('gyms').select('id,name,owner_id').eq('id', gymId).single();
    if (!gym || gym.owner_id !== uid) return res.status(403).json({ error: 'not gym owner' });

    // load the targets (never re-touch claimed rows)
    const { data: rows } = await admin
      .from('imported_members')
      .select('id,email,name,status')
      .eq('gym_id', gymId)
      .in('id', ids)
      .neq('status', 'claimed');

    const origin = req.headers.origin || ('https://' + (req.headers.host || 'app.martialtraininglab.com'));
    const gymName = (gym.name || 'tvůj gym');
    const ownerEmail = (ures && ures.user && ures.user.email) || '';
    const fromGym = '"' + String(gymName).replace(/["<>]/g, '') + '" <' + MAIL_ADDR + '>';

    let sent = 0, failed = 0;
    for (const m of (rows || [])) {
      try {
        // make sure the auth user exists, then mint a magic-link (same kind the app already handles)
        try { await admin.auth.admin.createUser({ email: m.email, email_confirm: true }); } catch (e) { /* already exists */ }
        const gl = await admin.auth.admin.generateLink({ type: 'magiclink', email: m.email, options: { redirectTo: origin } });
        const link = gl && gl.data && gl.data.properties && gl.data.properties.action_link;
        if (!link) throw new Error('no action_link');

        const firstName = (m.name || '').trim().split(' ')[0] || '';
        const html = inviteHtml(gymName, firstName, link);
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: fromGym,
            to: [m.email],
            reply_to: ownerEmail || undefined,
            subject: gymName + ' tě zve na MTL',
            html
          })
        });
        if (!r.ok) throw new Error('resend ' + r.status);

        await admin.from('imported_members')
          .update({ status: 'invited', invited_at: new Date().toISOString() })
          .eq('id', m.id);
        sent++;
      } catch (e) {
        failed++;
      }
    }
    return res.status(200).json({ ok: true, sent, failed });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
};

function inviteHtml(gymName, firstName, link) {
  const hi = firstName ? ('Ahoj ' + esc(firstName) + ',') : 'Ahoj,';
  return `<!doctype html><html><body style="margin:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#171717;">
  <div style="max-width:480px;margin:0 auto;padding:28px 22px;">
    <div style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#E11;margin-bottom:4px;">MARTIAL TRAINING LAB</div>
    <div style="font-size:12px;color:#888;margin-bottom:22px;">Be More.</div>
    <p style="font-size:15px;line-height:1.6;">${hi}</p>
    <p style="font-size:15px;line-height:1.6;"><b>${esc(gymName)}</b> teď jede na MTL — appce, kde máš rozvrh, členství, platby a svůj postup (levely, odznaky) na jednom místě. Připoj se jedním klikem, není potřeba nic vyplňovat.</p>
    <p style="text-align:center;margin:26px 0;">
      <a href="${link}" style="display:inline-block;background:#E11;color:#fff;text-decoration:none;font-weight:800;font-size:16px;padding:14px 30px;border-radius:12px;">Připojit se k ${esc(gymName)}</a>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#555;">Po kliknutí se přihlásíš, odsouhlasíš podmínky a nastavíš si heslo. Odkaz je platný omezenou dobu — když vyprší, řekni nám a pošleme nový.</p>
    <p style="font-size:12px;color:#aaa;line-height:1.6;margin-top:24px;">Tenhle e-mail ti přišel, protože jsi členem ${esc(gymName)}. Pokud si nepřeješ účet, e-mail ignoruj.</p>
  </div></body></html>`;
}
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
