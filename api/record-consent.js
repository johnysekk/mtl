// /api/record-consent  — records a clickwrap consent acceptance (legally-retrievable).
// Model: the exact wording is stored ONCE per immutable (kind, version, lang) in
// consent_versions; every acceptance is a small row in consent_acceptances that
// references that version by id + stores the hash of the exact text the user saw,
// the timestamp, the user_id, the request IP and the user-agent.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import crypto from 'crypto';

const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: opts.prefer || 'return=representation' },
    body: opts.body,
  });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : null; } catch (e) { j = t; }
  if (!r.ok) throw new Error(`SB ${r.status} ${path}: ${typeof j === 'string' ? j : JSON.stringify(j)}`);
  return j;
}

function sha256(s) { return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex'); }

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const { user_id, kind, version, lang, body_text, meta, scope } = body || {};
    if (!user_id || !kind || version == null || !body_text) {
      return res.status(400).json({ error: 'user_id, kind, version, body_text required' });
    }
    const _lang = lang || 'cs';
    const _scope = (scope == null || scope === '') ? null : String(scope);
    const body_hash = sha256(body_text);
    const scopeQ = _scope === null ? 'scope=is.null' : `scope=eq.${encodeURIComponent(_scope)}`;

    // 1) ensure an immutable version row exists (store the wording once)
    let versionId = null;
    let versionMismatch = null; // set if the wording for this version changed without a version bump
    try {
      const existing = await sb(`consent_versions?kind=eq.${encodeURIComponent(kind)}&${scopeQ}&version=eq.${encodeURIComponent(version)}&lang=eq.${encodeURIComponent(_lang)}&select=id,body_hash&limit=1`);
      if (existing && existing[0]) {
        versionId = existing[0].id;
        // GUARD: the wording under this (kind,scope,version,lang) is immutable. If the
        // submitted wording no longer matches the stored one, someone edited the legal
        // text WITHOUT bumping the version -> flag it so it can't slip through silently.
        if (existing[0].body_hash && existing[0].body_hash !== body_hash) {
          versionMismatch = { stored_hash: existing[0].body_hash, seen_hash: body_hash };
          console.error(`[record-consent] VERSION HASH MISMATCH kind=${kind} scope=${_scope} version=${version} lang=${_lang} — the wording changed but the version was not bumped. Bump the version.`);
        }
      } else {
        const ins = await sb('consent_versions', { method: 'POST', body: JSON.stringify({ kind, scope: _scope, version, lang: _lang, body_text, body_hash }) });
        versionId = ins && ins[0] && ins[0].id;
      }
    } catch (e) {
      // unique-race: re-read
      try { const again = await sb(`consent_versions?kind=eq.${encodeURIComponent(kind)}&${scopeQ}&version=eq.${encodeURIComponent(version)}&lang=eq.${encodeURIComponent(_lang)}&select=id&limit=1`); versionId = again && again[0] && again[0].id; } catch (e2) {}
    }

    // 2) record the acceptance (who / when / what-hash / from-where)
    const _meta = meta || {};
    if (versionMismatch) _meta.__version_hash_mismatch = versionMismatch;
    const row = {
      user_id, kind, scope: _scope, version, lang: _lang, version_id: versionId, body_hash,
      accepted_at: new Date().toISOString(),
      ip: clientIp(req),
      user_agent: req.headers['user-agent'] || null,
      meta: _meta,
    };
    const acc = await sb('consent_acceptances', { method: 'POST', body: JSON.stringify(row) });
    return res.status(200).json({ ok: true, id: (acc && acc[0] && acc[0].id) || null, version_id: versionId, warning: versionMismatch ? `VERSION HASH MISMATCH for ${kind} ${version}: the wording changed without bumping the version — bump it.` : undefined });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
