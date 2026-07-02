import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { PromotionsClient } from './PromotionsClient';

export const dynamic = 'force-dynamic';

export default async function PromotionsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!session.user.isAdmin) redirect('/dashboard');
  return <PromotionsClient />;
}
