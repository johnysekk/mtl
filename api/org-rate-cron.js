// /api/org-rate-cron — denní srovnání sazby 1,5 % z členství v asociaci.
//
// PROČ VŮBEC EXISTUJE, KDYŽ JE org_rate_until DATUM:
// Sazba sama vyprší -- hasOrgRate() jen porovná datum s dneškem, takže na odebrání
// není cron potřeba. Potřeba je na tři jiné věci:
//
//   1) SOUČET VÍCE ČLENSTVÍ. Poskytovatel může mít dva kluby ve dvou asociacích.
//      Ukončení jednoho z nich sazbu nesmí sebrat, dokud platí druhé -- proto se
//      org_rate_until přepočítává jako NEJZAZŠÍ datum ze všech jeho členství.
//   2) PŘIPOMENUTÍ. Klub se má o blížícím se konci dozvědět dřív, než mu sazba spadne.
//   3) ÚKLID. Členství, kterému vypršela platnost, zůstávalo ve stavu 'active'.
//
// Běží denně; je idempotentní, takže dvojí spuštění nic nerozbije.

const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1\/?$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    ...(opts.body ? { body: opts.body } : {}),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.text()).slice(0, 180)}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

export default async function handler(req, res) {
  // Stejná ochrana jako u ostatních cronů: bez tajemství se to nespustí zvenčí.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || (req.query && req.query.k) || '';
    if (got !== secret) return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (!SB || !KEY) return res.status(500).json({ error: 'server not configured' });
    const today = new Date().toISOString().slice(0, 10);
    const out = { expired: 0, rates: 0, reminders: 0 };

    // 1) Členství po platnosti přepnout na 'ended'. Bez toho by v seznamu asociace svítilo
    //    jako aktivní něco, co dávno skončilo.
    const stale = await sb(`organization_clubs?status=eq.active&valid_until=lt.${today}&select=id,gym_id,organization_id`);
    for (const r of (stale || [])) {
      try {
        await sb(`organization_clubs?id=eq.${r.id}`, { method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ status: 'ended', ended_at: new Date().toISOString() }) });
        out.expired++;
      } catch (e) {}
    }

    // 2) Přepočet sazby. Bere se NEJZAZŠÍ datum ze všech platných členství poskytovatele --
    //    kdo má dva kluby ve dvou asociacích, o sazbu ukončením jednoho nepřijde.
    const live = await sb(`organization_clubs?status=eq.active&fee_paid_at=not.is.null&valid_until=gte.${today}&select=gym_id,valid_until`);
    const byGym = {};
    for (const r of (live || [])) {
      if (!r.gym_id || !r.valid_until) continue;
      if (!byGym[r.gym_id] || r.valid_until > byGym[r.gym_id]) byGym[r.gym_id] = r.valid_until;
    }
    const gymIds = Object.keys(byGym);
    const owners = {};
    if (gymIds.length) {
      const gs = await sb(`gyms?id=in.(${gymIds.join(',')})&select=id,owner_id`);
      for (const g of (gs || [])) {
        if (!g.owner_id) continue;
        const u = byGym[g.id];
        if (!owners[g.owner_id] || u > owners[g.owner_id]) owners[g.owner_id] = u;
      }
    }
    // Komu sazba náleží, srovnat na správné datum; komu už nenáleží, sebrat.
    const holders = await sb(`profiles?org_rate_until=not.is.null&select=id,org_rate_until`);
    for (const p of (holders || [])) {
      const want = owners[p.id] || null;
      if (want !== p.org_rate_until) {
        try { await sb(`profiles?id=eq.${p.id}`, { method: 'PATCH', prefer: 'return=minimal',
          body: JSON.stringify({ org_rate_until: want }) }); out.rates++; } catch (e) {}
      }
      delete owners[p.id];
    }
    for (const [oid, until] of Object.entries(owners)) {
      try { await sb(`profiles?id=eq.${oid}`, { method: 'PATCH', prefer: 'return=minimal',
        body: JSON.stringify({ org_rate_until: until }) }); out.rates++; } catch (e) {}
    }

    // 3) Připomenutí 14 dní předem. Jednou -- opakované by bylo otravné a klub o tom ví.
    const soon = new Date(); soon.setDate(soon.getDate() + 14);
    const soonStr = soon.toISOString().slice(0, 10);
    const ending = await sb(`organization_clubs?status=eq.active&valid_until=eq.${soonStr}&select=id,gym_id,organization_id,valid_until`);
    for (const r of (ending || [])) {
      if (!r.gym_id) continue;   // klub mimo MTL nemá kam dostat zprávu
      try {
        const g = (await sb(`gyms?id=eq.${r.gym_id}&select=owner_id`))[0];
        const o = (await sb(`organizations?id=eq.${r.organization_id}&select=name,abbr`))[0];
        if (!g || !g.owner_id) continue;
        const d = new Date(r.valid_until).toLocaleDateString('cs-CZ');
        await sb('notifications', { method: 'POST', prefer: 'return=minimal',
          body: JSON.stringify({ user_id: g.owner_id, type: 'system', read: false,
            data: JSON.stringify({ kind: 'org_expiring', oc_id: r.id }),
            message: `\u23F3 Členství v ${(o && (o.abbr || o.name)) || 'asociaci'} končí ${d}. Po tomto dni ztrácíš sazbu 1,5 %.` }) });
        out.reminders++;
      } catch (e) {}
    }

    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
