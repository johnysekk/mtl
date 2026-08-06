// THE single source of truth for MTL's per-transaction rate. Every charge path (pay, cohort-pay,
// record-cash, ...) resolves the rate through here so a coach/club is billed the SAME way for a
// lesson, membership, event or course. Two layers:
//   - ladderRate(): the EP/FP/Shikai/Bankai ladder (what the owner pays ongoing).
//   - acquisitionRate(): the finder's fee MTL takes when the APP demonstrably brought the member
//     (first paid lesson / first 2 membership months). EP pays HALF (5% vs 10%).
//   - effectiveRate(): the actual per-tx rate = max(ladder, acquisition).
// No silent 3% fallback: resolvers throw if the owner can't be found, so an overcharge surfaces.

const ACQ_RATE = 0.10;     // finder's fee, standard providers
const ACQ_RATE_EP = 0.05;  // EP perk: half the acquisition fee

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

// Resolve the profile of whoever owns the money (ownerId, or via gymId / gym stripe_account).
export async function resolveOwner(sbGet, { ownerId, gymId, gymAccount }) {
  let oid = ownerId;
  if (!oid && gymId) {
    const g = (await sbGet(`gyms?id=eq.${encodeURIComponent(gymId)}&select=owner_id`))[0];
    oid = g && g.owner_id;
  }
  if (!oid && gymAccount) {
    const g = (await sbGet(`gyms?stripe_account=eq.${encodeURIComponent(gymAccount)}&select=owner_id&limit=1`))[0];
    oid = g && g.owner_id;
  }
  if (!oid) throw new Error('resolveOwner: no owner (ownerId/gymId/gymAccount all unresolved)');
  const p = (await sbGet(`profiles?id=eq.${encodeURIComponent(oid)}&select=id,partner,founding,coach_ref_score,bankai_eligible`))[0];
  if (!p) throw new Error('resolveOwner: owner profile not found');
  return p;
}

// The owner's ongoing ladder rate (no acquisition). Cohorts (courses) use this directly.
export async function resolveRate(sbGet, { ownerId, gymId, gymAccount, mode }) {
  const p = await resolveOwner(sbGet, { ownerId, gymId, gymAccount });
  return ladderRate(mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible });
}

// Acquisition finder's fee, or null if it doesn't apply. Only when acqSource === 'mtl_discovery'
// AND the member is still inside the window: membership = first 2 months, drop_in/coach_1to1 =
// first paid one. Window is bounded by counting prior COMPLETED tx of this type for this member at
// this provider (Stripe + cash together). ownerPartner => EP pays half.
export async function acquisitionRate(sbGet, { acqSource, type, ownerPartner, memberId, scopeCol, scopeId }) {
  if (acqSource !== 'mtl_discovery' || !memberId) return null;
  let max;
  if (type === 'membership') max = 2;
  else if (type === 'drop_in' || type === 'coach_1to1') max = 1;
  else return null;                                     // custom / event / course: no acquisition fee
  if (!scopeCol || !scopeId) return null;
  try {
    if (type === 'membership' && scopeCol === 'gym_id') {
      let used = 0;
      try {
        const tx = await sbGet(`transactions?select=acq_months&member_id=eq.${encodeURIComponent(memberId)}&type=eq.membership&gym_id=eq.${encodeURIComponent(scopeId)}&status=eq.completed&acq_months=gt.0`);
        used = (tx || []).reduce((n, r) => n + (parseInt(r && r.acq_months, 10) || 0), 0);
      } catch (e) {}
      if (!used) {
        const prior = await sbGet(`gym_memberships?select=months&student_id=eq.${encodeURIComponent(memberId)}&gym_id=eq.${encodeURIComponent(scopeId)}&status=in.(active,cancelling,ended,expired)`);
        used = (prior || []).reduce((n, r) => n + Math.max(1, parseInt(r && r.months, 10) || 1), 0);
      }
      const leftQualifying = max - used;
      if (leftQualifying > 0) return { rate: (ownerPartner ? ACQ_RATE_EP : ACQ_RATE), months: leftQualifying };
      return null;
    }
    const prior = await sbGet(`transactions?select=id&member_id=eq.${encodeURIComponent(memberId)}&type=eq.${encodeURIComponent(type)}&${scopeCol}=eq.${encodeURIComponent(scopeId)}&status=eq.completed`);
    if (!prior || prior.length < max) return ownerPartner ? ACQ_RATE_EP : ACQ_RATE;
  } catch (e) {}
  return null;
}

// The actual per-transaction rate = the higher of the owner's ladder rate and any acquisition fee.
export async function effectiveRate(sbGet, { ownerId, gymId, gymAccount, mode, type, acqSource, memberId, scopeCol, scopeId, months }) {
  const p = await resolveOwner(sbGet, { ownerId, gymId, gymAccount });
  const ladder = ladderRate(mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible });
  const acq = await acquisitionRate(sbGet, { acqSource, type, ownerPartner: p.partner, memberId, scopeCol, scopeId: (scopeId || p.id) });
  if (acq == null) return ladder;

  // Older shape: a bare number, no month information -> behave as before.
  if (typeof acq === 'number') return Math.max(ladder, acq);

  const bought = Math.max(1, parseInt(months, 10) || 1);
  const covered = Math.max(0, Math.min(bought, acq.months));
  if (covered <= 0) return ladder;
  if (covered >= bought) return Math.max(ladder, acq.rate);

  // A single payment covering more months than qualify: blend, so the acquisition fee lands on
  // the months it is owed for and the rest is charged at the ordinary rate. Buying a year up
  // front then costs the club the same as twelve monthly payments would have.
  const hi = Math.max(ladder, acq.rate);
  return (hi * covered + ladder * (bought - covered)) / bought;
}

// Same computation, but returns the parts as well, so the ledger can record WHY the rate is what
// it is instead of leaving a club to reverse-engineer a blended number.
export async function effectiveRateBreakdown(sbGet, args) {
  const p = await resolveOwner(sbGet, { ownerId: args.ownerId, gymId: args.gymId, gymAccount: args.gymAccount });
  const ladder = ladderRate(args.mode, { partner: p.partner, founding: p.founding, score: p.coach_ref_score, bankai: p.bankai_eligible });
  const acq = await acquisitionRate(sbGet, { acqSource: args.acqSource, type: args.type, ownerPartner: p.partner, memberId: args.memberId, scopeCol: args.scopeCol, scopeId: (args.scopeId || p.id) });
  const bought = Math.max(1, parseInt(args.months, 10) || 1);
  if (acq == null) return { rate: ladder, baseRate: ladder, acqMonths: 0, months: bought };
  if (typeof acq === 'number') return { rate: Math.max(ladder, acq), baseRate: ladder, acqMonths: bought, months: bought };
  const covered = Math.max(0, Math.min(bought, acq.months));
  if (covered <= 0) return { rate: ladder, baseRate: ladder, acqMonths: 0, months: bought };
  const hi = Math.max(ladder, acq.rate);
  const rate = (covered >= bought) ? hi : ((hi * covered + ladder * (bought - covered)) / bought);
  return { rate, baseRate: ladder, acqMonths: covered, months: bought };
}
