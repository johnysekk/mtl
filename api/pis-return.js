// /api/pis-return.js — DIAGNOSTIC verze (žádné importy, žádný klíč, žádná Supabase).
// Cíl: potvrdit, že route + deploy fungují a ukázat, co banka poslala.
// Když tohle projde (uvidíš text místo 500), víme, že crash dělal import/klíč — a doplníme logiku zpět.
export default function handler(req, res) {
  const q = req.query || {};
  res.status(200).send(
    'PIS return OK ✅\n\n' +
    'payment_id: ' + (q.payment_id || q.paymentId || '(none)') + '\n' +
    'state (bookingId): ' + (q.state || '(none)') + '\n\n' +
    'Všechny query parametry:\n' + JSON.stringify(q, null, 2) + '\n\n' +
    'Env check (jen jestli EXISTUJÍ, ne hodnoty):\n' +
    '  ENABLE_APP_ID: ' + (process.env.ENABLE_APP_ID ? 'ANO' : 'CHYBÍ') + '\n' +
    '  ENABLE_PRIVATE_KEY: ' + (process.env.ENABLE_PRIVATE_KEY ? ('ANO, délka ' + process.env.ENABLE_PRIVATE_KEY.length + ', začíná BEGIN: ' + (process.env.ENABLE_PRIVATE_KEY.includes('BEGIN') ? 'ANO' : 'NE')) : 'CHYBÍ') + '\n' +
    '  SUPABASE_URL: ' + (process.env.SUPABASE_URL ? 'ANO' : 'CHYBÍ') + '\n' +
    '  SUPABASE_SERVICE_KEY: ' + (process.env.SUPABASE_SERVICE_KEY ? 'ANO' : 'CHYBÍ')
  );
}
