import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_API_PREFIXES = ['/api/auth', '/api/dev'];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Skip explicitly public API namespaces (Auth.js routes; dev surface manages its own gate)
  if (PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Anything in the matcher below is protected. Read the session cookie.
  const hasSession = req.cookies.get('authjs.session-token') ?? req.cookies.get('__Secure-authjs.session-token');

  const isApi = pathname.startsWith('/api/');

  if (!hasSession) {
    if (isApi) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/forge/:path*',
    '/api/forges/:path*',
    '/api/conversations/:path*',
  ],
};
