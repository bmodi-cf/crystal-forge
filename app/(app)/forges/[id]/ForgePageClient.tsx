'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { ConversationList } from './ConversationList';
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

export function ForgePageClient({
  forge, runtime, canWrite, initialConversations, onCreateConversation,
}: Props) {
  const [conversations, setConversations] = useState<ConversationDto[]>(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(null);

  async function handleCreate() {
    const created = await onCreateConversation();
    setConversations((prev) => [created, ...prev]);
    setActiveId(created.id);
  }

  async function handleStart() {
    try { await fetch(`/api/forges/${forge.id}/start`, { method: 'POST' }); } catch { /* swallow */ }
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
          <div className="border-b border-border p-3">
            <ConversationList
              items={conversations}
              activeId={activeId}
              canWrite={canWrite}
              onSelect={setActiveId}
              onCreate={() => { void handleCreate(); }}
            />
          </div>
          <div className="flex-1 overflow-hidden">
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
