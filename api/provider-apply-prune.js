// /api/provider-apply-prune — daily cron. Deletes provider_applications that were never finished
// (status 'new' or 'onboarding') and are older than 30 days. Storage-limitation (GDPR).
// Vercel cron suggestion: "0 3 * * *". Claimed applications are kept (they became real accounts).

const _SUPA = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const _KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const url = _SUPA + '/rest/v1/provider_applications'
      + `?status=in.(new,onboarding)&created_at=lt.${encodeURIComponent(cutoff)}`;
    const r = await fetch(url, {
      method: 'DELETE',
      headers: { apikey: _KEY, Authorization: 'Bearer ' + _KEY, Prefer: 'return=representation' }
    });
    const deleted = r.ok ? (await r.json()) : [];
    return res.status(200).json({ ok: r.ok, deleted: Array.isArray(deleted) ? deleted.length : 0 });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
}
