import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { addMember, removeMember } from '@/lib/services/groups';
import { respondToServiceError } from '@/lib/http';

const MemberBody = z.object({ userId: z.uuid() });

export async function POST(req: NextRequest, ctx: RouteContext<'/api/admin/groups/[id]/members'>) {
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
  const parsed = MemberBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { id } = await ctx.params;
  try {
    const member = await addMember(session.user, id, parsed.data.userId);
    return NextResponse.json({ member }, { status: 201 });
  } catch (err) {
    return respondToServiceError(err);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext<'/api/admin/groups/[id]/members'>) {
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
  const parsed = MemberBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { id } = await ctx.params;
  try {
    await removeMember(session.user, id, parsed.data.userId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return respondToServiceError(err);
  }
}
