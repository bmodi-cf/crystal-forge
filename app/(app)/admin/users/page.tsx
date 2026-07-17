import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listUsersForAdmin } from '@/lib/services/users';
import { AdminUsersClient } from './AdminUsersClient';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  const session = await auth();
  if (!session?.user) redirect('/login'); // layout already guards admin
  const users = await listUsersForAdmin(session.user);
  return <AdminUsersClient users={users} currentUserId={session.user.id} />;
}
