'use client';

import { useState } from 'react';
import { Play, Square, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RuntimeStateView } from '@/lib/runtime/types';

export type RuntimeAction = 'start' | 'stop';

type Props = {
  forgeId: string;
  forgeName: string;
  canWrite: boolean;
  runtime: RuntimeStateView | null;
  onAction: (action: RuntimeAction) => void | Promise<void>;
};

const DOT_CLASS: Record<NonNullable<RuntimeStateView['status']> | 'stopped', string> = {
  stopped: 'bg-[#6b7785]',
  starting: 'bg-[#e0a948] animate-pulse',
  running: 'bg-[#4ad28b]',
  stopping: 'bg-[#e0a948] animate-pulse',
  crashed: 'bg-[#d96868]',
  'setup-failed': 'bg-[#d96868]',
};

const LABEL: Record<NonNullable<RuntimeStateView['status']> | 'stopped', string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  crashed: 'Crashed',
  'setup-failed': 'Setup failed',
};

export function ForgeCardRuntime({ forgeId: _id, forgeName: _name, canWrite, runtime, onAction }: Props) {
  const status: keyof typeof LABEL = runtime?.status ?? 'stopped';
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
    <div className="flex items-center justify-between gap-2 border-t border-border pt-3.5 text-[12px]">
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', DOT_CLASS[status])} />
        <span className="text-ink-dim">{LABEL[status]}</span>
        {status === 'crashed' || status === 'setup-failed' ? (
          <span className="ml-2 truncate font-mono text-[10px] text-ink-faint" title={runtime?.logPath}>
            {runtime?.logPath ?? ''}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        {showOpen ? (
          <a
            href={`/app/${runtime!.slug}/`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ink-dim hover:bg-panel-3 hover:text-ink"
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
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ink-dim disabled:opacity-50 hover:bg-panel-3 hover:text-ink"
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
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-ink-dim disabled:opacity-50 hover:bg-panel-3 hover:text-ink"
          >
            <Play className="h-3.5 w-3.5" /> Start
          </button>
        ) : null}
      </div>
    </div>
  );
}
