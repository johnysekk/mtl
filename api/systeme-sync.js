// /api/systeme-sync.js  — Vercel serverless funkce
// Vytvoří/aktualizuje kontakt v Systeme.io a přiřadí štítky (tagy).
// KLÍČ NIKDY není ve frontendu — čte se z env proměnné SYSTEME_API_KEY (Vercel → Settings → Environment Variables).
//
// Volá se z appky (best-effort) takto:
//   fetch('/api/systeme-sync', { method:'POST', headers:{'Content-Type':'application/json'},
//     body: JSON.stringify({ email, name, tags:['student'] }) });
//
// Pozn.: přesné cesty/payloady ověř v https://developer.systeme.io/reference/api
// (Systeme.io používá header X-API-Key a base URL https://api.systeme.io/api).

const BASE = 'https://api.systeme.io/api';

async function sio(path, method, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.SYSTEME_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  // 409 = kontakt už existuje — to nám nevadí
  if (!r.ok && r.status !== 409) {
    const t = await r.text().catch(() => '');
    throw new Error(`Systeme ${method} ${path} → ${r.status} ${t}`);
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}

// najde tag podle jména, případně vytvoří
async function ensureTagId(name) {
  const list = await sio(`/tags?limit=100`, 'GET');
  const items = (list && (list.items || list.data || list)) || [];
  const found = Array.isArray(items) && items.find(t => (t.name || '').toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  const created = await sio('/tags', 'POST', { name });
  return created && created.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.SYSTEME_API_KEY) return res.status(200).json({ skipped: 'no key' });
  try {
    const { email, name, tags = [] } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });

    // 1) vytvoř/získej kontakt (fields = vlastní pole; first_name je standardní)
    let contact = await sio('/contacts', 'POST', {
      email,
      fields: name ? [{ slug: 'first_name', value: name }] : [],
    });

    // pokud kontakt existoval (409), dohledej ID
    let contactId = contact && contact.id;
    if (!contactId) {
      const found = await sio(`/contacts?email=${encodeURIComponent(email)}`, 'GET');
      const items = (found && (found.items || found.data || found)) || [];
      contactId = Array.isArray(items) && items[0] && items[0].id;
    }
    if (!contactId) throw new Error('no contact id');

    // 2) přiřaď štítky
    for (const t of tags) {
      const tagId = await ensureTagId(t);
      if (tagId) await sio(`/contacts/${contactId}/tags`, 'POST', { tagId });
    }

    res.status(200).json({ ok: true, contactId });
  } catch (err) {
    console.error('systeme-sync error:', err.message);
    // nikdy neblokuj uživatele kvůli e-mail marketingu — vrať 200
    res.status(200).json({ ok: false, error: err.message });
  }
}
