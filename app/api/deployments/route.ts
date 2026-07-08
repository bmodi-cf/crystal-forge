import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getLatestDeploymentStatuses } from '@/lib/runtime/prod/reconciler';

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return NextResponse.json({ deployments: getLatestDeploymentStatuses() });
}
