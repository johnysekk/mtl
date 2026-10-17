// 2FA NA SERVERU (Vercel middleware, běží před každým /api/*).
// Účet se zapnutým dvoufázovým ověřením (kód z aplikace typu Google Authenticator) smí volat
// API jen s přihlášením, které prošlo kódem (aal2). Že má účet 2FA zapnuté, nese token sám
// (claim mtl_mfa z public.mtl_access_token_hook, sql/mfa.sql) -- middleware se proto nikam
// neptá a nic nezdržuje. Podpis tokenu tu nekontrolujeme: ověří ho každý endpoint u Supabase,
// a kdo by claim z tokenu odstranil, rozbije podpis. Endpointy, kterým appka posílá token
// v těle požadavku, hlídají totéž samy (api/_mfa.js).
// Cokoli, co nejde přečíst (cron s heslem, žádný token), projde beze změny.
export const config = { matcher: ['/api/:path*'] };

function claimsOf(tok) {
  try {
    const p = tok.split('.')[1] || '';
    const b = p.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(atob(b));
  } catch (e) { return null; }
}

export default function middleware(request) {
  const h = request.headers;
  const tok = String(h.get('x-access-token') || '').trim()
    || String(h.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok || tok.split('.').length !== 3) return;
  const c = claimsOf(tok);
  if (c && c.mtl_mfa === true && c.aal !== 'aal2') {
    return new Response(JSON.stringify({ error: 'mfa_required' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });
  }
}
