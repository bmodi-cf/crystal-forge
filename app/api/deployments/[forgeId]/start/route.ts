import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { setForgeDeployEnabled } from '@/lib/services/deployments';
import { prodOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/deployments/[forgeId]/start'>,
) {
  const guard = prodOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { forgeId } = await ctx.params;
  try {
    const deployment = await setForgeDeployEnabled(session.user, forgeId, true);
    return NextResponse.json({ deployment });
  } catch (err) {
    return respondToServiceError(err);
  }
}
