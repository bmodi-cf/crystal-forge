import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getRuntimeService } from '@/lib/services/runtime';
import { respondToServiceError } from '@/lib/http';
import { devOnlyRouteGuard } from '@/lib/mode';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/start'>,
) {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const runtime = await getRuntimeService().startForge(session.user, id);
    return NextResponse.json({ runtime });
  } catch (err) {
    return respondToServiceError(err);
  }
}
