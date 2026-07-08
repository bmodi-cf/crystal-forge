import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { acceptPromotion } from '@/lib/services/promotions';
import { respondToServiceError } from '@/lib/http';
import { devOnlyRouteGuard } from '@/lib/mode';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/promotions/[id]/accept'>,
) {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const promotion = await acceptPromotion(session.user, id);
    return NextResponse.json({ promotion });
  } catch (err) {
    return respondToServiceError(err);
  }
}
