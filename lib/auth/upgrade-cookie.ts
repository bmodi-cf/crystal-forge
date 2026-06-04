/** Parse a raw `Cookie:` header into a name→value map. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

// Auth.js v5 database-session cookie names: secure (https) first, then plain (http).
const SESSION_COOKIE_NAMES = ['__Secure-authjs.session-token', 'authjs.session-token'];

/** The Auth.js session token from a parsed cookie map, or null. */
export function sessionTokenFromCookies(cookies: Record<string, string>): string | null {
  for (const name of SESSION_COOKIE_NAMES) {
    if (cookies[name]) return cookies[name];
  }
  return null;
}
