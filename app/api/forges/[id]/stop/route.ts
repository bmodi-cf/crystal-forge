import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getRuntimeService } from '@/lib/services/runtime';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/stop'>,
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await getRuntimeService().stopForge(session.user, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return respondToServiceError(err);
  }
}
