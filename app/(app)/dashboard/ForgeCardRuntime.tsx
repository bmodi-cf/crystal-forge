'use client';

import { useState } from 'react';
import { Play, Square, ExternalLink, GitBranch, Trash2, Rocket } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RuntimeStateView } from '@/lib/runtime/types';
import { ACTIVE_PROMOTION_STATUSES, type Promotion } from './usePromotion';

export type RuntimeAction = 'start' | 'stop';

type RuntimeStatusKey = NonNullable<RuntimeStateView['status']> | 'stopped';

const DOT_CLASS: Record<RuntimeStatusKey, string> = {
  stopped: 'bg-[#6b7785]',
  starting: 'bg-[#e0a948] animate-pulse',
  running: 'bg-[#4ad28b]',
  stopping: 'bg-[#e0a948] animate-pulse',
  crashed: 'bg-[#d96868]',
  'setup-failed': 'bg-[#d96868]',
};

const LABEL: Record<RuntimeStatusKey, string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  crashed: 'Crashed',
  'setup-failed': 'Setup failed',
};

/** Runtime status indicator: colored dot + label (+ setup error, when present). */
export function RuntimeStatus({ runtime }: { runtime: RuntimeStateView | null }) {
  const status: RuntimeStatusKey = runtime?.status ?? 'stopped';
  const error = status === 'crashed' || status === 'setup-failed' ? runtime?.setupError : undefined;
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12px]">
      <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT_CLASS[status])} />
      <span className="text-ink-dim">{LABEL[status]}</span>
      {error ? (
        <span className="truncate text-[10px] text-ink-faint" title={error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

const actionBtn =
  'inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ink-dim disabled:opacity-50 hover:bg-panel-3 hover:text-ink';
const startBtn =
  'inline-flex items-center gap-1 rounded-md border border-[#4ad28b]/40 bg-[#4ad28b]/10 px-2 py-1 text-[#4ad28b] disabled:opacity-50 hover:border-[#4ad28b]/60 hover:bg-[#4ad28b]/20';
const promoteBtn =
  'inline-flex items-center gap-1 rounded-md border border-gold/40 bg-gold/[0.12] px-2 py-1 text-gold-soft disabled:opacity-50 hover:border-gold/60 hover:bg-gold/[0.2]';

const PROMOTION_STATUS_LABEL: Record<string, string> = {
  checks_running: 'checks running',
  checks_failed: 'checks failed',
  awaiting_approval: 'awaiting approval',
};

type RuntimeActionsProps = {
  canWrite: boolean;
  runtime: RuntimeStateView | null;
  onAction: (action: RuntimeAction) => void | Promise<void>;
};

/**
 * Runtime action buttons (Open / Stop / Start) for a forge, rendered as their
 * own row in the card's top section. Returns null when no action applies, so
 * the buffer space above it never shows for an empty row.
 */
export function ForgeRuntimeActions({ canWrite, runtime, onAction }: RuntimeActionsProps) {
  const status: RuntimeStatusKey = runtime?.status ?? 'stopped';
  const [busy, setBusy] = useState(false);

  async function go(action: RuntimeAction) {
    if (busy) return;
    setBusy(true);
    try { await onAction(action); } finally { setBusy(false); }
  }

  const showOpen = status === 'running' && runtime;
  const showStop = canWrite && (status === 'running' || status === 'starting' || status === 'stopping');
  const showStart = canWrite && (status === 'stopped' || status === 'crashed' || status === 'setup-failed');

  if (!showOpen && !showStop && !showStart) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
      {showOpen ? (
        <a
          href={`/app/${runtime!.slug}/`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open"
          className={actionBtn}
        >
          <ExternalLink className="h-3.5 w-3.5" /> Open
        </a>
      ) : null}
      {showStop ? (
        <button
          type="button"
          onClick={() => go('stop')}
          disabled={busy || status === 'starting' || status === 'stopping'}
          aria-label="Stop"
          className={actionBtn}
        >
          <Square className="h-3.5 w-3.5" /> Stop
        </button>
      ) : null}
      {showStart ? (
        <button
          type="button"
          onClick={() => go('start')}
          disabled={busy}
          aria-label="Start"
          className={startBtn}
        >
          <Play className="h-3.5 w-3.5" /> Start
        </button>
      ) : null}
    </div>
  );
}

type Props = {
  forgeName: string;
  canWrite: boolean;
  /** When set, renders a "view repo on GitHub" link. */
  repoUrl?: string;
  /** When set, renders a delete (trash) button. */
  onDelete?: () => void;
  /** Current promotion request for this forge, if any (drives the status line + button disabled state). */
  promotion?: Promotion | null;
  /** When set (and canWrite), renders a "Release" button that opens the promotion dialog. */
  onRequestPromotion?: () => void;
};

/** Bottom control row: Release / Git / Delete, right-aligned, with the promotion status line above. */
export function ForgeCardRuntime({
  forgeName,
  canWrite,
  repoUrl,
  onDelete,
  promotion,
  onRequestPromotion,
}: Props) {
  const promotionActive = !!promotion && ACTIVE_PROMOTION_STATUSES.includes(promotion.status);

  return (
    <div className="mt-auto border-t border-border">
      {promotionActive && promotion ? (
        <a
          href={promotion.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate px-5 pt-3 text-[11px] text-ink-faint hover:text-ink-dim"
        >
          Release {promotion.targetVersion} — {PROMOTION_STATUS_LABEL[promotion.status] ?? promotion.status}
        </a>
      ) : null}
      <div
        className={cn(
          'flex flex-wrap items-center justify-end gap-2 px-5 text-[12px]',
          promotionActive ? 'pt-1.5 pb-3.5' : 'py-3.5',
        )}
      >
        <div className="flex items-center gap-1.5">
          {canWrite && onRequestPromotion ? (
            <button
              type="button"
              onClick={onRequestPromotion}
              disabled={promotionActive}
              aria-label={`Release ${forgeName}`}
              className={promoteBtn}
            >
              <Rocket className="h-3.5 w-3.5" /> Release
            </button>
          ) : null}
          {repoUrl ? (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`View on GitHub: ${forgeName}`}
              className={actionBtn}
            >
              <GitBranch className="h-3.5 w-3.5" /> Git
            </a>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              aria-label={`Delete ${forgeName}`}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ink-dim transition hover:border-[rgba(217,104,104,0.4)] hover:bg-[rgba(217,104,104,0.12)] hover:text-[#ff9f9f]"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
