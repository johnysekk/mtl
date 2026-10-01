// PŘIJETÍ ZA ČLENA PO ZAPLACENÍ -- JEDNO MÍSTO PRO VŠECHNY ZPŮSOBY PLATBY.
//
// Spolek s přepínačem „přijímat automaticky každého, kdo zaplatí" (gyms.member_app_auto):
// zaplacením se rozhodnutí klubu stává účinným a přihláška se schválí. Dřív to uměl jen
// stripe-webhook, takže platba přes Finbricks, QR převodem nebo v hotovosti přihlášku
// neschválila -- a na startu půjde skoro všechno přes banku.
//
// Schvaluje se JEN přihláška toho, kdo platil (podle účtu, jinak e-mailu z přihlášky),
// a jen čekající. Opakované volání nic nezmění.
//
// who: { gymId, cohortId?, studentId?, email? }
const SB = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function _sb(path, init = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}) },
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}
const q = encodeURIComponent;

export async function approveMemberAppOnPayment(who) {
  try {
    if (!SB || !KEY || !who || !who.gymId) return 0;
    const g = ((await _sb(`gyms?id=eq.${q(who.gymId)}&select=org_form,member_app_auto,member_app_auto_ref`)) || [])[0];
    if (!g || g.org_form !== 'nonprofit' || !g.member_app_auto) return 0;
    const email = String(who.email || '').trim();
    // Účet NEBO e-mail: přihláška mohla vzniknout bez účtu a účet přibyl až pak (nebo naopak).
    const emailOk = email && !/["(),]/.test(email);
    const whoF = (who.studentId && emailOk)
      ? `&or=${q(`(student_id.eq.${who.studentId},applicant_email.ilike."${email}")`)}`
      : who.studentId ? `&student_id=eq.${q(who.studentId)}`
      : (emailOk ? `&applicant_email=ilike.${q(email)}` : null);
    if (!whoF) return 0;
    const coh = who.cohortId ? `&cohort_id=eq.${q(who.cohortId)}` : '';
    const rows = await _sb(`gym_member_applications?gym_id=eq.${q(who.gymId)}&status=eq.pending${whoF}${coh}`, {
      method: 'PATCH', prefer: 'return=representation',
      body: JSON.stringify({ status: 'approved', decided_at: new Date().toISOString(),
        decided_note: g.member_app_auto_ref || 'Přijato zaplacením (klub přijímá každého, kdo zaplatí)' }),
    });
    return (rows || []).length;
  } catch (e) {
    console.error('[member-app] approve on payment', e && e.message);
    return 0;
  }
}

// Kdo platil zálohu/splátku kurzu -- z řádku účastníka kurzu.
export async function cohortPayer(cohortMemberId) {
  try {
    const m = ((await _sb(`cohort_members?id=eq.${q(cohortMemberId)}&select=student_id,email,cohort_id,gym_id`)) || [])[0];
    if (!m) return null;
    let gymId = m.gym_id || null;
    if (!gymId && m.cohort_id) {
      const c = ((await _sb(`gym_cohorts?id=eq.${q(m.cohort_id)}&select=gym_id`)) || [])[0];
      gymId = (c && c.gym_id) || null;
    }
    return { gymId, cohortId: m.cohort_id || null, studentId: m.student_id || null, email: m.email || null };
  } catch (e) { return null; }
}
