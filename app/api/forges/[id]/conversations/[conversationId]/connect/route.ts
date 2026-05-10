import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { signTicket } from '@/lib/auth/ws-ticket';
import { env } from '@/lib/env';
import { assertCanConnect } from '@/lib/services/conversations';
import { respondToServiceError } from '@/lib/http';

const TICKET_TTL_MS = 60_000;

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations/[conversationId]/connect'>,
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: forgeId, conversationId } = await ctx.params;
  try {
    await assertCanConnect(session.user, forgeId, conversationId);
    const token = signTicket(
      { conversationId, userId: session.user.id, exp: Date.now() + TICKET_TTL_MS },
      env.CRYSTAL_FORGE_WS_SECRET,
    );
    const wsUrl = `ws://localhost:${env.CRYSTAL_FORGE_WS_PORT}/`;
    return NextResponse.json({ wsUrl, token, conversationId });
  } catch (err) { return respondToServiceError(err); }
}
