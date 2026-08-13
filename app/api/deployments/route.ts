import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { loadDeploymentStatuses } from '@/lib/runtime/prod/deployment-status';

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!session.user.isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const snapshot = await loadDeploymentStatuses();
  return NextResponse.json({ deployments: Object.values(snapshot) });
}
