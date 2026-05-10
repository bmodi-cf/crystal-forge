'use client';

import type { ConversationDto } from '@/lib/services/conversations';

type Props = {
  items: ConversationDto[];
  activeId: string | null;
  canWrite: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
};

export function ConversationList({ items, activeId, canWrite, onSelect, onCreate }: Props) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] uppercase tracking-wide text-ink-faint">Conversations</h2>
        <button
          type="button"
          onClick={onCreate}
          disabled={!canWrite}
          className="rounded-md border border-border px-2 py-0.5 text-[11px] text-ink-dim hover:bg-panel-3 disabled:opacity-50"
        >
          + New
        </button>
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              data-active={c.id === activeId ? 'true' : 'false'}
              onClick={() => onSelect(c.id)}
              className="block w-full text-left rounded-md border border-transparent px-2 py-1.5 text-[12px] text-ink-dim hover:bg-panel-2 data-[active=true]:border-border-strong data-[active=true]:bg-panel-2 data-[active=true]:text-ink"
            >
              <div className="truncate">{c.title}</div>
              <div className="font-mono text-[10px] text-ink-faint">
                {new Date(c.updatedAt).toISOString().slice(0, 10)}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
