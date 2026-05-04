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
  const res = NextResponse.json({ ok: true });
  res.cookies.set('authjs.session-token', session.sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: session.expires,
    secure: process.env.NODE_ENV === 'production',
  });
  return res;
}
