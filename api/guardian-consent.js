// /api/guardian-consent — minor's parent/guardian gives consent via e-mail (NO MTL account needed).
// Approval writes a waiver_acceptances row that UNLOCKS ONLY THAT GYM for that minor
// (the same record the in-app _minorWaiverGate reads). For 1:N family privates a real
// family_links account is still required — this only covers the gym waiver.
//
// POST { action }:
//   request : minor (auth via x-access-token) enters guardian e-mail -> insert request + e-mail a link
//   fetch   : public approval page loads the request by token (no auth)
//   approve : guardian clickwraps -> write waiver_acceptances + notify minor + mark approved
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, INVITE_FROM(optional)
//   Resend domain martialtraininglab.com must be verified (DNS).

const { createClient } = require('@supabase/supabase-js');

const _RL_SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _RL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
function _rlIp(req) { const xr = req.headers['x-real-ip']; if (xr) return String(xr).trim(); const p = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); return p.length ? p[p.length - 1] : ((req.socket && req.socket.remoteAddress) || 'unknown'); }
async function _rlAllow(endpoint, ip, limit) {
  try {
    const win = Math.floor(Date.now() / 600000);
    const r = await fetch(_RL_SUPA + '/rest/v1/rpc/rl_hit', { method: 'POST', headers: { apikey: _RL_KEY, Authorization: 'Bearer ' + _RL_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_key: ip + ':' + endpoint + ':' + win, p_ip: ip, p_endpoint: endpoint, p_window: win, p_limit: limit }) });
    if (!r.ok) return true;
    let _j = await r.json();
    if (Array.isArray(_j)) _j = _j[0];
    else if (_j && typeof _j === 'object') _j = Object.values(_j)[0];
    return _j !== false && _j !== 'false';
  } catch (e) { return true; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!(await _rlAllow('guardian-consent', _rlIp(req), 8))) return res.status(429).json({ error: 'Too many requests' });
  try {
    const SB = process.env.SUPABASE_URL;
    const SR = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const RESEND = process.env.RESEND_API_KEY;
    const FROM = process.env.INVITE_FROM || 'Martial Training Lab <no-reply@martialtraininglab.com>';
    if (!SB || !SR) return res.status(500).json({ error: 'config (supabase)' });
    const admin = createClient(SB, SR, { auth: { persistSession: false, autoRefreshToken: false } });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action || '';
    const origin = req.headers.origin || ('https://' + (req.headers.host || 'app.martialtraininglab.com'));

    // ---- request: minor asks; we e-mail the guardian an approval link ----
    if (action === 'request') {
      if (!RESEND) return res.status(500).json({ error: 'config (resend) — set RESEND_API_KEY' });
      const tok = req.headers['x-access-token'] || '';
      const { data: ures } = await admin.auth.getUser(tok);
      const uid = ures && ures.user && ures.user.id;
      if (!uid) return res.status(401).json({ error: 'bad token' });

      const email = String(body.guardian_email || '').trim().toLowerCase();
      const gymId = body.gym_id;
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !gymId) {
        return res.status(400).json({ error: 'valid guardian_email + gym_id required' });
      }
      const token = (cryptoUUID());
      const row = {
        token,
        minor_id: uid,
        minor_name: (body.minor_name || '').toString().slice(0, 120) || null,
        gym_id: gymId,
        gym_name: (body.gym_name || 'Gym').toString().slice(0, 160),
        guardian_email: email,
        body_hash: (body.body_hash || '').toString(),
        title: (body.title || '').toString().slice(0, 200),
        body: (body.body || '').toString().slice(0, 8000),
        version: (typeof body.version === 'number' ? body.version : parseInt(body.version) || 0),
        status: 'pending'
      };
      const { error: ie } = await admin.from('guardian_consent_requests').insert(row);
      if (ie) return res.status(500).json({ error: ie.message });

      const link = origin + '/?guardianconsent=' + encodeURIComponent(token);
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM,
          to: [email],
          subject: 'Souhlas s tréninkem nezletilého — ' + row.gym_name,
          html: consentHtml(row.gym_name, row.minor_name, link)
        })
      });
      if (!r.ok) return res.status(502).json({ error: 'resend ' + r.status });
      return res.status(200).json({ ok: true });
    }

    // ---- fetch: public approval page reads the request ----
    if (action === 'fetch') {
      const token = String(body.token || '');
      if (!token) return res.status(400).json({ error: 'token' });
      const { data: rq } = await admin.from('guardian_consent_requests')
        .select('gym_name,minor_name,title,body,status').eq('token', token).single();
      if (!rq) return res.status(404).json({ error: 'not found' });
      return res.status(200).json({ ok: true, request: rq });
    }

    // ---- approve: guardian clickwraps -> consent recorded ----
    if (action === 'approve') {
      const token = String(body.token || '');
      const gname = String(body.guardian_name || '').trim().slice(0, 120);
      if (!token || gname.length < 2) return res.status(400).json({ error: 'token + guardian_name required' });
      const { data: rq } = await admin.from('guardian_consent_requests').select('*').eq('token', token).single();
      if (!rq) return res.status(404).json({ error: 'not found' });
      if (rq.status === 'approved') return res.status(200).json({ ok: true, already: true, gym_name: rq.gym_name });

      // the exact record the in-app gate checks (gym_id + student_id + body_hash)
      const { error: we } = await admin.from('waiver_acceptances').insert({
        gym_id: rq.gym_id,
        version: rq.version || 0,
        student_id: rq.minor_id,
        student_name: rq.minor_name || null,
        body_hash: rq.body_hash,
        accepted_at: new Date().toISOString(),
        guardian_id: null,
        guardian_name: gname
      });
      if (we) return res.status(500).json({ error: we.message });

      await admin.from('guardian_consent_requests')
        .update({ status: 'approved', approved_at: new Date().toISOString(), guardian_name: gname })
        .eq('token', token);

      try {
        await admin.from('notifications').insert({
          user_id: rq.minor_id, type: 'system', read: false,
          data: JSON.stringify({ kind: 'minor_waiver_done', ok: true, gym_name: rq.gym_name }),
          message: '✅ Zástupce schválil — teď můžeš trénovat v ' + (rq.gym_name || 'gym') + '.'
        });
      } catch (e) { /* non-fatal */ }

      return res.status(200).json({ ok: true, gym_name: rq.gym_name });
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || 'error' });
  }
};

function cryptoUUID() {
  try { const c = require('crypto'); if (c.randomUUID) return c.randomUUID(); } catch (e) {}
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function consentHtml(gymName, minorName, link) {
  const who = minorName ? esc(minorName) : 'svěřenec';
  return `<!doctype html><html><body style="margin:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#171717;">
  <div style="max-width:480px;margin:0 auto;padding:28px 22px;">
    <div style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#E11;margin-bottom:4px;">MARTIAL TRAINING LAB</div>
    <div style="font-size:12px;color:#888;margin-bottom:22px;">Be More.</div>
    <p style="font-size:15px;line-height:1.6;">Dobrý den,</p>
    <p style="font-size:15px;line-height:1.6;"><b>${esc(who)}</b> chce trénovat v <b>${esc(gymName)}</b> přes aplikaci Martial Training Lab. Jako zákonný zástupce prosím potvrď souhlas s podmínkami gymu — stačí jeden klik, účet není potřeba.</p>
    <p style="text-align:center;margin:26px 0;">
      <a href="${link}" style="display:inline-block;background:#E11;color:#fff;text-decoration:none;font-weight:800;font-size:16px;padding:14px 30px;border-radius:12px;">Zobrazit a schválit</a>
    </p>
    <p style="font-size:13px;line-height:1.6;color:#555;">Na odkazu uvidíš podmínky gymu a souhlas potvrdíš zaškrtnutím. Bez tvého souhlasu nezletilý trénovat nezačne.</p>
    <p style="font-size:12px;color:#aaa;line-height:1.6;margin-top:24px;">Pokud o tom nic nevíš nebo nesouhlasíš, e-mail klidně ignoruj — nic se nestane.</p>
  </div></body></html>`;
}
function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
