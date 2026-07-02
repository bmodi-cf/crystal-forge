'use client';

import { useState } from 'react';
import { Play, Square, ExternalLink, GitBranch, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RuntimeStateView } from '@/lib/runtime/types';

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

type Props = {
  forgeName: string;
  canWrite: boolean;
  runtime: RuntimeStateView | null;
  onAction: (action: RuntimeAction) => void | Promise<void>;
  /** When set, renders a "view repo on GitHub" link on the right of the row. */
  repoUrl?: string;
  /** When set, renders a delete (trash) button on the right of the row. */
  onDelete?: () => void;
};

const actionBtn =
  'inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ink-dim disabled:opacity-50 hover:bg-panel-3 hover:text-ink';
const startBtn =
  'inline-flex items-center gap-1 rounded-md border border-[#4ad28b]/40 bg-[#4ad28b]/10 px-2 py-1 text-[#4ad28b] disabled:opacity-50 hover:border-[#4ad28b]/60 hover:bg-[#4ad28b]/20';
const iconOnlyBtn =
  'inline-flex items-center rounded-md border border-border p-1.5 text-ink-dim hover:bg-panel-3 hover:text-ink';

/** Control row: runtime action(s) on the left, repo + delete on the right. */
export function ForgeCardRuntime({ forgeName, canWrite, runtime, onAction, repoUrl, onDelete }: Props) {
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

  return (
    <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-5 py-3.5 text-[12px]">
      <div className="flex items-center gap-1.5">
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
      <div className="flex items-center gap-1.5">
        {repoUrl ? (
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`View on GitHub: ${forgeName}`}
            className={iconOnlyBtn}
          >
            <GitBranch className="h-3.5 w-3.5" />
          </a>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${forgeName}`}
            className="inline-flex items-center rounded-md border border-border p-1.5 text-ink-dim transition hover:border-[rgba(217,104,104,0.4)] hover:bg-[rgba(217,104,104,0.12)] hover:text-[#ff9f9f]"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
