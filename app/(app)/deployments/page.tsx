import { auth } from '@/lib/auth';
import { notFound, redirect } from 'next/navigation';
import { isProdMode } from '@/lib/mode';
import { DeploymentsClient } from './DeploymentsClient';

export const dynamic = 'force-dynamic';

export default async function DeploymentsPage() {
  if (!isProdMode()) notFound();
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!session.user.isAdmin) notFound();
  return <DeploymentsClient />;
}
