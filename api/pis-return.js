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
  const _coach1=(tbl==='bookings'); const _event=(tbl==='event_tickets');
  let _evP='gym', _evG=null, _evC=null;
  if(_event){ try{ const ev=await sb.from('events').select('gym_id,payout_coach_id').eq('id',rec.event_id).maybeSingle(); if(ev.data){ if(ev.data.payout_coach_id){ _evP='coach'; _evC=ev.data.payout_coach_id; } else { _evG=ev.data.gym_id; } } }catch(e){} }
  const _cohort=(tbl==='cohort_members'); let _cohGym=null, _cohDep=0, _cohCur='CZK';
  if(_cohort){ try{ const co=await sb.from('gym_cohorts').select('gym_id,deposit_amount,currency').eq('id',rec.cohort_id).maybeSingle(); if(co.data){ _cohGym=co.data.gym_id; _cohDep=co.data.deposit_amount||0; _cohCur=co.data.currency||'CZK'; } }catch(e){} }
  try{ const ex=await sb.from('transactions').select('id').eq('source_booking_id',rec.id).limit(1);
    if(!(ex.data && ex.data.length)){ const _body=_event
      ? { internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:_evP, gym_id:_evG, coach_id:_evC, member_id:rec.buyer_id||null, gross_amount:Math.round((rec.amount||0)*100), currency:rec.currency||'CZK', type:'event_ticket', payment_method:'pis', acq_source:'direct', source_booking_id:rec.id }
      : _coach1
      ? { internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:'coach', coach_id:rec.coach_id, member_id:rec.student_id||null, gross_amount:Math.round((rec.amount||0)*100), currency:rec.currency||'CZK', type:'coach_1to1', payment_method:'pis', acq_source:rec.acq_source||'direct', source_booking_id:rec.id }
      : _cohort
      ? { internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:'gym', gym_id:_cohGym, member_id:rec.student_id||null, gross_amount:Math.round(_cohDep*100), currency:_cohCur, type:'course', payment_method:'pis', cash_payer_name:rec.name||null, acq_source:rec.attribution||'direct', source_booking_id:rec.id }
      : { internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:'gym', gym_id:rec.gym_id, coach_id:rec.coach_id||null, member_id:rec.student_id||null, gross_amount:Math.round((rec.amount||0)*100), type:(tbl==='gym_memberships'?'membership':'drop_in'), payment_method:'pis', acq_source:rec.acq_source||'direct', source_booking_id:rec.id };
      await fetch(APP_URL+'/api/record-cash',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_body) }); } }catch(e){}
  if(_event){ try{ await fetch(APP_URL+'/api/ticket-email',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ticketId:rec.id }) }); }catch(e){} }
  try{ if(_event){ let target=(_evP==='coach')?_evC:null; if(!target && _evG){ const g=await sb.from('gyms').select('owner_id').eq('id',_evG).maybeSingle(); target=g.data&&g.data.owner_id; } if(target) await sb.from('notifications').insert({ user_id:target, type:'booking', read:false, message:'\ud83c\udf9f\ufe0f Nov\u00fd prodej vstupenky (p\u0159evodem): '+(rec.buyer_name||'Z\u00e1kazn\u00edk'), data:JSON.stringify({ kind:'pis_payment_in', event_id:rec.event_id }) }); }
    else if(_coach1){ await sb.from('notifications').insert({ user_id:rec.coach_id, type:'booking', read:false, message:'\ud83d\udcb3 Nov\u00e1 1:1 platba (p\u0159evodem)', data:JSON.stringify({ kind:'pis_payment_in', coach_id:rec.coach_id, booking_id:rec.id }) }); }
    else if(_cohort){ if(_cohGym){ const g=await sb.from('gyms').select('owner_id').eq('id',_cohGym).maybeSingle(); const ownerId=g.data&&g.data.owner_id; if(ownerId) await sb.from('notifications').insert({ user_id:ownerId, type:'booking', read:false, message:'\ud83c\udf93 Nov\u00e1 z\u00e1loha kurzu (p\u0159evodem): '+(rec.name||'Z\u00e1jemce'), data:JSON.stringify({ kind:'pis_payment_in', cohort_id:rec.cohort_id }) }); } }
    else { const g=await sb.from('gyms').select('owner_id').eq('id',rec.gym_id).maybeSingle(); const ownerId=g.data&&g.data.owner_id;
      if(ownerId){ const what=(tbl==='gym_memberships')?(rec.plan_name||'permanentka'):(rec.class_name||'drop-in'); const who=rec.student_name||'Student'; const msg=(tbl==='gym_memberships')?('\ud83c\udf9f\ufe0f Nov\u00fd \u010dlen (p\u0159evodem): '+who+' \u00b7 '+what):('\ud83d\udcc5 Nov\u00e1 rezervace (p\u0159evodem): '+who+' \u00b7 '+what); await sb.from('notifications').insert({ user_id:ownerId, type:'booking', read:false, message:msg, data:JSON.stringify({ kind:'pis_payment_in', gym_id:rec.gym_id, what, student:who }) }); } } }catch(e){}
}
const b64url = (o) => Buffer.from(typeof o==='string'?o:JSON.stringify(o)).toString('base64url');
function ebJwt(){ const now=Math.floor(Date.now()/1000);
  const si=b64url({typ:'JWT',alg:'RS256',kid:APP_ID})+'.'+b64url({iss:'enablebanking.com',aud:'api.enablebanking.com',iat:now,exp:now+3600});
  return si+'.'+crypto.sign('RSA-SHA256',Buffer.from(si),PRIV_KEY).toString('base64url'); }

export default async function handler(req, res){
  let _dbg='st=NO_PAYMENT_ID';
  try{
    const bookingId = req.query.state;
    // Enable redirects back with `state` (= our bookingId), NOT payment_id.
    // Derive the payment id from the stored booking/membership.
    let paymentId = req.query.payment_id || req.query.paymentId || req.query.id;
    if(!paymentId && bookingId){
      let r0=(await sb.from('gym_bookings').select('pis_payment_id').eq('id',bookingId).maybeSingle()).data;
      if(!r0){ const m0=await sb.from('gym_memberships').select('pis_payment_id').eq('id',bookingId).maybeSingle(); if(m0.data) r0=m0.data; }
      if(!r0){ const c0=await sb.from('bookings').select('pis_payment_id').eq('id',bookingId).maybeSingle(); if(c0.data) r0=c0.data; }
      if(!r0){ const e0=await sb.from('event_tickets').select('pis_payment_id').eq('id',bookingId).maybeSingle(); if(e0.data) r0=e0.data; }
      if(!r0){ const co0=await sb.from('cohort_members').select('pis_payment_id').eq('id',bookingId).maybeSingle(); if(co0.data) r0=co0.data; }
      if(r0 && r0.pis_payment_id) paymentId=r0.pis_payment_id; else _dbg='st=NO_STORED_PID';
    }
    if(paymentId){
      const jwt=ebJwt();
      const r=await fetch(EB_BASE+'/payments/'+encodeURIComponent(paymentId),{ headers:{ Authorization:'Bearer '+jwt } });
      const p=await r.json();
      const status=p.status||(p.payment_details&&p.payment_details.status);
      _dbg = 'st='+encodeURIComponent(String(status||'?'))+'&http='+r.status;
      if(r.ok && PAID_STATUSES.has(String(status))){
        let tbl='gym_bookings';
        let rec=(await sb.from('gym_bookings').select('id,status,student_id,gym_id,class_name,amount,coach_id,acq_source,student_name').eq('pis_payment_id',paymentId).maybeSingle()).data;
        if(!rec){ const m=await sb.from('gym_memberships').select('id,status,student_id,gym_id,plan_name,amount,coach_id,acq_source,student_name').eq('pis_payment_id',paymentId).maybeSingle(); if(m.data){ rec=m.data; tbl='gym_memberships'; } }
        if(!rec){ const c=await sb.from('bookings').select('id,status,student_id,coach_id,amount,currency,coach_name,slot_id,acq_source').eq('pis_payment_id',paymentId).maybeSingle(); if(c.data){ rec=c.data; tbl='bookings'; } }
        if(!rec){ const e=await sb.from('event_tickets').select('id,status,buyer_id,event_id,amount,currency,buyer_name').eq('pis_payment_id',paymentId).maybeSingle(); if(e.data){ rec=e.data; tbl='event_tickets'; } }
        if(!rec){ const co=await sb.from('cohort_members').select('id,status,student_id,cohort_id,name,attribution').eq('pis_payment_id',paymentId).maybeSingle(); if(co.data){ rec=co.data; tbl='cohort_members'; } }
        const _paidStatus=(tbl==='event_tickets')?'paid':(tbl==='cohort_members')?'deposit_paid':'active';
        if(rec && rec.status!==_paidStatus){
          await sb.from(tbl).update({ status:_paidStatus, pis_status:status }).eq('id',rec.id);
          if(tbl==='bookings' && rec.slot_id){ try{ await sb.from('slots').update({ booked:true }).eq('id',rec.slot_id); }catch(e){} }
          try{ const _buyerId=(tbl==='event_tickets')?rec.buyer_id:rec.student_id; const nd=(tbl==='gym_memberships')?{ kind:'payment_confirmed', auto:true, gym_id:rec.gym_id }:(tbl==='bookings')?{ kind:'payment_confirmed', auto:true, goto:'bookings' }:(tbl==='event_tickets')?{ kind:'payment_confirmed', auto:true, goto:'tickets', event_id:rec.event_id }:(tbl==='cohort_members')?{ kind:'payment_confirmed', auto:true, goto:'courses', cohort_id:rec.cohort_id }:{ kind:'payment_confirmed', auto:true, goto:'dropin', gym_id:rec.gym_id, class_name:rec.class_name }; await sb.from('notifications').insert({ user_id:_buyerId, type:'booking', read:false, data:JSON.stringify(nd) }); }catch(e){}
          await pisSideEffects(rec, tbl);
        }
        return res.redirect(302, APP_URL+'/?pis=ok');
      }
    }
    return res.redirect(302, APP_URL+'/?pis=pending&'+_dbg);
  }catch(e){ return res.redirect(302, APP_URL+'/?pis=err&msg='+encodeURIComponent((e.message||'').slice(0,120))); }
}
