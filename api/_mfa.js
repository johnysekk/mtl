// 2FA NA SERVERU pro endpointy, kterým appka posílá přihlašovací token v těle požadavku (ostatní
// hlídá middleware.js podle hlavičky). Účet se zapnutým dvoufázovým ověřením smí volat API jen
// s tokenem, který vznikl po zadání kódu (aal2). `user` = odpověď /auth/v1/user (nese factors).
export function mfaRequired(token, user) {
  const has = Array.isArray(user && user.factors) && user.factors.some((f) => f && f.status === 'verified');
  if (!has) return false;
  try {
    const p = String(token || '').split('.')[1] || '';
    const c = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return c.aal !== 'aal2';
  } catch (e) { return true; }
}
