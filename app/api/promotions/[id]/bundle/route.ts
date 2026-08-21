import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { cutBundle } from '@/lib/services/first-release';
import { devOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/promotions/[id]/bundle'>,
) {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ bundle: await cutBundle(session.user, id) });
  } catch (err) {
    return respondToServiceError(err);
  }
}
