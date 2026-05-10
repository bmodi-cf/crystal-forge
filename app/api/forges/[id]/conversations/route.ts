import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { listConversations, createConversation } from '@/lib/services/conversations';
import { respondToServiceError } from '@/lib/http';

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations'>,
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const conversations = await listConversations(session.user, id);
    return NextResponse.json({ conversations });
  } catch (err) { return respondToServiceError(err); }
}

export async function POST(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]/conversations'>,
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const conversation = await createConversation(session.user, id);
    return NextResponse.json({ conversation });
  } catch (err) { return respondToServiceError(err); }
}
