import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listGroupsForAdmin } from '@/lib/services/groups';
import { listUsersForAdmin } from '@/lib/services/users';
import { AdminGroupsClient } from './AdminGroupsClient';

export const dynamic = 'force-dynamic';

export default async function AdminGroupsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login'); // layout already guards admin
  const [groups, users] = await Promise.all([
    listGroupsForAdmin(session.user),
    listUsersForAdmin(session.user),
  ]);
  return (
    <AdminGroupsClient
      groups={groups}
      allUsers={users.map((u) => ({ id: u.id, name: u.name, email: u.email }))}
    />
  );
}
