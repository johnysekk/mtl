// MTL audit-lite pruner (QLI). Daily cron. Keeps the gym_audit table a tight ring buffer:
// deletes rows older than 90 days, then trims each gym to its newest 100 rows.
// Add to vercel.json crons, e.g. { "path": "/api/gym-audit-prune", "schedule": "0 3 * * *" }.
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res){
  try{
    const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // 1) hard age cap: 90 days
    const cutoff = new Date(Date.now() - 90*24*60*60*1000).toISOString();
    await supa.from('gym_audit').delete().lt('created_at', cutoff);

    // 2) per-gym cap: keep newest 100
    const { data: gyms } = await supa.from('gym_audit').select('gym_id');
    const ids = [...new Set((gyms||[]).map(g=>g.gym_id).filter(Boolean))];
    let trimmed = 0;
    for(const gid of ids){
      const { data: rows } = await supa
        .from('gym_audit')
        .select('id')
        .eq('gym_id', gid)
        .order('created_at', { ascending:false })
        .range(100, 100000); // everything beyond the newest 100
      const old = (rows||[]).map(r=>r.id);
      if(old.length){
        // delete in chunks to stay well within limits
        for(let i=0;i<old.length;i+=200){
          await supa.from('gym_audit').delete().in('id', old.slice(i, i+200));
        }
        trimmed += old.length;
      }
    }
    res.status(200).json({ ok:true, gyms: ids.length, trimmed });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e&&e.message||e) });
  }
}
