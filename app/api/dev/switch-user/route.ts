import { NextResponse } from 'next/server';
import { z } from 'zod';
import { devCreateSessionForEmail } from '@/lib/services/dev';

const Body = z.object({ email: z.string().email() });

export async function POST(req: Request) {
  if (process.env.AUTH_DEV_USERS_ENABLED !== 'true') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }); }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const session = await devCreateSessionForEmail(parsed.data.email);
  if (!session) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }
  // Auth.js prefixes the session cookie with `__Secure-` and marks it Secure
  // whenever it runs in a secure context (an https AUTH_URL). The dev-login
  // cookie must use the SAME name/flag or `auth()` won't find it — e.g. on the
  // https pilot, a plain `authjs.session-token` is silently ignored.
  const useSecure = (process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? '').startsWith('https://');
  const cookieName = useSecure ? '__Secure-authjs.session-token' : 'authjs.session-token';
  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieName, session.sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: session.expires,
    secure: useSecure,
  });
  return res;
}
