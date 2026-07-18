// /api/pis-return.js — NEONOMICS. redirect the student lands on AFTER approving in their bank.
// Synchronous confirmation (webhook is the reliable async backstop). GET payment status; if final-success,
// mark the booking paid (idempotent), then bounce the student back into the app.
//
// ENV: NEONOMICS_CLIENT_ID, NEONOMICS_SECRET_ID, NEONOMICS_ENV, APP_URL,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PIS_INTERNAL_SECRET
//
// pisSideEffects + the whole reconcile (table lookup by pis_payment_id, status update, buyer notif, record-cash,
// ticket-email, owner notif) are recycled VERBATIM from the Enable version — provider-agnostic. Only the auth,
// the status fetch (Neonomics GET Payment by ID, which needs the stored session_id+device_id) and the paid-status
// set are Neonomics-specific.
import { createClient } from '@supabase/supabase-js';

const ENVN = (process.env.NEONOMICS_ENV || 'sandbox').toLowerCase();
const AUTH_BASE = 'https://' + ENVN + '.neonomics.io/auth/realms/' + ENVN + '/protocol/openid-connect/token';
const ICS_BASE  = 'https://' + ENVN + '.neonomics.io/ics/v3';
const APP_URL  = process.env.APP_URL || 'https://app.martialtraininglab.com';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
// ISO 20022: ACSC = settled (final success). Accepted-and-beyond are treated as paid (bank transfer rarely
// reverses post-acceptance); webhook/reconcile is the backstop. Production may tighten to ACSC-only.
const PAID_STATUSES = new Set(['ACSC','ACCC','ACWC','ACSP','ACTC','ACCP','ACPT','SETLD','SETTLED']);

async function neoToken() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.NEONOMICS_CLIENT_ID || '', client_secret: process.env.NEONOMICS_SECRET_ID || '' });
  const r = await fetch(AUTH_BASE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw new Error('neo_token_failed');
  return d.access_token;
}

async function pisSideEffects(rec, tbl){
  const _coach1=(tbl==='bookings'); const _event=(tbl==='event_tickets');
  let _evP='gym', _evG=null, _evC=null;
  if(_event){ try{ const ev=await sb.from('events').select('gym_id,payout_coach_id').eq('id',rec.event_id).maybeSingle(); if(ev.data){ if(ev.data.payout_coach_id){ _evP='coach'; _evC=ev.data.payout_coach_id; } else { _evG=ev.data.gym_id; } } }catch(e){} }
  const _cohort=(tbl==='cohort_members'); let _cohGym=null, _cohDep=0, _cohCur='CZK';
  if(_cohort){ try{ const co=await sb.from('gym_cohorts').select('gym_id,deposit_amount,currency').eq('id',rec.cohort_id).maybeSingle(); if(co.data){ _cohGym=co.data.gym_id; _cohDep=co.data.deposit_amount||0; _cohCur=co.data.currency||'CZK'; } }catch(e){} }
  const _merch=(tbl==='merch_orders');
  try{ const ex=await sb.from('transactions').select('id').eq('source_booking_id',rec.id).limit(1);
    if(!(ex.data && ex.data.length)){ const _body=_event
      ? { internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:_evP, gym_id:_evG, coach_id:_evC, member_id:rec.buyer_id||null, gross_amount:Math.round((rec.amount||0)*100), currency:rec.currency||'CZK', type:'event_ticket', payment_method:'pis', acq_source:'direct', source_booking_id:rec.id }
      : _coach1
      ? { internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:'coach', coach_id:rec.coach_id, member_id:rec.student_id||null, gross_amount:Math.round((rec.amount||0)*100), currency:rec.currency||'CZK', type:'coach_1to1', payment_method:'pis', acq_source:rec.acq_source||'direct', source_booking_id:rec.id }
      : _merch
      ? { internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:(rec.coach_id?'coach':'gym'), gym_id:(rec.coach_id?null:rec.gym_id), coach_id:rec.coach_id||null, member_id:rec.student_id||null, gross_amount:Math.round((rec.amount||0)*100), currency:rec.currency||'CZK', type:'merch', payment_method:'pis', acq_source:'direct', source_booking_id:rec.id }
      : _cohort
      ? { internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:'gym', gym_id:_cohGym, member_id:rec.student_id||null, gross_amount:Math.round(_cohDep*100), currency:_cohCur, type:'course', payment_method:'pis', cash_payer_name:rec.name||null, acq_source:rec.attribution||'direct', source_booking_id:rec.id }
      : { internal:true, intSecret:process.env.PIS_INTERNAL_SECRET, provider:'gym', gym_id:rec.gym_id, coach_id:rec.coach_id||null, member_id:rec.student_id||null, gross_amount:Math.round((rec.amount||0)*100), type:(tbl==='gym_memberships'?'membership':'drop_in'), payment_method:'pis', acq_source:rec.acq_source||'direct', source_booking_id:rec.id };
      await fetch(APP_URL+'/api/record-cash',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(_body) }); } }catch(e){}
  if(_event){ try{ await fetch(APP_URL+'/api/ticket-email',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ticketId:rec.id }) }); }catch(e){} }
  try{ if(_event){ let target=(_evP==='coach')?_evC:null; if(!target && _evG){ const g=await sb.from('gyms').select('owner_id').eq('id',_evG).maybeSingle(); target=g.data&&g.data.owner_id; } if(target) await sb.from('notifications').insert({ user_id:target, type:'booking', read:false, message:'\ud83c\udf9f\ufe0f Nov\u00fd prodej vstupenky (p\u0159evodem): '+(rec.buyer_name||'Z\u00e1kazn\u00edk'), data:JSON.stringify({ kind:'pis_payment_in', event_id:rec.event_id, student:(rec.buyer_name||''), amt:(rec.amount!=null?String(rec.amount):''), sym:(rec.currency||'CZK') }) }); }
    else if(_coach1){ await sb.from('notifications').insert({ user_id:rec.coach_id, type:'booking', read:false, message:'\ud83d\udcb3 Nov\u00e1 1:1 platba (p\u0159evodem)'+((rec.amount!=null)?(' \u00b7 '+rec.amount+' '+(rec.currency||'CZK')):''), data:JSON.stringify({ kind:'pis_payment_in', coach_id:rec.coach_id, booking_id:rec.id, student:(rec.student_name||''), amt:(rec.amount!=null?String(rec.amount):''), sym:(rec.currency||'CZK'), date:(rec.training_date||null), time:(rec.training_time||null) }) }); }
    else if(_merch){ let mt=rec.coach_id||null; if(!mt && rec.gym_id){ const g=await sb.from('gyms').select('owner_id').eq('id',rec.gym_id).maybeSingle(); mt=g.data&&g.data.owner_id; } if(mt) await sb.from('notifications').insert({ user_id:mt, type:'booking', read:false, message:'\ud83d\udecd\ufe0f Nov\u00fd prodej merche (p\u0159evodem): '+(rec.item_name||'polo\u017eka')+(rec.buyer_name?(' \u00b7 '+rec.buyer_name):''), data:JSON.stringify({ kind:'merch_order', merch_id:rec.merch_id }) }); }
    else if(_cohort){ if(_cohGym){ const g=await sb.from('gyms').select('owner_id').eq('id',_cohGym).maybeSingle(); const ownerId=g.data&&g.data.owner_id; if(ownerId) await sb.from('notifications').insert({ user_id:ownerId, type:'booking', read:false, message:'\ud83c\udf93 Nov\u00e1 z\u00e1loha kurzu (p\u0159evodem): '+(rec.name||'Z\u00e1jemce'), data:JSON.stringify({ kind:'pis_payment_in', cohort_id:rec.cohort_id, student:(rec.name||''), amt:(_cohDep?String(_cohDep):''), sym:(_cohCur||'CZK') }) }); } }
    else { const g=await sb.from('gyms').select('owner_id').eq('id',rec.gym_id).maybeSingle(); const ownerId=g.data&&g.data.owner_id;
      if(ownerId){ const what=(tbl==='gym_memberships')?(rec.plan_name||'permanentka'):(rec.class_name||'drop-in'); const who=rec.student_name||'Student'; const _amtO=(rec.amount!=null)?(' \u00b7 '+rec.amount+' '+(rec.currency||'CZK')):''; const _whenO=(tbl!=='gym_memberships' && rec.class_date)?(' \u00b7 '+rec.class_date+(rec.class_time?(' '+rec.class_time):'')):''; const msg=(tbl==='gym_memberships')?('\ud83c\udf9f\ufe0f Nov\u00fd \u010dlen (p\u0159evodem): '+who+' \u00b7 '+what+_amtO):('\ud83d\udcc5 Nov\u00e1 rezervace (p\u0159evodem): '+who+' \u00b7 '+what+_whenO+_amtO); await sb.from('notifications').insert({ user_id:ownerId, type:'booking', read:false, message:msg, data:JSON.stringify({ kind:'pis_payment_in', gym_id:rec.gym_id, what, student:who, membership:(tbl==='gym_memberships'), amt:(rec.amount!=null?String(rec.amount):''), sym:(rec.currency||'CZK'), className:what, date:(rec.class_date||null), time:(rec.class_time||null), occ:(tbl==='gym_bookings'?{ date:rec.class_date||null, time:rec.class_time||null, name:rec.class_name||null }:null) }) }); } } }catch(e){}
}

export default async function handler(req, res){
  let _dbg='st=NO_PAYMENT_ID';
  try{
    const bookingId = req.query.state;
    // Neonomics redirects back to our x-redirect-url (which carries ?state=<bookingId>). Derive the paymentId
    // from the stored booking/membership, then look up the stored session_id+device_id to query the status.
    let paymentId = req.query.paymentId || req.query.payment_id || req.query.id;
    if(!paymentId && bookingId){
      let r0=(await sb.from('gym_bookings').select('pis_payment_id').eq('id',bookingId).maybeSingle()).data;
      if(!r0){ const m0=await sb.from('gym_memberships').select('pis_payment_id').eq('id',bookingId).maybeSingle(); if(m0.data) r0=m0.data; }
      if(!r0){ const c0=await sb.from('bookings').select('pis_payment_id').eq('id',bookingId).maybeSingle(); if(c0.data) r0=c0.data; }
      if(!r0){ const e0=await sb.from('event_tickets').select('pis_payment_id').eq('id',bookingId).maybeSingle(); if(e0.data) r0=e0.data; }
      if(!r0){ const co0=await sb.from('cohort_members').select('pis_payment_id').eq('id',bookingId).maybeSingle(); if(co0.data) r0=co0.data; }
      if(!r0){ const mo0=await sb.from('merch_orders').select('pis_payment_id').eq('id',bookingId).maybeSingle(); if(mo0.data) r0=mo0.data; }
      if(r0 && r0.pis_payment_id) paymentId=r0.pis_payment_id; else _dbg='st=NO_STORED_PID';
    }
    if(paymentId){
      // recover the session context stored by pis-create
      let sessionId=null, deviceId=null;
      try{ const ps=await sb.from('pis_session').select('session_id,device_id').eq('payment_id',paymentId).maybeSingle(); if(ps.data){ sessionId=ps.data.session_id; deviceId=ps.data.device_id; } }catch(e){}
      const token=await neoToken();
      const r=await fetch(ICS_BASE+'/payments/domestic-transfer/'+encodeURIComponent(paymentId),{
        headers:{ Authorization:'Bearer '+token, Accept:'application/json', ...(deviceId?{'x-device-id':deviceId}:{}), ...(sessionId?{'x-session-id':sessionId}:{}) }
      });
      const p=await r.json().catch(()=>({}));
      const status=p.status||(p.payment&&p.payment.status);
      _dbg = 'st='+encodeURIComponent(String(status||'?'))+'&http='+r.status;
      if(r.ok && PAID_STATUSES.has(String(status))){
        let tbl='gym_bookings';
        let rec=(await sb.from('gym_bookings').select('id,status,student_id,gym_id,class_name,class_date,class_time,amount,currency,coach_id,acq_source,student_name').eq('pis_payment_id',paymentId).maybeSingle()).data;
        if(!rec){ const m=await sb.from('gym_memberships').select('id,status,student_id,gym_id,plan_name,amount,currency,coach_id,acq_source,student_name').eq('pis_payment_id',paymentId).maybeSingle(); if(m.data){ rec=m.data; tbl='gym_memberships'; } }
        if(!rec){ const c=await sb.from('bookings').select('id,status,student_id,coach_id,amount,currency,coach_name,training_date,training_time,slot_id,acq_source').eq('pis_payment_id',paymentId).maybeSingle(); if(c.data){ rec=c.data; tbl='bookings'; } }
        if(!rec){ const e=await sb.from('event_tickets').select('id,status,buyer_id,event_id,amount,currency,buyer_name').eq('pis_payment_id',paymentId).maybeSingle(); if(e.data){ rec=e.data; tbl='event_tickets'; } }
        if(!rec){ const co=await sb.from('cohort_members').select('id,status,student_id,cohort_id,name,attribution').eq('pis_payment_id',paymentId).maybeSingle(); if(co.data){ rec=co.data; tbl='cohort_members'; } }
        if(!rec){ const mo=await sb.from('merch_orders').select('id,status,student_id,gym_id,coach_id,merch_id,item_name,amount,currency,buyer_name').eq('pis_payment_id',paymentId).maybeSingle(); if(mo.data){ rec=mo.data; tbl='merch_orders'; } }
        const _paidStatus=(tbl==='event_tickets'||tbl==='merch_orders')?'paid':(tbl==='cohort_members')?'deposit_paid':'active';
        if(rec && rec.status!==_paidStatus){
          await sb.from(tbl).update({ status:_paidStatus, pis_status:status }).eq('id',rec.id);
          if(tbl==='bookings' && rec.slot_id){ try{ await sb.from('slots').update({ booked:true }).eq('id',rec.slot_id); }catch(e){} }
          try{ const _buyerId=(tbl==='event_tickets')?rec.buyer_id:rec.student_id;
            const _cur=(rec.currency||'CZK'); const _amt=(rec.amount!=null)?(rec.amount+' '+_cur):'';
            const _dte=(rec.class_date||rec.training_date)||''; const _tme=(rec.class_time||rec.training_time)||'';
            let _gname=''; try{ const _gid=rec.gym_id||_cohGym||_evG||null; if(_gid){ const _gn=await sb.from('gyms').select('name').eq('id',_gid).maybeSingle(); _gname=(_gn.data&&_gn.data.name)||''; } }catch(e){}
            // auto:true => the bank confirmed it (PIS), not the club. The client renderer builds the visible text from these fields.
            let nd;
            if(tbl==='gym_memberships'){ nd={ kind:'payment_confirmed', auto:true, goto:'memberships', gym_id:rec.gym_id, gym_name:_gname, amount:_amt, item:(rec.plan_name||'') }; }
            else if(tbl==='bookings'){ nd={ kind:'payment_confirmed', auto:true, goto:'bookings', amount:_amt, date:_dte, time:_tme, coach:(rec.coach_name||'') }; }
            else if(tbl==='event_tickets'){ nd={ kind:'payment_confirmed', auto:true, goto:'tickets', event_id:rec.event_id, gym_name:_gname, amount:_amt }; }
            else if(tbl==='merch_orders'){ nd={ kind:'payment_confirmed', auto:true, goto:'merch', merch_id:rec.merch_id, gym_id:rec.gym_id, gym_name:_gname, amount:_amt, item:(rec.item_name||'') }; }
            else if(tbl==='cohort_members'){ nd={ kind:'payment_confirmed', auto:true, goto:'courses', cohort_id:rec.cohort_id, member_id:rec.id, gym_name:_gname, amount:_amt }; }
            else { nd={ kind:'payment_confirmed', auto:true, goto:'dropin', gym_id:rec.gym_id, gym_name:_gname, amount:_amt, item:(rec.class_name||''), date:_dte, time:_tme, class_name:rec.class_name }; }
            const _msg='\u2705 '+(nd.item||'')+(_amt?(' \u00b7 '+_amt):'');
            await sb.from('notifications').insert({ user_id:_buyerId, type:'booking', read:false, message:_msg, data:JSON.stringify(nd) }); }catch(e){}
          await pisSideEffects(rec, tbl);
        }
        return res.redirect(302, APP_URL+'/?pis=ok');
      }
    }
    return res.redirect(302, APP_URL+'/?pis=pending&'+_dbg);
  }catch(e){ return res.redirect(302, APP_URL+'/?pis=err&msg='+encodeURIComponent((e.message||'').slice(0,120))); }
}
