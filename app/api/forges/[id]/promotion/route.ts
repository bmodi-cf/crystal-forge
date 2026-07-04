import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { requestPromotion, refreshPromotionGates, getForgePromotion, getForgeCurrentVersion, ACTIVE } from '@/lib/services/promotions';
import { requestPromotionInput } from '@/lib/services/promotions-schema';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/promotion'>,
) {
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
  const parsed = requestPromotionInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const promotion = await requestPromotion(session.user, id, parsed.data);
    return NextResponse.json({ promotion });
  } catch (err) {
    return respondToServiceError(err);
  }
}

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/promotion'>,
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    let promotion = await getForgePromotion(session.user, id);
    // Refresh gates on read while the request is still in an active state.
    if (promotion && (ACTIVE as readonly string[]).includes(promotion.status)) {
      promotion = await refreshPromotionGates(promotion.id);
    }
    const currentVersion = await getForgeCurrentVersion(session.user, id);
    return NextResponse.json({ promotion, currentVersion });
  } catch (err) {
    return respondToServiceError(err);
  }
}
