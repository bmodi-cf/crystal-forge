'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Pencil, SquareTerminal } from 'lucide-react';
import { toast } from 'sonner';
import type { Forge } from '@/lib/services/types';
import { ForgeCardRuntime, ForgeRuntimeActions, RuntimeStatus, type RuntimeAction } from './ForgeCardRuntime';
import { RequestPromotionDialog, type BumpLevel } from './RequestPromotionDialog';
import { usePromotion } from './usePromotion';
import type { RuntimeStateView } from '@/lib/runtime/types';

type Props = {
  forge: Forge;
  canWrite: boolean;
  runtime: RuntimeStateView | null;
  onRuntimeAction: (forge: Forge, action: RuntimeAction) => void | Promise<void>;
  onEdit?: (forge: Forge) => void;
  onDelete?: (forge: Forge) => void;
};

export function ForgeCard({ forge, canWrite, runtime, onRuntimeAction, onEdit, onDelete }: Props) {
  const [promoOpen, setPromoOpen] = useState(false);
  const { promotion, currentVersion, refetch: refetchPromotion } = usePromotion(forge.id);
  const label = forge.displayName || forge.name;

  async function submitPromotion(bump: BumpLevel) {
    const res = await fetch(`/api/forges/${forge.id}/promotion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bumpLevel: bump }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body?.error ?? 'Promotion request failed');
      return;
    }
    toast.success('Promotion requested');
    void refetchPromotion();
  }

  return (
    <article className="relative flex min-h-[220px] flex-col overflow-hidden rounded-[14px] border border-border bg-panel transition hover:-translate-y-0.5 hover:border-border-strong hover:bg-panel-2">
      {/* Header — identity + runtime status (left column), Code Workspace launcher (right). Status sits bottom-left, in the space the tall button creates. */}
      <div className="px-5 py-4">
        <div className="flex gap-3.5">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex gap-3.5">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-base font-semibold tracking-tight">{label}</h3>
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
            aria-label={`Open Claude Code Workspace for ${label}`}
            className="grid h-[72px] w-[88px] shrink-0 place-items-center gap-1 rounded-[10px] border border-[#4ad28b]/40 bg-[#4ad28b]/10 text-[#4ad28b] transition hover:border-[#4ad28b]/60 hover:bg-[#4ad28b]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4ad28b]/60"
          >
            <span className="text-center text-[10px] font-medium leading-[1.15]">Claude Code Workspace</span>
            <SquareTerminal className="h-5 w-5" />
          </Link>
        </div>

        {/* Runtime actions — own row in the top section, buffered from the identity block above */}
        <ForgeRuntimeActions
          canWrite={canWrite}
          runtime={runtime}
          onAction={(action) => onRuntimeAction(forge, action)}
        />
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
              aria-label={`Edit ${label}`}
              onClick={() => onEdit(forge)}
              className="shrink-0 self-end rounded-md p-1.5 text-ink-dim transition hover:bg-panel-3 hover:text-ink"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Control — Release / Git / Delete (runtime actions moved to the top section) */}
      <ForgeCardRuntime
        forgeName={label}
        canWrite={canWrite}
        repoUrl={forge.repoUrl}
        onDelete={onDelete ? () => onDelete(forge) : undefined}
        promotion={promotion}
        onRequestPromotion={() => setPromoOpen(true)}
        runtime={runtime}
      />

      <RequestPromotionDialog
        open={promoOpen}
        onOpenChange={setPromoOpen}
        forgeName={label}
        currentVersion={currentVersion}
        onConfirm={submitPromotion}
      />
    </article>
  );
}
