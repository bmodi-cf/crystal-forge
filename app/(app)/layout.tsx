import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { Topbar } from '@/components/topbar/Topbar';
import { Toaster } from '@/components/ui/sonner';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }
  return (
    <div className="min-h-screen">
      <Topbar user={session.user} />
      {children}
      <Toaster richColors closeButton />
    </div>
  );
}
