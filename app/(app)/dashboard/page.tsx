import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { canEdit } from '@/lib/acl';
import { listForges } from '@/lib/services/forges';
import { listGroups } from '@/lib/services/groups';
import { isProdMode } from '@/lib/mode';
import { DashboardClient } from './DashboardClient';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  if (isProdMode()) notFound();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!canEdit(session.user)) redirect('/launch');

  const [forges, allGroups] = await Promise.all([
    listForges(session.user),
    listGroups(),
  ]);

  return (
    <DashboardClient
      initialForges={forges}
      allGroups={allGroups}
      myGroups={session.user.groups}
      isAdmin={session.user.isAdmin}
      currentUserId={session.user.id}
    />
  );
}
