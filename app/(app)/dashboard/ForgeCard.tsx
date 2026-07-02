'use client';

import Link from 'next/link';
import { GitBranch, Pencil, Trash2 } from 'lucide-react';
import type { Forge } from '@/lib/services/types';
import { ForgeCardRuntime, type RuntimeAction } from './ForgeCardRuntime';
import type { RuntimeStateView } from '@/lib/runtime/types';

const TONE_CLASSES: Record<Forge['tone'], string> = {
  navy: 'bg-gradient-to-br from-[rgba(0,46,92,0.9)] to-[rgba(0,28,56,0.9)] text-[#9ec6ee] border-[rgba(60,110,170,0.4)]',
  gold: 'bg-gradient-to-br from-[rgba(185,160,96,0.25)] to-[rgba(140,119,71,0.4)] text-gold-soft border-[rgba(185,160,96,0.45)]',
  grey: 'bg-gradient-to-br from-[rgba(150,150,150,0.25)] to-[rgba(80,80,80,0.4)] text-[#e0e0e0] border-[rgba(150,150,150,0.4)]',
};

type Props = {
  forge: Forge;
  canWrite: boolean;
  runtime: RuntimeStateView | null;
  onRuntimeAction: (forge: Forge, action: RuntimeAction) => void | Promise<void>;
  onEdit?: (forge: Forge) => void;
  onDelete?: (forge: Forge) => void;
};

export function ForgeCard({ forge, canWrite, runtime, onRuntimeAction, onEdit, onDelete }: Props) {
  const showActions = Boolean(onEdit || onDelete);
  return (
    <article className="relative flex min-h-[220px] flex-col gap-4 overflow-hidden rounded-[14px] border border-border bg-panel p-5 transition hover:-translate-y-0.5 hover:border-border-strong hover:bg-panel-2">
      <Link href={`/forges/${forge.id}`} className="flex flex-col gap-4 outline-none focus-visible:ring-2 focus-visible:ring-gold/60 rounded-md">
        <div className="flex items-start gap-3.5">
          <div className={`grid h-11 w-11 place-items-center rounded-[10px] border text-base font-bold ${TONE_CLASSES[forge.tone]}`}>
            {forge.initials}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold tracking-tight">{forge.name}</h3>
          </div>
        </div>

        <p className="line-clamp-2 text-[13px] leading-snug text-ink-dim">{forge.description ?? 'No description.'}</p>

        <div className="flex flex-wrap gap-1.5">
          {forge.groups.map((g, i) => (
            <span
              key={g}
              className={`rounded-md border border-border bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-ink-dim ${i === 0 ? 'border-gold/30 bg-gold/[0.1] text-gold-soft' : ''}`}
            >
              {g}
            </span>
          ))}
        </div>
      </Link>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3.5">
        <span className="text-[11px] text-ink-faint">by {forge.createdBy.name}</span>
        <div className="flex items-center gap-1">
          <a
            href={forge.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View on GitHub: ${forge.name}`}
            className="rounded-md p-1.5 text-ink-dim transition hover:bg-panel-3 hover:text-ink"
          >
            <GitBranch className="h-3.5 w-3.5" />
          </a>
          {showActions && onEdit && (
            <button
              type="button"
              aria-label={`Edit ${forge.name}`}
              onClick={() => onEdit(forge)}
              className="rounded-md p-1.5 text-ink-dim transition hover:bg-panel-3 hover:text-ink"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {showActions && onDelete && (
            <button
              type="button"
              aria-label={`Delete ${forge.name}`}
              onClick={() => onDelete(forge)}
              className="rounded-md p-1.5 text-ink-dim transition hover:bg-[rgba(217,104,104,0.12)] hover:text-[#ff9f9f]"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <ForgeCardRuntime
        forgeId={forge.id}
        forgeName={forge.name}
        canWrite={canWrite}
        runtime={runtime}
        onAction={(action) => onRuntimeAction(forge, action)}
      />
    </article>
  );
}
