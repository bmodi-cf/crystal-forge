import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { getConversation } from '@/lib/services/conversations';
import { respondToServiceError } from '@/lib/http';
import { devOnlyRouteGuard } from '@/lib/mode';

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations/[conversationId]'>,
) {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { conversationId } = await ctx.params;
  try {
    const conversation = await getConversation(session.user, conversationId);
    return NextResponse.json({ conversation });
  } catch (err) { return respondToServiceError(err); }
}
