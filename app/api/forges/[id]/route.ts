import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { updateForge, deleteForge } from '@/lib/services/forges';
import { updateForgeInput } from '@/lib/services/forges-schema';
import { respondToServiceError } from '@/lib/http';

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]'>,
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
  const parsed = updateForgeInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const forge = await updateForge(session.user, id, parsed.data);
    return NextResponse.json({ forge });
  } catch (err) {
    return respondToServiceError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext<'/api/forges/[id]'>,
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    await deleteForge(session.user, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return respondToServiceError(err);
  }
}
