// /api/mfa-device — „NA TOMTO ZAŘÍZENÍ UŽ NEPOŽADOVAT" u dvoufázového ověření (2FA).
//
// Kód z ověřovací aplikace se počítá z tajného klíče. Když si člověk zařízení označí jako
// důvěryhodné, dostane to zařízení náhodný token (uložený v prohlížeči). Při dalším přihlášení
// na něm appka pošle token sem, server ověří, že patří tomuhle účtu a neprošel, spočítá z klíče
// aktuální kód a appka s ním přihlášení dokončí (aal2) -- člověk nic nezadává. Jinde se kód
// chce dál. Klíč se ukládá jen zašifrovaný (AES-256-GCM); token jen jako otisk (SHA-256).
//
// POST, hlavička x-access-token (přihlášení), tělo { action, ... }:
//   secret  { factor_id, secret }  -- po zapnutí 2FA (přihlášení s kódem) uloží klíč
//   trust                         -- po zadání kódu s „už nepožadovat": vrátí { token }
//   code    { device_token }       -- přihlášení na důvěryhodném zařízení: vrátí { code, factor_id }
//   devices { device_token? }     -- seznam důvěryhodných zařízení [{ id, name, created_at,
//                                    last_used_at, current }] (current = to, ze kterého se ptá)
//   revoke_one { id }             -- zruší jedno zařízení
//   revoke                        -- zruší všechna důvěryhodná zařízení
//   forget                        -- po vypnutí 2FA smaže klíč i zařízení
// Tabulky: public.mtl_mfa_secrets, public.mtl_mfa_devices (sql/mfa.sql), jen pro server.
import crypto from 'crypto';

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const SKEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const svc = { apikey: SKEY, Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/json' };
const DEVICE_DAYS = 180;

const KEY = crypto.createHash('sha256').update(String(process.env.MFA_DEVICE_KEY || SKEY || '')).digest();
function enc(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}
function dec(s) {
  const [iv, tag, ct] = String(s || '').split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
function b32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of String(s || '').replace(/[=\s]/g, '').toUpperCase()) { const v = A.indexOf(ch); if (v >= 0) bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
// TOTP podle RFC 6238: SHA-1, 6 číslic, 30 s (to používá Supabase i Google Authenticator).
export function totp(secret, t = Date.now()) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)));
  const h = crypto.createHmac('sha1', b32(secret)).update(b).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const q = encodeURIComponent;
async function sbGet(path) { const r = await fetch(`${SB}/rest/v1/${path}`, { headers: svc }); return r.ok ? r.json() : []; }
async function sbSend(method, path, body, prefer) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { method, headers: { ...svc, Prefer: prefer || 'return=minimal' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`db ${r.status} ${await r.text()}`);
}
// Čitelný název zařízení z prohlížeče: „iPhone · Safari", „Mac · Chrome", „Windows · Edge".
// Přesný model (iPhone 15) ani verzi macOS prohlížeč neprozradí -- Apple je záměrně skrývá.
function deviceName(ua) {
  ua = String(ua || '');
  let os = 'Zařízení';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) { const m = ua.match(/Android[^;)]*;\s*([^;)]+?)\s*(?:Build|\))/); os = (m && m[1] && m[1] !== 'K') ? ('Android · ' + m[1]) : 'Android'; }
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'Chromebook';
  else if (/Linux/.test(ua)) os = 'Linux';
  const br = /EdgA?\/|EdgiOS/.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}
function aalOf(token) {
  try { const p = String(token).split('.')[1] || ''; return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).aal || 'aal1'; }
  catch (e) { return 'aal1'; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-access-token');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST' });
  if (!SB || !SKEY) return res.status(500).json({ error: 'server not configured' });
  try {
    const token = req.headers['x-access-token'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'no token' });
    const ur = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SKEY, Authorization: `Bearer ${token}` } });
    if (!ur.ok) return res.status(401).json({ error: 'bad token' });
    const u = await ur.json();
    const uid = u && u.id;
    if (!uid) return res.status(401).json({ error: 'no user' });
    const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {};
    const action = String(b.action || '');
    const verified = (Array.isArray(u.factors) ? u.factors : []).filter((f) => f && f.status === 'verified' && f.factor_type === 'totp');
    const aal2 = aalOf(token) === 'aal2';

    if (action === 'secret') {
      if (!aal2) return res.status(403).json({ error: 'mfa_required' });
      const fid = String(b.factor_id || ''), secret = String(b.secret || '').replace(/\s/g, '');
      if (!verified.some((f) => f.id === fid) || !/^[A-Z2-7=]{16,128}$/i.test(secret)) return res.status(400).json({ error: 'bad_factor' });
      await sbSend('POST', 'mtl_mfa_secrets?on_conflict=user_id', { user_id: uid, factor_id: fid, secret_enc: enc(secret), created_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
      await sbSend('DELETE', `mtl_mfa_devices?user_id=eq.${q(uid)}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'trust') {
      if (!aal2) return res.status(403).json({ error: 'mfa_required' });
      const s = (await sbGet(`mtl_mfa_secrets?user_id=eq.${q(uid)}&select=factor_id`))[0];
      if (!s || !verified.some((f) => f.id === s.factor_id)) return res.status(409).json({ error: 'no_secret' });
      const dt = crypto.randomBytes(32).toString('base64url');
      const label = String(req.headers['user-agent'] || '').slice(0, 160);
      await sbSend('POST', 'mtl_mfa_devices', { user_id: uid, token_hash: sha(dt), label, expires_at: new Date(Date.now() + DEVICE_DAYS * 86400000).toISOString() });
      return res.status(200).json({ ok: true, token: dt });
    }
    if (action === 'code') {
      const dt = String(b.device_token || '');
      if (dt.length < 20) return res.status(400).json({ error: 'bad_device' });
      const d = (await sbGet(`mtl_mfa_devices?user_id=eq.${q(uid)}&token_hash=eq.${q(sha(dt))}&select=id,expires_at`))[0];
      if (!d || Date.parse(d.expires_at) < Date.now()) return res.status(404).json({ error: 'device_unknown' });
      const s = (await sbGet(`mtl_mfa_secrets?user_id=eq.${q(uid)}&select=factor_id,secret_enc`))[0];
      if (!s || !verified.some((f) => f.id === s.factor_id)) return res.status(404).json({ error: 'device_unknown' });
      const code = totp(dec(s.secret_enc));
      try { await sbSend('PATCH', `mtl_mfa_devices?id=eq.${q(d.id)}`, { last_used_at: new Date().toISOString() }); } catch (e) {}
      return res.status(200).json({ ok: true, code, factor_id: s.factor_id });
    }
    if (action === 'devices') {
      if (!aal2) return res.status(403).json({ error: 'mfa_required' });
      const rows = await sbGet(`mtl_mfa_devices?user_id=eq.${q(uid)}&expires_at=gt.${q(new Date().toISOString())}&select=id,label,token_hash,created_at,last_used_at&order=created_at.desc`);
      const mine = b.device_token ? sha(String(b.device_token)) : null;
      const list = (rows || []).map((r) => ({ id: r.id, name: deviceName(r.label), created_at: r.created_at, last_used_at: r.last_used_at, current: !!(mine && r.token_hash === mine) }));
      return res.status(200).json({ ok: true, count: list.length, devices: list });
    }
    if (action === 'revoke_one') {
      if (!aal2) return res.status(403).json({ error: 'mfa_required' });
      const id = String(b.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'bad_id' });
      await sbSend('DELETE', `mtl_mfa_devices?user_id=eq.${q(uid)}&id=eq.${q(id)}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'revoke') {
      if (!aal2) return res.status(403).json({ error: 'mfa_required' });
      await sbSend('DELETE', `mtl_mfa_devices?user_id=eq.${q(uid)}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'forget') {
      if (verified.length) return res.status(409).json({ error: 'mfa_still_on' });
      await sbSend('DELETE', `mtl_mfa_devices?user_id=eq.${q(uid)}`);
      await sbSend('DELETE', `mtl_mfa_secrets?user_id=eq.${q(uid)}`);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'bad_action' });
  } catch (e) {
    console.error('[mfa-device]', e && e.message);
    return res.status(500).json({ error: 'server_error' });
  }
}
