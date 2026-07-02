'use client';

import Link from 'next/link';
import { Pencil, SquareTerminal } from 'lucide-react';
import type { Forge } from '@/lib/services/types';
import { ForgeCardRuntime, RuntimeStatus, type RuntimeAction } from './ForgeCardRuntime';
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
  return (
    <article className="relative flex min-h-[220px] flex-col overflow-hidden rounded-[14px] border border-border bg-panel transition hover:-translate-y-0.5 hover:border-border-strong hover:bg-panel-2">
      {/* Header — identity + runtime status (left column), Code Workspace launcher (right). Status sits bottom-left, in the space the tall button creates. */}
      <div className="flex gap-3.5 px-5 py-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex gap-3.5">
            <div className={`grid h-11 w-11 shrink-0 self-start place-items-center rounded-[10px] border text-base font-bold ${TONE_CLASSES[forge.tone]}`}>
              {forge.initials}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base font-semibold tracking-tight">{forge.name}</h3>
              <div className="truncate text-[11px] text-ink-faint">{forge.createdBy.name}</div>
            </div>
          </div>
          <div className="mt-auto pt-2">
            <RuntimeStatus runtime={runtime} />
          </div>
        </div>
        <Link
          href={`/forges/${forge.id}`}
          onClick={() => { if (canWrite) void onRuntimeAction(forge, 'start'); }}
          aria-label={`Open Claude Code Workspace for ${forge.name}`}
          className="grid h-[72px] w-[88px] shrink-0 place-items-center gap-1 rounded-[10px] border border-[#4ad28b]/40 bg-[#4ad28b]/10 text-[#4ad28b] transition hover:border-[#4ad28b]/60 hover:bg-[#4ad28b]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4ad28b]/60"
        >
          <span className="text-center text-[10px] font-medium leading-[1.15]">Claude Code Workspace</span>
          <SquareTerminal className="h-5 w-5" />
        </Link>
      </div>

      {/* Description — paragraph + groups; edit (description & groups) pinned bottom-right */}
      <div className="flex flex-col gap-3 border-t border-border px-5 py-4">
        <p className="line-clamp-2 text-[13px] leading-snug text-ink-dim">
          {forge.description ?? 'No description.'}
        </p>
        <div className="flex items-end justify-between gap-2">
          <div className="flex flex-1 flex-wrap gap-1.5">
            {forge.groups.map((g, i) => (
              <span
                key={g}
                className={`rounded-md border border-border bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-ink-dim ${i === 0 ? 'border-gold/30 bg-gold/[0.1] text-gold-soft' : ''}`}
              >
                {g}
              </span>
            ))}
          </div>
          {onEdit ? (
            <button
              type="button"
              aria-label={`Edit ${forge.name}`}
              onClick={() => onEdit(forge)}
              className="shrink-0 self-end rounded-md p-1.5 text-ink-dim transition hover:bg-panel-3 hover:text-ink"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Control — start/stop/open on the left, repo + delete on the right */}
      <ForgeCardRuntime
        forgeName={forge.name}
        canWrite={canWrite}
        runtime={runtime}
        onAction={(action) => onRuntimeAction(forge, action)}
        repoUrl={forge.repoUrl}
        onDelete={onDelete ? () => onDelete(forge) : undefined}
      />
    </article>
  );
}
