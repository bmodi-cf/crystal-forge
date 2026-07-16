import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { canEdit } from '@/lib/acl';

export default async function RootPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  redirect(canEdit(session.user) ? '/dashboard' : '/launch');
}
