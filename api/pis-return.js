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
const b64url = (o) => Buffer.from(typeof o==='string'?o:JSON.stringify(o)).toString('base64url');
function ebJwt(){ const now=Math.floor(Date.now()/1000);
  const si=b64url({typ:'JWT',alg:'RS256',kid:APP_ID})+'.'+b64url({iss:'enablebanking.com',aud:'api.enablebanking.com',iat:now,exp:now+3600});
  return si+'.'+crypto.sign('RSA-SHA256',Buffer.from(si),PRIV_KEY).toString('base64url'); }

export default async function handler(req, res){
  try{
    const paymentId = req.query.payment_id || req.query.paymentId;
    const bookingId = req.query.state;
    if(paymentId){
      const jwt=ebJwt();
      const r=await fetch(EB_BASE+'/payments/'+encodeURIComponent(paymentId),{ headers:{ Authorization:'Bearer '+jwt } });
      const p=await r.json();
      const status=p.status||(p.payment_details&&p.payment_details.status);
      if(r.ok && PAID_STATUSES.has(String(status))){
        let tbl='gym_bookings';
        let rec=(await sb.from('gym_bookings').select('id,status,student_id,gym_id,class_name').eq('pis_payment_id',paymentId).maybeSingle()).data;
        if(!rec){ const m=await sb.from('gym_memberships').select('id,status,student_id,gym_id,plan_name').eq('pis_payment_id',paymentId).maybeSingle(); if(m.data){ rec=m.data; tbl='gym_memberships'; } }
        if(rec && rec.status!=='active'){
          await sb.from(tbl).update({ status:'active', pis_status:status }).eq('id',rec.id);
          try{ const nd=(tbl==='gym_memberships')?{ kind:'payment_confirmed', gym_id:rec.gym_id }:{ kind:'payment_confirmed', goto:'dropin', gym_id:rec.gym_id, class_name:rec.class_name }; await sb.from('notifications').insert({ user_id:rec.student_id, type:'booking', read:false, data:JSON.stringify(nd) }); }catch(e){}
        }
        return res.redirect(302, APP_URL+'/?pis=ok&b='+encodeURIComponent(bookingId||''));
      }
    }
    return res.redirect(302, APP_URL+'/?pis=pending&b='+encodeURIComponent(bookingId||''));
  }catch(e){ return res.redirect(302, APP_URL+'/?pis=err'); }
}
