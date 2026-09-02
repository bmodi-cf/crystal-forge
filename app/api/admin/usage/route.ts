import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { getUsageSeries } from '@/lib/services/usage';
import { respondToServiceError } from '@/lib/http';

const RangeParam = z.enum(['24h', '7d', '30d', '90d']).default('30d');

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const raw = new URL(req.url).searchParams.get('range');
  const parsed = RangeParam.safeParse(raw ?? undefined);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid range' }, { status: 400 });
  }
  try {
    const series = await getUsageSeries(session.user, parsed.data);
    return NextResponse.json({ series });
  } catch (err) {
    return respondToServiceError(err);
  }
}
