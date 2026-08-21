import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { importBundle } from '@/lib/services/first-release';
import { importBundleInput } from '@/lib/services/first-release-schema';
import { prodOnlyRouteGuard } from '@/lib/mode';
import { respondToServiceError } from '@/lib/http';

export async function POST(
  req: NextRequest,
  ctx: RouteContext<'/api/deployments/bundles/[slug]/import'>,
) {
  const guard = prodOnlyRouteGuard();
  if (guard) return guard;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { slug } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = importBundleInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const imported = await importBundle(session.user, slug, parsed.data.version);
    return NextResponse.json({ imported });
  } catch (err) {
    return respondToServiceError(err);
  }
}
