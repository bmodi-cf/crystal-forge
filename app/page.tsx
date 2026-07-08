import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { canEdit } from '@/lib/acl';
import { isProdMode } from '@/lib/mode';

export default async function RootPage() {
  if (isProdMode()) redirect('/launch');
  const session = await auth();
  if (!session?.user) redirect('/login');
  redirect(canEdit(session.user) ? '/dashboard' : '/launch');
}
