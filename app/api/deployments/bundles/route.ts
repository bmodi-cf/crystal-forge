import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listBundleCandidates } from '@/lib/services/first-release';
import { prodOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function GET() {
  const guard = prodOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json({ candidates: await listBundleCandidates(session.user) });
  } catch (err) {
    return respondToServiceError(err);
  }
}
