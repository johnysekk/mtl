// /api/kid-badges.js  — public, read-only trophy-case data for a child.
// Deploy alongside api/profile-badges.js (same env vars).
// Needs: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// The kid link is  ...//app.<domain>/?ref=<PARENT_REFERRAL_CODE>&kid=<CHILD_SHARE_TOKEN>&l=<lang>
// We locate the parent by referral_code (carried in the link, so NO table scan),
// then find the child inside the parent's children JSON by its opaque share token.
// Child safety: only the child's FIRST name + non-identifying level/badges are returned
// (no last name, no photo, no contact, no chat/booking surface).

import { createClient } from '@supabase/supabase-js';

function xpForLevel(L){ if(L<=1) return 0; if(L>80) L=80; return Math.floor(3*Math.pow(L-1,1.5)); }
function levelFromXp(xp){ xp=Math.max(0,Math.round(xp||0)); let lvl=1; for(let L=80;L>=1;L--){ if(xp>=xpForLevel(L)){ lvl=L; break; } } return lvl; }

export default async function handler(req, res){
  try{
    const ref = String((req.query && req.query.ref) || '').trim();
    const kid = String((req.query && req.query.kid) || '').trim();
    if(!ref || !kid) return res.status(400).json({ error:'missing params' });

    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if(!url || !key) return res.status(500).json({ error:'server not configured' });
    const sb = createClient(url, key, { auth:{ persistSession:false } });

    // Parent located by the referral code carried in the link (no scan).
    const { data: prof } = await sb
      .from('profiles')
      .select('id,name,children')
      .eq('referral_code', ref)
      .maybeSingle();
    if(!prof) return res.status(404).json({ error:'not found' });

    let kids = [];
    try{ kids = typeof prof.children === 'string' ? JSON.parse(prof.children) : (prof.children || []); }
    catch(e){ kids = []; }
    const child = (Array.isArray(kids) ? kids : []).find(c => c && c.share === kid);
    if(!child) return res.status(404).json({ error:'not found' });

    // Level from per-child group attendance (2 XP per attended session — same curve as the app).
    let n = 0;
    try{
      const { data: att } = await sb
        .from('gym_attendance')
        .select('id')
        .eq('student_id', prof.id)
        .eq('child_name', child.name);
      n = (att || []).length;
    }catch(e){}
    const level = levelFromXp(n * 2);

    // Attendance milestones unlocked.
    const MS = [5,10,25,50,100,150,200,300,500];
    const milestones = MS.filter(m => n >= m).map(m => ({
      cat:'student', emoji:'\uD83E\uDD4B', en: m+' trainings', cs: m+' tr\u00e9nink\u016f'
    }));

    const firstName = String(child.name || '').trim().split(/\s+/)[0] || '';

    // belts: only ANNOUNCED ones are public (matches the in-app announce gate)
    let belts = [];
    try {
      let bobj = child.belts;
      if (typeof bobj === 'string') bobj = JSON.parse(bobj);
      belts = Object.values(bobj || {})
        .filter(b => b && b.belt && b.announced === b.belt)
        .map(b => ({ belt: b.belt, stripes: b.stripes || 0, disc: b.disc || null }));
    } catch (e) { belts = []; }

    return res.status(200).json({
      name: firstName,          // first name only (child safety)
      junior: true,
      certified: false,
      photo: null,
      levels: [{ role:'student', level }],
      belts,
      milestones
    });
  }catch(e){
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
