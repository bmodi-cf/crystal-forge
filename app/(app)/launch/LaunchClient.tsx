'use client';

import Link from 'next/link';
import type { Forge } from '@/lib/services/types';
import { useForgeRuntimes } from '@/app/(app)/dashboard/useForgeRuntimes';
import { LaunchCard } from './LaunchCard';

type Props = { forges: Forge[] };

export function LaunchClient({ forges }: Props) {
  const { runtimes } = useForgeRuntimes();

  const running = forges.flatMap((forge) => {
    const rt = runtimes[forge.id];
    return rt?.status === 'running' ? [{ forge, slug: rt.slug }] : [];
  });

  return (
    <main className="mx-auto w-full max-w-6xl px-8 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Launch</h1>
      {running.length === 0 ? (
        <div className="mt-20 text-center text-ink-dim">
          <p>No forges are running right now.</p>
          <Link href="/dashboard" className="mt-2 inline-block text-gold-soft hover:underline">
            Go to the dashboard to start one
          </Link>
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {running.map(({ forge, slug }) => (
            <LaunchCard key={forge.id} forge={forge} slug={slug} />
          ))}
        </div>
      )}
    </main>
  );
}
