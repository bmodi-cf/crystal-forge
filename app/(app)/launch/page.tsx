import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listForges } from '@/lib/services/forges';
import { LaunchClient } from './LaunchClient';

export const dynamic = 'force-dynamic';

export default async function LaunchPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const forges = await listForges(session.user);

  return <LaunchClient forges={forges} />;
}
