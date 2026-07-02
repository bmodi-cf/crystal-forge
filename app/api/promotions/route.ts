import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { listPendingPromotions, refreshPromotionGates } from '@/lib/services/promotions';
import { respondToServiceError } from '@/lib/http';

export async function GET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const pending = await listPendingPromotions(session.user);
    // Refresh each so the admin sees current gate state.
    const refreshed = await Promise.all(pending.map((p) => refreshPromotionGates(p.id)));
    return NextResponse.json({ promotions: refreshed });
  } catch (err) {
    return respondToServiceError(err);
  }
}
