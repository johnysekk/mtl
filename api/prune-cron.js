// /api/prune-cron — noční úklid krátkodobých dat.
//
// PROČ: několik tabulek jen roste. Sloty se tvoří hromadně na týdny dopředu a maže je
// jen kouč ručně po jednom; jednorázové tokeny zůstávají navždy i po vypršení;
// notifikace nikdo nemaže vůbec. Samotná velikost Postgresu nevadí, ale bez indexu
// a bez úklidu se dotazy s časem zpomalují a záloha zbytečně roste.
//
// CO SE NEMAŽE NIKDY, i když by "šlo":
//   consents, guardian_consents, waiver_acceptances  — právní záznamy souhlasu
//   transactions, doklady, commission_doklady        — účetnictví
//   fight_results, gym_attendance                    — historie, na kterou se lidi odvolávají
//   slots se stavem booked                           — patří k odjeté lekci a k dokladu
// Když si nejsem jistý, radši nechávám. Smazaná data se nevrátí.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=minimal', ...(opts.count ? { Prefer: 'count=exact' } : {}),
    },
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 160)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// Smaže a vrátí, kolik řádků odešlo. Chybu spolkne a jde dál -- jeden problémový
// krok nesmí zastavit celý úklid.
async function del(label, path) {
  try {
    const r = await fetch(`${SB}/rest/v1/${path}`, {
      method: 'DELETE',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'return=representation' },
    });
    if (!r.ok) return { label, error: `${r.status}` };
    const rows = await r.json().catch(() => []);
    return { label, deleted: Array.isArray(rows) ? rows.length : 0 };
  } catch (e) { return { label, error: (e && e.message) || 'error' }; }
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (req.query && req.query.k) || '';
    if (got !== secret && !req.headers['x-vercel-cron']) return res.status(401).json({ error: 'unauthorized' });
  }
  if (!SB || !KEY) return res.status(500).json({ error: 'server not configured' });

  const now = new Date();
  const iso = (d) => d.toISOString();
  const daysAgo = (n) => iso(new Date(now.getTime() - n * 86400000));
  const out = [];

  // ── SLOTY ────────────────────────────────────────────────────────────────────────────
  // Volný termín v minulosti si už nikdo nerezervuje. Rezervované NECHÁVÁME -- patří
  // k odjeté lekci a k dokladu, a kouč se na ně odvolává při sporu.
  out.push(await del('slots (volné, starší 30 dnů)',
    `slots?booked=is.false&date=lt.${daysAgo(30).slice(0, 10)}`));

  // ── JEDNORÁZOVÉ TOKENY ───────────────────────────────────────────────────────────────
  // Po vypršení jsou k ničemu: naskenovat je nejde a nic se z nich nedohledává.
  // Necháme týden po expiraci, ať se dá řešit "nešlo mi to naskenovat".
  out.push(await del('checkin_tokens (týden po expiraci)',
    `checkin_tokens?expires_at=lt.${daysAgo(7)}`));
  out.push(await del('coach_checkin_tokens (týden po expiraci)',
    `coach_checkin_tokens?expires_at=lt.${daysAgo(7)}`));

  // Přenos dítěte mezi zástupci má okno na vrácení. Po něm je záznam mrtvý.
  out.push(await del('kid_transfers (30 dnů po okně na vrácení)',
    `kid_transfers?undo_until=lt.${daysAgo(30)}&status=neq.pending`));

  // ── DRŽENÁ MÍSTA ─────────────────────────────────────────────────────────────────────
  // Držení místa v lekci, která už proběhla, nikoho neblokuje ani neinformuje.
  out.push(await del('gym_class_reservations (po lekci, 14 dnů)',
    `gym_class_reservations?class_date=lt.${daysAgo(14).slice(0, 10)}`));

  // Záskok na lekci, která dávno byla.
  // cover_requests ma class_date, zadne created_at -- s created_at by PostgREST dotaz odmitl.
  out.push(await del('cover_requests (uzavřené, po lekci 60 dnů)',
    `cover_requests?status=neq.open&class_date=lt.${daysAgo(60).slice(0, 10)}`));

  // ── NOTIFIKACE ───────────────────────────────────────────────────────────────────────
  // Přečtené notifikace starší půl roku nikdo nehledá a je jich nejvíc ze všeho.
  // NEPŘEČTENÉ necháváme bez ohledu na věk -- to je nedodělaná práce, ne odpad.
  out.push(await del('notifications (přečtené, starší 180 dnů)',
    `notifications?read=is.true&created_at=lt.${daysAgo(180)}`));

  const total = out.reduce((a, x) => a + (x.deleted || 0), 0);
  return res.status(200).json({ ok: true, total, steps: out });
}
