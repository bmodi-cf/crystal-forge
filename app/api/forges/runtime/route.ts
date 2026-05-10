import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getRuntimeService } from '@/lib/services/runtime';
import { respondToServiceError } from '@/lib/http';

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const runtimes = await getRuntimeService().listRuntimes(session.user);
    const map: Record<string, unknown> = {};
    for (const r of runtimes) map[r.forgeId] = r;
    return NextResponse.json({ runtimes: map });
  } catch (err) {
    return respondToServiceError(err);
  }
}
