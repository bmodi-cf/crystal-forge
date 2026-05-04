import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { createForge } from '@/lib/services/forges';
import { createForgeInput } from '@/lib/services/forges-schema';
import { respondToServiceError } from '@/lib/http';

export async function POST(req: Request) {
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
  const parsed = createForgeInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', issues: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  try {
    const forge = await createForge(session.user, parsed.data);
    return NextResponse.json({ forge }, { status: 201 });
  } catch (err) {
    return respondToServiceError(err);
  }
}
