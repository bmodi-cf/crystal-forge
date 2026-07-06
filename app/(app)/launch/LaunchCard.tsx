'use client';

import type { Forge } from '@/lib/services/types';

type Props = {
  forge: Forge;
  /** Runtime slug — the running app is served at /app/{slug}/. */
  slug: string;
};

export function LaunchCard({ forge, slug }: Props) {
  return (
    <a
      href={`/app/${slug}/`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${forge.name}`}
      className="group relative flex min-h-[220px] flex-col justify-end overflow-hidden rounded-[14px] border border-border bg-panel p-6 transition hover:-translate-y-1 hover:border-border-strong hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
    >
      {/* Empty upper area — reserved for a future hero image */}
      <h3 className="break-words text-4xl font-bold tracking-tight">{forge.name}</h3>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {forge.groups.map((g, i) => (
          <span
            key={g}
            className={`rounded-md border border-border bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-ink-dim ${i === 0 ? 'border-gold/30 bg-gold/[0.1] text-gold-soft' : ''}`}
          >
            {g}
          </span>
        ))}
      </div>
    </a>
  );
}
