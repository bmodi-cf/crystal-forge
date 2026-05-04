import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listForges } from '@/lib/services/forges';
import { listGroups } from '@/lib/services/groups';
import { DashboardClient } from './DashboardClient';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const [forges, allGroups] = await Promise.all([
    listForges(session.user),
    listGroups(),
  ]);

  return <DashboardClient initialForges={forges} allGroups={allGroups} />;
}
