// MTL — /api/profile-badges
// Public, read-only "achievements" payload for a shared profile link.
// The share token IS the user's referral_code (so the share link == the referral link).
// Returns ONLY safe, non-sensitive fields (name, photo, belts, levels, achieved milestones,
// a few headline counts). No email, no payments, no dates, no member identities.
//
// ENV required (Vercel project settings):
//   SUPABASE_URL                  = https://iqeovcvchtyfwtyzpqrh.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     = <service role key>   (server-only, never shipped to client)
//
// GET /api/profile-badges?token=MTL3X9KQ2

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || process.env.SUPABASE_PROJECT_URL || 'https://iqeovcvchtyfwtyzpqrh.supabase.co';
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SECRET || process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

// ---- level math (mirror of index.html: K=2.7, cap 80) ----
function xpForLevel(L){ if(L<=1) return 0; if(L>80) L=80; return Math.floor(3*Math.pow(L-1,1.5)); }
function levelOf(xp){ xp=Math.max(0,Math.round(xp||0)); let lvl=1; for(let L=80;L>=1;L--){ if(xp>=xpForLevel(L)){ lvl=L; break; } } return lvl; }

// tiny REST helper against Supabase (service role bypasses RLS — safe, server-only)
async function sb(path){
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  if(!r.ok) return [];
  try { return await r.json(); } catch(e){ return []; }
}
async function sbCount(path){
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
    method: 'HEAD',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, Prefer: 'count=exact' }
  });
  const cr = r.headers.get('content-range') || '';
  const n = parseInt((cr.split('/')[1]||'0'), 10);
  return isNaN(n) ? 0 : n;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  try{
    if(!SUPABASE_URL || !SERVICE_KEY){ res.status(500).json({ error: 'server not configured', hint: 'Set a Supabase SERVICE ROLE key env var (tried SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY / SUPABASE_SECRET / SERVICE_ROLE_KEY / SUPABASE_KEY)' }); return; }
    const token = String((req.query && req.query.token) || '').trim();
    if(!token || !/^[A-Za-z0-9]{4,40}$/.test(token)){ res.status(400).json({ error: 'bad token' }); return; }

    // 1) resolve profile by referral_code
    const prof = await sb('profiles?referral_code=eq.' + encodeURIComponent(token) +
      '&select=id,name,photo_url,belts,coach_status,cert_level&limit=1');
    if(!prof || !prof.length){ res.status(404).json({ error: 'not found' }); return; }
    const me = prof[0];
    const id = me.id;
    const isCoach = me.coach_status === 'approved';

    // 2) STUDENT — physical 1:1 confirmed + gym attendances
    const sBk = await sb('bookings?student_id=eq.' + id +
      '&status=eq.active&type=neq.online&student_confirmed=eq.true&coach_confirmed=eq.true&select=id,discipline');
    const s1 = sBk.length;
    const sGa = await sb('gym_attendance?student_id=eq.' + id + '&select=id');
    const sg = sGa.length;
    let refN = 0; try { const rf = await sb('profiles?referred_by=eq.' + id + '&referral_rewarded=eq.true&select=id'); refN = (rf||[]).length; } catch(e){}
    const studentXp = s1*10 + sg*2 + refN*5;

    // distinct sports + coaches (for milestones)
    const sportSet = new Set(); sBk.forEach(b => { if(b.discipline) sportSet.add(b.discipline); });

    const NOW = encodeURIComponent(new Date().toISOString());
    // 3) COACH — physical 1:1 taught + group classes taught + events hosted*40
    let coachXp = 0, c1 = 0, cev = 0;
    if(isCoach){
      const cBk = await sb('bookings?coach_id=eq.' + id +
        '&status=eq.active&type=neq.online&student_confirmed=eq.true&coach_confirmed=eq.true&select=id');
      c1 = cBk.length;
      cev = await sbCount('events?created_by=eq.' + id + '&status=eq.approved&starts_at=lt.' + NOW + '&select=id');
      const cga = await sb('gym_attendance?coach_id=eq.' + id + '&select=class_date,class_time,gym_id');
      const cset = new Set((cga||[]).map(a => (a.gym_id||'')+'|'+(a.class_date||'')+'|'+(a.class_time||''))); cset.delete('||');
      coachXp = c1*2 + cset.size + cev * 40;
    }

    // 4) GYM (owned) — distinct classes held + events hosted*40
    let gymXp = 0, ownsGym = false, gymName = null, cls = 0, gev = 0;
    const myG = await sb('gyms?owner_id=eq.' + id + '&status=eq.approved&select=id,name&limit=1');
    if(myG && myG.length){
      ownsGym = true; gymName = myG[0].name || null;
      const gid = myG[0].id;
      const ga = await sb('gym_attendance?gym_id=eq.' + gid + '&select=class_date,class_time');
      const set = new Set(ga.map(a => (a.class_date||'') + '|' + (a.class_time||''))); set.delete('|');
      cls = set.size;
      gev = await sbCount('events?gym_id=eq.' + gid + '&status=eq.approved&starts_at=lt.' + NOW + '&select=id');
      gymXp = cls + gev * 40;
    }

    // 5) levels payload (only roles the person actually has)
    const levels = [];
    levels.push({ role: 'student', level: levelOf(studentXp), xp: studentXp });
    if(isCoach)  levels.push({ role: 'coach', level: levelOf(coachXp), xp: coachXp });
    if(ownsGym)  levels.push({ role: 'gym',   level: levelOf(gymXp),   xp: gymXp });

    // 6) achieved milestones only (subset, labels resolved client-agnostic with emoji)
    const totalTrain = s1 + sg;
    const M = [];
    const add = (cond, emoji, en, cs) => { if(cond) M.push({ emoji, en, cs }); };
    add(totalTrain>=1,   '🥊','First training','První trénink');
    add(totalTrain>=25,  '🔥','25 trainings','25 tréninků');
    add(totalTrain>=100, '🏆','100 trainings','100 tréninků');
    add(totalTrain>=500, '💎','500 trainings','500 tréninků');
    add(sportSet.size>=3,'🌍','Tried 3 sports','Vyzkoušel 3 sporty');
    add(c1>=10,          '💯','10 lessons taught','10 odučených');
    add(c1>=250,         '🏆','250 lessons taught','250 odučených');
    add(me.cert_level==='certified','🏅','MTL Certified','MTL Certified');
    add(cev+gev>=1,      '🎪','Hosted an event','Uspořádal akci');
    add(cls>=100,        '🏋️','100 classes held','100 odučených skupinovek');

    // belts (best-effort, bjj only — same shape index.html uses)
    let belts = null;
    try { belts = (typeof me.belts === 'string') ? JSON.parse(me.belts) : me.belts; } catch(e){ belts = null; }

    res.status(200).json({
      name: me.name || 'Athlete',
      photo: me.photo_url || null,
      certified: me.cert_level === 'certified',
      levels,
      milestones: M,
      headline: { trainings: totalTrain, taught: c1, classes: cls, events: cev + gev, sports: sportSet.size },
      belts: belts || null
    });
  }catch(e){
    res.status(500).json({ error: 'server error' });
  }
}
