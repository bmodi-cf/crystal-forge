import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { signTicket } from '@/lib/auth/ws-ticket';
import { env } from '@/lib/env';
import { assertCanConnect } from '@/lib/services/conversations';
import { respondToServiceError } from '@/lib/http';
import { devOnlyRouteGuard } from '@/lib/mode';

const TICKET_TTL_MS = 60_000;

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations/[conversationId]/connect'>,
) {
  const guard = devOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: forgeId, conversationId } = await ctx.params;
  try {
    await assertCanConnect(session.user, forgeId, conversationId);
    const token = signTicket(
      { conversationId, userId: session.user.id, exp: Date.now() + TICKET_TTL_MS },
      env.CRYSTAL_FORGE_WS_SECRET,
    );
    const httpUrl = new URL(req.url);
    const wsProto = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    // Behind a TLS reverse proxy the WS is exposed on the same origin under a
    // path (CRYSTAL_FORGE_WS_PUBLIC_URL). Otherwise (local dev) connect directly
    // to the runtime WS port, where app and WS run as separate plaintext servers.
    const wsUrl =
      env.CRYSTAL_FORGE_WS_PUBLIC_URL ??
      `${wsProto}//${httpUrl.hostname}:${env.CRYSTAL_FORGE_WS_PORT}/`;
    return NextResponse.json({ wsUrl, token, conversationId });
  } catch (err) { return respondToServiceError(err); }
}
