// /api/pis-return.js — redirect_url the student lands on AFTER approving in their bank.
// Synchronous confirmation (webhook is the reliable async one). GET payment status; if final-success,
// mark the booking paid (idempotent with the webhook), then bounce the student back into the app.
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const APP_ID   = process.env.ENABLE_APP_ID;
const PRIV_KEY = (process.env.ENABLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const EB_BASE  = 'https://api.enablebanking.com';
const APP_URL  = process.env.APP_URL || 'https://app.martialtraininglab.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const PAID_STATUSES = new Set(['ACCP','ACTC','ACSP','ACSC','ACCC','ACWC','ACFC','SETLD','SETTLED']);
async function pisSideEffects(rec, tbl){
  try{ const ex=await sb.from('transactions').select('id').eq('source_booking_id',rec.id).limit(1);
    if(!(ex.data && ex.data.length)){ await fetch(APP_URL+'/api/record-cash',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:'gym', gym_id:rec.gym_id, coach_id:rec.coach_id||null, member_id:rec.student_id||null, gross_amount:Math.round((rec.amount||0)*100), type:(tbl==='gym_memberships'?'membership':'drop_in'), payment_method:'pis', acq_source:rec.acq_source||'direct', source_booking_id:rec.id }) }); } }catch(e){}
  try{ const g=await sb.from('gyms').select('owner_id').eq('id',rec.gym_id).maybeSingle(); const ownerId=g.data&&g.data.owner_id;
    if(ownerId){ const what=(tbl==='gym_memberships')?(rec.plan_name||'permanentka'):(rec.class_name||'drop-in'); await sb.from('notifications').insert({ user_id:ownerId, type:'booking', read:false, message:'\ud83d\udcb8 Platba p\u0159ijata (p\u0159evodem): '+what, data:JSON.stringify({ kind:'pis_payment_in', gym_id:rec.gym_id, what }) }); } }catch(e){}
}
const b64url = (o) => Buffer.from(typeof o==='string'?o:JSON.stringify(o)).toString('base64url');
function ebJwt(){ const now=Math.floor(Date.now()/1000);
  const si=b64url({typ:'JWT',alg:'RS256',kid:APP_ID})+'.'+b64url({iss:'enablebanking.com',aud:'api.enablebanking.com',iat:now,exp:now+3600});
  return si+'.'+crypto.sign('RSA-SHA256',Buffer.from(si),PRIV_KEY).toString('base64url'); }

export default async function handler(req, res){
  let _dbg='st=NO_PAYMENT_ID';
  try{
    const paymentId = req.query.payment_id || req.query.paymentId;
    const bookingId = req.query.state;
    if(paymentId){
      const jwt=ebJwt();
      const r=await fetch(EB_BASE+'/payments/'+encodeURIComponent(paymentId),{ headers:{ Authorization:'Bearer '+jwt } });
      const p=await r.json();
      const status=p.status||(p.payment_details&&p.payment_details.status);
      _dbg = 'st='+encodeURIComponent(String(status||'?'))+'&http='+r.status;
      if(r.ok && PAID_STATUSES.has(String(status))){
        let tbl='gym_bookings';
        let rec=(await sb.from('gym_bookings').select('id,status,student_id,gym_id,class_name,amount,coach_id,acq_source').eq('pis_payment_id',paymentId).maybeSingle()).data;
        if(!rec){ const m=await sb.from('gym_memberships').select('id,status,student_id,gym_id,plan_name,amount,coach_id,acq_source').eq('pis_payment_id',paymentId).maybeSingle(); if(m.data){ rec=m.data; tbl='gym_memberships'; } }
        if(rec && rec.status!=='active'){
          await sb.from(tbl).update({ status:'active', pis_status:status }).eq('id',rec.id);
          try{ const nd=(tbl==='gym_memberships')?{ kind:'payment_confirmed', gym_id:rec.gym_id }:{ kind:'payment_confirmed', goto:'dropin', gym_id:rec.gym_id, class_name:rec.class_name }; await sb.from('notifications').insert({ user_id:rec.student_id, type:'booking', read:false, data:JSON.stringify(nd) }); }catch(e){}
          await pisSideEffects(rec, tbl);
        }
        return res.redirect(302, APP_URL+'/?pis=ok&b='+encodeURIComponent(bookingId||''));
      }
    }
    return res.redirect(302, APP_URL+'/?pis=pending&'+_dbg+'&b='+encodeURIComponent(bookingId||''));
  }catch(e){ return res.redirect(302, APP_URL+'/?pis=err&msg='+encodeURIComponent((e.message||'').slice(0,120))); }
}
