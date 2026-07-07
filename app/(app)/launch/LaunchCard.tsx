'use client';

import { useState } from 'react';
import type { Forge } from '@/lib/services/types';

type Props = {
  forge: Forge;
  /** Runtime slug — the running app is served at /app/{slug}/. */
  slug: string;
};

export function LaunchCard({ forge, slug }: Props) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <a
      href={`/app/${slug}/`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open ${forge.name}`}
      className="group flex flex-col overflow-hidden rounded-[14px] border border-border bg-panel transition hover:-translate-y-1 hover:border-border-strong hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
    >
      {!imageFailed && (
        // The hero image lives inside the forge's own repo (public/splash-logo.png) and
        // is served by the running forge itself, proxied at /app/{slug}/ — not a static
        // asset of this app, so next/image's local-asset optimizer doesn't apply here.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/app/${slug}/splash-logo.png`}
          alt=""
          onError={() => setImageFailed(true)}
          className="h-40 w-full object-cover"
        />
      )}
      <div className="flex flex-1 flex-col justify-end p-6">
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
      </div>
    </a>
  );
}
