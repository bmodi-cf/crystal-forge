import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { createGroup, listGroupsForAdmin } from '@/lib/services/groups';
import { respondToServiceError } from '@/lib/http';

const NameBody = z.object({ name: z.string().trim().min(1).max(64) });

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const groups = await listGroupsForAdmin(session.user);
    return NextResponse.json({ groups });
  } catch (err) {
    return respondToServiceError(err);
  }
}

export async function POST(req: NextRequest) {
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
  try {
    const group = await createGroup(session.user, parsed.data.name);
    return NextResponse.json({ group }, { status: 201 });
  } catch (err) {
    return respondToServiceError(err);
  }
}
