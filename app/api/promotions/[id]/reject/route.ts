import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { rejectPromotion } from '@/lib/services/promotions';
import { rejectPromotionInput } from '@/lib/services/promotions-schema';
import { respondToServiceError } from '@/lib/http';
import { devOnlyRouteGuard } from '@/lib/mode';

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/promotions/[id]/reject'>,
) {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = rejectPromotionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const promotion = await rejectPromotion(session.user, id, parsed.data);
    return NextResponse.json({ promotion });
  } catch (err) {
    return respondToServiceError(err);
  }
}
