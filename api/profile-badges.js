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
      '&select=id,name,photo_url,belts,coach_status,cert_level,verify_disciplines&limit=1');
    if(!prof || !prof.length){ res.status(404).json({ error: 'not found' }); return; }
    const me = prof[0];
    const id = me.id;
    const isCoach = me.coach_status === 'approved';
    const isFounder = (id === '7e08d4bb-0efa-47ae-bd6a-85e9bd04400c');
    let isAmbassador = false; try { const v = me.verify_disciplines ? (typeof me.verify_disciplines==='string'?JSON.parse(me.verify_disciplines):me.verify_disciplines) : []; isAmbassador = Array.isArray(v) && v.length>0; } catch(e){}

    // 2) STUDENT — physical 1:1 confirmed + gym attendances
    const sBk = await sb('bookings?student_id=eq.' + id +
      '&status=eq.active&type=neq.online&student_confirmed=eq.true&coach_confirmed=eq.true&select=id,discipline');
    const s1 = sBk.length;
    const sGa = await sb('gym_attendance?student_id=eq.' + id + '&select=id,discipline');
    const sg = sGa.length;
    const sOnline = await sb('bookings?student_id=eq.' + id + '&status=eq.active&type=eq.online&fulfilled=eq.true&select=id');
    const onlineN = (sOnline||[]).length;
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
    let gymXp = 0, ownsGym = false, gymName = null, cls = 0, gev = 0, members = 0;
    const myG = await sb('gyms?owner_id=eq.' + id + '&status=eq.approved&select=id,name&limit=1');
    if(myG && myG.length){
      ownsGym = true; gymName = myG[0].name || null;
      const gid = myG[0].id;
      const gm = await sb('gym_memberships?gym_id=eq.' + gid + '&status=in.(active,cancelling)&select=id'); members = (gm||[]).length;
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
    const add = (cat, cond, emoji, en, cs, den, dcs) => { if(cond) M.push({ cat, emoji, en, cs, den, dcs }); };
    // newest/biggest tier only per cumulative track
    const topAdd = (cat, ...tiers) => { let last=null; for(const t of tiers){ if(t[0]) last=t; } if(last) M.push({ cat, emoji:last[1], en:last[2], cs:last[3], den:last[4], dcs:last[5] }); };
    topAdd('student',[totalTrain>=1,'🥊','First training','První trénink','Completed their first training','Absolvoval první trénink'],[totalTrain>=25,'🔥','25 trainings','25 tréninků','Completed 25 physical trainings','Absolvoval 25 fyzických tréninků'],[totalTrain>=100,'🏆','100 trainings','100 tréninků','Completed 100 physical trainings','Absolvoval 100 fyzických tréninků'],[totalTrain>=500,'💎','500 trainings','500 tréninků','Completed 500 physical trainings','Absolvoval 500 fyzických tréninků']);
    topAdd('student',[onlineN>=1,'🌐','First online lesson','První online lekce','Completed their first online lesson','Absolvoval první online lekci'],[onlineN>=5,'🔥','5 online lessons','5 online lekcí','Completed 5 online lessons','Absolvoval 5 online lekcí'],[onlineN>=25,'🏆','25 online lessons','25 online lekcí','Completed 25 online lessons','Absolvoval 25 online lekcí'],[onlineN>=100,'💎','100 online lessons','100 online lekcí','Completed 100 online lessons','Absolvoval 100 online lekcí']);
    add('student',sportSet.size>=3,'🌍','Tried 3 sports','Vyzkoušel 3 sporty','Trained in 3 different martial arts','Trénoval 3 různá bojová umění');
    // per-discipline training milestones — one chip per discipline (>=5), highest tier only, max 6
    const discCount = {};
    sBk.forEach(b => { if(b.discipline) discCount[b.discipline] = (discCount[b.discipline]||0)+1; });
    sGa.forEach(a => { if(a && a.discipline) discCount[a.discipline] = (discCount[a.discipline]||0)+1; });
    const DLBL = { bjj:'BJJ', mma:'MMA', muay_thai:'Muay Thai', boxing:'Box', kickboxing:'Kickbox', wrestling:'Wrestling', judo:'Judo', karate:'Karate', taekwondo:'Taekwondo', krav_maga:'Krav Maga', sambo:'Sambo', luta_livre:'Luta Livre', sanda:'Sanda', capoeira:'Capoeira', aikido:'Aikido', kung_fu:'Kung Fu' };
    const dlabel = d => DLBL[d] || String(d||'').replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
    const DTIERS = [[5,'🔥'],[25,'🔥'],[100,'🏆'],[500,'💎']];
    Object.keys(discCount).sort((x,y)=>discCount[y]-discCount[x]).slice(0,6).forEach(d => {
      const n = discCount[d]; let best = null; for(const t of DTIERS){ if(n>=t[0]) best=t; }
      if(best){ const lbl = dlabel(d); M.push({ cat:'discipline', emoji:best[1], en: best[0]+' · '+lbl, cs: best[0]+' tréninků '+lbl, den: 'Trained '+best[0]+' '+lbl+' sessions', dcs: 'Odtrénoval '+best[0]+' lekcí '+lbl }); }
    });
    topAdd('coach',[c1>=10,'💯','10 lessons taught','10 odučených','Taught 10 paid lessons','Odučil 10 placených lekcí'],[c1>=250,'🏆','250 lessons taught','250 odučených','Taught 250 paid lessons','Odučil 250 placených lekcí']);
    topAdd('gym',[members>=1,'🏠','First member','První člen','Their gym got its first member','Jeho gym získal prvního člena'],[members>=10,'📈','10 members','10 členů','Their gym has 10 members','Jeho gym má 10 členů'],[members>=50,'📈','50 members','50 členů','Their gym has 50 members','Jeho gym má 50 členů'],[members>=100,'📈','100 members','100 členů','Their gym has 100 members','Jeho gym má 100 členů'],[members>=200,'🏆','200 members','200 členů','Their gym has 200 members','Jeho gym má 200 členů']);
    // gym-referral ladder (Průkopník→Architekt) — top earned tier only; dcs/den = tap-to-reveal description
    try {
      const grN = await sbCount('gyms?referred_by=eq.' + id + '&referral_rewarded=is.true&select=id');
      const GR = [
        [1,'🧭','Scout','Průkopník','Brought 1 gym to MTL','Přivedl 1 gym na MTL'],
        [3,'🔗','Connector','Spojka','Brought 3 gyms to MTL','Přivedl 3 gymy na MTL'],
        [5,'⚙️','Engineer','Inženýr','Brought 5 gyms to MTL','Přivedl 5 gymů na MTL'],
        [10,'🏛️','Architect','Architekt','Brought 10 gyms to MTL','Přivedl 10 gymů na MTL']
      ];
      let gt = null; for(const t of GR){ if(grN >= t[0]) gt = t; }
      if(gt) M.push({ cat:'gym', emoji:gt[1], en:gt[2], cs:gt[3], den:gt[4], dcs:gt[5] });
    } catch(e){}
    add('platform',isFounder,'👑','MTL Founder','MTL Founder','👑 MTL Founder\n🏆 From a bullied kid to 70+ fights in the ring.\n🚀 His mission: Spread martial arts and its benefits.','👑 MTL Founder\n🏆 Ze šikanovaného kluka k 70+ zápasům v ringu.\n🚀 Jeho mise: Šířit bojová umění a jejich přínosy.');
    add('platform',isAmbassador,'⭐','MTL Ambassador','MTL Ambassador','MTL Ambassador for their discipline','MTL Ambasador své disciplíny');
    add('platform',me.cert_level==='certified','🏅','MTL Certified','MTL Certified','Verified & certified coach on MTL','Ověřený a certifikovaný kouč na MTL');
    add('coach',cev+gev>=1,'🎪','Hosted an event','Uspořádal akci','Hosted an event on MTL','Uspořádal akci na MTL');
    add('coach',cls>=100,'🏋️','100 classes held','100 odučených skupinovek','Taught 100 group classes','Odučil 100 skupinových lekcí');

    // belts (best-effort, bjj only — same shape index.html uses)
    let belts = null;
    try { belts = (typeof me.belts === 'string') ? JSON.parse(me.belts) : me.belts; } catch(e){ belts = null; }

    res.status(200).json({
      name: me.name || 'Athlete',
      photo: me.photo_url || null,
      certified: me.cert_level === 'certified',
      founder: isFounder,
      ambassador: isAmbassador,
      levels,
      milestones: M,
      headline: { trainings: totalTrain, taught: c1, classes: cls, events: cev + gev, sports: sportSet.size },
      belts: belts || null
    });
  }catch(e){
    res.status(500).json({ error: 'server error' });
  }
}
