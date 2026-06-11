// /api/partner-revenue.js  —  Founder-only: exact NET revenue from Exclusive MTL Partner ($49/mo) subscriptions.
// Reads every partner_sub subscription's PAID invoices and sums the real settled amounts
// from Stripe balance transactions (gross / fee / net), grouped by settlement currency.
//
// ENV required (Vercel project settings):
//   STRIPE_SECRET_KEY            (platform secret key — the account that bills the $49/mo)
//   SUPABASE_SERVICE_ROLE_KEY    (service role; bypasses RLS to read profiles.partner_sub)
//   SUPABASE_URL                 (optional; defaults to the MTL project URL below)
//
// ESM module (this Vercel project uses "export default" handlers).

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supa = createClient(
  process.env.SUPABASE_URL || 'https://iqeovcvchtyfwtyzpqrh.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(200).json({ ok: false, error: 'server not configured' });
    }

    // 1) Gather all partner subscription IDs from Supabase.
    const { data: profs, error: dbErr } = await supa
      .from('profiles')
      .select('id, name, partner_sub')
      .not('partner_sub', 'is', null);
    if (dbErr) return res.status(200).json({ ok: false, error: dbErr.message });

    const subs = (profs || []).filter(p => p.partner_sub);

    // Optional ?month=YYYY-MM filter (by invoice creation date).
    const month = (req.query && req.query.month) || '';
    let createdFilter = null;
    if (/^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map(Number);
      const gte = Math.floor(Date.UTC(y, m - 1, 1) / 1000);
      const lte = Math.floor(Date.UTC(y, m, 1) / 1000) - 1;
      createdFilter = { gte, lte };
    }

    const byCurrency = {}; // CUR -> { gross, fee, net, count }
    const add = (cur, g, f, n) => {
      const c = (cur || 'usd').toUpperCase();
      if (!byCurrency[c]) byCurrency[c] = { gross: 0, fee: 0, net: 0, count: 0 };
      byCurrency[c].gross += g;
      byCurrency[c].fee += f;
      byCurrency[c].net += n;
      byCurrency[c].count += 1;
    };

    let payments = 0;

    // 2) For each subscription, walk its PAID invoices and read the real balance transaction.
    for (const p of subs) {
      let starting_after;
      for (let page = 0; page < 20; page++) {
        let inv;
        try {
          inv = await stripe.invoices.list({
            subscription: p.partner_sub,
            status: 'paid',
            limit: 100,
            ...(createdFilter ? { created: createdFilter } : {}),
            ...(starting_after ? { starting_after } : {}),
          });
        } catch (e) {
          break; // subscription not found / no access — skip this partner
        }
        for (const i of (inv.data || [])) {
          const chargeId = typeof i.charge === 'string' ? i.charge : (i.charge && i.charge.id);
          if (!chargeId) {
            // No charge object (e.g. $0 invoice) — count gross only.
            add(i.currency, (i.amount_paid || 0) / 100, 0, (i.amount_paid || 0) / 100);
            payments += 1;
            continue;
          }
          let bt = null;
          try {
            const ch = await stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
            bt = ch.balance_transaction;
          } catch (e) { /* ignore */ }

          if (bt && typeof bt === 'object') {
            // Settled amounts in the SETTLEMENT currency — the real money MTL received.
            add(bt.currency, (bt.amount || 0) / 100, (bt.fee || 0) / 100, (bt.net || 0) / 100);
          } else {
            // Fallback: charge currency gross, no exact fee available.
            add(i.currency, (i.amount_paid || 0) / 100, 0, (i.amount_paid || 0) / 100);
          }
          payments += 1;
        }
        if (!inv.has_more) break;
        starting_after = inv.data[inv.data.length - 1].id;
      }
    }

    // round to 2 decimals
    Object.keys(byCurrency).forEach(c => {
      byCurrency[c].gross = Math.round(byCurrency[c].gross * 100) / 100;
      byCurrency[c].fee = Math.round(byCurrency[c].fee * 100) / 100;
      byCurrency[c].net = Math.round(byCurrency[c].net * 100) / 100;
    });

    return res.status(200).json({
      ok: true,
      month: month || 'all',
      partners: subs.length,
      payments,
      byCurrency,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || 'error' });
  }
}
