// /api/cron-purge-id.js  — Vercel Cron (schedule daily, e.g. "0 3 * * *")
// Data hygiene: an uploaded ID doklad (OP/ID photo) that nobody reviewed within
// PURGE_DAYS gets deleted from the private migration-id bucket, and id_doc_path is
// nulled so the request shows "doklad expired — ask the teen to re-upload".
// Verified requests are NOT touched (id_doc_path is already nulled on the verify/reject
// decision in-app). This only catches the "nobody got to it in time" tail.
import { createClient } from '@supabase/supabase-js';

const PURGE_DAYS = 14;

export default async function handler(req, res) {
  // optional: protect with a secret -> Vercel Cron sends Authorization: Bearer ${CRON_SECRET}
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const cutoff = new Date(Date.now() - PURGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let purged = 0, nulled = 0;
  try {
    // 1) find stale, still-unverified requests that still hold a scan
    const { data: stale, error: qErr } = await supa
      .from('migration_requests')
      .select('id, id_doc_path, id_doc_at, id_verified')
      .not('id_doc_path', 'is', null)
      .lt('id_doc_at', cutoff);
    if (qErr) throw qErr;

    for (const r of (stale || [])) {
      if (r.id_verified) continue; // verified ones are handled in-app already
      // delete the object from the private bucket
      try {
        const { error: dErr } = await supa.storage.from('migration-id').remove([r.id_doc_path]);
        if (!dErr) purged++;
      } catch (e) { /* ignore individual file errors */ }
      // null the path so the UI knows to ask for a re-upload
      const { error: uErr } = await supa
        .from('migration_requests')
        .update({ id_doc_path: null, id_doc_expired: true })
        .eq('id', r.id);
      if (!uErr) nulled++;
    }

    // 2) safety sweep: orphan objects in the bucket older than cutoff with no matching open request
    try {
      const { data: files } = await supa.storage.from('migration-id').list('', { limit: 1000 });
      for (const f of (files || [])) {
        const created = f.created_at || (f.metadata && f.metadata.lastModified) || null;
        if (created && created < cutoff) {
          // if no request still references it, remove it
          const reqId = (f.name || '').split('.')[0];
          const { data: still } = await supa
            .from('migration_requests')
            .select('id')
            .eq('id', reqId)
            .not('id_doc_path', 'is', null)
            .maybeSingle();
          if (!still) { try { await supa.storage.from('migration-id').remove([f.name]); purged++; } catch (e) {} }
        }
      }
    } catch (e) { /* list may not be supported on all plans; primary path above is enough */ }

    return res.status(200).json({ ok: true, purged, nulled, cutoff });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}
