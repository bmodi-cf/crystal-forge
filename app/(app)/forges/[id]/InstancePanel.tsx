'use client';

import { ExternalLink, Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { RuntimeStateView } from '@/lib/runtime/types';

type Props = {
  forgeName: string;
  runtime: RuntimeStateView | null;
  canWrite: boolean;
  onStart: () => void | Promise<void>;
};

const LABEL: Record<NonNullable<RuntimeStateView['status']> | 'stopped', string> = {
  stopped: 'Forge is stopped',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  crashed: 'Crashed',
  'setup-failed': 'Setup failed',
};

export function InstancePanel({ forgeName, runtime, canWrite, onStart }: Props) {
  const [reloadKey, setReloadKey] = useState(0);

  if (runtime?.status === 'running') {
    const url = `/app/${runtime.slug}/`;
    return (
      <div className="relative flex flex-col h-full">
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] text-ink-faint">
          <span className="truncate">{forgeName} · /app/{runtime.slug}</span>
          <span className="text-[#4ad28b]">Running</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="inline-flex items-center gap-1 text-ink-dim hover:text-ink"
              title="Reload preview"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-dim hover:text-ink">
              <ExternalLink className="h-3 w-3" /> standalone
            </a>
          </div>
        </div>
        <iframe key={reloadKey} src={url} className="flex-1 border-0 bg-white" title={`${forgeName} live preview`} />
      </div>
    );
  }
  const status = runtime?.status ?? 'stopped';
  return (
    <div className="grid place-items-center h-full p-6">
      <div className="text-center">
        <div className="text-base text-ink-dim mb-3">{LABEL[status]}</div>
        {(status === 'stopped' || status === 'crashed' || status === 'setup-failed') && canWrite ? (
          <button
            type="button"
            onClick={() => onStart()}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-[12px] text-ink-dim hover:bg-panel-3 hover:text-ink"
          >
            <Play className="h-3.5 w-3.5" /> Start forge
          </button>
        ) : null}
      </div>
    </div>
  );
}
