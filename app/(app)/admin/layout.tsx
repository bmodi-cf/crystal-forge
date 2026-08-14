import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { isProdMode } from '@/lib/mode';
import { AdminNav } from './AdminNav';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (!session.user.isAdmin) redirect('/dashboard');
  return (
    <div className="flex w-full gap-8 px-6 py-8">
      <AdminNav prodMode={isProdMode()} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
