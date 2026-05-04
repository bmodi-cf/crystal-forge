import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { listForges } from '@/lib/services/forges';
import { ForgeCard } from './ForgeCard';

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const forges = await listForges(session.user);
  const counts = forges.reduce(
    (acc, f) => {
      acc.all++;
      acc[f.status]++;
      return acc;
    },
    { all: 0, active: 0, draft: 0, archived: 0 }
  );

  return (
    <main className="mx-auto max-w-[1400px] px-8 py-10 pb-20">
      <div className="mb-7 flex items-end justify-between gap-6">
        <div>
          <h1 className="text-[32px] font-semibold tracking-[-0.02em]">Forges</h1>
          <div className="mt-1.5 text-sm text-ink-dim">
            <b className="font-medium text-ink">{counts.all}</b> applications ·{' '}
            <b className="font-medium text-ink">{counts.active}</b> active ·{' '}
            <b className="font-medium text-ink">{counts.draft}</b> in draft
          </div>
        </div>
      </div>

      {forges.length === 0 ? (
        <div className="rounded-[14px] border border-dashed border-border bg-white/[0.015] py-16 text-center text-ink-dim">
          <h4 className="mb-1.5 text-base font-medium text-ink">No forges visible to you yet.</h4>
          <p>Ask an administrator to add you to the relevant groups.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-[1.125rem]">
          {forges.map((f) => (
            <ForgeCard key={f.id} forge={f} />
          ))}
        </div>
      )}
    </main>
  );
}
