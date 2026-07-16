import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { setUserRole } from '@/lib/services/users';
import { respondToServiceError } from '@/lib/http';

const Body = z.object({ role: z.enum(['ADMIN', 'DEVELOPER', 'DEFAULT_USER']) });

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext<'/api/admin/users/[id]/role'>,
) {
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
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const { id } = await ctx.params;
  try {
    const user = await setUserRole(session.user, id, parsed.data.role);
    return NextResponse.json({ user });
  } catch (err) {
    return respondToServiceError(err);
  }
}
