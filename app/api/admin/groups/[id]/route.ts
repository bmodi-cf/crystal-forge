import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { deleteGroup, getGroupDetail, renameGroup } from '@/lib/services/groups';
import { respondToServiceError } from '@/lib/http';

const NameBody = z.object({ name: z.string().trim().min(1).max(64) });

export async function GET(_req: NextRequest, ctx: RouteContext<'/api/admin/groups/[id]'>) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const group = await getGroupDetail(session.user, id);
    return NextResponse.json({ group });
  } catch (err) {
    return respondToServiceError(err);
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext<'/api/admin/groups/[id]'>) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = NameBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { id } = await ctx.params;
  try {
    const group = await renameGroup(session.user, id, parsed.data.name);
    return NextResponse.json({ group });
  } catch (err) {
    return respondToServiceError(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<'/api/admin/groups/[id]'>) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await ctx.params;
  try {
    const impact = await deleteGroup(session.user, id);
    return NextResponse.json({ impact });
  } catch (err) {
    return respondToServiceError(err);
  }
}
