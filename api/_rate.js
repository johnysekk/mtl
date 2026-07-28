// The ONE source of truth for MTL's commission rate. Mirrors the client _ladderRate exactly.
// Every charge path (cohort-pay, pay, ...) must resolve the rate through here so a coach/club
// is charged the SAME rate for a lesson, membership, event or course. No silent 3% fallback:
// resolveRate throws if it cannot resolve the owner, so an overcharge surfaces as an error
// instead of quietly billing the base rate.

// mode: 'stripe' (Stripe track) | anything else (QR/bank/cash/pis track)
// o: { partner, founding, score, bankai }
export function ladderRate(mode, o) {
  o = o || {};
  if (o.partner) return 0.005;                         // Exclusive Partner (flat 1000/mo + 0.5%)
  const s = o.score || 0;
  if (o.founding) {                                    // Founding Partner
    if (mode === 'stripe') return (s >= 5 && o.bankai) ? 0.01 : (s >= 2 ? 0.015 : 0.02);
    return (s >= 2) ? 0.015 : 0.02;                    // QR/PIS: no Bankai
  }
  if (mode === 'stripe') return (s >= 5 && o.bankai) ? 0.02 : (s >= 2 ? 0.025 : 0.03);
  return (s >= 2) ? 0.03 : 0.035;
}

// Resolve the effective rate for whoever owns the money.
//   sbGet: a function (path) => Promise<rows[]> against the REST API (service role)
//   { ownerId, gymId, mode }: pass ownerId when you have it; gymId is a fallback (owner_id may be
//   null on a row); mode selects the Stripe vs bank ladder.
export async function resolveRate(sbGet, { ownerId, gymId, gymAccount, mode }) {
  let oid = ownerId;
  if (!oid && gymId) {
    const g = (await sbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id`))[0];
    oid = g && g.owner_id;
  }
  if (!oid && gymAccount) {
    const g = (await sbGet(`gyms?stripe_account=eq.${encodeURIComponent(gymAccount)}&select=owner_id&limit=1`))[0];
    oid = g && g.owner_id;
  }
  if (!oid) throw new Error('resolveRate: no owner (ownerId/gymId both unresolved)');
  const p = (await sbGet(`profiles?id=eq.${encodeURIComponent(oid)}&select=partner,founding,coach_ref_score,bankai_eligible`))[0];
  if (!p) throw new Error('resolveRate: owner profile not found');
  return ladderRate(mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible });
}
