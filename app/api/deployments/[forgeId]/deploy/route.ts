import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { deployForge } from '@/lib/services/deployments';
import { deployForgeInput } from '@/lib/services/deployments-schema';
import { prodOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/deployments/[forgeId]/deploy'>,
) {
  const guard = prodOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { forgeId } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = deployForgeInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const deployment = await deployForge(session.user, forgeId, parsed.data.version);
    return NextResponse.json({ deployment });
  } catch (err) {
    return respondToServiceError(err);
  }
}
