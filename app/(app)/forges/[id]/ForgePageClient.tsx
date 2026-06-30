'use client';

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { ChevronLeft } from 'lucide-react';
import { ChatPanel } from './ChatPanel';
import { InstancePanel } from './InstancePanel';
import type { ConversationDto } from '@/lib/services/conversations';
import type { RuntimeStateView } from '@/lib/runtime/types';

type Props = {
  forge: { id: string; name: string; createdBy: { id: string; name: string } };
  runtime: RuntimeStateView | null;
  canWrite: boolean;
  currentUserId: string;
  initialConversations: ConversationDto[];
  onCreateConversation: () => Promise<ConversationDto>;
};

const POLL_MS = 2_000;

export function ForgePageClient({
  forge, runtime: initialRuntime, canWrite, initialConversations, onCreateConversation,
}: Props) {
  const [conversations, setConversations] = useState<ConversationDto[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStateView | null>(initialRuntime);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPoll() {
    if (pollRef.current !== null) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  async function fetchRuntime() {
    try {
      const res = await fetch('/api/forges/runtime');
      if (!res.ok) return;
      const body = (await res.json()) as { runtimes: Record<string, RuntimeStateView> };
      const next = body.runtimes?.[forge.id] ?? null;
      setRuntime(next);
      if (next?.status === 'running' || next?.status === 'crashed' || next?.status === 'setup-failed' || next === null) {
        stopPoll();
      }
    } catch { /* Network blip — leave previous state */ }
  }

  useEffect(() => () => stopPoll(), []);

  async function handleCreate() {
    const created = await onCreateConversation();
    setConversations((prev) => [created, ...prev]);
    setActiveId(created.id);
  }

  async function handleStart() {
    try {
      await fetch(`/api/forges/${forge.id}/start`, { method: 'POST' });
      stopPoll();
      pollRef.current = setInterval(fetchRuntime, POLL_MS);
    } catch { /* swallow */ }
  }

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <Link href="/dashboard" className="inline-flex items-center gap-1 text-[12px] text-ink-dim hover:text-ink">
          <ChevronLeft className="h-3.5 w-3.5" /> Forges
        </Link>
        <div className="text-[13px] font-medium tracking-tight">{forge.name}</div>
        <div className="w-[80px]" />
      </header>
      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-[40%] min-w-[280px] flex-col border-r border-border">
          {/* compact conversation header — dropdown replaces the old vertical list */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 shrink-0">
            <select
              value={activeId ?? ''}
              onChange={(e) => { setActiveId(e.target.value || null); }}
              className="flex-1 min-w-0 bg-surface border border-border rounded px-2 py-0.5 text-[11px] text-ink truncate focus:outline-none focus:border-border-strong"
            >
              <option value="">— select a conversation —</option>
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title} · {new Date(c.updatedAt).toISOString().slice(0, 10)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => { void handleCreate(); }}
              disabled={!canWrite}
              className="shrink-0 rounded border border-border px-2 py-0.5 text-[11px] text-ink-dim hover:bg-panel-3 disabled:opacity-50"
            >
              + New
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <ChatPanel forgeId={forge.id} conversationId={activeId} />
          </div>
        </aside>
        <section className="flex-1 min-w-[320px]">
          <InstancePanel
            forgeName={forge.name}
            runtime={runtime}
            canWrite={canWrite}
            onStart={() => { void handleStart(); }}
          />
        </section>
      </div>
    </main>
  );
}
