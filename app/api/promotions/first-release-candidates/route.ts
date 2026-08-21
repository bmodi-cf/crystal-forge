import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listFirstReleaseCandidates } from '@/lib/services/first-release';
import { devOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function GET() {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ candidates: await listFirstReleaseCandidates(session.user) });
  } catch (err) {
    return respondToServiceError(err);
  }
}
