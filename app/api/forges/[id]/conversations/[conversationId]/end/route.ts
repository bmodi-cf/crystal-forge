import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { assertCanConnect } from '@/lib/services/conversations';
import { endSession } from '@/lib/runtime/end-session';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations/[conversationId]/end'>,
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: forgeId, conversationId } = await ctx.params;
  try {
    await assertCanConnect(session.user, forgeId, conversationId);
    await endSession(forgeId, conversationId);
    return NextResponse.json({ ok: true });
  } catch (err) { return respondToServiceError(err); }
}
