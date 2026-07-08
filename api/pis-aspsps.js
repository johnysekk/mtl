// /api/pis-aspsps.js — list banks (ASPSPs) for a country, for the "Zaplatit z účtu" bank picker.
// GET /api/pis-aspsps?country=CZ  ->  { aspsps: [{name, country, logo}] }
import crypto from 'crypto';
const APP_ID   = process.env.ENABLE_APP_ID;
const PRIV_KEY = (process.env.ENABLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const EB_BASE  = 'https://api.enablebanking.com';
const b64url = (o) => Buffer.from(typeof o==='string'?o:JSON.stringify(o)).toString('base64url');
function ebJwt(){ const n=Math.floor(Date.now()/1000);
  const si=b64url({typ:'JWT',alg:'RS256',kid:APP_ID})+'.'+b64url({iss:'enablebanking.com',aud:'api.enablebanking.com',iat:n,exp:n+3600});
  return si+'.'+crypto.sign('RSA-SHA256',Buffer.from(si),PRIV_KEY).toString('base64url'); }

export default async function handler(req, res){
  try{
    const country = (req.query.country || 'CZ').toUpperCase();
    const r = await fetch(EB_BASE+'/aspsps?country='+encodeURIComponent(country), { headers:{ Authorization:'Bearer '+ebJwt() } });
    const d = await r.json();
    if(!r.ok) return res.status(r.status).json({ error:'enable_error', detail:d });
    // only banks that support PIS (payments) + personal PSU; keep it small for the picker
    const list = (d.aspsps||[])
      .filter(b => !b.beta)
      .map(b => ({ name:b.name, country:b.country, logo:b.logo||null,
                   payment_types:b.payment_types||b.paymentTypes||[], psu_types:b.psu_types||[] }));
    return res.status(200).json({ aspsps: list });
  }catch(e){ return res.status(500).json({ error: e.message }); }
}
